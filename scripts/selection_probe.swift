import AppKit
import ApplicationServices
import Foundation

struct Bounds: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct SelectionRange: Codable {
  let location: Int
  let length: Int
}

struct Payload: Codable {
  let trusted: Bool
  let frontmostPid: Int32?
  let bundleIdentifier: String?
  let text: String
  let selectionBounds: Bounds?
  let elementBounds: Bounds?
  let selectionRange: SelectionRange?
  let supportsRangeEditing: Bool
}

struct SetSelectionRequest: Codable {
  let bundleIdentifier: String?
  let frontmostPid: Int32?
  let expectedText: String?
  let selectionRange: SelectionRange
  let targetRange: SelectionRange
}

struct CommandResult: Codable {
  let ok: Bool
  let error: String?
}

struct SelectionInfo {
  let text: String
  let selectionBounds: Bounds?
  let elementBounds: Bounds?
  let selectionRange: SelectionRange?
  let supportsRangeEditing: Bool
}

func writeJSON<T: Encodable>(_ payload: T) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(payload) else { return }
  FileHandle.standardOutput.write(data)
}

func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(element, attribute, &value)
  guard result == .success else { return nil }
  return value
}

func rangeValue(_ range: SelectionRange) -> AXValue? {
  var cfRange = CFRange(location: range.location, length: range.length)
  return AXValueCreate(.cfRange, &cfRange)
}

func selectionRange(from ref: CFTypeRef?) -> SelectionRange? {
  guard
    let ref,
    CFGetTypeID(ref) == AXValueGetTypeID()
  else {
    return nil
  }

  let value = unsafeBitCast(ref, to: AXValue.self)
  var cfRange = CFRange()

  guard
    AXValueGetType(value) == .cfRange,
    AXValueGetValue(value, .cfRange, &cfRange),
    cfRange.location >= 0,
    cfRange.length >= 0
  else {
    return nil
  }

  return SelectionRange(location: cfRange.location, length: cfRange.length)
}

func textForRange(_ element: AXUIElement, _ range: SelectionRange) -> String? {
  guard let parameter = rangeValue(range) else {
    return nil
  }

  return copyParameterizedAttribute(
    element,
    kAXStringForRangeParameterizedAttribute as CFString,
    parameter
  ) as? String
}

func supportsRangeEditing(_ element: AXUIElement) -> Bool {
  var settable = DarwinBoolean(false)
  let result = AXUIElementIsAttributeSettable(
    element,
    kAXSelectedTextRangeAttribute as CFString,
    &settable
  )
  return result == .success && settable.boolValue
}

func setSelectedTextRange(_ element: AXUIElement, _ range: SelectionRange) -> Bool {
  guard let value = rangeValue(range) else {
    return false
  }

  let result = AXUIElementSetAttributeValue(
    element,
    kAXSelectedTextRangeAttribute as CFString,
    value
  )
  return result == .success
}

func copyParameterizedAttribute(
  _ element: AXUIElement,
  _ attribute: CFString,
  _ parameter: CFTypeRef
) -> CFTypeRef? {
  var value: CFTypeRef?
  let result = AXUIElementCopyParameterizedAttributeValue(element, attribute, parameter, &value)
  guard result == .success else { return nil }
  return value
}

func elementBounds(_ element: AXUIElement) -> Bounds? {
  guard
    let positionRef = copyAttribute(element, kAXPositionAttribute as CFString),
    let sizeRef = copyAttribute(element, kAXSizeAttribute as CFString),
    CFGetTypeID(positionRef) == AXValueGetTypeID(),
    CFGetTypeID(sizeRef) == AXValueGetTypeID()
  else {
    return nil
  }

  let positionValue = unsafeBitCast(positionRef, to: AXValue.self)
  let sizeValue = unsafeBitCast(sizeRef, to: AXValue.self)

  var position = CGPoint.zero
  var size = CGSize.zero

  guard
    AXValueGetType(positionValue) == .cgPoint,
    AXValueGetValue(positionValue, .cgPoint, &position),
    AXValueGetType(sizeValue) == .cgSize,
    AXValueGetValue(sizeValue, .cgSize, &size)
  else {
    return nil
  }

  return Bounds(
    x: Double(position.x),
    y: Double(position.y),
    width: Double(size.width),
    height: Double(size.height)
  )
}

