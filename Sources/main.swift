import AppKit
import Combine
import SwiftUI

final class AccountsPanelWindow: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let model = AccountsModel(staging: CommandLine.arguments.contains("--staging"))
    private let updater = AppUpdater()
    private var host: NSHostingController<AccountsPanel>?
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var subscription: AnyCancellable?
    private var startupTask: Task<Void, Never>?
    private var preview: NSWindow?
    private var setupWindow: NSWindow?
    private var panelSize = PanelSizeState()
    private var additionalAccountHeight: CGFloat = 0
    private var layingOutPanel = false
    private let setupModel = SetupModel(staging: CommandLine.arguments.contains("--staging"))
    private lazy var panel: AccountsPanelWindow = {
        let window = AccountsPanelWindow(contentRect: .zero, styleMask: [.borderless, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isFloatingPanel = true; window.level = .statusBar
        window.delegate = self; window.isRestorable = false
        window.backgroundColor = .clear; window.isOpaque = false; window.hasShadow = true
        window.hidesOnDeactivate = false; window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let hosting = NSHostingController(rootView: AccountsPanel(model: model, updater: updater, onQuit: { NSApp.terminate(nil) },
            onContentSizeChange: { [weak self] height in
                self?.additionalAccountHeight = height
                Task { @MainActor [weak self] in
                    await Task.yield()
                    guard let self, self.panel.isVisible else { return }
                    self.layoutPanel()
                }
            }))
        hosting.sizingOptions = [.intrinsicContentSize]
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        let container = NSView(); container.wantsLayer = true
        container.layer?.cornerRadius = AccountsPanel.cornerRadius; container.layer?.cornerCurve = .continuous; container.layer?.masksToBounds = true
        container.addSubview(hosting.view)
        NSLayoutConstraint.activate([hosting.view.leadingAnchor.constraint(equalTo: container.leadingAnchor), hosting.view.trailingAnchor.constraint(equalTo: container.trailingAnchor), hosting.view.topAnchor.constraint(equalTo: container.topAnchor), hosting.view.bottomAnchor.constraint(equalTo: container.bottomAnchor)])
        window.contentView = container; host = hosting
        window.title = "Claude Codex"
        return window
    }()
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let button = statusItem.button {
            let icon = NSImage(systemSymbolName: "terminal", accessibilityDescription: "Claude Codex")
            icon?.isTemplate = true; button.image = icon
            button.imagePosition = .imageLeading
            button.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
            button.target = self; button.action = #selector(togglePanel)
            button.setAccessibilityLabel("Claude Codex")
        }
        updateStatusItem()
        subscription = model.objectWillChange.sink { [weak self] _ in
            Task { @MainActor in
                await Task.yield()
                guard let self else { return }
                self.updateStatusItem()
                if self.panel.isVisible && !self.panel.inLiveResize { self.layoutPanel() }
            }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(showSetup), name: Notification.Name("ShowClaudeSetup"), object: nil)
        updater.hidePanel = { [weak self] in self?.hidePanel() }
        updater.showPanel = { [weak self] in self?.showPanel() }
        updater.canPrepare = { [weak self] in
            guard let self else { return false }
            return !self.model.maintenancePending && !self.model.preparingService && !self.model.applying && !self.model.refreshing && !self.setupModel.busy && self.model.confirmation == nil
        }
        model.beforeServicePreparation = { [weak self] in
            guard let self else { return false }
            return await self.updater.start()
        }
        startupTask = Task { [weak self] in
            guard let self else { return }
            model.start()
            if CommandLine.arguments.contains("--staging") { return }
            while !Task.isCancelled {
                if await updater.start() { return }
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, self?.panel.isVisible == true, self?.model.confirmation == nil {
                self?.hidePanel(); return nil
            }
            return event
        }
        if CommandLine.arguments.contains("--preview") { showPreview() }
        else if !CommandLine.arguments.contains("--update-recovery") && (CommandLine.arguments.contains("--show") || !UserDefaults.standard.bool(forKey: "hasShownWelcome")) {
            UserDefaults.standard.set(true, forKey: "hasShownWelcome"); showPanel()
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showPanel(); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { updater.terminationReply() }
    func applicationWillTerminate(_ notification: Notification) {
        startupTask?.cancel()
        model.stop()
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    }
    private func updateStatusItem() {
        let presentation = MenuBarQuotaPresentation(snapshot: model.snapshot, unavailable: model.queryError != nil || model.maintenancePending)
        statusItem.button?.title = " " + presentation.title
        statusItem.button?.toolTip = presentation.tooltip
        statusItem.button?.setAccessibilityLabel(presentation.tooltip)
    }
    @objc private func togglePanel() {
        guard model.confirmation == nil else { return }
        panel.isVisible ? hidePanel() : showPanel()
    }
    private func showPanel() {
        layoutPanel(); panel.orderFrontRegardless(); panel.makeKey(); panel.invalidateShadow()
        if globalMonitor == nil {
            globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                guard let self, self.model.confirmation == nil else { return }
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
        guard !panel.inLiveResize else { return }
        guard let button = statusItem.button, let window = button.window, let host else { return }
        layingOutPanel = true
        defer { layingOutPanel = false }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        panel.layoutIfNeeded()
        let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let maximum = NSSize(width: max(1, visible.width - 16), height: max(1, visible.height - 16))
        let width = panelSize.width(connection: model.showingConnectionForm, maximum: maximum.width)
        let fitting = host.sizeThatFits(in: NSSize(width: width, height: 0))
        let minimum = PanelSizeState.minimum(fittingHeight: fitting.height)
        let size = panelSize.size(connection: model.showingConnectionForm, maximum: maximum,
                                  minimumHeight: minimum.height, idealHeight: fitting.height + additionalAccountHeight)
        panel.contentMinSize = NSSize(width: min(maximum.width, minimum.width), height: min(maximum.height, minimum.height))
        panel.contentMaxSize = maximum
        if panel.contentRect(forFrameRect: panel.frame).size != size { panel.setContentSize(size) }
        let x = min(max(anchor.midX - size.width / 2, visible.minX + 8), visible.maxX - size.width - 8)
        let y = max(visible.minY + 8, anchor.minY - 6 - size.height)
        panel.setFrameOrigin(NSPoint(x: x, y: y)); panel.invalidateShadow()
    }
    func windowDidEndLiveResize(_ notification: Notification) {
        guard let resized = notification.object as? NSWindow, resized === panel, !layingOutPanel else { return }
        panelSize.remember(panel.contentRect(forFrameRect: panel.frame).size, connection: model.showingConnectionForm)
        layoutPanel()
    }
    @objc private func showSetup() {
        hidePanel()
        if let setupWindow { NSApp.activate(); setupWindow.makeKeyAndOrderFront(nil); return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 620), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = L10n.text("setup.windowTitle"); window.isReleasedWhenClosed = false
        window.contentViewController = NSHostingController(rootView: SetupView(model: setupModel))
        setupWindow = window; window.center(); NSApp.activate(); window.makeKeyAndOrderFront(nil)
    }
    private func showPreview() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 650), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isRestorable = false
        window.title = "Claude Codex"
        let hosting = NSHostingController(rootView: AccountsPanel(model: model, updater: updater, onQuit: { NSApp.terminate(nil) }))
        window.contentViewController = hosting
        window.contentMinSize = PanelSizeState.minimum(fittingHeight: hosting.sizeThatFits(in: CGSize(width: 420, height: 0)).height)
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
