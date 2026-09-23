// Native macOS computer-use helper. It speaks the same line-delimited JSON protocol as
// computer-linux.py: screenshots come from ScreenCaptureKit and input is posted with CGEvent.
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Failure: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

let outputLock = NSLock()
func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  outputLock.lock()
  defer { outputLock.unlock() }
  FileHandle.standardOutput.write(data + Data([0x0a]))
}

final class Flag {
  private let lock = NSLock()
  private var value = false
  var isSet: Bool {
    get { lock.lock(); defer { lock.unlock() }; return value }
    set { lock.lock(); value = newValue; lock.unlock() }
  }
}

let paused = Flag()
let terminating = Flag()

func number(_ value: Any?, _ low: Double, _ high: Double, _ name: String) throws -> Double {
  guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { throw Failure("Invalid " + name) }
  let result = value.doubleValue
  guard result.isFinite, result >= low, result <= high else { throw Failure("Invalid " + name) }
  return result
}

// Sleeps in small steps so Pause (SIGUSR1) interrupts long actions promptly.
func rest(_ seconds: Double) throws {
  let deadline = Date().addingTimeInterval(seconds)
  while true {
    try checkpoint()
    let left = deadline.timeIntervalSinceNow
    if left <= 0 { return }
    usleep(useconds_t(min(left, 0.02) * 1_000_000))
  }
}

func checkpoint() throws {
  if terminating.isSet { throw Failure("Computer control was stopped.") }
  if paused.isSet { throw Failure("Computer control was paused.") }
}

func blocking<T>(_ body: @escaping () async throws -> T) throws -> T {
  let semaphore = DispatchSemaphore(value: 0)
  var result: Result<T, Error> = .failure(Failure("The screen could not be captured."))
  Task.detached {
    do { result = .success(try await body()) } catch { result = .failure(error) }
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 20) == .timedOut { throw Failure("The screen capture timed out.") }
  return try result.get()
}

func onMain<T>(_ body: () -> T) -> T {
  Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
}

func openPrivacySettings(_ anchor: String) {
  if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
    onMain { _ = NSWorkspace.shared.open(url) }
  }
}

func systemSupported() -> Bool {
  if #available(macOS 14.0, *) { return true }
  return false
}

struct Display {
  let id: String
  let displayID: CGDirectDisplayID
  let name: String
  let frame: CGRect
  let content: AnyObject
}

let modifierKeys: [String: (CGKeyCode, CGEventFlags)] = [
  "Control": (CGKeyCode(kVK_Control), .maskControl), "Ctrl": (CGKeyCode(kVK_Control), .maskControl),
  "Alt": (CGKeyCode(kVK_Option), .maskAlternate), "Option": (CGKeyCode(kVK_Option), .maskAlternate), "Opt": (CGKeyCode(kVK_Option), .maskAlternate),
  "Shift": (CGKeyCode(kVK_Shift), .maskShift),
  "Super": (CGKeyCode(kVK_Command), .maskCommand), "Meta": (CGKeyCode(kVK_Command), .maskCommand),
  "Command": (CGKeyCode(kVK_Command), .maskCommand), "Cmd": (CGKeyCode(kVK_Command), .maskCommand),
]

let namedKeys: [String: Int] = [
  "Enter": kVK_Return, "Return": kVK_Return, "Escape": kVK_Escape, "Tab": kVK_Tab, "Space": kVK_Space,
  "Backspace": kVK_Delete, "Delete": kVK_ForwardDelete, "Insert": kVK_Help,
  "ArrowUp": kVK_UpArrow, "ArrowDown": kVK_DownArrow, "ArrowLeft": kVK_LeftArrow, "ArrowRight": kVK_RightArrow,
  "Home": kVK_Home, "End": kVK_End, "PageUp": kVK_PageUp, "PageDown": kVK_PageDown,
  "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4, "F5": kVK_F5, "F6": kVK_F6, "F7": kVK_F7, "F8": kVK_F8,
  "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12, "F13": kVK_F13, "F14": kVK_F14, "F15": kVK_F15,
  "F16": kVK_F16, "F17": kVK_F17, "F18": kVK_F18, "F19": kVK_F19, "F20": kVK_F20,
]

