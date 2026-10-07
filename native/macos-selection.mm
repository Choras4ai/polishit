#include <node_api.h>
#include <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>
#include <unordered_set>
#include <vector>

namespace {

struct RangeValue {
  CFIndex location = -1;
  CFIndex length = 0;
  bool valid = false;
};

struct RectValue {
  CGRect rect = CGRectZero;
  bool valid = false;
};

struct SelectionInfo {
  std::string text;
  std::string elementToken;
  RangeValue range;
  RectValue selectionBounds;
  RectValue elementBounds;
  bool supportsRangeEditing = false;
  AXUIElementRef element = nullptr;
};

// Retain the last captured control so a changing Word accessibility tree does
// not require a fresh breadth-first search on every hover. Geometry still
// verifies its text, parent window and foreground process on every request.
struct CapturedControl {
  AXUIElementRef element = nullptr;
  pid_t pid = 0;
  ~CapturedControl() { if (element) CFRelease(element); }
  void remember(AXUIElementRef value, pid_t owner) {
    if (value) CFRetain(value);
    if (element) CFRelease(element);
    element = value; pid = owner;
  }
};
thread_local CapturedControl capturedControl;

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value Bool(napi_env env, bool input) {
  napi_value value;
  napi_get_boolean(env, input, &value);
  return value;
}

napi_value Number(napi_env env, double input) {
  napi_value value;
  napi_create_double(env, input, &value);
  return value;
}

napi_value String(napi_env env, const std::string &input) {
  napi_value value;
  napi_create_string_utf8(env, input.c_str(), input.size(), &value);
  return value;
}

napi_value Null(napi_env env) {
  napi_value value;
  napi_get_null(env, &value);
  return value;
}

void Set(napi_env env, napi_value object, const char *name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}

napi_value Get(napi_env env, napi_value object, const char *name) {
  napi_value value = Undefined(env);
  napi_valuetype type;
  bool isNull = false;
  if (napi_typeof(env, object, &type) != napi_ok || type != napi_object) return value;
  napi_strict_equals(env, object, Null(env), &isNull);
  if (isNull) return value;
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) == napi_ok && has) {
    napi_get_named_property(env, object, name, &value);
  }
  return value;
}

double GetNumber(napi_env env, napi_value object, const char *name, double fallback = -1) {
  napi_value value = Get(env, object, name);
  double output = fallback;
  napi_get_value_double(env, value, &output);
  return output;
}

std::string GetString(napi_env env, napi_value object, const char *name) {
  napi_value value = Get(env, object, name);
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok) return "";
  std::string output(size + 1, '\0');
  napi_get_value_string_utf8(env, value, output.data(), output.size(), &size);
  output.resize(size);
  return output;
}

std::string ToUtf8(CFTypeRef value) {
  if (!value || CFGetTypeID(value) != CFStringGetTypeID()) return "";
  NSString *string = (__bridge NSString *)value;
  const char *utf8 = [string UTF8String];
  return utf8 ? std::string(utf8) : std::string();
}

CFTypeRef CopyAttribute(AXUIElementRef element, CFStringRef attribute) {
  if (!element) return nullptr;
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) {
    return nullptr;
  }
  return value;
}

CFTypeRef CopyParameterized(AXUIElementRef element, CFStringRef attribute, CFTypeRef parameter) {
  if (!element || !parameter) return nullptr;
  CFTypeRef value = nullptr;
  if (AXUIElementCopyParameterizedAttributeValue(element, attribute, parameter, &value) != kAXErrorSuccess) {
    return nullptr;
  }
  return value;
}

RangeValue ReadRange(CFTypeRef value) {
  RangeValue output;
  if (!value || CFGetTypeID(value) != AXValueGetTypeID()) return output;
  AXValueRef axValue = static_cast<AXValueRef>(value);
  CFRange range = CFRangeMake(0, 0);
  const auto rangeType = static_cast<AXValueType>(kAXValueCFRangeType);
  if (AXValueGetType(axValue) != rangeType || !AXValueGetValue(axValue, rangeType, &range)) {
    return output;
  }
  if (range.location < 0 || range.length < 0) return output;
  output.location = range.location;
  output.length = range.length;
  output.valid = true;
  return output;
}

RectValue ReadRect(CFTypeRef value) {
  RectValue output;
  if (!value || CFGetTypeID(value) != AXValueGetTypeID()) return output;
  AXValueRef axValue = static_cast<AXValueRef>(value);
  CGRect rect = CGRectZero;
  const auto rectType = static_cast<AXValueType>(kAXValueCGRectType);
  if (AXValueGetType(axValue) != rectType || !AXValueGetValue(axValue, rectType, &rect)) {
    return output;
  }
  output.rect = rect;
  output.valid = true;
  return output;
}

RectValue ElementBounds(AXUIElementRef element) {
  RectValue output;
  CFTypeRef positionRef = CopyAttribute(element, kAXPositionAttribute);
  CFTypeRef sizeRef = CopyAttribute(element, kAXSizeAttribute);
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  if (positionRef && sizeRef
      && CFGetTypeID(positionRef) == AXValueGetTypeID()
      && CFGetTypeID(sizeRef) == AXValueGetTypeID()
      && AXValueGetValue(static_cast<AXValueRef>(positionRef), static_cast<AXValueType>(kAXValueCGPointType), &position)
      && AXValueGetValue(static_cast<AXValueRef>(sizeRef), static_cast<AXValueType>(kAXValueCGSizeType), &size)) {
    output.rect = CGRectMake(position.x, position.y, size.width, size.height);
    output.valid = true;
  }
  if (positionRef) CFRelease(positionRef);
  if (sizeRef) CFRelease(sizeRef);
  return output;
}

