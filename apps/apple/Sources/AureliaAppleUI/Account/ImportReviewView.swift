import SwiftUI
import AureliaCloud

/// Candidate metadata is shown for explicit confirmation; a title similarity
/// never silently selects a replacement recording.
struct ImportReviewView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var cloud: CloudAccountStore
    let accountID: String
    @ViewState private var items: [CloudImportItemDTO]
    @ViewState private var confirmation: ImportReviewConfirmation?
    @ViewState private var message: String?
    @ViewState private var isLoading = false
    @ViewState private var generation: UInt64 = 0
    init(cloud: CloudAccountStore, accountID: String, items: [CloudImportItemDTO]) {
        self.cloud = cloud; self.accountID = accountID; _items = ViewState(initialValue: items)
    }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if cloud.account?.id == accountID {
                    SectionHeading(title: "Review imported songs", subtitle: "Choose the correct recording before it is added to your library")
                    Text("Compare the song, artist, album, duration and version. Skip an uncertain match; it stays available for later review.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button("Refresh import progress") { Task { await load() } }
                        .disabled(isLoading || cloud.isMutating)
                    if isLoading || cloud.isMutating { ProgressView("Updating import…") }
                    if items.isEmpty && !isLoading {
                        EmptyCollection(symbol: "checkmark.circle", title: "No songs need review", detail: "Your current import has no pending matches.")
                    }
                    ForEach(items) { item in review(item) }
                    if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                    if let error = cloud.message { Text(error).font(.footnote).foregroundStyle(.secondary) }
                    Text("Only metadata is imported. No audio, source credentials, account identity or active queue is transferred.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    EmptyCollection(symbol: "person.crop.circle", title: "Account changed", detail: "Return to your current account before reviewing imported songs.")
                }
            }.padding(24).frame(maxWidth: 900).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle("Import review")
        .refreshable { await load() }
        .confirmationDialog("Use this recording?", isPresented: confirmationPresented, titleVisibility: .visible) {
            if let confirmation {
                Button("Confirm match") { Task { await resolve(confirmation) } }
            }
            Button("Cancel", role: .cancel) { confirmation = nil }
        } message: {
            if let confirmation {
                Text("Add \(confirmation.candidate.title) by \(confirmation.candidate.artist) as the match for \(confirmation.sourceTitle)?")
            }
        }
        .onChange(of: cloud.account?.id) { _, _ in
            generation &+= 1; confirmation = nil; items = []; message = nil; isLoading = false
        }
        .onDisappear { generation &+= 1; confirmation = nil; isLoading = false }
    }
    private var confirmationPresented: Binding<Bool> {
        Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })
    }
    private func review(_ item: CloudImportItemDTO) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(item.source.title).font(.headline)
                Text([item.source.artist, item.source.album, duration(item.source.duration)].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if item.match.candidates.isEmpty {
                Text("No supported candidate was found. Keep this song pending and try again from the web import screen when more candidates are available.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(item.match.candidates) { candidate in
                Button {
                    confirmation = ImportReviewConfirmation(itemID: item.id, sourceTitle: item.source.title, candidate: candidate.track)
                } label: {
                    HStack(spacing: 12) {
                        CloudArtwork(track: candidate.track, radius: 8).frame(width: 48, height: 48)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(candidate.track.title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                            Text([candidate.track.artist, candidate.track.album, duration(candidate.track.duration)].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            Text("\(Int((candidate.confidence * 100).rounded()))% metadata match · \(candidate.track.provider == "youtube" ? "YouTube" : "Studio")")
                                .font(.caption2).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "checkmark.circle").foregroundStyle(theme.accent)
                    }.padding(12).contentShape(Rectangle())
                        .background(theme.background, in: RoundedRectangle(cornerRadius: 10))
                }.buttonStyle(.plain)
                    .disabled(cloud.isMutating || cloud.libraryNeedsRefresh || isLoading)
                    .accessibilityLabel("Review \(candidate.track.title) by \(candidate.track.artist), \(duration(candidate.track.duration))")
            }
        }.padding(16).background(theme.card, in: RoundedRectangle(cornerRadius: 14))
    }
    private func duration(_ seconds: Double) -> String {
        let seconds = Int(seconds)
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }
    private func load() async {
        guard cloud.account?.id == accountID, !isLoading, !cloud.isMutating else { return }
        generation &+= 1; let ticket = generation
        isLoading = true; message = nil
        defer { if generation == ticket { isLoading = false } }
        let result = await cloud.imports(expectedAccountID: accountID)
        guard generation == ticket, cloud.account?.id == accountID, !Task.isCancelled else { return }
        if let result { items = result.items }
        else { message = "Could not refresh import progress. Your pending matches remain available." }
    }
    private func resolve(_ selection: ImportReviewConfirmation) async {
        guard cloud.account?.id == accountID, !isLoading, !cloud.isMutating else { confirmation = nil; return }
        generation &+= 1; let ticket = generation
        confirmation = nil; isLoading = true; message = nil
        defer { if generation == ticket { isLoading = false } }
        let result = await cloud.resolveImport(itemID: selection.itemID, trackID: selection.candidate.id, expectedAccountID: accountID)
        guard generation == ticket, cloud.account?.id == accountID, !Task.isCancelled else { return }
        if let result { items = result.items; message = "Match confirmed and added to your cloud library." }
        else { message = "Could not confirm this match. Refresh import progress before retrying." }
    }
}

private struct ImportReviewConfirmation {
    let itemID: String
    let sourceTitle: String
    let candidate: TrackDTO
}
