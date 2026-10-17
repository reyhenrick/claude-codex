import AppKit
import Combine
import SwiftUI

final class AccountsPanelWindow: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let model = AccountsModel(staging: CommandLine.arguments.contains("--staging"))
    private var host: NSView?
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var subscription: AnyCancellable?
    private var preview: NSWindow?
    private var setupWindow: NSWindow?
    private let setupModel = SetupModel()
    private lazy var panel: AccountsPanelWindow = {
        let window = AccountsPanelWindow(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isFloatingPanel = true; window.level = .statusBar
        window.backgroundColor = .clear; window.isOpaque = false; window.hasShadow = true
        window.hidesOnDeactivate = false; window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let hosting = NSHostingView(rootView: AccountsPanel(model: model, onQuit: { NSApp.terminate(nil) }))
        hosting.translatesAutoresizingMaskIntoConstraints = false
        let container = NSView(); container.wantsLayer = true
        container.layer?.cornerRadius = AccountsPanel.cornerRadius; container.layer?.cornerCurve = .continuous; container.layer?.masksToBounds = true
        container.addSubview(hosting)
        NSLayoutConstraint.activate([hosting.leadingAnchor.constraint(equalTo: container.leadingAnchor), hosting.trailingAnchor.constraint(equalTo: container.trailingAnchor), hosting.topAnchor.constraint(equalTo: container.topAnchor), hosting.bottomAnchor.constraint(equalTo: container.bottomAnchor)])
        window.contentView = container; host = hosting
        window.title = "Contas Codex"
        return window
    }()
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let button = statusItem.button {
            let icon = NSImage(systemSymbolName: "person.2.circle", accessibilityDescription: "Contas Codex")
            icon?.isTemplate = true; button.image = icon
            button.target = self; button.action = #selector(togglePanel)
            button.setAccessibilityLabel("Contas Codex")
        }
        subscription = model.objectWillChange.sink { [weak self] _ in
            Task { @MainActor in
                await Task.yield()
                guard let self else { return }
                self.statusItem.button?.toolTip = "Contas Codex" + (self.model.snapshot?.nextAccount.map { ": \($0)" } ?? "")
                if self.panel.isVisible { self.layoutPanel() }
            }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(showSetup), name: Notification.Name("ShowClaudeSetup"), object: nil)
        model.start()
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, self?.panel.isVisible == true, self?.model.disconnectCandidate == nil {
                self?.hidePanel(); return nil
            }
            return event
        }
        if CommandLine.arguments.contains("--preview") { showPreview() }
        else if CommandLine.arguments.contains("--show") || !UserDefaults.standard.bool(forKey: "hasShownWelcome") {
            UserDefaults.standard.set(true, forKey: "hasShownWelcome"); showPanel()
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showPanel(); return true }
    func applicationWillTerminate(_ notification: Notification) {
        model.stop()
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    }
    @objc private func togglePanel() { panel.isVisible ? hidePanel() : showPanel() }
    private func showPanel() {
        layoutPanel(); panel.orderFrontRegardless(); panel.makeKey(); panel.invalidateShadow()
        if globalMonitor == nil {
            globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                guard let self, self.model.disconnectCandidate == nil else { return }
                let point = NSEvent.mouseLocation
                if self.statusItem.button?.window?.frame.contains(point) == true || self.panel.frame.contains(point) { return }
                self.hidePanel()
            }
        }
        Task { await model.load(refresh: true) }
    }
    private func hidePanel() {
        panel.orderOut(nil)
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor); self.globalMonitor = nil }
    }
    private func layoutPanel() {
        guard let button = statusItem.button, let window = button.window else { return }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        panel.layoutIfNeeded()
        let size = NSSize(width: 420, height: model.showingConnectionForm ? 340 : 650)
        panel.setContentSize(size)
        let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let x = min(max(anchor.midX - size.width / 2, visible.minX + 8), visible.maxX - size.width - 8)
        let y = max(visible.minY + 8, anchor.minY - 6 - size.height)
        panel.setFrameOrigin(NSPoint(x: x, y: y)); panel.invalidateShadow()
    }
    @objc private func showSetup() {
        hidePanel()
        if let setupWindow { NSApp.activate(); setupWindow.makeKeyAndOrderFront(nil); return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Configurar Claude"; window.isReleasedWhenClosed = false
        window.contentViewController = NSHostingController(rootView: SetupView(model: setupModel))
        setupWindow = window; window.center(); NSApp.activate(); window.makeKeyAndOrderFront(nil)
    }
    private func showPreview() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 650), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Contas Codex"
        window.contentViewController = NSHostingController(rootView: AccountsPanel(model: model, onQuit: { NSApp.terminate(nil) }))
        window.isReleasedWhenClosed = false; preview = window; window.center()
        NSApp.setActivationPolicy(.regular); NSApp.activate(); window.makeKeyAndOrderFront(nil)
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let bundleID = Bundle.main.bundleIdentifier ?? "com.henrick.codex-accounts"
    if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first(where: { $0.processIdentifier != getpid() }) {
        running.activate(); exit(0)
    }
    let delegate = AppDelegate(); application.delegate = delegate
    application.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { application.run() }
}