bool IsRangeSettable(AXUIElementRef element) {
  Boolean settable = false;
  return AXUIElementIsAttributeSettable(element, kAXSelectedTextRangeAttribute, &settable) == kAXErrorSuccess
    && settable;
}

void AppendElement(std::vector<AXUIElementRef> &elements,
                   std::unordered_set<CFHashCode> &seen,
                   AXUIElementRef element) {
  if (!element || CFGetTypeID(element) != AXUIElementGetTypeID()) return;
  CFHashCode hash = CFHash(element);
  if (seen.find(hash) != seen.end()) return;
  seen.insert(hash);
  CFRetain(element);
  elements.push_back(element);
}

void AppendChildren(std::vector<AXUIElementRef> &queue,
                    std::unordered_set<CFHashCode> &seen,
                    AXUIElementRef element,
                    CFStringRef attribute,
                    size_t maxNodes) {
  CFTypeRef value = CopyAttribute(element, attribute);
  if (!value || CFGetTypeID(value) != CFArrayGetTypeID()) {
    if (value) CFRelease(value);
    return;
  }
  CFArrayRef array = static_cast<CFArrayRef>(value);
  CFIndex count = CFArrayGetCount(array);
  for (CFIndex index = 0; index < count && queue.size() < maxNodes; index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(array, index);
    if (child && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      AppendElement(queue, seen, static_cast<AXUIElementRef>(const_cast<void *>(child)));
    }
  }
  CFRelease(value);
}

std::vector<AXUIElementRef> CandidateElements(AXUIElementRef appElement, bool expandDescendants) {
  std::vector<AXUIElementRef> elements;
  std::unordered_set<CFHashCode> seen;
  CFTypeRef focusedRef = CopyAttribute(appElement, kAXFocusedUIElementAttribute);
  if (focusedRef && CFGetTypeID(focusedRef) == AXUIElementGetTypeID()) {
    AXUIElementRef current = static_cast<AXUIElementRef>(focusedRef);
    AppendElement(elements, seen, current);
    for (int depth = 0; depth < 10; depth += 1) {
      CFTypeRef parentRef = CopyAttribute(current, kAXParentAttribute);
      if (!parentRef || CFGetTypeID(parentRef) != AXUIElementGetTypeID()) {
        if (parentRef) CFRelease(parentRef);
        break;
      }
      current = static_cast<AXUIElementRef>(parentRef);
      AppendElement(elements, seen, current);
      CFRelease(parentRef);
    }
  }
  if (focusedRef) CFRelease(focusedRef);

  CFTypeRef windowRef = CopyAttribute(appElement, kAXFocusedWindowAttribute);
  if (windowRef && CFGetTypeID(windowRef) == AXUIElementGetTypeID()) {
    AppendElement(elements, seen, static_cast<AXUIElementRef>(windowRef));
  }
  if (windowRef) CFRelease(windowRef);
  AppendElement(elements, seen, appElement);

  // WPS/Qt editors frequently expose selection on a descendant rather than
  // the nominal focused element. Only do the bounded tree walk when the fast
  // focused-element path did not find a selection.
  if (expandDescendants) {
    for (size_t index = 0; index < elements.size() && elements.size() < 240; index += 1) {
      AXUIElementRef element = elements[index];
      AppendChildren(elements, seen, element, kAXSelectedChildrenAttribute, 240);
      AppendChildren(elements, seen, element, kAXChildrenAttribute, 240);
      AppendChildren(elements, seen, element, kAXContentsAttribute, 240);
    }
  }
  return elements;
}

SelectionInfo ReadSelection(AXUIElementRef element) {
  SelectionInfo output;
  output.elementBounds = ElementBounds(element);
  CFTypeRef textRef = CopyAttribute(element, kAXSelectedTextAttribute);
  CFTypeRef rangeRef = CopyAttribute(element, kAXSelectedTextRangeAttribute);
  output.range = ReadRange(rangeRef);
  output.supportsRangeEditing = output.range.valid && IsRangeSettable(element);
  output.text = ToUtf8(textRef);

  if (output.text.empty() && output.range.valid && output.range.length > 0 && rangeRef) {
    CFTypeRef rangedText = CopyParameterized(element, kAXStringForRangeParameterizedAttribute, rangeRef);
    output.text = ToUtf8(rangedText);
    if (rangedText) CFRelease(rangedText);
  }
  if (rangeRef) {
    CFTypeRef boundsRef = CopyParameterized(element, kAXBoundsForRangeParameterizedAttribute, rangeRef);
    output.selectionBounds = ReadRect(boundsRef);
    if (boundsRef) CFRelease(boundsRef);
  }

  // Chromium and several custom editors expose text-marker ranges instead.
  if (output.text.empty()) {
    CFTypeRef markerRange = CopyAttribute(element, kAXSelectedTextMarkerRangeAttribute);
    if (markerRange) {
      CFTypeRef markerText = CopyParameterized(element, kAXStringForTextMarkerRangeParameterizedAttribute, markerRange);
      output.text = ToUtf8(markerText);
      if (markerText) CFRelease(markerText);
      CFTypeRef markerBounds = CopyParameterized(element, kAXBoundsForTextMarkerRangeParameterizedAttribute, markerRange);
      output.selectionBounds = ReadRect(markerBounds);
      if (markerBounds) CFRelease(markerBounds);
      CFRelease(markerRange);
    }
  }

  if (textRef) CFRelease(textRef);
  if (rangeRef) CFRelease(rangeRef);
  if (!output.text.empty()) {
    output.elementToken = std::to_string(CFHash(element));
    output.element = element;
    CFRetain(element);
  }
  return output;
}

