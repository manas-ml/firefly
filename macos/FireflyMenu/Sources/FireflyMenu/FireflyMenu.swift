import AppKit
import Foundation
import SwiftUI

/// Reads ~/Library/Application Support/Firefly/menubar.json:
///   { "url": "http://127.0.0.1:8080", "token": "<DASHBOARD_TOKEN>" }
/// (written by `make menubar-config`).
struct MenuConfig: Decodable {
    let url: String
    let token: String

    static func load() -> MenuConfig? {
        let file = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Firefly/menubar.json")
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(MenuConfig.self, from: data)
    }
}

struct AgentStatus: Decodable {
    let paused: Bool
    let pendingApprovals: Int
    let uptimeSeconds: Int
}

@MainActor
final class StatusModel: ObservableObject {
    @Published var status: AgentStatus?
    @Published var reachable = false
    let config = MenuConfig.load()
    private var timer: Timer?

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) -> URLRequest? {
        guard let config, let url = URL(string: config.url + path) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("1", forHTTPHeaderField: "x-firefly")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    func refresh() {
        guard let req = request("/api/status") else {
            reachable = false
            return
        }
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: req)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                status = try JSONDecoder().decode(AgentStatus.self, from: data)
                reachable = true
            } catch {
                reachable = false
            }
        }
    }

    func setPaused(_ paused: Bool) {
        guard let req = request("/api/pause", method: "POST", body: ["paused": paused]) else { return }
        Task {
            _ = try? await URLSession.shared.data(for: req)
            refresh()
        }
    }

    func openDashboard() {
        guard let config, let url = URL(string: "\(config.url)/?token=\(config.token)") else { return }
        NSWorkspace.shared.open(url)
    }

    var dotColor: Color {
        if !reachable { return .red }
        return (status?.paused ?? false) ? .orange : .green
    }
}

@main
struct FireflyMenuApp: App {
    @StateObject private var model = StatusModel()

    var body: some Scene {
        MenuBarExtra {
            if model.config == nil {
                Text("Run `make menubar-config` in the Firefly folder")
            } else if !model.reachable {
                Text("Firefly is not reachable")
            } else if let s = model.status {
                Text(s.paused ? "Paused" : "Running")
                Text("Up \(s.uptimeSeconds / 3600) h \((s.uptimeSeconds % 3600) / 60) min")
                Button(s.pendingApprovals == 1 ? "1 pending approval" : "\(s.pendingApprovals) pending approvals") {
                    model.openDashboard()
                }
                .disabled(s.pendingApprovals == 0)
                Divider()
                Button(s.paused ? "Resume agent" : "Pause agent") { model.setPaused(!s.paused) }
            }
            Button("Open dashboard") { model.openDashboard() }
                .disabled(model.config == nil)
            Divider()
            Button("Refresh") { model.refresh() }
            Button("Quit") { NSApplication.shared.terminate(nil) }
        } label: {
            Image(systemName: "circle.fill")
                .foregroundStyle(model.dotColor)
                .accessibilityLabel("Firefly status")
        }
    }
}
