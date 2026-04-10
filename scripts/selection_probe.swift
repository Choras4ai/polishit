import AppKit
import ApplicationServices
import Foundation

struct Bounds: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct Payload: Codable {
  let trusted: Bool
  let frontmostPid: Int32?
  let bundleIdentifier: String?
  let text: String
  let selectionBounds: Bounds?
  let elementBounds: Bounds?
}

func writeJSON(_ payload: Payload) {
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

func selectionFromTextMarkerRange(_ element: AXUIElement) -> (String, Bounds?)? {
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

  return (text, boundsForTextMarkerRange(element, markerRangeRef))
}

func childElements(of element: AXUIElement, attribute: CFString) -> [AXUIElement] {
  guard let value = copyAttribute(element, attribute) else {
    return []
  }

  return (value as? [AXUIElement]) ?? []
}

func descendantCandidates(from root: AXUIElement, maxDepth: Int = 5, maxNodes: Int = 160) -> [AXUIElement] {
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

    let selectedChildren = childElements(of: element, attribute: kAXSelectedChildrenAttribute as CFString)
    let children = childElements(of: element, attribute: kAXChildrenAttribute as CFString)

    for child in selectedChildren + children {
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
  }

  return results
}

func selectedTextAndBounds(from element: AXUIElement) -> (String, Bounds?, Bounds?) {
  let focusedBounds = elementBounds(element)
  let selectedText = copyAttribute(element, kAXSelectedTextAttribute as CFString) as? String
  let rangeRef = copyAttribute(element, kAXSelectedTextRangeAttribute as CFString)

  if let text = selectedText, !text.isEmpty {
    if let rangeRef {
      return (text, boundsForRange(element, rangeRef), focusedBounds)
    }
    return (text, nil, focusedBounds)
  }

  if let markerSelection = selectionFromTextMarkerRange(element) {
    return (markerSelection.0, markerSelection.1, focusedBounds)
  }

  guard
    let rangeRef,
    CFGetTypeID(rangeRef) == AXValueGetTypeID()
  else {
    return ("", nil, focusedBounds)
  }

  let rangeValue = unsafeBitCast(rangeRef, to: AXValue.self)
  var range = CFRange()

  guard
    AXValueGetType(rangeValue) == .cfRange,
    AXValueGetValue(rangeValue, .cfRange, &range),
    range.length > 0
  else {
    return ("", nil, focusedBounds)
  }

  let textRef = copyParameterizedAttribute(
    element,
    kAXStringForRangeParameterizedAttribute as CFString,
    rangeRef
  )

  let text = (textRef as? String) ?? ""
  return (text, boundsForRange(element, rangeRef), focusedBounds)
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
  while depth < 6 {
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

  return elements
}

let selfPid = Int32(CommandLine.arguments.dropFirst().first ?? "") ?? -1
let trusted = AXIsProcessTrusted()

guard trusted else {
  writeJSON(Payload(
    trusted: false,
    frontmostPid: nil,
    bundleIdentifier: nil,
    text: "",
    selectionBounds: nil,
    elementBounds: nil
  ))
  exit(0)
}

guard let frontmostApp = NSWorkspace.shared.frontmostApplication else {
  writeJSON(Payload(
    trusted: true,
    frontmostPid: nil,
    bundleIdentifier: nil,
    text: "",
    selectionBounds: nil,
    elementBounds: nil
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
    elementBounds: nil
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
    elementBounds: nil
  ))
  exit(0)
}

let focusedElement = unsafeBitCast(focusedRef, to: AXUIElement.self)
let candidates = candidateElements(focusedElement: focusedElement, appElement: appElement)

var text = ""
var selectionBounds: Bounds?
var elementBoundsValue: Bounds?

for candidate in candidates {
  let result = selectedTextAndBounds(from: candidate)
  if !result.0.isEmpty {
    text = result.0
    selectionBounds = result.1
    elementBoundsValue = result.2
    break
  }
}

writeJSON(Payload(
  trusted: true,
  frontmostPid: frontmostPid,
  bundleIdentifier: frontmostApp.bundleIdentifier,
  text: text,
  selectionBounds: selectionBounds,
  elementBounds: elementBoundsValue
))