func boundsForRange(_ element: AXUIElement, _ rangeRef: CFTypeRef) -> Bounds? {
  guard
    let boundsRef = copyParameterizedAttribute(
      element,
      kAXBoundsForRangeParameterizedAttribute as CFString,
      rangeRef
    ),
    CFGetTypeID(boundsRef) == AXValueGetTypeID()
  else {
    return nil
  }

  let boundsValue = unsafeBitCast(boundsRef, to: AXValue.self)
  var rect = CGRect.zero

  guard
    AXValueGetType(boundsValue) == .cgRect,
    AXValueGetValue(boundsValue, .cgRect, &rect)
  else {
    return nil
  }

  return Bounds(
    x: Double(rect.origin.x),
    y: Double(rect.origin.y),
    width: Double(rect.size.width),
    height: Double(rect.size.height)
  )
}

func boundsForTextMarkerRange(_ element: AXUIElement, _ markerRangeRef: CFTypeRef) -> Bounds? {
  guard
    let boundsRef = copyParameterizedAttribute(
      element,
      kAXBoundsForTextMarkerRangeParameterizedAttribute as CFString,
      markerRangeRef
    ),
    CFGetTypeID(boundsRef) == AXValueGetTypeID()
  else {
    return nil
  }

  let boundsValue = unsafeBitCast(boundsRef, to: AXValue.self)
  var rect = CGRect.zero

  guard
    AXValueGetType(boundsValue) == .cgRect,
    AXValueGetValue(boundsValue, .cgRect, &rect)
  else {
    return nil
  }

  return Bounds(
    x: Double(rect.origin.x),
    y: Double(rect.origin.y),
    width: Double(rect.size.width),
    height: Double(rect.size.height)
  )
}

func parentElement(of element: AXUIElement) -> AXUIElement? {
  guard
    let parentRef = copyAttribute(element, kAXParentAttribute as CFString),
    CFGetTypeID(parentRef) == AXUIElementGetTypeID()
  else {
    return nil
  }

  return unsafeBitCast(parentRef, to: AXUIElement.self)
}

func windowElement(of appElement: AXUIElement) -> AXUIElement? {
  guard
    let windowRef = copyAttribute(appElement, kAXFocusedWindowAttribute as CFString),
    CFGetTypeID(windowRef) == AXUIElementGetTypeID()
  else {
    return nil
  }

  return unsafeBitCast(windowRef, to: AXUIElement.self)
}

func selectionFromTextMarkerRange(_ element: AXUIElement) -> SelectionInfo? {
  guard
    let markerRangeRef = copyAttribute(element, kAXSelectedTextMarkerRangeAttribute as CFString)
  else {
    return nil
  }

  let text = (copyParameterizedAttribute(
    element,
    kAXStringForTextMarkerRangeParameterizedAttribute as CFString,
    markerRangeRef
  ) as? String) ?? ""

  guard !text.isEmpty else {
    return nil
  }

  return SelectionInfo(
    text: text,
    selectionBounds: boundsForTextMarkerRange(element, markerRangeRef),
    elementBounds: elementBounds(element),
    selectionRange: nil,
    supportsRangeEditing: false
  )
}

func childElements(of element: AXUIElement, attribute: CFString) -> [AXUIElement] {
  guard let value = copyAttribute(element, attribute) else {
    return []
  }

  return (value as? [AXUIElement]) ?? []
}

func descendantCandidates(from root: AXUIElement, maxDepth: Int = 8, maxNodes: Int = 400) -> [AXUIElement] {
  var results: [AXUIElement] = []
  var queue: [(AXUIElement, Int)] = [(root, 0)]
  var index = 0
  var seen = Set<CFHashCode>([CFHash(root)])

  while index < queue.count && results.count < maxNodes {
    let (element, depth) = queue[index]
    index += 1

    if depth >= maxDepth {
      continue
    }

    // Search multiple child attributes for broader compatibility (Qt/WPS/etc.)
    let childAttrs: [CFString] = [
      kAXSelectedChildrenAttribute as CFString,
      kAXChildrenAttribute as CFString,
      kAXContentsAttribute as CFString,
    ]

    for attr in childAttrs {
      let children = childElements(of: element, attribute: attr)
      for child in children {
        let hash = CFHash(child)
        if seen.contains(hash) {
          continue
        }

        seen.insert(hash)
        results.append(child)
        queue.append((child, depth + 1))

        if results.count >= maxNodes {
          break
        }
      }
      if results.count >= maxNodes {
        break
      }
    }
  }

  return results
}

