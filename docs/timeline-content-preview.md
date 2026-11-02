# Timeline Content Preview

Timeline clips show their content: a filmstrip for video, a waveform for
audio, the image for stills, and a poster for Groups. Content is drawn behind
the block's chrome, as a progressive enhancement. A missing tile or peaks file
never blocks editing and never turns the clip into an error banner.

`TimelineVisualPreview` dispatches by layer kind and gates resources.
`LayerBlock` owns geometry, interaction and chrome (labels, selection, lock,
group accent). `computeLayerSlices` (`timeline/geometry.ts`) puts a track's
visual layer in the top half and its audio layer in the bottom half, so a
paired clip shows the filmstrip above the waveform.

## Gating

Decisions use the rendered pixel width, not the duration:

| Width | Behavior |
| --- | --- |
| `< 16px` (`LAYER_PREVIEW_MIN_PX`) | Colour only; no tile or peaks requests |
| `16–48px` | Content, no label |
| `≥ 48px` (`layerLabelMin` × UI scale) | Content plus label |
| `> 120px` (`layerFullLabelMin` × UI scale) | Full label and status affordances |

An `IntersectionObserver` (margin `256px 512px`) enables requests only near
the viewport. Resources are cached per media id and shared across clips. A
`media:job_complete` event invalidates only that media id.

## Per kind

- **VideoClip**: filmstrip (below).
- **Audio**: waveform (below). It draws the baked-effect peaks when a bake is
  ready, otherwise the conform's peaks, so the picture matches what plays
  ([audio.md](audio.md#clip-effects-baked)).
- **ImageOverlay**: the file via `convertFileSrc`, `object-fit: contain`, or
  a plain fill when the file is unavailable.
- **CompositionRef (Group)**: a `contain` poster of the earliest video inside
  the composition, or a plain fill. It is a still, because a filmstrip cannot
  map a Group's window onto more than one inner clip.
- **Color**: the actual colour.
- **Text**: a plain fill only. The sticky name chip carries the text
  (`layerName.ts`). Drawing it in the body as well put two strings on one line.
- **Motif**: a patterned fill. Motifs have no dynamic thumbnail.

## Filmstrip

`TimelineFilmstrip` with `timeline/tileEngine/` (`TileEngine.ts`,
`FilmstripTileProducer.ts`):

- Tiles sit on a time grid `(lod, index)`. Spacing is 250 ms at lod 0 and
  doubles each level up to lod 12. The grid does not depend on zoom or lane
  height, so panning, zooming and resizing never invalidate fetched tiles.
- Tiles are extracted at a fixed height of 256 px (`FILMSTRIP_TILE_HEIGHT`).
  Each is placed at its own source timestamp, using the clip's
  `src_in_us`..`src_out_us` window, and keeps its natural aspect ratio.
  Trimming re-flows tiles and never stretches them.
- The target lod is chosen from the on-screen width of one thumbnail.
  Requests are debounced by 140 ms. Mounts, media switches, completions and
  segments scrolling into view request immediately. Drawing uses fixed-width
  canvas segments. Only visible segments (±1) fetch, paint or allocate a
  backing store.
- Zooming never blanks the strip. Levels up to 3 steps on either side of the
  target are painted as fallback: finer first, then coarser, then the target
  on top. Only the target level's own tiles decide whether the placeholder
  shows.
- The renderer keeps at most 4 tile fetches in flight.

`getFilmstripTile(mediaId, lod, index)` returns `{ path, widthPx, heightPx }`.
`path` points to a cached JPG at
`<cache>/filmstrip/<hash>/<src>/<lod>/<index:06>.jpg`, where `<src>` is
`orig`, `quick` or `full`. The layout trusts the decoded bitmap's own size.
The source is chosen by `filmstrip_decode_source`
(`native/src/commands/media.rs`):

- `Bypass`, `DirectExport` and `NativeSw` extract from the original.
- `Proxied` extracts from the quick proxy, or failing that the full proxy. It
  never extracts from the original. With no proxy yet it rejects with
  `not_ready`, and the tile fills in when the proxy job completes.
- `<src>` is part of the key, so a route change re-extracts. Old tiles age out
  through the disk LRU.

## Waveform

`TimelineWaveform` with `WaveformTileProducer.ts`:

- `getWaveformLevels(mediaId)` returns the LOD table.
  `getWaveformTile(mediaId, level, channel, startPeak, count)` returns
  dequantized min/max (−1..1) and RMS (0..1) for each window.
- Peaks files (format v4) store each level's exact `frames_per_peak` and the
  sample rate. Index by the fractional `peaksPerSecond`: 22 050 Hz / 352 is
  62.642… peaks/s, not 62. Rounding causes drift that grows with source time.
- The producer picks the coarsest level that is dense enough for the zoom.
  The strip draws a soft min/max envelope with a brighter RMS core and a 1 px
  floor, so quiet audio stays visible. Silence draws only the envelope line.
- A stereo slice at least 28 px tall draws two lanes (L above R). Shorter
  slices, and mono sources, draw one merged lane.
- Zoom and scroll keep the old envelope stretched while a 120 ms-debounced
  refetch runs. A media switch clears immediately.
- `getWaveformPeaks(mediaId)` is the coarse max-abs reader kept for MCP.

## Other derivatives and the disk cache

- The import thumbnail job writes 10 JPGs (`000.jpg`–`009.jpg`).
  `getMediaThumbnail` returns the middle one (`004.jpg`) as the media-pool
  poster. The timeline does not use them.
- `filmstrip/`, `thumbnails/` and `waveforms/` are cheap to regenerate. A
  cache read refreshes a file's mtime. `native/src/cache/disk_lru.rs` evicts
  oldest-first down to 90 % of the Temporary cache space budget
  (`resources::disk_cache_bytes()`; see
  [performance-settings.md](performance-settings.md)).