SelectionInfo FindSelection(AXUIElementRef appElement, const std::string &expected = "") {
  for (bool expand : {false, true}) {
    SelectionInfo found;
    std::vector<AXUIElementRef> candidates = CandidateElements(appElement, expand);
    for (AXUIElementRef element : candidates) {
      SelectionInfo candidate = ReadSelection(element);
      if (!candidate.text.empty() && (expected.empty() || candidate.text == expected)) {
        found = candidate;
        break;
      }
      if (candidate.element) CFRelease(candidate.element);
    }
    for (AXUIElementRef element : candidates) CFRelease(element);
    if (found.element) return found;
  }
  return SelectionInfo();
}

AXUIElementRef FindElementForTextRange(AXUIElementRef appElement,
                                       const RangeValue &range,
                                       const std::string &expected,
                                       const std::string &elementToken) {
  if (!range.valid || (expected.empty() && range.length != 0) || elementToken.empty()) return nullptr;
  CFRange value = CFRangeMake(range.location, range.length);
  AXValueRef rangeValue = AXValueCreate(
    static_cast<AXValueType>(kAXValueCFRangeType), &value);
  if (!rangeValue) return nullptr;

  AXUIElementRef found = nullptr;
  for (bool expand : {false, true}) {
    std::vector<AXUIElementRef> candidates = CandidateElements(appElement, expand);
    for (AXUIElementRef element : candidates) {
      if (!IsRangeSettable(element)) continue;
      if (std::to_string(CFHash(element)) != elementToken) continue;
      CFTypeRef textRef = CopyParameterized(
        element, kAXStringForRangeParameterizedAttribute, rangeValue);
      const std::string text = ToUtf8(textRef);
      const bool rangeExists = textRef != nullptr;
      if (textRef) CFRelease(textRef);
      if (rangeExists && text == expected) {
        found = element;
        CFRetain(found);
        break;
      }
    }
    for (AXUIElementRef element : candidates) CFRelease(element);
    if (found) break;
  }
  CFRelease(rangeValue);
  return found;
}

napi_value RangeObject(napi_env env, const RangeValue &range) {
  if (!range.valid) return Null(env);
  napi_value object;
  napi_create_object(env, &object);
  Set(env, object, "location", Number(env, range.location));
  Set(env, object, "length", Number(env, range.length));
  return object;
}

napi_value RectObject(napi_env env, const RectValue &rect) {
  if (!rect.valid) return Null(env);
  napi_value object;
  napi_create_object(env, &object);
  Set(env, object, "x", Number(env, rect.rect.origin.x));
  Set(env, object, "y", Number(env, rect.rect.origin.y));
  Set(env, object, "width", Number(env, rect.rect.size.width));
  Set(env, object, "height", Number(env, rect.rect.size.height));
  return object;
}

napi_value Probe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double selfPidNumber = -1;
  if (argc > 0) napi_get_value_double(env, argv[0], &selfPidNumber);

  @autoreleasepool {
    bool trusted = AXIsProcessTrusted();
    NSRunningApplication *frontmost = [[NSWorkspace sharedWorkspace] frontmostApplication];
    pid_t frontPid = frontmost ? frontmost.processIdentifier : 0;
    NSString *bundle = frontmost.bundleIdentifier ?: @"";
    NSString *ownBundle = [[NSBundle mainBundle] bundleIdentifier] ?: @"";

    napi_value result;
    napi_create_object(env, &result);
    Set(env, result, "trusted", Bool(env, trusted));
    Set(env, result, "frontmostPid", frontPid > 0 ? Number(env, frontPid) : Null(env));
    Set(env, result, "bundleIdentifier", String(env, bundle.UTF8String ?: ""));
    Set(env, result, "text", String(env, ""));
    Set(env, result, "selectionBounds", Null(env));
    Set(env, result, "elementBounds", Null(env));
    Set(env, result, "selectionRange", Null(env));
    Set(env, result, "supportsRangeEditing", Bool(env, false));

    if (!trusted || !frontmost) return result;
    bool isOwnBundle = ownBundle.length > 0
      && ([bundle isEqualToString:ownBundle]
        || [bundle hasPrefix:[ownBundle stringByAppendingString:@"."]]);
    if (frontPid == static_cast<pid_t>(selfPidNumber) || isOwnBundle) {
      Set(env, result, "text", String(env, "__SELF__"));
      return result;
    }

    AXUIElementRef appElement = AXUIElementCreateApplication(frontPid);
    SelectionInfo selection = FindSelection(appElement);
    // Word lazily exposes its document text areas. Request its advertised
    // accessibility tree before concluding that the selection has no geometry.
    if (selection.text.empty() && [bundle isEqualToString:@"com.microsoft.Word"]) {
      Boolean settable = false;
      if (AXUIElementIsAttributeSettable(appElement, CFSTR("AXEnhancedUserInterface"), &settable) == kAXErrorSuccess && settable) {
        AXUIElementSetAttributeValue(appElement, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
        if (selection.element) CFRelease(selection.element);
        selection = FindSelection(appElement);
      }
    }
    CFRelease(appElement);
    Set(env, result, "text", String(env, selection.text));
    Set(env, result, "selectionBounds", RectObject(env, selection.selectionBounds));
    Set(env, result, "elementBounds", RectObject(env, selection.elementBounds));
    Set(env, result, "selectionRange", RangeObject(env, selection.range));
    Set(env, result, "elementToken", String(env, selection.elementToken));
    Set(env, result, "supportsRangeEditing", Bool(env, selection.supportsRangeEditing));
    if (selection.element && !selection.text.empty()) capturedControl.remember(selection.element, frontPid);
    if (selection.element) CFRelease(selection.element);
    return result;
  }
}