// Maps characters to the key that produces them in the current keyboard layout, so shortcuts
// such as Command+Z press the key labelled Z on AZERTY and QWERTZ keyboards too.
func layoutKeys() -> [Character: (CGKeyCode, Bool)] {
  var table: [Character: (CGKeyCode, Bool)] = [:]
  onMain {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return }
    let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    data.withUnsafeBytes { raw in
      guard let layout = raw.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
      // Main keyboard keys win over the numeric keypad, even when they need Shift.
      let keypad = 0x41...0x5C
      let main = (0..<128).filter { !keypad.contains($0) }
      for (codes, shifted) in [(main, false), (main, true), (Array(keypad), false), (Array(keypad), true)] {
        for code in codes {
          var dead: UInt32 = 0
          var length = 0
          var characters = [UniChar](repeating: 0, count: 4)
          let modifiers = shifted ? UInt32((shiftKey >> 8) & 0xff) : 0
          let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), modifiers, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &characters)
          guard status == noErr, length == 1, let character = String(utf16CodeUnits: characters, count: length).first,
                character.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f }), table[character] == nil else { continue }
          table[character] = (CGKeyCode(code), shifted)
        }
      }
    }
  }
  return table
}

final class Controller {
  let source = CGEventSource(stateID: .hidSystemState)
  var control = false
  var displays: [Display] = []
  var cursor = CGPoint.zero
  var heldKeys: [CGKeyCode] = []
  var heldButtons: [String] = []
  lazy var keys = layoutKeys()

  func start(control: Bool) throws -> [[String: Any]] {
    guard #available(macOS 14.0, *) else { throw Failure("Computer use requires macOS 14 or later.") }
    if !CGPreflightScreenCaptureAccess() {
      _ = CGRequestScreenCaptureAccess()
      openPrivacySettings("Privacy_ScreenCapture")
      throw Failure("Allow Citropy in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen Citropy.")
    }
    if control && !CGPreflightPostEventAccess() {
      _ = CGRequestPostEventAccess()
      openPrivacySettings("Privacy_Accessibility")
      throw Failure("Allow Citropy in System Settings > Privacy & Security > Accessibility, then share the screen again.")
    }
    self.control = control
    let content = try blocking { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
    let names: [CGDirectDisplayID: String] = onMain {
      var result: [CGDirectDisplayID: String] = [:]
      for screen in NSScreen.screens {
        if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber { result[number.uint32Value] = screen.localizedName }
      }
      return result
    }
    let main = CGMainDisplayID()
    let sorted = content.displays.sorted { left, right in
      if (left.displayID == main) != (right.displayID == main) { return left.displayID == main }
      let a = CGDisplayBounds(left.displayID), b = CGDisplayBounds(right.displayID)
      return a.minX == b.minX ? a.minY < b.minY : a.minX < b.minX
    }
    displays = sorted.enumerated().map { index, display in
      Display(id: String(display.displayID), displayID: display.displayID, name: names[display.displayID] ?? "Screen \(index + 1)", frame: CGDisplayBounds(display.displayID), content: display)
    }
    if displays.isEmpty { throw Failure("No screen is available to share.") }
    if let location = CGEvent(source: nil)?.location { cursor = location }
    return displays.map { ["id": $0.id, "name": $0.name, "width": Int($0.frame.width.rounded()), "height": Int($0.frame.height.rounded()), "x": Int($0.frame.minX.rounded()), "y": Int($0.frame.minY.rounded())] }
  }

  func display(_ id: Any?) throws -> Display {
    guard let id = id as? String, let display = displays.first(where: { $0.id == id }) else { throw Failure("Choose one of the shared screens.") }
    if CGDisplayBounds(display.displayID) != display.frame {
      let reason = "The screen layout or resolution changed. Share the screen again before continuing."
      emit(["event": "closed", "reason": reason, "error": true])
      throw Failure(reason)
    }
    return display
  }

  func screenshot(_ displayId: Any?, maximum: Double, crop: Any?) throws -> [String: Any] {
    guard #available(macOS 14.0, *) else { throw Failure("Computer use requires macOS 14 or later.") }
    let display = try self.display(displayId)
    guard let content = display.content as? SCDisplay else { throw Failure("Choose one of the shared screens.") }
    let filter = SCContentFilter(display: content, excludingWindows: [])
    let scale = Double(filter.pointPixelScale)
    let width = display.frame.width * scale, height = display.frame.height * scale
    var left = 0.0, top = 0.0, right = width, bottom = height
    var bounds: [String: Double]?
    if let crop {
      guard let crop = crop as? [String: Any] else { throw Failure("Choose a screen region.") }
      let x = try number(crop["x"], 0, 1, "region x"), y = try number(crop["y"], 0, 1, "region y")
      let w = try number(crop["width"], 0, 1, "region width"), h = try number(crop["height"], 0, 1, "region height")
      if w <= 0 || h <= 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9 { throw Failure("The region must fit inside the screen.") }
      left = (x * width).rounded(.down)
      top = (y * height).rounded(.down)
      right = min(width, ((x + w) * width).rounded(.up))
      bottom = min(height, ((y + h) * height).rounded(.up))
      if right <= left || bottom <= top { throw Failure("The screen region is empty.") }
      bounds = ["x": left / width, "y": top / height, "width": (right - left) / width, "height": (bottom - top) / height]
    }
    let factor = min(1, maximum / (right - left), 1600 / (bottom - top))
    let configuration = SCStreamConfiguration()
    configuration.width = max(1, Int(((right - left) * factor).rounded()))
    configuration.height = max(1, Int(((bottom - top) * factor).rounded()))
    configuration.showsCursor = true
    configuration.captureResolution = .best
    if bounds != nil { configuration.sourceRect = CGRect(x: left / scale, y: top / scale, width: (right - left) / scale, height: (bottom - top) / scale) }
    let image = try blocking { try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { throw Failure("The screen image could not be encoded.") }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw Failure("The screen image could not be encoded.") }
    var result: [String: Any] = ["image": data.base64EncodedString(), "width": image.width, "height": image.height]
    if let bounds { result["crop"] = bounds }
    return result
  }

  func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
  }

