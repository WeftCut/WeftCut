/// Content-Type for a `weftcut-media://` body, keyed by file extension.
///
/// Two kinds of consumer, two different needs. For video/audio containers the
/// exact type is cosmetic: what matters is that it is NOT text, so Chromium's
/// loader skips the main-thread `TextResourceDecoder` pass over the body (the
/// header comment at the `weftcut-media` handler in index.ts has the
/// measurement); a container mediabunny does not recognise falls back to
/// `application/octet-stream`, which is equally non-text. For images the type is
/// load-bearing: WebCodecs `ImageDecoder` refuses `application/octet-stream`
/// outright (`createImageBitmap` sniffs bytes, `ImageDecoder` does not), so a
/// generic type here freezes every animated image to its first frame. Every
/// image the renderer's animated path decodes therefore needs its real type —
/// twin of `EXT_MIME` in renderer/render/sprite/animatedImageCache.ts, the
/// renderer's own fallback when this header is missing or generic.
export function mediaMimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.webm':
      return 'video/webm'
    case '.mkv':
      return 'video/x-matroska'
    case '.m4a':
      return 'audio/mp4'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.png':
      return 'image/png'
    case '.apng':
      return 'image/apng'
    case '.avif':
      return 'image/avif'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    default:
      return 'application/octet-stream'
  }
}
