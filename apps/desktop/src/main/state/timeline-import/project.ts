import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canvasSizeError } from '../../../shared/newProject'
import type { ExactTime } from '../../../shared/timeMapping'
import { affineTimeMap, ceilTime, compareTime, divideTime, exactTime, floorTime, multiplyTime, roundTime, subtractTime } from '../../../renderer/timeMapping'
import { splitExact, writeSourceWindow } from '../../../renderer/layerTiming'
import { ffprobeColorToWebCodecs } from '../../../renderer/render/decoder/ffprobeColorSpace'
import { createActor } from '../actor'
import { type IdGen } from '../ids'
import { createMediaImporter, type MediaImportDeps } from '../mediaImport'
import { blankProject, newComposition, rootComposition, type AudioParams, type Composition, type CompositionRefParams, type Layer, type MediaItem, type Project } from '../model'
import { applyAddTrack, DEFAULT_MARKER_COLOR, defaultTransform } from '../mutations/add'
import { audioParams, imageOverlayParams, videoClipParams } from '../mutations/media'
import { applyDurationAutofit } from '../mutations/helpers'
import { AUDIO_GRID, timeUsAtFrame, timeUsAtGridIndex } from '../snap'
import { sourceInstantHibernating, sourceInstantTimelineUs } from '../summary'
import { validate } from '../validate'
import { FCPXML_LIMITS, inspectFcpxml, listFcpxmlSequences, TimelineEditFailure } from './fcpxml'
import type { ImportTimeline, TimelineClip, TimelineMediaReference, TimelineSourceWindow } from './timeline'
import type { TimelineImportReport, TimelineCompatibilityItem, TimelineMediaChange, TimelineMediaGap, TimelineMediaIssue, TimelineMediaReplacement, TimelineMediaReview, TimelineSequenceList } from '../../../shared/timelineImport'
import { originalMediaPath } from './mediaPath'
import { MAX_VIDEO_IN_POINTS, readVideoInPoints } from './videoTiming'

export class TimelineMediaFailure extends Error {
  constructor(
    readonly issues: TimelineMediaIssue[],
    readonly canSearchFolder: boolean,
    readonly editIssues: TimelineCompatibilityItem[],
    readonly mediaChanges: TimelineMediaChange[] = [],
    readonly mediaReview?: TimelineMediaReview,
  ) {
    super(issues.map(issue => issue.detail).join('\n'))
  }
}

type ImageSize = { width: number; height: number }
export type TimelineMediaProbe = {
  item: MediaItem
  streams: { video_us: number | null; audio_us: number | null }
}
type MediaDeps = Pick<MediaImportDeps, 'compute' | 'statPath' | 'realPath' | 'fileKey'> & {
  inspectMedia?(path: string): Promise<TimelineMediaProbe>
  inspectImage?(path: string): Promise<ImageSize | 'too-large' | null>
}

async function readTimelineDocument(path: string, deps: MediaDeps): Promise<string> {
  const before = await lstat(path).catch(() => null)
  if (!before?.isFile() || before.isSymbolicLink()) throw new Error('Choose a regular timeline file, rather than a symlink or device')
  const facts = deps.statPath(path)
  if (facts?.kind !== 'file' || !facts.readable) throw new Error('The selected timeline file is missing or unreadable')
  // Nonblocking open prevents a swapped-in FIFO from hanging the editor.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error('The timeline file changed during import. Try again after the file is ready')
    }
    if (stat.size > FCPXML_LIMITS.bytes) throw new Error('Choose a regular timeline file up to 16 MiB')
    const data = Buffer.alloc(stat.size + 1)
    let read = 0
    while (read < data.length) {
      const result = await file.read(data, read, data.length - read, read)
      if (result.bytesRead === 0) break
      read += result.bytesRead
    }
    if (read !== stat.size) throw new Error('The timeline file changed during import. Try again after the file is ready')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, read)) }
    catch { throw new Error('Export the timeline document as UTF-8 and try again') }
  } finally { await file.close() }
}

async function resolveTimelineInput(path: unknown): Promise<{ inputFile: string; extension: string }> {
  const extension = typeof path === 'string' && isAbsolute(path) ? extname(path).toLowerCase() : ''
  if (typeof path !== 'string' || !['.fcpxml', '.fcpxmld'].includes(extension)) {
    throw new Error('Choose a local .fcpxml, .fcpxmld bundle')
  }
  let inputFile = resolve(path)
  if (extension === '.fcpxmld') {
    const bundle = await lstat(inputFile).catch(() => null)
    if (!bundle?.isDirectory() || bundle.isSymbolicLink()) {
      throw new Error('The FCPXML bundle must be an accessible .fcpxmld directory')
    }
    inputFile = join(inputFile, 'Info.fcpxml')
    const info = await lstat(inputFile).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error('The FCPXML bundle needs a regular Info.fcpxml file at its root')
    }
  }
  return { inputFile, extension }
}

const documentId = (xml: string) => createHash('sha256').update(xml).digest('hex')

export async function listTimelineSequences(path: unknown, deps: MediaDeps): Promise<TimelineSequenceList> {
  const { inputFile } = await resolveTimelineInput(path)
  const xml = await readTimelineDocument(inputFile, deps)
  return { documentId: documentId(xml), choices: listFcpxmlSequences(xml) }
}

