import SwiftUI
import AureliaCloud

struct MusicCatalogueView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    @StateObject private var catalogue: CloudCatalogueStore
    let collection: MusicCollectionDTO
    @ViewState private var retry = 0
    init(model: AureliaModel, cloud: CloudAccountStore, catalogue: CloudCatalogueStore, collection: MusicCollectionDTO) {
        self.model = model; self.cloud = cloud; self.collection = collection
        _catalogue = StateObject(wrappedValue: catalogue)
    }
    private var request: CatalogueScreenRequest {
        .init(key: collection.kind.rawValue + ":" + collection.id, accountID: cloud.account?.id, phase: cloud.phase, retry: retry)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                SectionHeading(title: collection.title, subtitle: collection.kind.title + (collection.subtitle.isEmpty ? "" : " · " + collection.subtitle))
                if catalogue.loading { ProgressView("Opening collection…").frame(maxWidth: .infinity).padding(.vertical, 24) }
                else if let error = catalogue.error {
                    MusicErrorView(title: "Collection is unavailable", message: error) { retry &+= 1 }
                } else if let result = catalogue.result {
                    if !result.subtitle.isEmpty { Text(result.subtitle).foregroundStyle(.secondary) }
                    MusicCatalogueContent(model: model, cloud: cloud, catalogue: catalogue, result: result)
                }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle(collection.kind.title)
        .task(id: request) { await catalogue.browse(collection) }
        .refreshable { await catalogue.browse(collection) }
    }
}

struct MusicChartsView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    @StateObject private var catalogue: CloudCatalogueStore
    @ViewState private var country = "ZZ"
    @ViewState private var retry = 0
    private let regions = [("ZZ", "Global"), ("US", "United States"), ("GB", "United Kingdom"), ("DE", "Germany"),
                           ("FR", "France"), ("JP", "Japan"), ("KR", "South Korea"), ("BR", "Brazil"), ("IN", "India"), ("RU", "Russia")]
    init(model: AureliaModel, cloud: CloudAccountStore, catalogue: CloudCatalogueStore) {
        self.model = model; self.cloud = cloud; _catalogue = StateObject(wrappedValue: catalogue)
    }
    private var request: CatalogueScreenRequest { .init(key: country, accountID: cloud.account?.id, phase: cloud.phase, retry: retry) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                SectionHeading(title: "Music charts", subtitle: "Public chart selections from YouTube Music")
                Picker("Chart region", selection: $country) {
                    ForEach(regions, id: \.0) { region in Text(region.1).tag(region.0) }
                }.pickerStyle(.menu)
                if catalogue.loading || (catalogue.result != nil && catalogue.result?.country != country) {
                    ProgressView("Loading charts…").frame(maxWidth: .infinity).padding(.vertical, 24)
                } else if let error = catalogue.error {
                    MusicErrorView(title: "Charts are unavailable", message: error) { retry &+= 1 }
                } else if let result = catalogue.result {
                    Text(result.countryName ?? country).font(.title2.bold())
                    if let date = result.fetchedDate {
                        Text("Retrieved \(date.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if !result.subtitle.isEmpty { Text(result.subtitle).foregroundStyle(.secondary) }
                    Text("Selections keep the order returned by YouTube Music. Available charts vary by region.")
                        .font(.caption).foregroundStyle(.secondary)
                    MusicCatalogueContent(model: model, cloud: cloud, catalogue: catalogue, result: result)
                }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle("Charts")
        .task(id: request) { await catalogue.charts(country: country) }
        .refreshable { await catalogue.charts(country: country) }
    }
}

struct MusicCatalogueContent: View {
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    @ObservedObject var catalogue: CloudCatalogueStore
    let result: MusicCatalogueDTO
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if result.isEmpty {
                EmptyCollection(symbol: "music.note.list", title: "No items available", detail: "This public collection is empty or unavailable in your region. Try another search or chart region.")
            }
            if !result.tracks.isEmpty { CloudTrackRows(model: model, cloud: cloud, tracks: result.tracks, accountID: cloud.account?.id) }
            collectionRows(result.collections)
            ForEach(result.sections) { section in
                VStack(alignment: .leading, spacing: 14) {
                    Text(section.title).font(.title3.bold()).accessibilityAddTraits(.isHeader)
                    if !section.tracks.isEmpty { CloudTrackRows(model: model, cloud: cloud, tracks: section.tracks, accountID: cloud.account?.id) }
                    collectionRows(section.collections)
                }
            }
            if result.truncated {
                Text("Showing a limited selection. More items may be available in YouTube Music.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private func collectionRows(_ collections: [MusicCollectionDTO]) -> some View {
        LazyVStack(spacing: 12) {
            ForEach(collections) { collection in
                NavigationLink {
                    MusicCatalogueView(model: model, cloud: cloud, catalogue: catalogue.makeSession(), collection: collection)
                } label: { MusicCollectionRow(collection: collection) }.buttonStyle(.plain)
            }
        }
    }
}
private struct MusicCollectionRow: View {
    @Environment(\.aureliaPalette) private var theme
    let collection: MusicCollectionDTO
    var body: some View {
        HStack(spacing: 14) {
            ArtworkViewport(radius: collection.kind == .artist ? 32 : 10) {
                AsyncImage(url: collection.safeArtworkURL) { image in image.resizable().scaledToFill() } placeholder: {
                    Rectangle().fill(theme.accent.opacity(0.12)).overlay(Image(systemName: collection.kind == .artist ? "person.fill" : "square.stack.fill").foregroundStyle(.secondary))
                }
            }.frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 4) {
                Text(collection.title).font(.headline).foregroundStyle(.primary).lineLimit(2)
                Text(collection.kind.title + (collection.subtitle.isEmpty ? "" : " · " + collection.subtitle))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").foregroundStyle(.secondary).accessibilityHidden(true)
        }.padding(12).background(theme.card, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}
private struct CatalogueScreenRequest: Equatable {
    let key: String
    let accountID: String?
    let phase: CloudAuthPhase
    let retry: Int
}