func selectedTextAndBounds(from element: AXUIElement) -> SelectionInfo {
  let focusedBounds = elementBounds(element)
  let selectedText = copyAttribute(element, kAXSelectedTextAttribute as CFString) as? String
  let rangeRef = copyAttribute(element, kAXSelectedTextRangeAttribute as CFString)
  let selectedRange = selectionRange(from: rangeRef)
  let canEditRange = selectedRange != nil && supportsRangeEditing(element)

  if let text = selectedText, !text.isEmpty {
    return SelectionInfo(
      text: text,
      selectionBounds: rangeRef != nil ? boundsForRange(element, rangeRef!) : nil,
      elementBounds: focusedBounds,
      selectionRange: selectedRange,
      supportsRangeEditing: canEditRange
    )
  }

  if let markerSelection = selectionFromTextMarkerRange(element) {
    return markerSelection
  }

  guard let selectedRange, selectedRange.length > 0 else {
    return SelectionInfo(
      text: "",
      selectionBounds: nil,
      elementBounds: focusedBounds,
      selectionRange: nil,
      supportsRangeEditing: false
    )
  }

  let text = textForRange(element, selectedRange) ?? ""
  return SelectionInfo(
    text: text,
    selectionBounds: rangeRef != nil ? boundsForRange(element, rangeRef!) : nil,
    elementBounds: focusedBounds,
    selectionRange: selectedRange,
    supportsRangeEditing: canEditRange
  )
}

func candidateElements(focusedElement: AXUIElement, appElement: AXUIElement) -> [AXUIElement] {
  var elements: [AXUIElement] = []
  var seen = Set<CFHashCode>()

  func appendIfNeeded(_ element: AXUIElement?) {
    guard let element else { return }
    let hash = CFHash(element)
    guard !seen.contains(hash) else { return }
    seen.insert(hash)
    elements.append(element)
  }

  appendIfNeeded(focusedElement)

  var currentParent = parentElement(of: focusedElement)
  var depth = 0
  while depth < 10 {
    appendIfNeeded(currentParent)
    currentParent = currentParent.flatMap(parentElement)
    depth += 1
  }

  let focusedWindow = windowElement(of: appElement)
  appendIfNeeded(focusedWindow)
  appendIfNeeded(appElement)

  if let focusedWindow {
    for candidate in descendantCandidates(from: focusedWindow) {
      appendIfNeeded(candidate)
    }
  }

  // Search all windows (WPS/Qt apps may use non-focused window hierarchies)
  let allWindows = childElements(of: appElement, attribute: kAXWindowsAttribute as CFString)
  for window in allWindows {
    appendIfNeeded(window)
    for candidate in descendantCandidates(from: window, maxDepth: 6, maxNodes: 200) {
      appendIfNeeded(candidate)
    }
  }

  return elements
}

func decodeRequest<T: Decodable>(_ encoded: String, as type: T.Type) -> T? {
  guard let data = Data(base64Encoded: encoded) else {
    return nil
  }
  return try? JSONDecoder().decode(T.self, from: data)
}

func resolveFrontmostApp(selfPid: Int32) -> (NSRunningApplication?, Bool) {
  let trusted = AXIsProcessTrusted()
  guard trusted else {
    return (nil, false)
  }
  return (NSWorkspace.shared.frontmostApplication, true)
}

