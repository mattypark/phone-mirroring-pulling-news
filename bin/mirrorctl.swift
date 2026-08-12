// mirrorctl — the only native piece of phone-mirroring-pulling-news.
//
// Finds the iPhone Mirroring window, screenshots it, and posts scroll/tap/swipe
// events into it. Everything else in this project is Node.
//
// Safety property: no event-posting subcommand will fire unless iPhone Mirroring is
// the frontmost application. A stray scroll landing in Xcode or Messages is the exact
// failure this guard exists to prevent.
//
// Build:  swiftc bin/mirrorctl.swift -o bin/mirrorctl   (or scripts/build.sh)

import AppKit
import CoreGraphics
import Foundation

let kAppName = "iPhone Mirroring"

// MARK: - Exit helpers

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(("mirrorctl: " + message + "\n").data(using: .utf8)!)
    exit(code)
}

let usage = """
mirrorctl — drive the macOS iPhone Mirroring window

USAGE
  mirrorctl winid                       print the window id, or exit 1 if not found
  mirrorctl bounds                      print window geometry as JSON
  mirrorctl focus                       bring iPhone Mirroring to the front
  mirrorctl shot <path.png>             screenshot the window
  mirrorctl scroll <ticks>              scroll the feed down (negative = up)
  mirrorctl tap <fx> <fy>               click at a point, given as 0..1 fractions
  mirrorctl swipe <fx1> <fy1> <fx2> <fy2> [--ms 350]
  mirrorctl home                        swipe up from the bottom edge
  mirrorctl type <text>                 type text into the focused iOS field
  mirrorctl key <name>                  return | escape | space | tab | delete | up | down

NOTES
  Fractions are relative to the mirror window: 0,0 is top-left, 1,1 bottom-right.
  Event commands require iPhone Mirroring to be frontmost — run `focus` first.
  The mouse cursor is moved during scroll/tap/swipe and restored afterwards.
"""

// MARK: - Window lookup

struct MirrorWindow {
    let id: CGWindowID
    let rect: CGRect

    /// Point at the given 0..1 fractions of the window, in global display coordinates.
    func point(_ fx: Double, _ fy: Double) -> CGPoint {
        CGPoint(x: rect.origin.x + rect.width * CGFloat(fx),
                y: rect.origin.y + rect.height * CGFloat(fy))
    }

    var center: CGPoint { point(0.5, 0.5) }
}

func findMirrorWindow() -> MirrorWindow? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }

    for info in raw {
        guard let owner = info[kCGWindowOwnerName as String] as? String, owner == kAppName,
              let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
              let number = info[kCGWindowNumber as String] as? CGWindowID,
              let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
        else { continue }

        // The app also owns small helper windows; the phone screen is the tall one.
        if rect.width < 200 || rect.height < 300 { continue }
        return MirrorWindow(id: number, rect: rect)
    }
    return nil
}

func requireWindow() -> MirrorWindow {
    guard let win = findMirrorWindow() else {
        fail("""
        no iPhone Mirroring window found.
          - open iPhone Mirroring on this Mac
          - leave the iPhone locked, idle and nearby (it pauses the moment you pick it up)
          - if the app is open but showing "iPhone in Use", put the phone down and retry
        """)
    }
    return win
}

// MARK: - Frontmost guard

func isMirrorFrontmost() -> Bool {
    NSWorkspace.shared.frontmostApplication?.localizedName == kAppName
}

func requireFrontmost() {
    guard isMirrorFrontmost() else {
        let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
        fail("""
        refusing to post events: frontmost app is "\(front)", not "\(kAppName)".
        run `mirrorctl focus` first.
        """)
    }
}

func focusMirror() -> Bool {
    let apps = NSWorkspace.shared.runningApplications.filter { $0.localizedName == kAppName }
    guard let app = apps.first else { return false }
    app.activate(options: [])
    // Activation is async; give the window server a moment to settle.
    for _ in 0..<20 {
        if isMirrorFrontmost() { return true }
        usleep(50_000)
    }
    return isMirrorFrontmost()
}

// MARK: - Cursor

let eventSource = CGEventSource(stateID: .hidSystemState)

func currentCursor() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

func warp(to point: CGPoint) {
    CGWarpMouseCursorPosition(point)
    CGAssociateMouseAndMouseCursorPosition(1)
}

/// Runs `body` with the cursor parked over the mirror window, then puts it back.
func withCursor(at point: CGPoint, _ body: () -> Void) {
    let original = currentCursor()
    warp(to: point)
    usleep(30_000)
    body()
    usleep(30_000)
    warp(to: original)
}

// MARK: - Actions

/// Positive ticks scroll the feed downwards, matching how you'd read it.
func scroll(ticks: Int, at point: CGPoint) {
    let pixelsPerTick = 120
    let stepsPerTick = 5
    let perStep = Int32(pixelsPerTick / stepsPerTick) * (ticks < 0 ? 1 : -1)

    withCursor(at: point) {
        for _ in 0..<(abs(ticks) * stepsPerTick) {
            guard let event = CGEvent(scrollWheelEvent2Source: eventSource,
                                      units: .pixel,
                                      wheelCount: 1,
                                      wheel1: perStep, wheel2: 0, wheel3: 0)
            else { continue }
            event.post(tap: .cghidEventTap)
            usleep(8_000)
        }
    }
}