napi_value SetSelection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value result;
  napi_create_object(env, &result);
  if (argc < 1 || !AXIsProcessTrusted()) {
    Set(env, result, "ok", Bool(env, false));
    Set(env, result, "error", String(env, "macOS 辅助功能权限不可用。"));
    return result;
  }

  napi_value request = argv[0];
  pid_t pid = static_cast<pid_t>(GetNumber(env, request, "frontmostPid", -1));
  std::string expected = GetString(env, request, "expectedText");
  std::string elementToken = GetString(env, request, "elementToken");
  napi_value original = Get(env, request, "selectionRange");
  RangeValue originalRange;
  originalRange.location = static_cast<CFIndex>(GetNumber(env, original, "location", -1));
  originalRange.length = static_cast<CFIndex>(GetNumber(env, original, "length", -1));
  originalRange.valid = originalRange.location >= 0 && originalRange.length >= 0;
  napi_value target = Get(env, request, "targetRange");
  CFIndex location = static_cast<CFIndex>(GetNumber(env, target, "location", -1));
  CFIndex length = static_cast<CFIndex>(GetNumber(env, target, "length", -1));
  if (pid <= 0 || location < 0 || length < 0) {
    Set(env, result, "ok", Bool(env, false));
    Set(env, result, "error", String(env, "缺少有效的原始选区信息。"));
    return result;
  }

  AXUIElementRef appElement = AXUIElementCreateApplication(pid);
  AXUIElementRef targetElement = FindElementForTextRange(appElement, originalRange, expected, elementToken);
  CFRelease(appElement);
  if (!targetElement) {
    Set(env, result, "ok", Bool(env, false));
    Set(env, result, "error", String(env, "原文选区已经变化，请重新选中文字。"));
    return result;
  }

  CFRange targetRange = CFRangeMake(location, length);
  AXValueRef rangeValue = AXValueCreate(static_cast<AXValueType>(kAXValueCFRangeType), &targetRange);
  AXError error = AXUIElementSetAttributeValue(targetElement, kAXSelectedTextRangeAttribute, rangeValue);
  CFRelease(rangeValue);
  CFRelease(targetElement);
  Set(env, result, "ok", Bool(env, error == kAXErrorSuccess));
  if (error != kAXErrorSuccess) {
    Set(env, result, "error", String(env, "当前编辑器不允许定位到这条修订。"));
  }
  return result;
}