function comparableFilename(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

async function findRelinkCandidates(directory: string, wanted: ReadonlySet<string>): Promise<{
  exact: Map<string, string>; suggestions: Map<string, string[]>
}> {
  const root = await realpath(directory)
  const entries = await opendir(root)
  const exact = new Map<string, string>()
  const suggestions = new Map<string, string[]>()
  const wantedNames = new Set([...wanted].map(comparableFilename))
  const maxSuggestions = 5
  let scanned = 0
  for await (const entry of entries) {
    if (++scanned > FCPXML_LIMITS.directoryEntries) throw new Error('The relink folder contains too many entries. Choose a smaller folder containing the original files')
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const key = comparableFilename(entry.name)
    if (!wantedNames.has(key)) continue
    const isExact = wanted.has(entry.name)
    const matches = suggestions.get(key) ?? []
    if (!isExact && matches.length > maxSuggestions) continue
    const candidate = join(root, entry.name)
    const actual = await realpath(candidate).catch(() => null)
    const info = await lstat(candidate).catch(() => null)
    if (!actual || !info?.isFile() || info.isSymbolicLink() || relative(root, dirname(actual)) !== '') continue
    if (isExact) exact.set(entry.name, actual)
    if (matches.length <= maxSuggestions) suggestions.set(key, [...matches, actual])
    if (exact.size === wanted.size) break
  }
  for (const [key, matches] of suggestions) {
    if (matches.length > maxSuggestions) suggestions.delete(key)
    else matches.sort()
  }
  return { exact, suggestions }
}

function replacementSelection(replacements: unknown, originals: ReadonlyMap<string, { asset: TimelineMediaReference }>,
  revalidateReplacements: boolean,
): TimelineMediaReview {
  const result: TimelineMediaReview = { replacements: [], unmatchedReplacements: [] }
  if (replacements === undefined) return result
  if (!Array.isArray(replacements) || replacements.length > FCPXML_LIMITS.mediaFiles ||
      (!revalidateReplacements && replacements.length > originals.size)) {
    throw new Error('Choose at most one replacement per media asset')
  }
  const identities = new Map<string, string>()
  const byIdentity = new Map<string, string | null>()
  for (const { asset } of originals.values()) {
    const identity = createHash('sha256').update(JSON.stringify([asset.path, asset.uid, asset.signature])).digest('hex')
    identities.set(asset.ref, identity)
    byIdentity.set(identity, byIdentity.has(identity) ? null : asset.ref)
  }
  const validated = new Map<string, TimelineMediaReplacement | null>()
  const seen = new Set<string>()
  const unmatched = (path: string) => { result.unmatchedReplacements.push(basename(path)) }
  for (const choice of replacements) {
    if (!choice || typeof choice.assetRef !== 'string' || typeof choice.path !== 'string' || !isAbsolute(choice.path)) {
      throw new Error('Choose a local replacement file for each source')
    }
    if (seen.has(choice.assetRef)) throw new Error('The replacement does not identify a unique asset in this sequence')
    seen.add(choice.assetRef)
    const sourceHint = typeof choice.sourceIdentity === 'string' ? choice.sourceIdentity : undefined
    const ref = revalidateReplacements ? (sourceHint ? byIdentity.get(sourceHint) : undefined) : choice.assetRef
    const sourceIdentity = ref ? identities.get(ref) : undefined
    if (!ref || sourceIdentity === undefined) {
      if (!revalidateReplacements) throw new Error('The replacement does not identify a unique asset in this sequence')
      unmatched(choice.path)
      continue
    }
    if (validated.has(ref)) {
      const previous = validated.get(ref)
      if (previous) unmatched(previous.path)
      unmatched(choice.path)
      validated.set(ref, null)
      continue
    }
    const path = originalMediaPath(pathToFileURL(choice.path).href).path
    const reused = revalidateReplacements || (choice.reused === true && sourceHint === sourceIdentity)
    validated.set(ref, { assetRef: ref, path,
      ...(byIdentity.get(sourceIdentity) === ref ? { sourceIdentity } : {}), ...(reused ? { reused: true } : {}) })
  }
  result.replacements = [...validated.values()].filter(choice => choice !== null)
  return result
}

export async function prepareTimelineProject(
  path: unknown, destination: string | null, idGen: IdGen, deps: MediaDeps, assertCurrent: () => void,
  relinkDirectory?: unknown, sequenceIndex?: unknown, existing?: Project, replacements?: unknown, expectedDocument?: unknown, omitEffects = false, leaveTitleGaps = false,
  revalidateReplacements = false, leaveMediaGaps?: unknown,
): Promise<{ project: Project; report: TimelineImportReport; assertDocumentUnchanged: () => Promise<void> }> {
  const { inputFile, extension } = await resolveTimelineInput(path)
  if (sequenceIndex !== undefined &&
      (!Number.isSafeInteger(sequenceIndex) || (sequenceIndex as number) < 0)) {
    throw new Error('Choose a valid FCPXML sequence index')
  }
  const document = await readTimelineDocument(inputFile, deps)
  const reviewedDocumentId = documentId(document)
  if (expectedDocument !== undefined && expectedDocument !== reviewedDocumentId) {
    throw new Error('The FCPXML file changed since you opened it. Choose it again to review the updated timeline.')
  }
  const inspection = inspectFcpxml(document, sequenceIndex as number | undefined, omitEffects, leaveTitleGaps)
  const timeline = 'timeline' in inspection ? inspection.timeline : undefined
  assertCurrent()
  const initial = blankProject(idGen, timeline?.name?.trim() || basename(inputFile, extname(inputFile)))
  if (timeline) rootComposition(initial).fps = timeline.fps
  if (existing) {
    initial.media_pool = existing.media_pool
    const parent = rootComposition(existing)
    rootComposition(initial).sample_rate = parent.sample_rate
    rootComposition(initial).channels = parent.channels
  }
  const actor = createActor({ initial, idGen, clock: () => new Date().toISOString() })
  // Stage registration through the normal importer against the destination's
  // pool. Disk jobs wait for confirmation; cancellation discards this actor.
  const streamDurations = new Map<string, TimelineMediaProbe['streams']>()
  const importer = createMediaImporter({
    ...deps, actor, workspaceDir: () => destination,
    compute: {
      ...deps.compute,
      async probeMedia(path) {
        if (!deps.inspectMedia) return deps.compute.probeMedia(path)
        const { item, streams } = await deps.inspectMedia(path)
        streamDurations.set(path, streams)
        return JSON.stringify(item)
      },
    },
    enqueueDerivatives: async () => {}, enqueueWorkspaceCopy: async () => {},
  })
  let relinkRoot: string | undefined
  if (relinkDirectory !== undefined) {
    if (typeof relinkDirectory !== 'string' || !isAbsolute(relinkDirectory)) {
      throw new Error('Choose an absolute media folder for relinking')
    }
    relinkRoot = resolve(relinkDirectory)
    const directory = await lstat(relinkRoot).catch(() => null)
    if (!directory?.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('The selected media folder is missing or is not a regular directory')
    }
  }
  const sequences = new Set<ImportTimeline>()
  const multicamSequences = new Set<ImportTimeline>()
  function visit(sequence: ImportTimeline): void {
    if (sequences.has(sequence)) return
    sequences.add(sequence)
    for (const group of sequence.groups) {
      if (group.kind === 'multicam') multicamSequences.add(group.timeline)
      visit(group.timeline)
    }
  }
  if (timeline) visit(timeline)
  const samplesPerUs = exactTime(AUDIO_GRID.num, 1_000_000)
  function sampleIndex(time: ExactTime, sequenceEnd: number) {
    const sample = multiplyTime(time, samplesPerUs)
    const nearest = roundTime(sample)
    // Rounding past the last frame would extend the composition by one frame.
    return timeUsAtGridIndex(nearest, AUDIO_GRID) <= sequenceEnd ? nearest : floorTime(sample)
  }
  const audioSamples = new Map<TimelineClip, { first: number; last: number }>()
  const omittedAudio = new Map<TimelineClip, TimelineCompatibilityItem>()
  for (const sequence of sequences) {
    const frameDuration = exactTime(1_000_000 * sequence.fps.den, sequence.fps.num)
    const end = timeUsAtFrame(sequence.durationFrames, sequence.fps.num, sequence.fps.den)
    for (const clip of sequence.clips) {
      if (!clip.audioRole) continue
      const window = clip.splitAudio ?? clip
      const first = sampleIndex(window.timelineStart, end)
      const last = sampleIndex(window.timelineEnd, end)
      if (last > first) {
        audioSamples.set(clip, { first, last })
        continue
      }
      const label = clip.label || clip.asset.name || clip.asset.filename
      const notes = ['Both audio edges land on the same 48 kHz sample boundary, leaving no audio to play. ' +
        'This sound and any settings specific to it will be left out. ' +
        'The surrounding edits keep their timing. To keep the sound, extend its trim in the source editor and export again.']
      if (sequence !== timeline) notes.push('This frame range is inside “' + (sequence.name ?? 'Imported Group') + '”.')
      if (!clip.hasVideo && clip.markers.length) {
        notes.push('Its markers stay on the timeline as independent markers.')
        for (const marker of clip.markers) notes.push(...marker.notes)
      }
      omittedAudio.set(clip, { location: clip.location, label, lane: clip.lane, status: 'approximated', notes,
        timelineFrames: { start: floorTime(divideTime(window.timelineStart, frameDuration)),
          end: ceilTime(divideTime(window.timelineEnd, frameDuration)) } })
    }
  }
  const clips = [...sequences].flatMap(sequence => sequence.clips)
  const retained = clips.filter(clip => clip.hasVideo || !omittedAudio.has(clip))
  const editIssues = 'issues' in inspection ? inspection.issues : [...sequences].flatMap(sequence => sequence.editIssues ?? [])
  const mediaUses = 'sources' in inspection ? inspection.sources : clips
  const originals = new Map<string, { asset: TimelineMediaReference; label: string; placements: number }>()
  for (const { asset, label } of mediaUses) {
    const original = originals.get(asset.ref)
    if (!original) originals.set(asset.ref, { asset, label: asset.name || label || asset.ref, placements: 0 })
  }
  for (const { asset } of 'sources' in inspection ? inspection.sources : retained) {
    originals.get(asset.ref)!.placements++
  }
  const mediaIssue = (asset: TimelineMediaReference, detail: string): TimelineMediaIssue => {
    const { label, placements } = originals.get(asset.ref)!
    return { assetRef: asset.ref, label, filename: asset.filename, sourcePath: asset.path, placements, detail }
  }
  const localProxies = (asset: TimelineMediaReference) => [...new Set(asset.proxies?.filter(proxy => proxy.local).map(proxy => proxy.path) ?? [])].slice(0, 5)
  const replacementIssue = (asset: TimelineMediaReference, detail: string, exclude?: string): TimelineMediaIssue => {
    const proxyPaths = localProxies(asset).filter(path => path !== exclude && path !== asset.path)
    return { ...mediaIssue(asset, detail), ...(proxyPaths.length ? { proxyPaths } : {}) }
  }
  if (originals.size > FCPXML_LIMITS.mediaFiles) {
    throw new Error('This sequence references too many media assets. Export the sequence in smaller parts')
  }
  const gapSelection = new Set<string>()
  if (leaveMediaGaps !== undefined) {
    if (!Array.isArray(leaveMediaGaps) || leaveMediaGaps.length > originals.size) {
      throw new Error('Choose media from this timeline to leave out')
    }
    for (const ref of leaveMediaGaps) {
      if (typeof ref !== 'string' || !originals.has(ref) || gapSelection.has(ref)) {
        throw new Error('Choose each source at most once in this timeline')
      }
      gapSelection.add(ref)
    }
  }
  const mediaReview = replacementSelection(replacements, originals, revalidateReplacements)
  const selected = new Map(mediaReview.replacements.map(choice => [choice.assetRef, choice.path]))

  async function checkFile(path: string): Promise<string> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Choose a regular file')
    const actual = await realpath(path)
    originalMediaPath(pathToFileURL(actual).href)
    return importer.checkPath(actual)
  }

  const resolved = new Map<string, { path: string; choice: 'original' | 'selected' | 'folder' }>()
  const offline: TimelineMediaReference[] = []
  const missing: TimelineMediaIssue[] = []
  const checkedPaths = new Map<string, Promise<string>>()
  for (const { asset, placements } of originals.values()) {
    if (placements === 0) continue
    const replacement = selected.get(asset.ref)
    const candidate = replacement ?? (asset.local ? asset.path : undefined)
    if (candidate !== undefined) {
      const checked = checkedPaths.get(candidate) ?? checkFile(candidate)
      checkedPaths.set(candidate, checked)
      try {
        resolved.set(asset.ref, { path: await checked, choice: replacement === undefined ? 'original' : 'selected' })
        continue
      } catch {
        if (replacement !== undefined) {
          missing.push(replacementIssue(asset, 'The chosen replacement is missing or unreadable. Choose another local file.', replacement))
          continue
        }
      }
    }
    offline.push(asset)
  }
  const candidates = relinkRoot && offline.length
    ? await findRelinkCandidates(relinkRoot, new Set(offline.map(asset => asset.filename)))
    : undefined
  for (const asset of offline) {
    const candidate = candidates?.exact.get(asset.filename)
    if (candidate !== undefined) {
      const checked = checkedPaths.get(candidate) ?? checkFile(candidate)
      checkedPaths.set(candidate, checked)
      try {
        resolved.set(asset.ref, { path: await checked, choice: 'folder' })
        continue
      } catch { /* Leave this asset unresolved. */ }
    }
    const issue = replacementIssue(asset, 'Missing or unreadable original media: ' + asset.path +
      (asset.local ? '' : ' (path is from another platform)') + '. Choose the original file or look for it in a folder.')
    const suggestions = candidates?.suggestions.get(comparableFilename(asset.filename))?.filter(path => path !== candidate)
    if (suggestions?.length) issue.suggestedPaths = suggestions
    missing.push(issue)
  }

  const fileKeys = new Map<string, string>()
  const originalPathsByFile = new Map<string, Set<string>>()
  for (const [ref, { path }] of resolved) {
    const key = fileKeys.get(path) ?? deps.fileKey?.(path) ?? deps.realPath?.(path) ?? path
    fileKeys.set(path, key)
    const originalsForFile = originalPathsByFile.get(key) ?? new Set<string>()
    originalsForFile.add(originals.get(ref)!.asset.path)
    originalPathsByFile.set(key, originalsForFile)
  }
  for (const [ref, { path, choice }] of resolved) {
    if (choice !== 'folder' || originalPathsByFile.get(fileKeys.get(path)!)!.size <= 1) continue
    missing.push({ ...replacementIssue(originals.get(ref)!.asset, 'Ambiguous media relink. More than one original matches this file. Choose the file for this asset.'),
      suggestedPaths: [path] })
    resolved.delete(ref)
  }

  const mediaChanges = new Map<string, TimelineMediaChange>()
  for (const choice of mediaReview.replacements) {
    const selectedPath = resolved.get(choice.assetRef)?.path
    if (!choice.reused || selectedPath === undefined) continue
    const { asset } = originals.get(choice.assetRef)!
    const kind = 'reused-replacement'
    const issue = mediaIssue(asset, 'The updated timeline still references the same original. ' +
      'WeftCut kept your earlier choice of “' + basename(selectedPath) + '”. Check that this is the file you want to use.')
    mediaChanges.set(JSON.stringify([asset.ref, kind]), { ...issue, kind, sourcePath: selectedPath })
  }
  if (!timeline) {
    const changes = [...mediaChanges.values()]
    if (missing.length) throw new TimelineMediaFailure(missing, offline.length > 0, editIssues, changes, mediaReview)
    throw new TimelineEditFailure(editIssues, false, changes, mediaReview)
  }

  const stillAssets = new Set(clips.filter(clip => clip.asset.stillImage).map(clip => clip.asset.ref))
  const relinkedMedia: TimelineImportReport['relinkedMedia'] = []
  const mediaIds = new Map<string, string>()
  const failed: TimelineMediaIssue[] = []
  const importedPaths = new Map<string, ReturnType<typeof importer.ensureImported>>()
  for (const [ref, { path: mediaPath, choice }] of resolved) {
    assertCurrent()
    const { asset, label } = originals.get(ref)!
    try {
      const imported = importedPaths.get(mediaPath) ?? importer.ensureImported(mediaPath)
      importedPaths.set(mediaPath, imported)
      const result = await imported
      if (result.disposition === 'relinked' && existing?.media_pool[result.mediaId]) {
        throw new Error('An existing pool item needs repair. Relink it through the media pool before reviewing this timeline')
      }
      mediaIds.set(ref, result.mediaId)
      if (choice !== 'original' && asset.path !== mediaPath) relinkedMedia.push({ assetRef: ref, label, from: asset.path, to: mediaPath })
    } catch (error) {
      assertCurrent()
      const remedy = stillAssets.has(ref) ? 'Choose another image or save a PNG copy and select it. '
        : 'Choose another file or export a compatible copy. '
      failed.push(replacementIssue(asset, 'Could not read ' + mediaPath + '. ' + remedy +
        (error instanceof Error ? error.message : String(error)), selected.get(ref)))
    }
  }
  assertCurrent()
  const snapshot = actor.snapshot()
  const root = rootComposition(snapshot)
  const itemOf = (clip: TimelineClip) => snapshot.media_pool[mediaIds.get(clip.asset.ref)!]!
  const sourceEnds = new Map<TimelineClip, { videoEnd: ExactTime; audioEnd: ExactTime }>()
  for (const [ref, { path, choice }] of resolved) {
    const { asset } = originals.get(ref)!
    const chosen = selected.get(ref) ?? path
    if (choice === 'original' || !mediaIds.has(ref) || !asset.proxies?.some(proxy => proxy.local && (proxy.path === chosen || proxy.path === path))) continue
    const kind = 'proxy-source'
    const issue = mediaIssue(asset, 'The selected file is a proxy. WeftCut will use this copy for editing and export. ' +
      'It may have lower picture or sound quality. The original cut times stay in place.')
    mediaChanges.set(JSON.stringify([ref, kind]), { ...issue, kind, sourcePath: path })
  }
  const pointsByPath = new Map<string, Set<number>>()
  const maxTimingChecks = 4_096
  let timingChecks = 0
  for (const clip of clips) {
    const video = itemOf(clip)?.metadata.video
    if (!clip.hasVideo || clip.asset.stillImage || !video?.fps_num || !video.fps_den ||
        !Number.isSafeInteger(video.fps_num) || !Number.isSafeInteger(video.fps_den)) continue
    const frame = exactTime(1_000_000 * video.fps_den, video.fps_num)
    if (divideTime(clip.sourceIn, frame).den === 1) continue
    const path = itemOf(clip).path_abs
    const points = pointsByPath.get(path) ?? new Set<number>()
    const time = clip.sourceIn.num / clip.sourceIn.den
    if (points.size >= MAX_VIDEO_IN_POINTS || timingChecks >= maxTimingChecks || points.has(time)) continue
    points.add(time)
    pointsByPath.set(path, points)
    timingChecks++
  }
  const verifiedPoints = new Map<string, Map<number, number>>()
  for (const [path, points] of pointsByPath) {
    assertCurrent()
    try {
      const checked = await checkFile(path)
      const frames = await readVideoInPoints(checked, [...points].sort((a, b) => a - b), assertCurrent)
      verifiedPoints.set(path, frames)
    } catch { /* Validation below gives the affected file a recovery action. */ }
    assertCurrent()
  }
  const incompatibilities = new Map<string, { issue: TimelineMediaIssue; clips: TimelineClip[] }>()
  const imageSizes = new Map<string, ImageSize>()
  const imageChecks = new Map<string, Promise<ImageSize>>()
  async function checkImage(path: string, inspect: NonNullable<MediaDeps['inspectImage']>): Promise<ImageSize> {
    let size: Awaited<ReturnType<typeof inspect>>
    try { size = await inspect(await checkFile(path)) }
    catch {
      throw new Error('WeftCut could not check this image. Review again or choose a readable PNG copy.')
    }
    if (size === 'too-large') {
      throw new Error('This image is too large to check during import. Save a copy smaller than 256 MiB and choose it as the replacement.')
    }
    if (!size?.width || !size.height) {
      throw new Error('WeftCut found this image, but its editor cannot display it. Save the image as a PNG and choose that copy. The clip keeps its timing.')
    }
    return size
  }
  for (const clip of retained) {
    const item = itemOf(clip)
    if (!item) continue
    try {
      const actualFrameUs = verifiedPoints.get(item.path_abs)?.get(clip.sourceIn.num / clip.sourceIn.den)
      if (deps.inspectImage && clip.asset.stillImage && item.kind === 'Image') {
        const checked = imageChecks.get(item.path_abs) ?? checkImage(item.path_abs, deps.inspectImage)
        imageChecks.set(item.path_abs, checked)
        imageSizes.set(item.id, await checked)
        assertCurrent()
      }
      const played = omittedAudio.has(clip) ? { ...clip, audioRole: null } : clip
      const result = validateSource(played, item, streamDurations.get(resolved.get(clip.asset.ref)!.path),
        actualFrameUs, imageSizes.get(item.id))
      sourceEnds.set(clip, result)
      for (const { kind, detail } of result.changes) {
        const issue = mediaIssue(clip.asset, detail)
        mediaChanges.set(JSON.stringify([clip.asset.ref, kind, detail]), { ...issue, kind, sourcePath: item.path_abs })
      }
    } catch (error) {
      assertCurrent()
      const detail = error instanceof Error ? error.message : String(error)
      const key = JSON.stringify([clip.asset.ref, detail])
      const known = incompatibilities.get(key)
      if (known) known.clips.push(clip)
      else incompatibilities.set(key, { issue: replacementIssue(clip.asset, detail, selected.get(clip.asset.ref)), clips: [clip] })
    }
  }
  const clipsByAsset = new Map<string, TimelineClip[]>()
  for (const clip of retained) {
    const siblings = clipsByAsset.get(clip.asset.ref) ?? []
    siblings.push(clip)
    clipsByAsset.set(clip.asset.ref, siblings)
  }
  const transitionClips = new Set<TimelineClip>()
  for (const sequence of sequences) {
    for (const dissolve of sequence.dissolves ?? []) {
      transitionClips.add(dissolve.from)
      transitionClips.add(dissolve.to)
    }
  }
  const unavailable: TimelineMediaIssue[] = []
  const gapReasons = new Map<TimelineClip, string>()
  for (const { issue, clips: affected } of [
    ...[...missing, ...failed].map(issue => ({ issue, clips: clipsByAsset.get(issue.assetRef) ?? [] })),
    ...incompatibilities.values(),
  ]) {
    const requiredForTransition = affected.some(clip => transitionClips.has(clip))
    if (!affected.length || requiredForTransition || !timeline.canvas) {
      unavailable.push(requiredForTransition
        ? { ...issue, detail: issue.detail + ' A transition needs this media. Replace the file or render the transition in the source editor.' }
        : issue)
    } else if (!gapSelection.has(issue.assetRef)) {
      unavailable.push({ ...issue, canLeaveGaps: true, placements: affected.length })
    } else {
      for (const clip of affected) gapReasons.set(clip, issue.detail)
    }
  }
  const gaps = new Map<TimelineClip, TimelineMediaGap>()
  for (const sequence of sequences) {
    const duration = exactTime(1_000_000 * sequence.fps.den, sequence.fps.num)
    for (const clip of sequence.clips) {
      const reason = gapReasons.get(clip)
      if (reason === undefined) continue
      const { ref, filename } = clip.asset
      const notes = [reason, 'This clip and its settings will be left out. Its place in the edit is marked so you can add a replacement later. ' +
        'Other cuts stay at their original times.']
      if (sequence !== timeline) notes.push('This frame range is inside “' + (sequence.name ?? 'Imported Group') + '”.')
      if (clip.markers.length) {
        notes.push('Its markers keep their timeline positions as shown in this review and can be moved independently.')
        for (const marker of clip.markers) notes.push(...marker.notes)
      }
      const start = clip.splitAudio ? Math.min(clip.firstFrame, floorTime(divideTime(clip.splitAudio.timelineStart, duration))) : clip.firstFrame
      const end = clip.splitAudio ? Math.max(clip.endFrame, ceilTime(divideTime(clip.splitAudio.timelineEnd, duration))) : clip.endFrame
      gaps.set(clip, { assetRef: ref, filename, label: clip.label || clip.asset.name || filename,
        lane: clip.lane, location: clip.location, status: 'approximated', notes, timelineFrames: { start, end } })
    }
  }
  const mediaGaps = [...gaps.values()]
  const omittedShortAudio = [...omittedAudio].filter(([clip]) => !gaps.has(clip)).map(([, issue]) => issue)
  const blockedEdits = [...editIssues, ...omittedShortAudio, ...mediaGaps]
  const playable = retained.filter(clip => !gaps.has(clip))
  const activeAssetRefs = new Set(playable.map(({ asset }) => asset.ref))
  const activeChanges = [...mediaChanges.values()].filter(change => activeAssetRefs.has(change.assetRef))
  if (unavailable.length) {
    throw new TimelineMediaFailure(unavailable, offline.length > 0, blockedEdits, activeChanges, mediaReview)
  }
  if (editIssues.length) throw new TimelineEditFailure(blockedEdits, editIssues.some(issue => issue.recovery === 'omit-effect'),
    activeChanges, mediaReview)
  const video = timeline.canvas ? null : itemOf(playable[0]!).metadata.video
  const width = timeline.canvas?.width ?? video?.width ?? 0
  const height = timeline.canvas?.height ?? video?.height ?? 0
  if (canvasSizeError(width, height)) throw new Error('The original media must have a supported even-sized WeftCut canvas')
  const target = { ...root, width, height, tracks: root.tracks.map((track) => ({ ...track, layers: [] as Layer[] })),
    links: [...root.links], markers: [...root.markers] }
  const usedMedia = new Set(playable.map(clip => mediaIds.get(clip.asset.ref)!))
  const project = { ...snapshot,
    media_pool: Object.fromEntries(Object.entries(snapshot.media_pool).filter(([id]) => usedMedia.has(id))),
    compositions: { ...snapshot.compositions, [root.id]: target } }
  let videoClips = 0
  let audioClips = 0
  let roundedEnds = 0
  let resampledAudioClips = 0
  let downmixedAudioClips = 0
  let rateConformedVideoClips = 0
  let resizedVideoClips = 0
  const videoConversions = new Map<string, TimelineImportReport['videoConversions'][number]>()
  const compatibilityItems: TimelineCompatibilityItem[] = [...sequences].flatMap(sequence => sequence.notices)
  const built = new Map<ImportTimeline, Composition>([[timeline, target]])
  const allLanes = [...new Set(playable.map(clip => clip.lane).concat(timeline.groups.length ? [0] : []))].sort((a, b) => a - b)

  function mapSequence(sequence: ImportTimeline, target: Composition): void {
    const laneIds = new Map([[0, target.tracks[0]!.id]])
    const layers = sequence.clips.filter(clip => !gaps.has(clip) && (clip.hasVideo || !omittedAudio.has(clip)))
    const lanes = [...new Set(layers.map(clip => clip.lane))].sort((a, b) => a - b)
    let lowerTracks = 0
    let firstOverlay = true
    for (const lane of lanes) {
      if (lane < 0) laneIds.set(lane, applyAddTrack(project, idGen, null, lowerTracks++, target.id))
      if (lane > 0) {
        laneIds.set(lane, firstOverlay ? target.tracks[lowerTracks + 1]!.id : applyAddTrack(project, idGen, null, undefined, target.id))
        firstOverlay = false
      }
    }
    const tracks = new Map(target.tracks.map((track) => [track.id, track]))
    const boundary = (frame: number) => timeUsAtFrame(frame, target.fps.num, target.fps.den)
    const sequenceEnd = boundary(sequence.durationFrames)
    function addMarkers(clip: TimelineClip, layer: Layer | null, notes?: string[]) {
      for (const mark of clip.markers) {
        notes?.push(...mark.notes)
        const t_us = boundary(mark.frame)
        const end_t_us = mark.endFrame === null ? null : boundary(mark.endFrame)
        let anchor = null
        if (layer) {
          const { whole, fraction } = splitExact(mark.source)
          const at = { src_us: whole, ...(fraction.num ? { src_fraction: fraction } : {}) }
          if (sourceInstantHibernating(at, layer) || sourceInstantTimelineUs(layer, at, target.fps) !== t_us) {
            notes?.push('Marker “' + mark.label + '” stays at frame ' + mark.frame + ' as an independent marker. It will not follow the clip when moved.')
          } else anchor = { ...at, layer: layer.id }
        }
        target.markers.push({
          id: idGen(), t_us, end_t_us, label: mark.label, note: mark.note ?? '', color: DEFAULT_MARKER_COLOR, anchor,
        })
      }
    }
    const visualLayers = new Map<TimelineClip, Layer>()
    const splitLayers: Layer[] = []
    for (const clip of sequence.clips) {
      const gap = gaps.get(clip)
      if (gap) {
        const { start, end } = gap.timelineFrames
        target.markers.push({
          id: idGen(), t_us: boundary(start), end_t_us: boundary(end), label: 'Replace media — ' + gap.label,
          note: 'Add “' + gap.filename + '” or a replacement at this position. See the source timeline for the original trim.',
          color: DEFAULT_MARKER_COLOR, anchor: null,
        })
        addMarkers(clip, null)
        continue
      }
      const omission = omittedAudio.get(clip)
      if (omission && !clip.hasVideo) {
        addMarkers(clip, null)
        continue
      }
      const item = itemOf(clip)
      const notes = [...clip.notes]
      const audioRole = omission ? null : clip.audioRole
      let approximation = false
      let converted = notes.length > 0
      const adjustment = (value: ExactTime) => (value.num / value.den).toFixed(6).replace(/\.?0+$/, '')
      const audioWindow = clip.splitAudio ?? clip
      const sampleSpan = audioSamples.get(clip)
      if (clip.playbackRate) {
        notes.push('Constant playback speed is kept as an editable setting (' +
          clip.playbackRate.num + '/' + clip.playbackRate.den + '×).')
        converted = true
      }
      if (sampleSpan) {
        if (clip.sourceAudioRole?.usesDialogueFallback) {
          notes.push('WeftCut has no audio role named “' + clip.sourceAudioRole.label +
            '”. This clip will use Dialogue in the mixer. Its source audio stays editable.')
          approximation = true
        } else if (clip.sourceAudioRole) {
          const { label } = clip.sourceAudioRole
          notes.push('Audio subrole “' + label + '” is grouped under “' + label.split('.')[0] + '”')
          converted = true
        }
        if (clip.splitAudio) {
          notes.push(clip.hasVideo
            ? 'Separate picture and sound trims are kept as linked editable clips.'
            : 'The separate audio trim and its timeline position are kept.')
          if (clip.splitAudio.clippedBeforeZero) {
            notes.push('Audio before the timeline begins is left out. The remaining audio stays in sync.')
          }
          converted = true
        }
        for (const [label, time, sample] of [['start', audioWindow.timelineStart, sampleSpan.first], ['end', audioWindow.timelineEnd, sampleSpan.last]] as const) {
          const delta = subtractTime(divideTime(exactTime(sample), samplesPerUs), time)
          if (delta.num !== 0) {
            const direction = delta.num < 0 ? 'earlier' : 'later'
            const magnitude = exactTime(Math.abs(delta.num), delta.den)
            notes.push('Audio ' + label + ' moved ' + adjustment(magnitude) + ' µs ' + direction + ' to fit the 48 kHz sample grid.')
            converted = true
          }
        }
      }
      if (clip.markers.length && (clip.asset.stillImage || (!clip.hasVideo && clip.splitAudio))) {
        converted = true
        notes.push(clip.asset.stillImage ? 'Still-image markers keep their timeline positions as independent markers'
          : 'Markers on split audio keep their original timeline positions as independent markers')
      }
      if (clip.asset.stillImage) {
        converted = true
        notes.push('Still image uses ' + (clip.conform ?? 'fit') + ' spatial conform from its original dimensions to the sequence canvas')
      }
      const { videoEnd, audioEnd: audioSourceEnd } = sourceEnds.get(clip)!
      const videoEndRounded = clip.hasVideo && videoEnd !== clip.sourceOut
      const audioEndRounded = audioRole !== null && audioSourceEnd !== audioWindow.sourceOut
      if (videoEndRounded || audioEndRounded) {
        roundedEnds++
        converted = true
        if (videoEndRounded) notes.push('Video source out-point rounded to the probed file endpoint: ' +
          adjustment(subtractTime(videoEnd, clip.sourceOut)) + ' µs')
        if (audioEndRounded) notes.push('Audio source out-point rounded to the probed file endpoint: ' +
          adjustment(subtractTime(audioSourceEnd, audioWindow.sourceOut)) + ' µs')
      }
      if (clip.hasVideo && !clip.asset.stillImage && item.metadata.video) {
        const sourceVideo = item.metadata.video
        const rateConformed = sourceVideo.fps_num! * target.fps.den !== sourceVideo.fps_den! * target.fps.num
        const aspect = clip.asset.videoFormat
        const nonSquarePixels = aspect !== undefined && aspect.paspH !== aspect.paspV
        const scaledToFit = sourceVideo.width !== target.width || sourceVideo.height !== target.height || nonSquarePixels ||
          (clip.conform !== undefined && clip.conform !== 'fit')
        if (rateConformed) {
          rateConformedVideoClips++
          converted = true
          notes.push('Source-timestamp FPS conform: output may repeat or skip source frames')
          approximation = true
        }
        if (scaledToFit) {
          resizedVideoClips++
          converted = true
          notes.push(clip.conform === 'fill' ? 'Spatial conform: fill the canvas (may crop)'
            : clip.conform === 'none' ? 'Spatial conform: preserve source pixel dimensions (may crop)'
              : nonSquarePixels
                ? 'Source pixel aspect ' + aspect.paspH + ':' + aspect.paspV + ' is conformed and scaled to fit'
                : 'Source resolution is scaled uniformly to fit the canvas')
        }
        const conversionKey = item.path_abs + '|' + (clip.conform ?? 'fit')
        if ((rateConformed || scaledToFit) && !videoConversions.has(conversionKey)) {
          videoConversions.set(conversionKey, { source: item.path_abs,
            sourceWidth: sourceVideo.width!, sourceHeight: sourceVideo.height!,
            sourceFps: { num: sourceVideo.fps_num!, den: sourceVideo.fps_den! },
            pixelAspect: nonSquarePixels ? { h: aspect.paspH, v: aspect.paspV } : null,
            spatialConform: clip.conform ?? 'fit',
            rateConformed, scaledToFit })
        }
      }
      if (audioRole && item.metadata.audio) {
        if (item.metadata.audio.sample_rate != null && item.metadata.audio.sample_rate !== 48_000) {
          resampledAudioClips++
          converted = true
          notes.push('Audio resampled to the 48 kHz editing mix')
        }
        if ((item.metadata.audio.channels ?? 0) > 2) {
          downmixedAudioClips++
          converted = true
          notes.push('Discrete multichannel audio downmixed to stereo')
          approximation = true
        }
      }
      if (audioRole && clip.volumeDb) notes.push('Static clip gain: ' + clip.volumeDb + 'dB (editable)')
      if (clip.staticTransform) notes.push('Static position/scale/rotation (editable)')
      if (clip.opacity !== undefined && clip.opacity !== 1) {
        notes.push('Static opacity: ' + clip.opacity + ' (editable)')
      }
      const track = tracks.get(laneIds.get(clip.lane)!)!
      const video = clip.hasVideo && !clip.asset.stillImage
        ? newLayer(idGen, clip, clip.sourceIn, videoEnd, boundary(clip.firstFrame), boundary(clip.endFrame),
          visualAdjustments(fitVideoParams(item, target, clip), clip, target))
        : null
      const image = clip.asset.stillImage
        ? newLayer(idGen, clip, clip.sourceIn, videoEnd, boundary(clip.firstFrame), boundary(clip.endFrame),
          visualAdjustments(fitVisualParams(imageOverlayParams(item.id, target) as Extract<Layer['params'], { kind: 'ImageOverlay' }>,
            imageSizes.get(item.id) ?? item.metadata.video, target, clip), clip, target))
        : null
      const audio = sampleSpan && audioRole
        ? newLayer(idGen, clip, audioWindow.sourceIn, audioSourceEnd,
          timeUsAtGridIndex(sampleSpan.first, AUDIO_GRID), timeUsAtGridIndex(sampleSpan.last, AUDIO_GRID),
          { ...audioParams(item.id, 0, 0), role: audioRole, gain_db: { mode: 'Static', value: clip.volumeDb ?? 0 } })
        : null
      if (video || image) {
        const layer = (video ?? image)!
        track.layers.push(layer)
        visualLayers.set(clip, layer)
        videoClips++
      }
      if (audio) {
        if (clip.splitAudio) splitLayers.push(audio)
        else track.layers.push(audio)
        audioClips++
      }
      if (video && audio) target.links.push({ id: idGen(), members: [video.id, audio.id].sort() })
      const beforeMarkers = notes.length
      addMarkers(clip, video ?? (!clip.splitAudio ? audio : null), notes)
      converted ||= notes.length > beforeMarkers
      compatibilityItems.push({ location: clip.location,
        label: clip.label || clip.asset.ref, lane: clip.lane,
        status: approximation ? 'approximated' : converted ? 'converted' : 'exact',
        notes })
    }
    const audioTracks: Composition['tracks'] = []
    for (const layer of splitLayers.sort((a, b) => a.t_start_us - b.t_start_us)) {
      let track = audioTracks.find(candidate => candidate.layers.at(-1)!.t_end_us <= layer.t_start_us)
      if (!track) {
        if (audioTracks.length >= FCPXML_LIMITS.splitAudioTracks) {
          throw new Error('Too many split audio clips overlap at once. Mix the overlapping audio in the source editor or import the timeline in smaller sections.')
        }
        applyAddTrack(project, idGen, null, audioTracks.length, target.id)
        track = target.tracks[audioTracks.length]!
        audioTracks.push(track)
      }
      track.layers.push(layer)
    }
    for (const dissolve of sequence.dissolves ?? []) {
      target.transitions.push({
        id: idGen(), from_layer: visualLayers.get(dissolve.from)!.id, to_layer: visualLayers.get(dissolve.to)!.id,
        duration_us: boundary(dissolve.endFrame) - boundary(dissolve.firstFrame), kind: { kind: 'Crossfade' }, extended_us: 0,
      })
    }
    for (const group of sequence.groups) {
      let child = built.get(group.timeline)
      if (!child) {
        const { width, height } = group.timeline.canvas!
        child = newComposition(idGen(), idGen, group.timeline.name ?? 'Compound clip', project.next_group_ordinal++, {
          width, height, fps: target.fps, sample_rate: target.sample_rate, channels: target.channels,
          color_space: target.color_space, background: { r: 0, g: 0, b: 0, a: 0 },
        })
        built.set(group.timeline, child)
        project.compositions[child.id] = child
        mapSequence(group.timeline, child)
      }
      const scale = group.conform === 'none' ? 1
        : (group.conform === 'fill' ? Math.max : Math.min)(target.width / child.width, target.height / child.height)
      const transform = defaultTransform(target.width / 2, target.height / 2)
      transform.scale_x = { mode: 'Static', value: scale }
      transform.scale_y = { mode: 'Static', value: scale }
      const params: CompositionRefParams = {
        kind: 'CompositionRef', composition: child.id, src_in_us: 0, src_out_us: 0,
        transform, opacity: { mode: 'Static', value: 1 }, blend_mode: 'Normal',
      }
      writeSourceWindow(params, group.sourceIn, group.sourceOut)
      tracks.get(laneIds.get(0)!)!.layers.push({
        id: idGen(), label: group.label, enabled: group.enabled, locked: false, metadata: {}, effects: [], params,
        t_start_us: boundary(group.firstFrame), t_end_us: boundary(group.endFrame),
      })
    }
    for (const track of target.tracks) track.layers.sort((a, b) => a.t_start_us - b.t_start_us)
    target.markers.sort((a, b) => a.t_us - b.t_us)
    applyDurationAutofit(target)
    if (sequenceEnd > target.duration_us) {
      target.duration_us = sequenceEnd
      target.duration_pinned = true
    }
  }

  mapSequence(timeline, target)
  validate(project)
  async function assertDocumentUnchanged() {
    const currentId = await resolveTimelineInput(path)
      .then(input => readTimelineDocument(input.inputFile, deps)).then(documentId).catch(() => null)
    if (currentId !== reviewedDocumentId) throw new Error('The FCPXML file changed or became unreadable after review. Review the timeline again.')
  }
  return { project, assertDocumentUnchanged, report: {
    ...mediaReview,
    name: project.metadata.name, destination, width, height, fps: target.fps, durationFrames: timeline.durationFrames,
    outputColorChange: videoClips ? [...new Set([...sequences].flatMap(sequence => sequence.sourceColor ? [sequence.sourceColor] : []))].join(', ') || null : null,
    compoundGroups: [...sequences].reduce((count, sequence) => count + sequence.groups.filter(group => group.kind === 'compound').length, 0),
    mediaChanges: activeChanges, omittedEffects: [...sequences].flatMap(sequence => sequence.omittedEffects ?? []),
    omittedTitles: [...sequences].flatMap(sequence => sequence.omittedTitles ?? []),
    omittedShortAudio, mediaGaps,
    videoClips, audioClips, markers: Object.values(project.compositions).reduce((count, composition) => count + composition.markers.length, 0), media: Object.keys(project.media_pool).length,
    lanes: allLanes, connectedClips: [...sequences].filter(sequence => !multicamSequences.has(sequence))
      .reduce((count, sequence) => count + sequence.clips.filter(clip => clip.lane !== 0 && !gaps.has(clip) && (clip.hasVideo || !omittedAudio.has(clip))).length, 0), roundedEnds,
    resampledAudioClips, downmixedAudioClips,
    rateConformedVideoClips, resizedVideoClips, videoConversions: [...videoConversions.values()],
    normalizedTimecode: [...sequences].some(sequence => sequence.normalizedTimecode),
    dropFrameTimecode: [...sequences].some(sequence => sequence.dropFrameTimecode),
    namedFormatDefaults: [...sequences].some(sequence => sequence.namedFormatDefaults),
    bundleSource: extension === '.fcpxmld', relinkedMedia: relinkedMedia.filter(item => activeAssetRefs.has(item.assetRef)), compatibilityItems,
    compatibilityCounts: {
      exact: compatibilityItems.filter(i => i.status === 'exact').length,
      converted: compatibilityItems.filter(i => i.status === 'converted').length,
      approximated: compatibilityItems.filter(i => i.status === 'approximated').length + omittedShortAudio.length + mediaGaps.length,
      unsupported: 0,
    },
  } }
}