func click(at point: CGPoint) {
    withCursor(at: point) {
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            CGEvent(mouseEventSource: eventSource,
                    mouseType: type,
                    mouseCursorPosition: point,
                    mouseButton: .left)?
                .post(tap: .cghidEventTap)
            usleep(40_000)
        }
    }
}

func swipe(from start: CGPoint, to end: CGPoint, durationMs: Int) {
    let steps = max(8, durationMs / 12)
    let stepDelay = UInt32(max(1, durationMs / steps) * 1000)

    withCursor(at: start) {
        CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown,
                mouseCursorPosition: start, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        usleep(stepDelay)

        for step in 1...steps {
            let t = CGFloat(step) / CGFloat(steps)
            let point = CGPoint(x: start.x + (end.x - start.x) * t,
                                y: start.y + (end.y - start.y) * t)
            CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDragged,
                    mouseCursorPosition: point, mouseButton: .left)?
                .post(tap: .cghidEventTap)
            usleep(stepDelay)
        }

        CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp,
                mouseCursorPosition: end, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }
}

func type(text: String) {
    for character in text {
        var utf16 = Array(String(character).utf16)
        for isDown in [true, false] {
            guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: isDown)
            else { continue }
            event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            event.post(tap: .cghidEventTap)
            usleep(6_000)
        }
    }
}

let virtualKeys: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "escape": 53, "esc": 53, "space": 49,
    "tab": 48, "delete": 51, "up": 126, "down": 125, "left": 123, "right": 124,
]

func press(key name: String) {
    guard let code = virtualKeys[name.lowercased()] else {
        fail("unknown key \"\(name)\". known: \(virtualKeys.keys.sorted().joined(separator: ", "))")
    }
    for isDown in [true, false] {
        CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: isDown)?
            .post(tap: .cghidEventTap)
        usleep(20_000)
    }
}

// MARK: - Screenshot

func capture(windowID: CGWindowID, to path: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    // -o drops the window shadow, -x silences the shutter sound.
    process.arguments = ["-o", "-x", "-l", String(windowID), path]

    do { try process.run() } catch {
        fail("could not run screencapture: \(error.localizedDescription)")
    }
    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
        fail("screencapture exited \(process.terminationStatus)", code: process.terminationStatus)
    }
    guard FileManager.default.fileExists(atPath: path) else {
        fail("""
        screencapture wrote nothing. this is almost always a missing permission:
        System Settings › Privacy & Security › Screen & System Audio Recording → enable your terminal,
        then restart the terminal.
        """)
    }
}

// MARK: - Argument parsing

func fraction(_ raw: String, _ label: String) -> Double {
    guard let value = Double(raw), value >= 0, value <= 1 else {
        fail("\(label) must be a fraction between 0 and 1, got \"\(raw)\"")
    }
    return value
}

func flagValue(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    print(usage)
    exit(2)
}

switch command {
case "-h", "--help", "help":
    print(usage)

case "winid":
    print(requireWindow().id)

case "bounds":
    let win = requireWindow()
    let json = """
    {"id":\(win.id),"x":\(Int(win.rect.origin.x)),"y":\(Int(win.rect.origin.y)),\
    "width":\(Int(win.rect.width)),"height":\(Int(win.rect.height)),\
    "frontmost":\(isMirrorFrontmost())}
    """
    print(json)

case "focus":
    _ = requireWindow()
    guard focusMirror() else { fail("could not bring \(kAppName) to the front") }
    print("ok")

case "shot":
    guard args.count >= 2 else { fail("shot needs an output path\n\n\(usage)", code: 2) }
    capture(windowID: requireWindow().id, to: args[1])
    print(args[1])

case "scroll":
    guard args.count >= 2, let ticks = Int(args[1]) else {
        fail("scroll needs a tick count\n\n\(usage)", code: 2)
    }
    let win = requireWindow()
    requireFrontmost()
    scroll(ticks: ticks, at: win.center)
    print("ok")

case "tap":
    guard args.count >= 3 else { fail("tap needs <fx> <fy>\n\n\(usage)", code: 2) }
    let win = requireWindow()
    requireFrontmost()
    click(at: win.point(fraction(args[1], "fx"), fraction(args[2], "fy")))
    print("ok")

case "swipe":
    guard args.count >= 5 else { fail("swipe needs <fx1> <fy1> <fx2> <fy2>\n\n\(usage)", code: 2) }
    let win = requireWindow()
    requireFrontmost()
    let ms = Int(flagValue("--ms", in: args) ?? "350") ?? 350
    swipe(from: win.point(fraction(args[1], "fx1"), fraction(args[2], "fy1")),
          to: win.point(fraction(args[3], "fx2"), fraction(args[4], "fy2")),
          durationMs: ms)
    print("ok")

case "home":
    let win = requireWindow()
    requireFrontmost()
    swipe(from: win.point(0.5, 0.98), to: win.point(0.5, 0.55), durationMs: 260)
    print("ok")

case "type":
    guard args.count >= 2 else { fail("type needs text\n\n\(usage)", code: 2) }
    _ = requireWindow()
    requireFrontmost()
    type(text: args.dropFirst().joined(separator: " "))
    print("ok")

case "key":
    guard args.count >= 2 else { fail("key needs a name\n\n\(usage)", code: 2) }
    _ = requireWindow()
    requireFrontmost()
    press(key: args[1])
    print("ok")

default:
    fail("unknown command \"\(command)\"\n\n\(usage)", code: 2)
}
