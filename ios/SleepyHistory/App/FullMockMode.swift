import Foundation
import UIKit

enum FullMockMode {
  static func makeFixtureStory(from draft: CreateStoryDraft) -> FixtureStory {
    let id = "mock-story-\(slug(for: draft.subject))"
    let category = draft.kind == .historicalFigure ? "Historical Figure" : "Daily Life"
    let chapterCount = max(8, min(12, draft.durationMinutes / 6))

    return FixtureStory(
      id: id,
      title: draft.displayTitle,
      subtitle: "\(draft.era), \(draft.location)",
      synopsis: "A complete offline bedtime history from the perspective of \(draft.perspective.lowercased()).",
      category: category,
      symbol: FixtureStory.symbol(forTitle: draft.displayTitle, category: category),
      chapter: "Chapter 1 of \(chapterCount): A Quiet Beginning",
      durationMinutes: draft.durationMinutes,
      currentTime: "00:00",
      remainingTime: "-\(draft.durationMinutes):00",
      progress: 0,
      status: .completed,
      isDownloaded: true,
      isBookmarked: false,
      downloadDetail: "Audio ready offline",
      failureReason: nil
    )
  }

  static func makePersistentStory(
    from draft: CreateStoryDraft,
    localAssetsDirectory: URL,
    now: Date = Date(),
    fileManager: FileManager = .default,
    audioDurationSeconds: UInt32 = 600
  ) throws -> PersistentStory {
    try makePersistentStory(
      from: makeFixtureStory(from: draft),
      kind: draft.kind.rawValue,
      localAssetsDirectory: localAssetsDirectory,
      now: now,
      fileManager: fileManager,
      audioDurationSeconds: audioDurationSeconds
    )
  }

  static func makePersistentStory(
    from fixtureStory: FixtureStory,
    localAssetsDirectory: URL,
    now: Date = Date(),
    fileManager: FileManager = .default,
    audioDurationSeconds: UInt32 = 600
  ) throws -> PersistentStory {
    try makePersistentStory(
      from: fixtureStory,
      kind: fixtureStory.category.lowercased().replacingOccurrences(of: " ", with: "-"),
      localAssetsDirectory: localAssetsDirectory,
      now: now,
      fileManager: fileManager,
      audioDurationSeconds: audioDurationSeconds
    )
  }

  private static func makePersistentStory(
    from fixtureStory: FixtureStory,
    kind: String,
    localAssetsDirectory: URL,
    now: Date,
    fileManager: FileManager,
    audioDurationSeconds: UInt32
  ) throws -> PersistentStory {
    try fileManager.createDirectory(at: localAssetsDirectory, withIntermediateDirectories: true)

    let audioFileName = "\(fixtureStory.id)-mock-audio-v2.wav"
    let coverFileName = "\(fixtureStory.id)-cover-v2.png"
    let audioURL = localAssetsDirectory.appendingPathComponent(audioFileName)
    let coverURL = localAssetsDirectory.appendingPathComponent(coverFileName)
    if !fileManager.fileExists(atPath: audioURL.path(percentEncoded: false)) {
      try MockAudioFile.writeAudibleWAV(to: audioURL, durationSeconds: audioDurationSeconds)
    }
    if !fileManager.fileExists(atPath: coverURL.path(percentEncoded: false)) {
      try writeCoverPNG(for: fixtureStory, to: coverURL)
    }

    let audioSize = try fileManager.attributesOfItem(atPath: audioURL.path(percentEncoded: false))[.size] as? NSNumber
    let coverSize = try fileManager.attributesOfItem(atPath: coverURL.path(percentEncoded: false))[.size] as? NSNumber
    let story = PersistentStory(
      id: fixtureStory.id,
      title: fixtureStory.title,
      synopsis: fixtureStory.synopsis,
      kind: kind,
      generationStatus: "completed",
      createdAt: now,
      updatedAt: now,
      durationSeconds: TimeInterval(fixtureStory.durationMinutes * 60)
    )

    story.assets = [
      PersistentAsset(
        id: "asset_\(fixtureStory.id)_audio",
        kind: "audio",
        localFileName: audioFileName,
        mimeType: "audio/wav",
        byteCount: audioSize?.int64Value,
        createdAt: now
      ),
      PersistentAsset(
        id: "asset_\(fixtureStory.id)_cover",
        kind: "coverImage",
        localFileName: coverFileName,
        mimeType: "image/png",
        byteCount: coverSize?.int64Value,
        createdAt: now
      )
    ]
    story.chapters = [
      PersistentChapter(
        id: "chapter_\(fixtureStory.id)_01",
        index: 1,
        title: "A Quiet Beginning",
        summary: "The story settles into its opening routines.",
        estimatedDurationSeconds: TimeInterval(fixtureStory.durationMinutes * 60 / 3),
        transcript: fixtureStory.transcriptSections.first?.text ?? fixtureStory.synopsis,
        sourceIDs: ["source_\(fixtureStory.id)_fixture"],
        story: story
      )
    ]
    story.sources = [
      PersistentSource(
        id: "source_\(fixtureStory.id)_fixture",
        title: "Sleepy History fixture dossier",
        publisher: "Sleepy History",
        notes: "Local fixture data for offline playback checks.",
        story: story
      )
    ]
    story.state = PersistentStoryState(
      storyID: fixtureStory.id,
      isDownloaded: true,
      downloadedAt: now,
      playbackDurationSeconds: TimeInterval(fixtureStory.durationMinutes * 60),
      updatedAt: now,
      story: story
    )

    return story
  }

