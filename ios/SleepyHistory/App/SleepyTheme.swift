import SwiftUI

enum SleepyTheme {
  enum ColorToken {
    static let ink = Color(red: 0.01, green: 0.015, blue: 0.02)
    static let midnight = Color(red: 0.035, green: 0.05, blue: 0.06)
    static let evening = Color(red: 0.055, green: 0.075, blue: 0.085)
    static let canopy = Color(red: 0.075, green: 0.105, blue: 0.11)
    static let card = Color(red: 0.085, green: 0.105, blue: 0.115)
    static let cardRaised = Color(red: 0.12, green: 0.14, blue: 0.15)
    static let tabBar = Color(red: 0.075, green: 0.085, blue: 0.095)
    static let primaryText = Color(red: 0.965, green: 0.955, blue: 0.925)
    static let secondaryText = Color(red: 0.68, green: 0.68, blue: 0.66)
    static let tertiaryText = Color(red: 0.48, green: 0.50, blue: 0.50)
    static let parchment = primaryText
    static let parchmentMuted = secondaryText
    static let gold = Color(red: 0.96, green: 0.64, blue: 0.28)
    static let amber = Color(red: 0.86, green: 0.44, blue: 0.22)
    static let ember = Color(red: 0.42, green: 0.19, blue: 0.14)
    static let moon = Color(red: 0.72, green: 0.84, blue: 0.86)
    static let stroke = Color.white.opacity(0.095)
    static let separator = Color.white.opacity(0.075)
    static let glow = ColorToken.gold.opacity(0.20)
  }

  enum Typography {
    static let display = Font.system(.largeTitle, design: .default, weight: .bold)
    static let title = Font.system(.title2, design: .default, weight: .bold)
    static let cardTitle = Font.system(.headline, design: .default, weight: .semibold)
    static let body = Font.system(.body, design: .default, weight: .regular)
    static let callout = Font.system(.callout, design: .default, weight: .regular)
    static let caption = Font.system(.caption, design: .default, weight: .medium)
    static let label = Font.system(.caption2, design: .default, weight: .semibold)
  }

  enum Spacing {
    static let xxs: CGFloat = 4
    static let xs: CGFloat = 8
    static let sm: CGFloat = 12
    static let md: CGFloat = 16
    static let lg: CGFloat = 24
    static let xl: CGFloat = 32
  }

  enum Radius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 10
    static let lg: CGFloat = 12
    static let pill: CGFloat = 999
  }

  enum Icon {
    static let primarySize: CGFloat = 44
    static let secondarySize: CGFloat = 34
    static let symbolWeight: Font.Weight = .semibold
    static let symbolRenderingMode = SymbolRenderingMode.hierarchical
  }

  enum Shadow {
    static let cardColor = Color.black.opacity(0.18)
    static let glowColor = ColorToken.gold.opacity(0.16)
  }

  static let glassMaterial: Material = .ultraThinMaterial
  static let quietMaterial: Material = .thinMaterial

  static var eveningGradient: LinearGradient {
    LinearGradient(
      colors: [
        ColorToken.ink,
        ColorToken.midnight,
        ColorToken.evening
      ],
      startPoint: .topLeading,
      endPoint: .bottomTrailing
    )
  }

  static var artworkGradient: LinearGradient {
    LinearGradient(
      colors: [
        ColorToken.gold.opacity(0.96),
        ColorToken.amber,
        ColorToken.ember,
        ColorToken.midnight
      ],
      startPoint: .topLeading,
      endPoint: .bottomTrailing
    )
  }
}

struct SleepyCard<Content: View>: View {
  private let padding: CGFloat
  private let content: Content

  init(
    padding: CGFloat = SleepyTheme.Spacing.md,
    @ViewBuilder content: () -> Content
  ) {
    self.padding = padding
    self.content = content()
  }

  var body: some View {
    content
      .padding(padding)
      .background {
        RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
          .fill(SleepyTheme.ColorToken.card)
          .overlay {
            RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
              .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 0.75)
          }
      }
      .shadow(
        color: SleepyTheme.Shadow.cardColor,
        radius: 12,
        x: 0,
        y: 8
      )
  }
}

struct PrimaryIconButton: View {
  let systemName: String
  let accessibilityLabel: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: systemName)
        .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
        .font(.system(size: 18, weight: SleepyTheme.Icon.symbolWeight))
        .foregroundStyle(SleepyTheme.ColorToken.ink)
        .frame(
          width: SleepyTheme.Icon.primarySize,
          height: SleepyTheme.Icon.primarySize
        )
        .background {
          Circle()
            .fill(SleepyTheme.ColorToken.gold)
            .shadow(color: SleepyTheme.Shadow.glowColor, radius: 14, x: 0, y: 8)
        }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityLabel)
  }
}

struct SleepyIconBadge: View {
  let systemName: String

  var body: some View {
    Image(systemName: systemName)
      .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
      .font(.system(size: 15, weight: SleepyTheme.Icon.symbolWeight))
      .foregroundStyle(SleepyTheme.ColorToken.gold)
      .frame(
        width: SleepyTheme.Icon.secondarySize,
        height: SleepyTheme.Icon.secondarySize
      )
      .background {
        Circle()
          .fill(SleepyTheme.ColorToken.gold.opacity(0.12))
          .overlay {
            Circle()
              .stroke(SleepyTheme.ColorToken.gold.opacity(0.22), lineWidth: 1)
          }
      }
  }
}

struct SleepyPill: View {
  let text: String
  let systemName: String?

  init(_ text: String, systemName: String? = nil) {
    self.text = text
    self.systemName = systemName
  }

  var body: some View {
    HStack(spacing: SleepyTheme.Spacing.xs) {
      if let systemName {
        Image(systemName: systemName)
          .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
      }

      Text(text)
    }
    .font(SleepyTheme.Typography.label)
    .foregroundStyle(SleepyTheme.ColorToken.parchment)
    .padding(.horizontal, SleepyTheme.Spacing.sm)
    .padding(.vertical, SleepyTheme.Spacing.xs)
    .background {
      Capsule()
        .fill(SleepyTheme.ColorToken.cardRaised.opacity(0.72))
        .overlay {
          Capsule()
            .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
        }
    }
  }
}
