import SwiftUI
import AureliaCloud
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor enum AccountBrowser {
    static func open(_ url: URL) {
        guard CloudAPIClient.isAccountURL(url) else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }
}

struct AccountView: View {
    @ObservedObject var cloud: CloudAccountStore
    var body: some View {
        Form {
            if let user = cloud.account {
                Section("Your Aurelia account") {
                    Text(user.name).font(.title2.bold())
                    if let email = user.email { Text(email).foregroundStyle(.secondary) }
                    Text("Your saved cloud library stays with this account.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Connected sign-in methods") {
                    ForEach(["local", "telegram", "google", "apple"], id: \.self) { provider in
                        LabeledContent(provider == "local" ? "Email" : provider.capitalized,
                                       value: user.identities.contains(provider) ? "Linked" : "Not linked")
                    }
                    Button("Manage connected accounts in browser") {
                        if let url = CloudAPIClient.accountURL(expectedAccountID: user.id) { AccountBrowser.open(url) }
                    }
                    Text("The browser must use the same Aurelia account. Refresh here after linking a provider.").font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    Button("Refresh account and library") { Task { await cloud.refresh() } }.disabled(cloud.isRefreshing)
                    Button("Sign out of this device", role: .destructive) { Task { await cloud.signOut(expectedAccountID: user.id) } }.disabled(cloud.isMutating)
                }
            } else {
                Section("Bring your music with you") {
                    Text("Connect the same account you use on the web. Sign in with Telegram, Google, Apple or email in your browser, then approve this device.")
                    if cloud.phase == .secureStorageLocked {
                        Button("Retry secure storage") { Task { await cloud.restore() } }
                    }
                    if cloud.phase != .authorizing && cloud.phase != .restoring {
                        Button("Sign in with your browser") {
                            Task {
                                #if os(macOS)
                                let deviceName = "Aurelia for Mac"
                                #else
                                let deviceName = "Aurelia for iPhone"
                                #endif
                                if let url = await cloud.beginSignIn(deviceName: deviceName) { AccountBrowser.open(url) }
                            }
                        }.disabled(cloud.phase == .secureStorageLocked)
                    }
                }
            }
            if let approval = cloud.approval {
                Section("Approve this device") {
                    Text(approval.userCode).font(.title.monospaced().bold()).textSelection(.enabled)
                    Text("Check this code in the browser, choose your Aurelia account and approve the connection. This window updates automatically.")
                    Button("Open approval page") { AccountBrowser.open(approval.verificationURL) }
                    Button("Cancel connection", role: .cancel) { cloud.cancelSignIn() }
                }
            } else if cloud.phase == .authorizing || cloud.phase == .restoring {
                ProgressView(cloud.phase == .restoring ? "Restoring secure session…" : "Preparing sign-in…")
            }
            if cloud.isRefreshing { ProgressView("Refreshing cloud library…") }
            if let message = cloud.message {
                Section { Text(message).foregroundStyle(.secondary).accessibilityLabel(message) }
            }
            Section("On this device") {
                Text("Offline Studio likes and playlists stay separate. Connecting an account does not upload or merge them. Your playback always stays paused and silent after an account change.")
                    .font(.caption).foregroundStyle(.secondary)
                Text("The device credential is stored in OS Keychain. A locked or unavailable Keychain has no plaintext fallback.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped).navigationTitle("Account")
    }
}
