import AnvilCore
import AppKit
import SwiftUI
import UniformTypeIdentifiers

final class PresetStore: ObservableObject {
    @Published var presets: [Preset] {
        didSet { SessionStore.savePresets(presets) }
    }

    init() {
        let loaded = SessionStore.loadPresets()
        presets = loaded.isEmpty ? PresetStore.starterPresets : loaded
    }

    /// Something usable on first launch, so the app is not an empty box.
    static var starterPresets: [Preset] {
        [
            Preset(
                name: "Deep Work",
                appBundleIDs: ["com.tinyspeck.slackmacgap", "com.hnc.Discord", "com.apple.MobileSMS"],
                domains: ["reddit.com", "x.com", "twitter.com", "news.ycombinator.com", "youtube.com"],
                defaultMinutes: 90
            ),
            Preset(
                name: "Evening",
                appBundleIDs: [],
                domains: ["reddit.com", "youtube.com", "instagram.com", "tiktok.com"],
                defaultMinutes: 180
            ),
        ]
    }

    func add() {
        presets.append(Preset(name: "New preset", defaultMinutes: 60))
    }

    func delete(_ preset: Preset) {
        presets.removeAll { $0.id == preset.id }
    }

    func binding(for preset: Preset) -> Binding<Preset>? {
        guard let index = presets.firstIndex(where: { $0.id == preset.id }) else { return nil }
        return Binding(
            get: { self.presets[index] },
            set: { self.presets[index] = $0 }
        )
    }
}

struct PresetsView: View {
    @ObservedObject var store: PresetStore
    @State private var selection: UUID?

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                ForEach(store.presets) { preset in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(preset.name).font(.body)
                        Text("\(preset.appBundleIDs.count) apps · \(preset.domains.count) sites")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .tag(preset.id)
                }
            }
            .frame(minWidth: 200)
            .safeAreaInset(edge: .bottom) {
                HStack {
                    Button {
                        store.add()
                        selection = store.presets.last?.id
                    } label: {
                        Image(systemName: "plus")
                    }
                    Button {
                        if let selection, let preset = store.presets.first(where: { $0.id == selection }) {
                            store.delete(preset)
                        }
                        selection = store.presets.first?.id
                    } label: {
                        Image(systemName: "minus")
                    }
                    .disabled(selection == nil)
                    Spacer()
                }
                .padding(8)
            }
        } detail: {
            if let selection,
               let preset = store.presets.first(where: { $0.id == selection }),
               let binding = store.binding(for: preset) {
                PresetDetailView(preset: binding)
            } else {
                Text("Select a preset").foregroundStyle(.secondary)
            }
        }
        .onAppear { if selection == nil { selection = store.presets.first?.id } }
    }
}

struct PresetDetailView: View {
    @Binding var preset: Preset
    @State private var domainText: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                LabeledContent("Name") {
                    TextField("Name", text: $preset.name).textFieldStyle(.roundedBorder)
                }

                LabeledContent("Default length") {
                    HStack {
                        Stepper(
                            value: $preset.defaultMinutes,
                            in: Limits.minMinutes...Limits.maxMinutes,
                            step: 15
                        ) {
                            Text("\(preset.defaultMinutes) minutes")
                        }
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text("Blocked apps").font(.headline)
                    Text("Matched by bundle identifier, so renaming or moving the app does not get around it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    ForEach(preset.appBundleIDs, id: \.self) { bundleID in
                        HStack {
                            Text(bundleID).font(.system(.body, design: .monospaced))
                            Spacer()
                            Button {
                                preset.appBundleIDs.removeAll { $0 == bundleID }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                            }
                            .buttonStyle(.borderless)
                        }
                    }

                    Button("Add app…", action: chooseApp)
                }

                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text("Blocked websites").font(.headline)
                    Text("One per line. The apex domain and its www. form are both blocked.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $domainText)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 140)
                        .border(Color.secondary.opacity(0.3))
                        .onChange(of: domainText) { newValue in
                            preset.domains = newValue
                                .components(separatedBy: .newlines)
                                .compactMap { HostsFile.normalize($0) }
                        }
                }
            }
            .padding(20)
        }
        .onAppear { domainText = preset.domains.joined(separator: "\n") }
        .onChange(of: preset.id) { _ in domainText = preset.domains.joined(separator: "\n") }
    }

    private func chooseApp() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType.applicationBundle]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        guard panel.runModal() == .OK else { return }

        for url in panel.urls {
            // Store both signals: the identifier is what actually holds, the path is a
            // fallback for anything that is not a well-formed bundle.
            if let bundleID = Bundle(url: url)?.bundleIdentifier {
                if !preset.appBundleIDs.contains(bundleID) { preset.appBundleIDs.append(bundleID) }
            }
            if !preset.appPaths.contains(url.path) { preset.appPaths.append(url.path) }
        }
    }
}
