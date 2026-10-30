// G5040 Manager.app: opening it opens the web UI; the server runs it with
// `notify <title> <message>` to post macOS notifications under its own name, because
// osascript notifications are dropped on macOS 26. Clicking a notification opens the UI.

import AppKit
import UserNotifications

let uiURL = URL(string: "http://localhost:4280/")!

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    let args = CommandLine.arguments
    guard args.count >= 4, args[1] == "notify" else {
      openUI()
      return
    }
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
      guard granted else { exit(2) }
      let content = UNMutableNotificationContent()
      content.title = args[2]
      content.body = args[3]
      let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
      center.add(request) { error in
        // Give Notification Center a moment to take it before the process ends.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(error == nil ? 0 : 1) }
      }
    }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    openUI()
    done()
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .sound])
  }

  func openUI() {
    NSWorkspace.shared.open(uiURL)
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { NSApp.terminate(nil) }
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