func writeProbePayload(selfPid: Int32) {
  let resolved = resolveFrontmostApp(selfPid: selfPid)
  guard resolved.1 else {
    writeJSON(Payload(
      trusted: false,
      frontmostPid: nil,
      bundleIdentifier: nil,
      text: "",
      selectionBounds: nil,
      elementBounds: nil,
      selectionRange: nil,
      supportsRangeEditing: false
    ))
    exit(0)
  }

  guard let frontmostApp = resolved.0 else {
    writeJSON(Payload(
      trusted: true,
      frontmostPid: nil,
      bundleIdentifier: nil,
      text: "",
      selectionBounds: nil,
      elementBounds: nil,
      selectionRange: nil,
      supportsRangeEditing: false
    ))
    exit(0)
  }

  let frontmostPid = frontmostApp.processIdentifier
  if frontmostPid == selfPid {
    writeJSON(Payload(
      trusted: true,
      frontmostPid: frontmostPid,
      bundleIdentifier: frontmostApp.bundleIdentifier,
      text: "__SELF__",
      selectionBounds: nil,
      elementBounds: nil,
      selectionRange: nil,
      supportsRangeEditing: false
    ))
    exit(0)
  }

  let appElement = AXUIElementCreateApplication(frontmostPid)
  guard
    let focusedRef = copyAttribute(appElement, kAXFocusedUIElementAttribute as CFString)
  else {
    writeJSON(Payload(
      trusted: true,
      frontmostPid: frontmostPid,
      bundleIdentifier: frontmostApp.bundleIdentifier,
      text: "",
      selectionBounds: nil,
      elementBounds: nil,
      selectionRange: nil,
      supportsRangeEditing: false
    ))
    exit(0)
  }

  let focusedElement = unsafeBitCast(focusedRef, to: AXUIElement.self)
  let candidates = candidateElements(focusedElement: focusedElement, appElement: appElement)

  var selectionInfo = SelectionInfo(
    text: "",
    selectionBounds: nil,
    elementBounds: nil,
    selectionRange: nil,
    supportsRangeEditing: false
  )

  for candidate in candidates {
    let result = selectedTextAndBounds(from: candidate)
    if !result.text.isEmpty {
      selectionInfo = result
      break
    }
  }

  writeJSON(Payload(
    trusted: true,
    frontmostPid: frontmostPid,
    bundleIdentifier: frontmostApp.bundleIdentifier,
    text: selectionInfo.text,
    selectionBounds: selectionInfo.selectionBounds,
    elementBounds: selectionInfo.elementBounds,
    selectionRange: selectionInfo.selectionRange,
    supportsRangeEditing: selectionInfo.supportsRangeEditing
  ))
  exit(0)
}

func handleSetSelection(selfPid: Int32, encodedRequest: String?) {
  let resolved = resolveFrontmostApp(selfPid: selfPid)
  guard resolved.1 else {
    writeJSON(CommandResult(ok: false, error: "未授予辅助功能权限。"))
    exit(0)
  }

  guard
    let encodedRequest,
    let request = decodeRequest(encodedRequest, as: SetSelectionRequest.self)
  else {
    writeJSON(CommandResult(ok: false, error: "原位修订请求无效。"))
    exit(0)
  }

  guard let frontmostApp = resolved.0 else {
    writeJSON(CommandResult(ok: false, error: "未找到前台应用。"))
    exit(0)
  }

  if let bundleIdentifier = request.bundleIdentifier, !bundleIdentifier.isEmpty,
     frontmostApp.bundleIdentifier != bundleIdentifier {
    writeJSON(CommandResult(ok: false, error: "原文窗口已切换，已停止原位修订。"))
    exit(0)
  }

  if let expectedPid = request.frontmostPid, expectedPid > 0,
     frontmostApp.processIdentifier != expectedPid,
     request.bundleIdentifier == nil || request.bundleIdentifier?.isEmpty == true {
    writeJSON(CommandResult(ok: false, error: "原文窗口已切换，已停止原位修订。"))
    exit(0)
  }

  let appElement = AXUIElementCreateApplication(frontmostApp.processIdentifier)
  guard
    let focusedRef = copyAttribute(appElement, kAXFocusedUIElementAttribute as CFString)
  else {
    writeJSON(CommandResult(ok: false, error: "未找到可编辑的文本控件。"))
    exit(0)
  }

  let focusedElement = unsafeBitCast(focusedRef, to: AXUIElement.self)
  let candidates = candidateElements(focusedElement: focusedElement, appElement: appElement)

  var targetElement: AXUIElement?
  for candidate in candidates {
    guard supportsRangeEditing(candidate) else {
      continue
    }

    guard let currentText = textForRange(candidate, request.selectionRange) else {
      continue
    }

    if let expectedText = request.expectedText, currentText != expectedText {
      continue
    }

    targetElement = candidate
    break
  }

  guard let targetElement else {
    writeJSON(CommandResult(ok: false, error: "原文内容已经变化，无法安全原位修订。"))
    exit(0)
  }

  guard setSelectedTextRange(targetElement, request.targetRange) else {
    writeJSON(CommandResult(ok: false, error: "当前应用不支持精确设置选区。"))
    exit(0)
  }

  writeJSON(CommandResult(ok: true, error: nil))
  exit(0)
}

let args = Array(CommandLine.arguments.dropFirst())
let selfPid = Int32(args.first ?? "") ?? -1
let command = args.count >= 2 ? args[1] : "probe"

switch command {
case "set-selection":
  handleSetSelection(selfPid: selfPid, encodedRequest: args.count >= 3 ? args[2] : nil)
default:
  writeProbePayload(selfPid: selfPid)
}