function fitVideoParams(item: MediaItem, target: Pick<ReturnType<typeof rootComposition>, 'width' | 'height'>,
  clip: TimelineClip) {
  return fitVisualParams(videoClipParams(item.id, 0, 0, target), item.metadata.video, target, clip)
}

function fitVisualParams<T extends Extract<Layer['params'], { kind: 'VideoClip' | 'ImageOverlay' }>>(
  params: T, video: { width?: number; height?: number } | null | undefined,
  target: Pick<ReturnType<typeof rootComposition>, 'width' | 'height'>, clip: TimelineClip,
): T {
  if (video?.width && video.height) {
    const ratio = clip.asset.videoFormat
      ? clip.asset.videoFormat.paspH / clip.asset.videoFormat.paspV : 1
    const displayedWidth = video.width * ratio
    const fit = clip.conform === 'none' ? 1
      : clip.conform === 'fill'
        ? Math.max(target.width / displayedWidth, target.height / video.height)
        : Math.min(target.width / displayedWidth, target.height / video.height)
    params.transform.scale_x = { mode: 'Static', value: fit * ratio }
    params.transform.scale_y = { mode: 'Static', value: fit }
    params.transform.scale_linked = ratio === 1
  }
  return params
}

function visualAdjustments<T extends Extract<Layer['params'], { kind: 'VideoClip' | 'ImageOverlay' }>>(
  params: T, clip: TimelineClip, target: Pick<ReturnType<typeof rootComposition>, 'width' | 'height'>,
): T {
  if (clip.staticTransform) {
    const adj = clip.staticTransform
    // FCPXML offsets are percentages of FRAME height, with Y increasing
    // upward; WeftCut uses composition pixels with Y increasing downward.
    params.transform.position.x = { mode: 'Static', value:
      target.width / 2 + adj.xPercent * target.height / 100 }
    params.transform.position.y = { mode: 'Static', value:
      target.height / 2 - adj.yPercent * target.height / 100 }
    if (params.transform.scale_x.mode !== 'Static' || params.transform.scale_y.mode !== 'Static') {
      throw new Error('Imported clips require static source scale tracks')
    }
    params.transform.scale_x = { mode: 'Static', value: params.transform.scale_x.value * adj.scaleX }
    params.transform.scale_y = { mode: 'Static', value: params.transform.scale_y.value * adj.scaleY }
    // FCPXML positive rotation is counterclockwise; Pixi's angle is
    // clockwise in screen coordinates.
    params.transform.rotation_deg = { mode: 'Static', value: -adj.rotation }
  }
  params.transform.scale_linked = params.transform.scale_x.value === params.transform.scale_y.value
  if (clip.opacity !== undefined) params.opacity = { mode: 'Static', value: clip.opacity }
  return params
}