  func move(_ point: CGPoint) {
    cursor = point
    let dragging = heldButtons.contains("left")
    post(CGEvent(mouseEventSource: source, mouseType: dragging ? .leftMouseDragged : .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
  }

  func button(_ name: String, pressed: Bool, clicks: Int64 = 1) {
    let (type, button): (CGEventType, CGMouseButton) = switch name {
    case "right": (pressed ? .rightMouseDown : .rightMouseUp, .right)
    case "middle": (pressed ? .otherMouseDown : .otherMouseUp, .center)
    default: (pressed ? .leftMouseDown : .leftMouseUp, .left)
    }
    if pressed { heldButtons.append(name) }
    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: cursor, mouseButton: button)
    event?.setIntegerValueField(.mouseEventClickState, value: clicks)
    post(event)
    if !pressed, let index = heldButtons.lastIndex(of: name) { heldButtons.remove(at: index) }
  }

  func key(_ code: CGKeyCode, pressed: Bool, flags: CGEventFlags) {
    if pressed { heldKeys.append(code) }
    let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: pressed)
    event?.flags = flags
    post(event)
    if !pressed, let index = heldKeys.lastIndex(of: code) { heldKeys.remove(at: index) }
  }

  func resolve(_ name: String) throws -> (CGKeyCode, Bool) {
    if let code = namedKeys[name] { return (CGKeyCode(code), false) }
    if name == "PrintScreen" { throw Failure("macOS has no Print Screen key. Use Command+Shift+3 or Command+Shift+4.") }
    let text = name == "Plus" ? "+" : name == "Minus" ? "-" : name.count == 1 ? name.lowercased() : ""
    if let character = text.first, text.count == 1, character.isASCII, let entry = keys[character] { return entry }
    throw Failure("Unknown key: " + name)
  }

