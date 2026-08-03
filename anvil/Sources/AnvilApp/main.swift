import AppKit

// Menu bar only: no dock icon, no main window until you ask for one.
let application = NSApplication.shared
let controller = AppDelegate()
application.delegate = controller
application.setActivationPolicy(.accessory)
application.run()