function newLayer(idGen: IdGen, clip: TimelineClip, sourceIn: ExactTime, sourceOut: ExactTime, start: number, end: number, params: Extract<Layer['params'], { kind: 'VideoClip' | 'ImageOverlay' }> | AudioParams): Layer {
  // A still image has no moving source clock. Its authored span is on the
  // composition timeline, not a range within a zero-duration image asset.
  if (params.kind !== 'ImageOverlay') {
    writeSourceWindow(params, sourceIn, sourceOut)
    if (clip.playbackRate) params.time_map = affineTimeMap(clip.playbackRate)
    if (params.kind === 'Audio' && clip.preservePitch !== undefined) params.preserve_pitch = clip.preservePitch
  }
  return { id: idGen(), label: clip.label ?? null, t_start_us: start, t_end_us: end,
    enabled: clip.enabled ?? true, locked: false, metadata: {}, params, effects: [] }
}

function validateSource(clip: TimelineClip, item: MediaItem, streams: TimelineMediaProbe['streams'] | undefined,
  actualFrameUs?: number, displaySize?: ImageSize) {
  const { video, audio, duration_us: duration } = item.metadata
  const dimensions = displaySize ?? video
  const fail = (message: string): never => { throw new Error(message) }
  const changes: Pick<TimelineMediaChange, 'kind' | 'detail'>[] = []
  const reportSize = (kind: 'still-size' | 'video-size', declared: { width?: number; height?: number }) => {
    if ((declared.width === undefined || dimensions!.width === declared.width) &&
        (declared.height === undefined || dimensions!.height === declared.height)) return
    const listedSize = declared.width === undefined ? declared.height + ' pixels tall'
      : declared.height === undefined ? declared.width + ' pixels wide'
        : declared.width + ' × ' + declared.height + ' pixels'
    changes.push({ kind, detail: 'The timeline lists ' + listedSize +
      ', but this file is ' + dimensions!.width + ' × ' + dimensions!.height +
      '. WeftCut can use the file’s actual size. This may change the framing.' })
  }
  const withEnds = (videoEnd: ExactTime, audioEnd = videoEnd) => ({ videoEnd, audioEnd, changes })
  const srgbStill = clip.asset.stillImage && clip.asset.sourceColor?.trim() === 'sRGB IEC61966-2.1'
  if (srgbStill) {
    changes.push({ kind: 'color-format', detail: 'The timeline declares sRGB for this image. WeftCut uses the colors decoded from the file. ' +
      'If the source editor overrode an embedded profile, choose a copy exported as sRGB to preserve that appearance.' })
  }
  if (clip.hasVideo && video) {
    const { color_matrix: matrix, color_primaries: primaries, color_transfer: transfer } = video
    const decoded = ffprobeColorToWebCodecs(video)
    if ((primaries != null && decoded?.primaries === undefined) || (transfer != null && decoded?.transfer === undefined) ||
        matrix === 'bt2020nc' || matrix === 'bt2020c' || matrix === 'ictcp') {
      const hdrOrWideGamut = transfer === 'smpte2084' || transfer === 'arib-std-b67' ||
        primaries === 'bt2020' || matrix === 'bt2020nc' || matrix === 'bt2020c' || matrix === 'ictcp'
      const tags = [transfer, primaries, matrix].filter(tag => tag != null).join(', ')
      if (hdrOrWideGamut) {
        fail('This file uses HDR or wide-gamut color (' + tags + '). WeftCut edits in standard dynamic range. ' +
          'Export an SDR Rec. 709 copy with the same timing. In the source editor, use tone mapping to preserve highlights, ' +
          'then choose the new copy as the replacement.')
      }
      fail('WeftCut cannot reproduce this file’s color settings (' + tags +
        '). Export an SDR Rec. 709 copy with the same timing, then choose it as the replacement.')
    }
    const declared = clip.asset.sourceColor
    const declared601 = declared === 'Rec. 601 NTSC' || declared === 'Rec. 601 PAL'
    const file601 = [decoded?.matrix, decoded?.primaries, decoded?.transfer]
      .some(tag => tag === 'smpte170m' || tag === 'bt470bg')
    const tagged709 = decoded?.primaries === 'bt709' &&
      (decoded?.transfer === 'bt709' || decoded?.transfer === 'iec61966-2-1') &&
      (matrix == null || decoded.matrix === 'bt709' || decoded.matrix === 'rgb')
    if (!srgbStill && declared !== undefined && !declared601) {
      if (!tagged709) fail('The timeline describes this file as ' + declared +
        '. Export an SDR Rec. 709 copy with color tags and the same timing, then choose it as the replacement.')
      changes.push({ kind: 'color-format', detail: 'The timeline describes this file as ' + declared +
        ', but the selected file is tagged SDR Rec. 709. WeftCut can use its SDR colors and keep the cut times.' })
    } else if (declared601 || file601 || (matrix != null && decoded?.matrix === undefined)) {
      const descriptions: string[] = []
      if (declared601) descriptions.push('The timeline describes this file as ' + declared + '.')
      if (file601) descriptions.push('This file uses Rec. 601 color tags.')
      if (matrix != null && decoded?.matrix === undefined) {
        descriptions.push('WeftCut uses its playback default for the unfamiliar color matrix (' + matrix + ').')
      }
      if (decoded?.matrix === undefined || decoded?.primaries === undefined || decoded?.transfer === undefined) {
        descriptions.push('Any missing color tags use WeftCut’s usual playback defaults.')
      }
      descriptions.push('WeftCut will render in SDR Rec. 709. Colors can differ from the source editor. The cut times stay the same.')
      changes.push({ kind: 'color-format', detail: descriptions.join(' ') })
    }
  }
  if (clip.asset.stillImage) {
    // The normal image probe may report width/height in metadata.video even
    // though the media is an Image, not a moving VideoClip. Image kind is the
    // authoritative distinction; a real audio stream remains unsupported.
    if (item.kind !== 'Image' || audio) {
      fail('A zero-duration FCPXML still image must reference original image media without audio')
    }
    if (!dimensions?.width || !dimensions.height || !Number.isSafeInteger(dimensions.width) ||
        !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1) {
      fail('The image dimensions must be known and positive')
    }
    if (clip.asset.imageSize) reportSize('still-size', clip.asset.imageSize)
    if (displaySize && video?.width && video.height &&
        (displaySize.width !== video.width || displaySize.height !== video.height)) {
      changes.push({ kind: 'still-size', detail: 'The editor displays this image at ' +
        displaySize.width + ' × ' + displaySize.height + ' pixels. The file probe reported ' +
        video.width + ' × ' + video.height + '. WeftCut uses the displayed size for framing.' })
    }
    return withEnds(clip.sourceOut)
  }
  if (clip.hasVideo) {
    if (item.kind !== 'Video' || !video || !video.width || !video.height ||
        !video.fps_num || !video.fps_den ||
        !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) ||
        !Number.isSafeInteger(video.fps_num) || !Number.isSafeInteger(video.fps_den)) {
      fail('The original must be decodable video with known positive dimensions and frame rate')
    }
    const v = video!
    const sourceFpsNum = v.fps_num!, sourceFpsDen = v.fps_den!
    const declared = clip.asset.videoFormat
    const probeFrame = exactTime(1_000_000 * sourceFpsDen, sourceFpsNum)
    const differentRate = declared !== undefined && compareTime(probeFrame, declared.frameDuration) !== 0
    if (divideTime(clip.sourceIn, probeFrame).den !== 1) {
      if (actualFrameUs === undefined) {
        const rate = differentRate ? 'The file’s frame rate differs from its FCPXML asset format. ' : ''
        fail(rate + 'The source in-point falls between frames on the reported grid, and WeftCut could not verify a picture at the requested time. ' +
          'Choose the original or export a constant-frame-rate copy with the same timing.')
      } else {
        const sourceUs = clip.sourceIn.num / clip.sourceIn.den
        const frame = actualFrameUs / 1_000_000
        const requested = (sourceUs / 1_000_000).toFixed(6)
        const detail = sourceUs - actualFrameUs < 1
          ? 'The file’s timestamps confirm a frame at the requested source in-point (' + requested + ' s).'
          : 'The cut starts inside a displayed frame at ' + requested + ' s. WeftCut will use the frame at ' + frame.toFixed(6) + ' s in the source.'
        changes.push({ kind: 'video-timestamp', detail: detail + ' The source in-point and timeline cut stay in place.' })
      }
    }
    if (declared) {
      if (differentRate) {
        const declaredRate = divideTime(exactTime(1_000_000), declared.frameDuration)
        changes.push({ kind: 'video-rate', detail: 'The timeline lists ' + declaredRate.num + '/' + declaredRate.den +
          ' fps, but this file is ' + sourceFpsNum + '/' + sourceFpsDen +
          ' fps. WeftCut will keep the cut times. The picture may repeat or skip frames.' })
      }
      reportSize('video-size', declared)
    }
  } else if ((item.kind !== 'Audio' && item.kind !== 'Video') || (!clip.asset.hasVideo && video)) {
    fail('The file does not contain the type of audio the timeline requests. Choose the matching original.')
  }
  if (clip.audioRole && (!audio?.channels || audio.channels > 8 || !audio.sample_rate)) {
    fail('The timeline needs usable audio from this file. Choose a matching original with 1–8 audio channels.')
  }
  if (audio && !clip.asset.hasAudio) {
    changes.push({ kind: 'audio-format', detail: 'This file contains audio the timeline did not request. WeftCut will leave that audio out.' })
  }
  if (audio && clip.audioRole && (
    (clip.asset.audioChannels !== undefined && clip.asset.audioChannels !== audio.channels) ||
    (clip.asset.audioRate !== undefined && clip.asset.audioRate !== audio.sample_rate)
  )) {
    changes.push({ kind: 'audio-format', detail: 'The file’s audio differs from the timeline description. The file has ' +
      audio.channels + ' channel(s) at ' + audio.sample_rate + ' Hz. The timeline lists ' +
      (clip.asset.audioChannels ?? 'an unspecified number of') + ' channel(s) and ' +
      (clip.asset.audioRate === undefined ? 'does not specify a sample rate' : clip.asset.audioRate + ' Hz') +
      '. WeftCut will use the audio in the file and keep the edit’s timing.' })
  }
  const knownExtent = (extent: unknown): extent is number =>
    typeof extent === 'number' && Number.isSafeInteger(extent) && extent > 0
  let staleDuration = false
  function checkWindow(window: TimelineSourceWindow, stream: 'video' | 'audio', extent: number | null | undefined) {
    const { sourceIn, sourceOut } = window
    const fits = (end: number) => compareTime(sourceIn, exactTime(end)) < 0 && roundTime(sourceOut) <= end
    if (!knownExtent(duration) || !fits(duration)) {
      return fail('The ' + stream + ' trim exceeds the probed duration of the original file. Relink the matching original or shorten the trim.')
    }
    if (knownExtent(extent) && !fits(extent)) {
      return fail('The ' + stream + ' stream ends before this trim. Choose a file with enough ' + stream + ' or shorten the trim.')
    }
    if (compareTime(sourceOut, clip.asset.duration) > 0) {
      if (!knownExtent(extent)) {
        return fail('The trim extends past the length listed in the FCPXML. WeftCut cannot verify that every requested stream covers it. Relink a file with verifiable stream durations or correct the trim in the source editor.')
      }
      staleDuration = true
    }
    const availableEnd = exactTime(knownExtent(extent) ? Math.min(duration, extent) : duration)
    // The probe rounds to microseconds, including at an exclusive fractional frame boundary.
    return compareTime(sourceOut, availableEnd) > 0 ? availableEnd : sourceOut
  }
  const videoEnd = clip.hasVideo ? checkWindow(clip, 'video', streams?.video_us) : clip.sourceOut
  const audioEnd = clip.audioRole ? checkWindow(clip.splitAudio ?? clip, 'audio', streams?.audio_us) : clip.sourceOut
  if (staleDuration) {
    const seconds = (clip.asset.duration.num / clip.asset.duration.den / 1_000_000).toFixed(6).replace(/\.?0+$/, '')
    changes.push({ kind: 'source-duration', detail: 'The timeline lists a source length of ' + seconds +
      ' seconds, but a cut uses later material. The file contains that material. WeftCut can keep the original cut times.' })
  }
  return withEnds(videoEnd, audioEnd)
}