  func press(_ names: [String]) throws {
    var modifiers: [(CGKeyCode, CGEventFlags)] = []
    var main: [(CGKeyCode, Bool)] = []
    for name in names {
      if let modifier = modifierKeys[name] { modifiers.append(modifier) } else { main.append(try resolve(name)) }
    }
    if main.contains(where: { $0.1 }) && !modifiers.contains(where: { $0.1 == .maskShift }) { modifiers.append(modifierKeys["Shift"]!) }
    var flags: CGEventFlags = []
    var held: [(CGKeyCode, CGEventFlags)] = []
    defer {
      for (code, _) in main.reversed() where heldKeys.contains(code) { key(code, pressed: false, flags: flags) }
      for (code, flag) in held.reversed() { flags.remove(flag); key(code, pressed: false, flags: flags) }
    }
    for (code, flag) in modifiers {
      flags.insert(flag)
      key(code, pressed: true, flags: flags)
      held.append((code, flag))
    }
    for (code, _) in main { key(code, pressed: true, flags: flags) }
    usleep(25_000)
  }

  func type(_ text: String) throws {
    for character in text {
      try checkpoint()
      if character == "\n" || character == "\r\n" || character == "\t" {
        let code = CGKeyCode(character == "\t" ? kVK_Tab : kVK_Return)
        key(code, pressed: true, flags: [])
        key(code, pressed: false, flags: [])
      } else {
        let units = Array(String(character).utf16)
        let (code, shifted) = keys[character] ?? (0, false)
        for pressed in [true, false] {
          let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: pressed)
          event?.flags = shifted ? .maskShift : []
          event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
          post(event)
        }
      }
      usleep(8_000)
    }
  }

  func scroll(dx: Double, dy: Double) throws {
    var x = dx, y = dy
    while abs(x) >= 1 || abs(y) >= 1 {
      try checkpoint()
      let stepX = max(-120, min(120, x)), stepY = max(-120, min(120, y))
      post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(-stepY.rounded()), wheel2: Int32(-stepX.rounded()), wheel3: 0))
      x -= stepX
      y -= stepY
      usleep(12_000)
    }
  }

  func act(_ data: [String: Any]) throws {
    if !control { throw Failure("This session only allows viewing the screen.") }
    let action = data["action"] as? String
    var display: Display?
    var x = 0.0, y = 0.0
    if ["move", "click", "drag", "scroll"].contains(action) {
      let current = try self.display(data["displayId"])
      display = current
      x = try number(data["x"], 0, current.frame.width - 1, "x")
      y = try number(data["y"], 0, current.frame.height - 1, "y")
      move(CGPoint(x: current.frame.minX + x, y: current.frame.minY + y))
      if action != "move" { usleep(15_000) }
    }
    switch action {
    case "click":
      let button = data["button"] as? String ?? "left"
      if !["left", "middle", "right"].contains(button) { throw Failure("Unknown mouse button") }
      let count = try number(data["count"] ?? 1, 1, 3, "click count")
      if count.rounded() != count { throw Failure("Use a whole click count") }
      for index in 1...Int(count) {
        self.button(button, pressed: true, clicks: Int64(index))
        usleep(25_000)
        self.button(button, pressed: false, clicks: Int64(index))
        usleep(60_000)
      }
    case "drag":
      guard let display else { break }
      let targetX = try number(data["toX"], 0, display.frame.width - 1, "target x")
      let targetY = try number(data["toY"], 0, display.frame.height - 1, "target y")
      let duration = try number(data["durationMs"] ?? 500, 100, 3000, "drag duration") / 1000
      let steps = max(2, Int((duration * 40).rounded()))
      defer { if heldButtons.contains("left") { button("left", pressed: false) } }
      button("left", pressed: true)
      usleep(40_000)
      for index in 1...steps {
        try rest(duration / Double(steps))
        let progress = Double(index) / Double(steps)
        move(CGPoint(x: display.frame.minX + x + (targetX - x) * progress, y: display.frame.minY + y + (targetY - y) * progress))
      }
    case "scroll":
      try scroll(dx: try number(data["deltaX"] ?? 0, -4800, 4800, "horizontal scroll"), dy: try number(data["deltaY"] ?? 0, -4800, 4800, "vertical scroll"))
    case "press":
      guard let value = data["key"] as? String, value.count <= 100 else { throw Failure("Provide a key or shortcut") }
      let names = value.components(separatedBy: "+")
      if names.count > 5 || Set(names).count != names.count { throw Failure("Invalid shortcut") }
      for name in names where modifierKeys[name] == nil { _ = try resolve(name) }
      try press(names)
    case "type":
      guard let text = data["text"] as? String, !text.isEmpty, text.count <= 4000,
            !text.unicodeScalars.contains(where: { $0.value < 32 && $0 != "\t" && $0 != "\n" }) else {
        throw Failure("Type between 1 and 4,000 characters without control codes.")
      }
      try type(text)
    case "wait":
      try rest(try number(data["durationMs"] ?? 500, 0, 5000, "wait duration") / 1000)
    case "move":
      break
    default:
      throw Failure("Unknown computer action")
    }
  }

  func release() {
    for code in heldKeys.reversed() {
      let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
      event?.flags = []
      post(event)
    }
    heldKeys.removeAll()
    for name in heldButtons.reversed() { button(name, pressed: false) }
    heldButtons.removeAll()
  }
}