// All calls below are read-only. In particular, geometry must never set the
// selection, raise a window, or activate an application to discover its bounds.
napi_value ReviewGeometry(napi_env env, napi_callback_info info) {
  using Clock = std::chrono::steady_clock;
  const auto deadline = Clock::now() + std::chrono::milliseconds(180);
  auto expired = [&]() { return Clock::now() >= deadline; };
  auto failure = [&](const char *reason) {
    napi_value result, rects;
    napi_create_object(env, &result);
    napi_create_array(env, &rects);
    Set(env, result, "ok", Bool(env, false));
    Set(env, result, "rects", rects);
    Set(env, result, "reason", String(env, reason));
    return result;
  };
  auto integer = [](double value) {
    return std::isfinite(value) && value >= 0 && value <= 2147483647
      && std::floor(value) == value;
  };
  auto positiveRect = [](const RectValue &value) {
    return value.valid && std::isfinite(value.rect.origin.x)
      && std::isfinite(value.rect.origin.y) && std::isfinite(value.rect.size.width)
      && std::isfinite(value.rect.size.height) && value.rect.size.width > 0
      && value.rect.size.height > 0;
  };
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) return failure("invalid-request");
  napi_valuetype requestType;
  napi_typeof(env, argv[0], &requestType);
  if (requestType != napi_object) return failure("invalid-request");
  const double pidNumber = GetNumber(env, argv[0], "frontmostPid");
  const std::string token = GetString(env, argv[0], "elementToken");
  const std::string expected = GetString(env, argv[0], "expectedText");
  napi_value selection = Get(env, argv[0], "selectionRange");
  const double start = GetNumber(env, selection, "location");
  const double length = GetNumber(env, selection, "length");
  napi_value ranges = Get(env, argv[0], "ranges");
  bool isArray = false;
  uint32_t count = 0;
  napi_is_array(env, ranges, &isArray);
  if (isArray) napi_get_array_length(env, ranges, &count);
  if (!integer(pidNumber) || pidNumber == 0 || token.empty() || token.size() > 32
      || !integer(start) || !integer(length) || length == 0 || length > 100000
      || !integer(start + length) || expected.empty() || expected.size() > 400000
      || !isArray || count == 0 || count > 32) return failure("invalid-request");
  struct RequestedRange { int id; CFRange range; };
  std::vector<RequestedRange> requested;
  std::unordered_set<int> ids;
  for (uint32_t index = 0; index < count; ++index) {
    napi_value item;
    napi_get_element(env, ranges, index, &item);
    double id = GetNumber(env, item, "id");
    double location = GetNumber(env, item, "location");
    double size = GetNumber(env, item, "length");
    if (!integer(id) || !ids.insert(static_cast<int>(id)).second
        || !integer(location) || !integer(size) || location < start
        || location + size > start + length) return failure("invalid-range");
    requested.push_back({static_cast<int>(id), CFRangeMake(location, size)});
  }

  @autoreleasepool {
    NSString *expectedString = [[NSString alloc] initWithBytes:expected.data()
      length:expected.size() encoding:NSUTF8StringEncoding];
    if (!expectedString || expectedString.length != static_cast<NSUInteger>(length)) {
      return failure("invalid-text-length");
    }
    if (!AXIsProcessTrusted()) return failure("accessibility-unavailable");
    pid_t pid = static_cast<pid_t>(pidNumber);
    if ([[NSWorkspace sharedWorkspace] frontmostApplication].processIdentifier != pid) {
      return failure("host-not-frontmost");
    }
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    // Each remote AX query has a short timeout as well as the total deadline.
    AXUIElementSetMessagingTimeout(application, 0.025f);
    CFTypeRef windowRef = CopyAttribute(application, kAXFocusedWindowAttribute);
    CFTypeRef focusRef = CopyAttribute(application, kAXFocusedUIElementAttribute);
    CFRelease(application);
    if (!windowRef || CFGetTypeID(windowRef) != AXUIElementGetTypeID()) {
      if (windowRef) CFRelease(windowRef);
      if (focusRef) CFRelease(focusRef);
      return failure("host-window-unavailable");
    }
    AXUIElementRef window = static_cast<AXUIElementRef>(windowRef);
    std::vector<AXUIElementRef> queue;
    std::unordered_set<CFHashCode> seen;
    AppendElement(queue, seen, static_cast<AXUIElementRef>(focusRef));
    AppendElement(queue, seen, window);
    if (focusRef) CFRelease(focusRef);
    AXUIElementRef target = nullptr;
    if (capturedControl.element && capturedControl.pid == pid
        && std::to_string(CFHash(capturedControl.element)) == token) {
      target = capturedControl.element;
      CFRetain(target);
    }
    for (size_t index = 0; !target && index < queue.size() && !expired(); ++index) {
      AXUIElementRef element = queue[index];
      AXUIElementSetMessagingTimeout(element, 0.025f);
      if (std::to_string(CFHash(element)) == token) {
        target = element;
        CFRetain(target);
        break;
      }
      if (queue.size() < 80 && !expired()) {
        AppendChildren(queue, seen, element, kAXSelectedChildrenAttribute, 80);
        AppendChildren(queue, seen, element, kAXContentsAttribute, 80);
        AppendChildren(queue, seen, element, kAXChildrenAttribute, 80);
      }
    }
    for (AXUIElementRef element : queue) CFRelease(element);
    if (!target) {
      CFRelease(window);
      return failure(expired() ? "geometry-timeout" : "source-element-unavailable");
    }
    AXUIElementSetMessagingTimeout(target, 0.025f);
    CFTypeRef minimized = CopyAttribute(window, kAXMinimizedAttribute);
    const bool isMinimized = minimized && CFEqual(minimized, kCFBooleanTrue);
    if (minimized) CFRelease(minimized);
    if (isMinimized) {
      CFRelease(target); CFRelease(window);
      return failure("source-not-visible");
    }
    auto finishFailure = [&](const char *reason) {
      CFRelease(target);
      CFRelease(window);
      return failure(reason);
    };
    auto textMatches = [&]() {
      CFRange range = CFRangeMake(start, length);
      AXValueRef value = AXValueCreate(static_cast<AXValueType>(kAXValueCFRangeType), &range);
      CFTypeRef text = CopyParameterized(target, kAXStringForRangeParameterizedAttribute, value);
      const bool matches = text && ToUtf8(text) == expected;
      if (text) CFRelease(text);
      CFRelease(value);
      return matches;
    };
    if (expired()) return finishFailure("geometry-timeout");
    if (!textMatches()) return finishFailure("source-text-changed");

    RectValue visible = ElementBounds(target);
    if (!positiveRect(visible)) return finishFailure("host-bounds-unavailable");
    // Intersect every container (including scroll views) through the focused
    // window: offscreen document coordinates must not produce floating marks.
    AXUIElementRef ancestor = target;
    CFRetain(ancestor);
    bool reachesWindow = false;
    for (int depth = 0; depth < 16 && !expired(); ++depth) {
      if (CFEqual(ancestor, window)) { reachesWindow = true; break; }
      CFTypeRef parent = CopyAttribute(ancestor, kAXParentAttribute);
      CFRelease(ancestor);
      ancestor = nullptr;
      if (!parent || CFGetTypeID(parent) != AXUIElementGetTypeID()) {
        if (parent) CFRelease(parent);
        break;
      }
      ancestor = static_cast<AXUIElementRef>(parent);
      AXUIElementSetMessagingTimeout(ancestor, 0.025f);
      RectValue bounds = ElementBounds(ancestor);
      if (positiveRect(bounds)) visible.rect = CGRectIntersection(visible.rect, bounds.rect);
    }
    if (ancestor) CFRelease(ancestor);
    if (expired()) return finishFailure("geometry-timeout");
    if (!reachesWindow) return finishFailure("source-window-changed");
    if (!positiveRect(visible) || CGRectIsNull(visible.rect)) return finishFailure("source-not-visible");

    napi_value rects;
    napi_create_array(env, &rects);
    uint32_t rectCount = 0;
    for (const auto &item : requested) {
      CFIndex cursor = item.range.location;
      const CFIndex end = cursor + item.range.length;
      if (item.range.length == 0) {
        AXValueRef caretValue = AXValueCreate(static_cast<AXValueType>(kAXValueCFRangeType), &item.range);
        CFTypeRef bounds = CopyParameterized(target, kAXBoundsForRangeParameterizedAttribute, caretValue);
        CFRelease(caretValue);
        RectValue caret = ReadRect(bounds);
        if (bounds) CFRelease(bounds);
        if (caret.valid && caret.rect.size.width == 0 && caret.rect.size.height > 0) caret.rect.size.width = 2;
        if (positiveRect(caret)) {
          caret.rect = CGRectIntersection(caret.rect, visible.rect);
          if (positiveRect(caret) && !CGRectIsNull(caret.rect)) {
            napi_value object = RectObject(env, caret);
            Set(env, object, "id", Number(env, item.id));
            napi_set_element(env, rects, rectCount++, object);
          }
        }
        continue;
      }
      while (cursor < end) {
        if (expired()) return finishFailure("geometry-timeout");
        if (rectCount >= 96) return finishFailure("geometry-limit");
        CFNumberRef indexValue = CFNumberCreate(nullptr, kCFNumberCFIndexType, &cursor);
        CFTypeRef line = CopyParameterized(target, kAXLineForIndexParameterizedAttribute, indexValue);
        CFRelease(indexValue);
        if (!line || CFGetTypeID(line) != CFNumberGetTypeID()) {
          if (line) CFRelease(line);
          return finishFailure("line-geometry-unavailable");
        }
        CFTypeRef lineRangeValue = CopyParameterized(target, kAXRangeForLineParameterizedAttribute, line);
        CFRelease(line);
        RangeValue lineRange = ReadRange(lineRangeValue);
        if (lineRangeValue) CFRelease(lineRangeValue);
        if (!lineRange.valid || lineRange.location > cursor || lineRange.length <= 0
            || lineRange.location > 2147483647 - lineRange.length
            || lineRange.location + lineRange.length <= cursor) {
          return finishFailure("line-geometry-unavailable");
        }
        CFIndex next = std::min(end, lineRange.location + lineRange.length);
        CFRange segment = CFRangeMake(cursor, next - cursor);
        AXValueRef segmentValue = AXValueCreate(static_cast<AXValueType>(kAXValueCFRangeType), &segment);
        CFTypeRef bounds = CopyParameterized(target, kAXBoundsForRangeParameterizedAttribute, segmentValue);
        CFRelease(segmentValue);
        RectValue rect = ReadRect(bounds);
        if (bounds) CFRelease(bounds);
        if (!positiveRect(rect)) return finishFailure("range-geometry-unavailable");
        rect.rect = CGRectIntersection(rect.rect, visible.rect);
        if (positiveRect(rect) && !CGRectIsNull(rect.rect)) {
          napi_value object = RectObject(env, rect);
          Set(env, object, "id", Number(env, item.id));
          napi_set_element(env, rects, rectCount++, object);
        }
        cursor = next;
      }
    }
    // Revalidate after querying: document edits or app switches mid-query must
    // discard all coordinates, never leave a partly stale result visible.
    if (expired()) return finishFailure("geometry-timeout");
    if ([[NSWorkspace sharedWorkspace] frontmostApplication].processIdentifier != pid) {
      return finishFailure("host-not-frontmost");
    }
    if (!textMatches()) return finishFailure("source-text-changed");
    if (expired()) return finishFailure("geometry-timeout");
    if (rectCount == 0) return finishFailure("source-not-visible");
    CFRelease(target);
    CFRelease(window);
    napi_value result;
    napi_create_object(env, &result);
    Set(env, result, "ok", Bool(env, true));
    Set(env, result, "rects", rects);
    Set(env, result, "frontmostPid", Number(env, pid));
    Set(env, result, "elementToken", String(env, token));
    return result;
  }
}

