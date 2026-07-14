import SwiftUI

struct CachedArtworkImage<Placeholder: View>: View {
  let storyId: String
  let variant: ArtworkVariant
  let cache: ArtworkCache
  @ViewBuilder var placeholder: () -> Placeholder

  var body: some View {
    #if canImport(UIKit)
    if let image = try? cache.cachedImage(storyId: storyId, variant: variant) {
      Image(uiImage: image)
        .resizable()
    } else {
      placeholder()
    }
    #else
    placeholder()
    #endif
  }
}