  private static func slug(for value: String) -> String {
    let lowercased = value.lowercased()
    let scalars = lowercased.unicodeScalars.map { scalar -> Character in
      CharacterSet.alphanumerics.contains(scalar) ? Character(String(scalar)) : "-"
    }
    let collapsed = String(scalars).split(separator: "-").joined(separator: "-")
    return collapsed.isEmpty ? "untitled" : collapsed
  }

  private static func writeCoverPNG(for story: FixtureStory, to url: URL) throws {
    let size = CGSize(width: 1024, height: 1024)
    let palette = CoverPalette(title: story.title)
    let renderer = UIGraphicsImageRenderer(size: size)
    let data = renderer.pngData { context in
      let rect = CGRect(origin: .zero, size: size)
      let cgContext = context.cgContext
      let colors = [palette.top.cgColor, palette.middle.cgColor, palette.bottom.cgColor] as CFArray
      let locations: [CGFloat] = [0, 0.55, 1]
      let colorSpace = CGColorSpaceCreateDeviceRGB()
      if let gradient = CGGradient(colorsSpace: colorSpace, colors: colors, locations: locations) {
        cgContext.drawLinearGradient(
          gradient,
          start: CGPoint(x: rect.minX, y: rect.minY),
          end: CGPoint(x: rect.maxX, y: rect.maxY),
          options: []
        )
      }

      cgContext.setFillColor(palette.glow.withAlphaComponent(0.28).cgColor)
      cgContext.fillEllipse(in: CGRect(x: 620, y: -120, width: 420, height: 420))
      cgContext.setFillColor(UIColor.white.withAlphaComponent(0.08).cgColor)
      cgContext.fillEllipse(in: CGRect(x: -110, y: 620, width: 360, height: 360))

      cgContext.setStrokeColor(UIColor.white.withAlphaComponent(0.16).cgColor)
      cgContext.setLineWidth(2)
      for index in 0..<6 {
        let y = 220 + CGFloat(index) * 72
        cgContext.move(to: CGPoint(x: 118, y: y))
        cgContext.addCurve(
          to: CGPoint(x: 900, y: y + CGFloat(index % 2 == 0 ? 20 : -18)),
          control1: CGPoint(x: 320, y: y - 32),
          control2: CGPoint(x: 660, y: y + 42)
        )
        cgContext.strokePath()
      }

      let symbolConfiguration = UIImage.SymbolConfiguration(pointSize: 132, weight: .semibold)
      UIImage(systemName: "book.closed.fill", withConfiguration: symbolConfiguration)?
        .withTintColor(UIColor(red: 0.98, green: 0.86, blue: 0.64, alpha: 0.92), renderingMode: .alwaysOriginal)
        .draw(in: CGRect(x: 112, y: 650, width: 156, height: 156))

      cgContext.setFillColor(palette.glow.withAlphaComponent(0.18).cgColor)
      cgContext.fillEllipse(in: CGRect(x: 258, y: 744, width: 260, height: 64))
    }

    try data.write(to: url, options: .atomic)
    try DownloadFileStore.prepareForLockedPlayback(url)
  }

  private struct CoverPalette {
    let top: UIColor
    let middle: UIColor
    let bottom: UIColor
    let glow: UIColor

    init(title _: String) {
      top = UIColor(red: 0.90, green: 0.55, blue: 0.23, alpha: 1)
      middle = UIColor(red: 0.46, green: 0.24, blue: 0.18, alpha: 1)
      bottom = UIColor(red: 0.04, green: 0.08, blue: 0.09, alpha: 1)
      glow = UIColor(red: 0.98, green: 0.72, blue: 0.36, alpha: 1)
    }
  }
}

enum MockAudioFile {
  static func writeAudibleWAV(to url: URL, sampleRate: UInt32 = 8_000, durationSeconds: UInt32 = 600) throws {
    let channelCount: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    let bytesPerSample = UInt32(bitsPerSample / 8)
    let sampleCount = sampleRate * durationSeconds
    let dataByteCount = sampleCount * UInt32(channelCount) * bytesPerSample
    let byteRate = sampleRate * UInt32(channelCount) * bytesPerSample
    let blockAlign = channelCount * (bitsPerSample / 8)

    var data = Data()
    data.append(contentsOf: Array("RIFF".utf8))
    appendLittleEndian(UInt32(36) + dataByteCount, to: &data)
    data.append(contentsOf: Array("WAVE".utf8))
    data.append(contentsOf: Array("fmt ".utf8))
    appendLittleEndian(UInt32(16), to: &data)
    appendLittleEndian(UInt16(1), to: &data)
    appendLittleEndian(channelCount, to: &data)
    appendLittleEndian(sampleRate, to: &data)
    appendLittleEndian(byteRate, to: &data)
    appendLittleEndian(blockAlign, to: &data)
    appendLittleEndian(bitsPerSample, to: &data)
    data.append(contentsOf: Array("data".utf8))
    appendLittleEndian(dataByteCount, to: &data)

    for sampleIndex in 0..<sampleCount {
      let seconds = Double(sampleIndex) / Double(sampleRate)
      let envelope = 0.16 + 0.04 * sin(2 * Double.pi * seconds / 8)
      let lowTone = sin(2 * Double.pi * 220 * seconds)
      let warmTone = sin(2 * Double.pi * 330 * seconds) * 0.28
      let sample = Int16((lowTone + warmTone) * envelope * Double(Int16.max))
      appendLittleEndian(sample, to: &data)
    }

    try data.write(to: url, options: .atomic)
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    var mutableURL = url
    try mutableURL.setResourceValues(resourceValues)
  }

  private static func appendLittleEndian<Value: FixedWidthInteger>(_ value: Value, to data: inout Data) {
    var littleEndianValue = value.littleEndian
    withUnsafeBytes(of: &littleEndianValue) { bytes in
      data.append(contentsOf: bytes)
    }
  }
}