napi_value ApplyReviewEdit(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_object(env, &result);
  auto fail = [&](const char *reason, bool mayHaveChanged = false) {
    Set(env, result, "ok", Bool(env, false));
    Set(env, result, "reason", String(env, reason));
    Set(env, result, "sourceMayHaveChanged", Bool(env, mayHaveChanged));
    return result;
  };
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 2) return fail("invalid-request");
  napi_valuetype replacementType;
  napi_typeof(env, argv[1], &replacementType);
  if (replacementType != napi_string) return fail("invalid-replacement");
  napi_value holder;
  napi_create_object(env, &holder);
  Set(env, holder, "replacement", argv[1]);
  std::string replacement = GetString(env, holder, "replacement");
  std::string expected = GetString(env, argv[0], "expectedText");
  std::string token = GetString(env, argv[0], "elementToken");
  const double pidValue = GetNumber(env, argv[0], "frontmostPid");
  napi_value original = Get(env, argv[0], "selectionRange");
  napi_value requested = Get(env, argv[0], "targetRange");
  const double location = GetNumber(env, original, "location");
  const double length = GetNumber(env, original, "length");
  const double targetLocation = GetNumber(env, requested, "location");
  const double targetLength = GetNumber(env, requested, "length");
  for (double number : {pidValue, location, length, targetLocation, targetLength}) {
    if (!std::isfinite(number) || number < 0 || number > 2147483647
        || std::floor(number) != number) return fail("invalid-request");
  }
  if (pidValue == 0 || token.empty() || token.size() > 32 || length == 0 || length > 100000
      || location + length > 2147483647 || targetLocation < location
      || targetLocation + targetLength > location + length || expected.empty()
      || expected.size() > 400000 || replacement.size() > 400000) return fail("invalid-request");
  @autoreleasepool {
    NSString *expectedString = [[NSString alloc] initWithBytes:expected.data()
      length:expected.size() encoding:NSUTF8StringEncoding];
    NSString *replacementString = [[NSString alloc] initWithBytes:replacement.data()
      length:replacement.size() encoding:NSUTF8StringEncoding];
    if (!expectedString || !replacementString || expectedString.length != static_cast<NSUInteger>(length)) {
      return fail("invalid-text-length");
    }
    if (!AXIsProcessTrusted()) return fail("accessibility-unavailable");
    const pid_t pid = static_cast<pid_t>(pidValue);
    auto isFrontmost = [&]() {
      return [[NSWorkspace sharedWorkspace] frontmostApplication].processIdentifier == pid;
    };
    if (!isFrontmost()) return fail("host-not-frontmost");
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(application, 0.05f);
    CFTypeRef focus = CopyAttribute(application, kAXFocusedUIElementAttribute);
    CFRelease(application);
    if (!focus || CFGetTypeID(focus) != AXUIElementGetTypeID()) {
      if (focus) CFRelease(focus);
      return fail("source-element-unavailable");
    }
    AXUIElementRef target = static_cast<AXUIElementRef>(focus);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(300);
    for (int depth = 0; target && std::to_string(CFHash(target)) != token && depth < 12; ++depth) {
      if (std::chrono::steady_clock::now() >= deadline) break;
      AXUIElementSetMessagingTimeout(target, 0.05f);
      CFTypeRef parent = CopyAttribute(target, kAXParentAttribute);
      CFRelease(target);
      target = nullptr;
      if (parent && CFGetTypeID(parent) == AXUIElementGetTypeID()) {
        target = static_cast<AXUIElementRef>(parent);
      } else if (parent) CFRelease(parent);
    }
    if (!target || std::to_string(CFHash(target)) != token) {
      if (target) CFRelease(target);
      return fail("source-element-unavailable");
    }
    AXUIElementSetMessagingTimeout(target, 0.05f);
    auto finishFailure = [&](const char *reason, bool mayHaveChanged = false) {
      CFRelease(target);
      return fail(reason, mayHaveChanged);
    };
    Boolean textSettable = false;
    if (!IsRangeSettable(target)
        || AXUIElementIsAttributeSettable(target, kAXSelectedTextAttribute, &textSettable) != kAXErrorSuccess
        || !textSettable) return finishFailure("direct-edit-unavailable");
    auto readText = [&](CFRange range) {
      AXValueRef value = AXValueCreate(static_cast<AXValueType>(kAXValueCFRangeType), &range);
      CFTypeRef text = CopyParameterized(target, kAXStringForRangeParameterizedAttribute, value);
      const std::string output = ToUtf8(text);
      if (text) CFRelease(text);
      CFRelease(value);
      return output;
    };
    CFRange sourceRange = CFRangeMake(location, length);
    if (readText(sourceRange) != expected) return finishFailure("source-text-changed");
    if (!isFrontmost()) return finishFailure("host-not-frontmost");
    CFRange editRange = CFRangeMake(targetLocation, targetLength);
    AXValueRef rangeValue = AXValueCreate(static_cast<AXValueType>(kAXValueCFRangeType), &editRange);
    AXError selectionError = AXUIElementSetAttributeValue(target, kAXSelectedTextRangeAttribute, rangeValue);
    CFRelease(rangeValue);
    if (selectionError != kAXErrorSuccess) return finishFailure("range-selection-failed");
    // Verify the setter landed on this exact range before touching its text.
    CFTypeRef actualRangeValue = CopyAttribute(target, kAXSelectedTextRangeAttribute);
    RangeValue actualRange = ReadRange(actualRangeValue);
    if (actualRangeValue) CFRelease(actualRangeValue);
    if (!actualRange.valid || actualRange.location != editRange.location || actualRange.length != editRange.length) {
      return finishFailure("range-selection-unverified");
    }
    if (!isFrontmost()) return finishFailure("host-not-frontmost");
    if (readText(sourceRange) != expected) return finishFailure("source-changed-before-edit");
    NSString *updated = [expectedString stringByReplacingCharactersInRange:
      NSMakeRange(targetLocation - location, targetLength) withString:replacementString];
    const std::string updatedText = updated.UTF8String ?: "";
    AXError editError = AXUIElementSetAttributeValue(target, kAXSelectedTextAttribute,
      (__bridge CFStringRef)replacementString);
    if (editError != kAXErrorSuccess) return finishFailure("direct-edit-failed", true);
    CFRange updatedRange = CFRangeMake(location, updated.length);
    if (readText(updatedRange) != updatedText) return finishFailure("edit-verification-failed", true);
    CFRelease(target);
    Set(env, result, "ok", Bool(env, true));
    Set(env, result, "updatedText", String(env, updatedText));
    RangeValue range;
    range.valid = true;
    range.location = updatedRange.location;
    range.length = updatedRange.length;
    Set(env, result, "selectionRange", RangeObject(env, range));
    return result;
  }
}