func probe() -> [String: Any] {
  guard systemSupported() else { return ["available": false, "platform": "darwin", "backend": "unavailable", "reason": "Computer use requires macOS 14 or later."] }
  let screen = CGPreflightScreenCaptureAccess(), input = CGPreflightPostEventAccess()
  var result: [String: Any] = ["available": true, "platform": "darwin", "backend": "macos", "screenRecording": screen, "accessibility": input]
  if !screen || !input {
    result["reason"] = "Share a screen once to request \(screen ? "Accessibility" : input ? "Screen Recording" : "Screen Recording and Accessibility") access for Citropy in System Settings > Privacy & Security."
  }
  return result
}

if CommandLine.arguments.contains("--probe") {
  emit(probe())
  exit(0)
}

let controller = Controller()
let lock = NSLock()
var started = false
let signals = DispatchQueue(label: "citropy.computer.signals")
var sources: [DispatchSourceSignal] = []
for code in [SIGUSR1, SIGTERM, SIGINT] {
  signal(code, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: code, queue: signals)
  source.setEventHandler {
    if code == SIGUSR1 { paused.isSet = true; return }
    terminating.isSet = true
    lock.lock()
    controller.release()
    exit(0)
  }
  source.resume()
  sources.append(source)
}

Thread {
  defer {
    terminating.isSet = true
    lock.lock()
    controller.release()
    exit(0)
  }
  while let line = readLine(strippingNewline: true) {
    if line.utf8.count > 100_000 {
      emit(["event": "closed", "reason": "Computer input exceeded the request limit.", "error": true])
      return
    }
    guard !line.isEmpty else { continue }
    var request: [String: Any] = [:]
    lock.lock()
    do {
      guard let parsed = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { throw Failure("Invalid request") }
      request = parsed
      let method = request["method"] as? String
      let data = request["params"] as? [String: Any] ?? [:]
      var result: Any
      if method == "start" {
        if started { throw Failure("A computer session is already open.") }
        let displays = try controller.start(control: (data["control"] as? Bool) == true)
        started = true
        result = ["displays": displays, "backend": "macos"]
      } else if !started {
        throw Failure("Start a computer session first.")
      } else if method == "screenshot" {
        result = try controller.screenshot(data["displayId"], maximum: try number(data["maxWidth"] ?? 1600, 320, 2560, "image width"), crop: data["crop"])
      } else if method == "action" {
        if paused.isSet { throw Failure("Computer control is paused.") }
        try controller.act(data)
        result = ["ok": true]
      } else if method == "pause" {
        paused.isSet = (data["paused"] as? Bool) == true
        result = ["paused": paused.isSet]
      } else if method == "stop" {
        lock.unlock()
        return
      } else {
        throw Failure("Unknown computer operation")
      }
      emit(["id": request["id"] ?? NSNull(), "result": result])
    } catch let failure as Failure {
      emit(["id": request["id"] ?? NSNull(), "error": failure.message])
    } catch {
      emit(["id": request["id"] ?? NSNull(), "error": error.localizedDescription])
    }
    lock.unlock()
  }
}.start()

dispatchMain()
