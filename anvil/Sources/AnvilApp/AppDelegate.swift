import AnvilCore
import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var refreshTimer: Timer?
    private var presetsWindow: NSWindow?
    let store = PresetStore()

    private let durationChoices = [15, 30, 45, 60, 90, 120, 180, 240, 480]

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "hammer.fill", accessibilityDescription: "Anvil"
        )
        statusItem.button?.imagePosition = .imageLeading
        rebuildMenu()

        refreshTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.rebuildMenu()
        }
    }

    // MARK: - Menu

    private func rebuildMenu() {
        let state = SessionStore.loadPublicState()
        let menu = NSMenu()

        if let state, state.active, let endsAt = state.endsAt {
            statusItem.button?.title = " " + countdownText(until: endsAt)

            let header = NSMenuItem(
                title: "\(state.presetName ?? "Session") · ends \(timeText(endsAt))",
                action: nil, keyEquivalent: ""
            )
            header.isEnabled = false
            menu.addItem(header)

            let detail = NSMenuItem(
                title: "\(state.blockedAppCount) apps · \(state.blockedDomainCount) sites blocked",
                action: nil, keyEquivalent: ""
            )
            detail.isEnabled = false
            menu.addItem(detail)

            menu.addItem(.separator())

            // No stop button, because the daemon has no stop opcode to call.
            let notice = NSMenuItem(
                title: "This session cannot be cancelled", action: nil, keyEquivalent: ""
            )
            notice.isEnabled = false
            menu.addItem(notice)

            menu.addItem(.separator())
            let extend = NSMenuItem(title: "Extend", action: nil, keyEquivalent: "")
            extend.submenu = durationMenu(for: nil, extending: true)
            menu.addItem(extend)
        } else {
            statusItem.button?.title = ""

            if store.presets.isEmpty {
                let empty = NSMenuItem(title: "No presets yet", action: nil, keyEquivalent: "")
                empty.isEnabled = false
                menu.addItem(empty)
            }
            for preset in store.presets {
                let item = NSMenuItem(title: preset.name, action: nil, keyEquivalent: "")
                item.submenu = durationMenu(for: preset, extending: false)
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        menu.addItem(
            NSMenuItem(title: "Edit Presets…", action: #selector(openPresets), keyEquivalent: ",")
        )
        menu.addItem(
            NSMenuItem(title: "Quit Anvil", action: #selector(quit), keyEquivalent: "q")
        )
        for item in menu.items where item.action != nil { item.target = self }
        statusItem.menu = menu
    }

    private func durationMenu(for preset: Preset?, extending: Bool) -> NSMenu {
        let menu = NSMenu()
        var minutesList = durationChoices
        if let preset, !minutesList.contains(preset.defaultMinutes) {
            minutesList.insert(preset.defaultMinutes, at: 0)
        }
        for minutes in minutesList where minutes <= Limits.maxMinutes {
            // Deadlines are always computed from now, never added to the existing one,
            // so an extension is labelled for what it actually does. Picking a time
            // earlier than the current deadline is simply refused by the daemon.
            let title = extending ? "Until \(durationLabel(minutes)) from now" : durationLabel(minutes)
            let item = NSMenuItem(
                title: title, action: #selector(startFromMenu(_:)), keyEquivalent: ""
            )
            item.target = self
            item.representedObject = StartIntent(preset: preset, minutes: minutes, extending: extending)
            menu.addItem(item)
        }
        return menu
    }

    private func durationLabel(_ minutes: Int) -> String {
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return remainder == 0 ? "\(hours) hr" : "\(hours) hr \(remainder) min"
    }

    private func countdownText(until endsAt: Date) -> String {
        let remaining = max(0, Int(endsAt.timeIntervalSinceNow))
        let hours = remaining / 3600
        let minutes = (remaining % 3600) / 60
        let seconds = remaining % 60
        if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, seconds) }
        return String(format: "%d:%02d", minutes, seconds)
    }

    private func timeText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }

    // MARK: - Actions

    final class StartIntent: NSObject {
        let preset: Preset?
        let minutes: Int
        let extending: Bool
        init(preset: Preset?, minutes: Int, extending: Bool) {
            self.preset = preset
            self.minutes = minutes
            self.extending = extending
        }
    }

    @objc private func startFromMenu(_ sender: NSMenuItem) {
        guard let intent = sender.representedObject as? StartIntent else { return }

        if intent.extending {
            // An empty preset against a live session means "same blocklist, later
            // deadline". The daemon unions blocklists, so this can only ever widen.
            let extensionPreset = Preset(name: "Extension", defaultMinutes: intent.minutes)
            send(StartRequest(preset: extensionPreset, minutes: intent.minutes))
            return
        }

        guard let preset = intent.preset, !preset.isEmpty else {
            let name = intent.preset?.name ?? "this preset"
            alert(
                title: "Nothing to block",
                message: "Add at least one app or website to \"\(name)\" before starting."
            )
            return
        }

        let endsAt = Date().addingTimeInterval(TimeInterval(intent.minutes) * 60)
        let formatter = DateFormatter()
        formatter.dateStyle = .full
        formatter.timeStyle = .short

        let confirmation = NSAlert()
        confirmation.messageText = "Start \(durationLabel(intent.minutes))?"
        confirmation.informativeText = """
        Ends \(formatter.string(from: endsAt)).

        \(preset.appBundleIDs.count) apps and \(preset.domains.count) websites will be blocked. \
        Terminal, Activity Monitor and System Settings are quit for the whole session.

        This cannot be cancelled once it starts.
        """
        confirmation.alertStyle = .warning
        confirmation.addButton(withTitle: "Start")
        confirmation.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard confirmation.runModal() == .alertFirstButtonReturn else { return }

        send(StartRequest(preset: preset, minutes: intent.minutes))
    }

    private func send(_ request: StartRequest) {
        do {
            let data = try SessionStore.encodeRequest(request)
            try ControlSocketClient.send(data, to: Paths.socket)
            rebuildMenu()
        } catch {
            alert(
                title: "Could not reach the Anvil daemon",
                message: """
                \(error)

                If you have not installed it yet, run this from the project directory:

                    sudo ./install.sh
                """
            )
        }
    }

    private func alert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func openPresets() {
        if let window = presetsWindow {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 460),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Anvil Presets"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: PresetsView(store: store))
        presetsWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func quit() {
        // Worth being explicit: quitting the app does not lift anything. The daemon
        // owns the deadline and keeps enforcing it.
        NSApp.terminate(nil)
    }
}