napi_value ClipboardChangeCount(napi_env env, napi_callback_info info) {
  (void)info;
  return Number(env, [[NSPasteboard generalPasteboard] changeCount]);
}

napi_value CopySelection(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  napi_create_object(env, &result);

  if (!AXIsProcessTrusted()) {
    Set(env, result, "ok", Bool(env, false));
    Set(env, result, "error", String(env, "macOS 辅助功能权限不可用。"));
    return result;
  }

  // Post Cmd+C directly through CoreGraphics. This uses the same stable
  // Accessibility identity as the app and avoids a separate System Events
  // Automation permission, which is unreliable in WPS/Qt editors.
  CGEventRef keyDown = CGEventCreateKeyboardEvent(nullptr, static_cast<CGKeyCode>(8), true);
  CGEventRef keyUp = CGEventCreateKeyboardEvent(nullptr, static_cast<CGKeyCode>(8), false);
  if (!keyDown || !keyUp) {
    if (keyDown) CFRelease(keyDown);
    if (keyUp) CFRelease(keyUp);
    Set(env, result, "ok", Bool(env, false));
    Set(env, result, "error", String(env, "无法生成 WPS 选区复制事件。"));
    return result;
  }

  CGEventSetFlags(keyDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(keyUp, kCGEventFlagMaskCommand);
  CGEventPost(kCGHIDEventTap, keyDown);
  CGEventPost(kCGHIDEventTap, keyUp);
  CFRelease(keyDown);
  CFRelease(keyUp);

  Set(env, result, "ok", Bool(env, true));
  return result;
}

napi_value SnapshotClipboard(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value snapshot;
  napi_create_array(env, &snapshot);
  uint32_t itemIndex = 0;
  for (NSPasteboardItem *item in [NSPasteboard generalPasteboard].pasteboardItems) {
    napi_value entries;
    napi_create_array(env, &entries);
    uint32_t entryIndex = 0;
    for (NSString *type in item.types) {
      NSData *data = [item dataForType:type];
      if (!data) continue;
      napi_value entry, buffer;
      napi_create_object(env, &entry);
      napi_create_buffer_copy(env, data.length, data.bytes, nullptr, &buffer);
      Set(env, entry, "type", String(env, type.UTF8String));
      Set(env, entry, "data", buffer);
      napi_set_element(env, entries, entryIndex++, entry);
    }
    napi_set_element(env, snapshot, itemIndex++, entries);
  }
  return snapshot;
}

napi_value RestoreClipboard(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t itemCount = 0;
  if (argc != 1 || napi_get_array_length(env, argv[0], &itemCount) != napi_ok) return Bool(env, false);
  NSMutableArray<NSPasteboardItem *> *items = [NSMutableArray array];
  for (uint32_t i = 0; i < itemCount; i++) {
    napi_value entries;
    napi_get_element(env, argv[0], i, &entries);
    uint32_t entryCount = 0;
    if (napi_get_array_length(env, entries, &entryCount) != napi_ok) return Bool(env, false);
    NSPasteboardItem *item = [[NSPasteboardItem alloc] init];
    for (uint32_t j = 0; j < entryCount; j++) {
      napi_value entry;
      napi_get_element(env, entries, j, &entry);
      std::string type = GetString(env, entry, "type");
      void *bytes = nullptr;
      size_t length = 0;
      if (type.empty() || napi_get_buffer_info(env, Get(env, entry, "data"), &bytes, &length) != napi_ok) return Bool(env, false);
      [item setData:[NSData dataWithBytes:bytes length:length] forType:[NSString stringWithUTF8String:type.c_str()]];
    }
    if (entryCount) [items addObject:item];
  }
  NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
  [pasteboard clearContents];
  return Bool(env, items.count == 0 || [pasteboard writeObjects:items]);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value probe;
  napi_value setSelection;
  napi_value copySelection;
  napi_create_function(env, "probe", NAPI_AUTO_LENGTH, Probe, nullptr, &probe);
  napi_create_function(env, "setSelection", NAPI_AUTO_LENGTH, SetSelection, nullptr, &setSelection);
  napi_create_function(env, "copySelection", NAPI_AUTO_LENGTH, CopySelection, nullptr, &copySelection);
  Set(env, exports, "probe", probe);
  Set(env, exports, "setSelection", setSelection);
  napi_value reviewGeometry;
  napi_create_function(env, "reviewGeometry", NAPI_AUTO_LENGTH, ReviewGeometry, nullptr, &reviewGeometry);
  Set(env, exports, "reviewGeometry", reviewGeometry);
  napi_value applyReviewEdit;
  napi_create_function(env, "applyReviewEdit", NAPI_AUTO_LENGTH, ApplyReviewEdit, nullptr, &applyReviewEdit);
  Set(env, exports, "applyReviewEdit", applyReviewEdit);
  Set(env, exports, "copySelection", copySelection);
  napi_value snapshotClipboard, restoreClipboard, clipboardChangeCount;
  napi_create_function(env, "snapshotClipboard", NAPI_AUTO_LENGTH, SnapshotClipboard, nullptr, &snapshotClipboard);
  napi_create_function(env, "restoreClipboard", NAPI_AUTO_LENGTH, RestoreClipboard, nullptr, &restoreClipboard);
  napi_create_function(env, "clipboardChangeCount", NAPI_AUTO_LENGTH, ClipboardChangeCount, nullptr, &clipboardChangeCount);
  Set(env, exports, "snapshotClipboard", snapshotClipboard);
  Set(env, exports, "restoreClipboard", restoreClipboard);
  Set(env, exports, "clipboardChangeCount", clipboardChangeCount);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
