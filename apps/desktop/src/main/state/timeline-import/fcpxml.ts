import { SaxesParser } from 'saxes'
import { canvasSizeError, FPS_OPTIONS } from '../../../shared/newProject'
import type { ExactTime } from '../../../shared/timeMapping'
import { TimeMappingError } from '../../../shared/timeMapping'
import { addTime, ceilTime, compareTime, divideTime, exactTime, floorTime, multiplyTime, roundTime, subtractTime, ZERO_TIME } from '../../../renderer/timeMapping'
import type { TimelineCompatibilityItem, TimelineMediaChange, TimelineMediaReview } from '../../../shared/timelineImport'
import type { AudioRole } from '../model'
import type { ImportTimeline, TimelineClip, TimelineGroup, TimelineMediaReference, TimelineSource } from './timeline'
import { originalMediaPath, type OriginalMediaPath } from './mediaPath'

interface Element {
  tag: string
  attrs: Record<string, string>
  children: Element[]
  line: number
  timing?: Record<string, ExactTime>
  titleGap?: TimelineCompatibilityItem
  sequenceConnection?: true
}

interface Asset extends TimelineSource {
  start: ExactTime
  hasAudio: boolean
  mediaNotices: string[]
}

interface Format {
  width: number
  height: number
  frameDuration: ExactTime
  paspH: number
  paspV: number
  namedDefaults: boolean
  sourceColor?: string
}

export const FCPXML_LIMITS = {
  bytes: 16 * 1024 * 1024,
  depth: 24,
  elements: 50_000,
  mediaFiles: 2_048,
  compounds: 256,
  compoundDepth: 8,
  expandedPlacements: 50_000,
  splitAudioTracks: 128,
  directoryEntries: 50_000,
  attributes: 64,
  attributeLength: 16_384,
} as const

const US_PER_SECOND = { num: 1_000_000, den: 1 }
const FCPXML_AUDIO_ROLES = new Map<string, AudioRole>([
  ['dialogue', 'dialogue'],
  ['music', 'music'],
  ['effects', 'sfx'],
  ['sfx', 'sfx'],
  ['voiceover', 'voiceover'],
])

function location(el: Element): string {
  const name = el.attrs.name || el.attrs.id
  return `<${el.tag}> at line ${el.line}${name ? ` (${name})` : ''}`
}

class FcpxmlError extends Error {
  constructor(readonly element: Element, readonly details: string[]) {
    super(details.join('\n'))
  }
}

function fail(el: Element, message: string): never {
  throw new FcpxmlError(el, [`FCPXML ${location(el)}: ${message}`])
}

function readXml(xml: string): Element {
  if (Buffer.byteLength(xml, 'utf8') > FCPXML_LIMITS.bytes) {
    throw new Error('FCPXML exceeds the 16 MiB document limit. Export a smaller sequence')
  }
  if (/[\uD800-\uDFFF]/u.test(xml)) throw new Error('Malformed FCPXML: invalid Unicode surrogate')
  let elements = 0
  const document: Element = { tag: 'document', attrs: {}, children: [], line: 1 }
  const stack = [document]
  const parser = new SaxesParser<{ xmlns: false }>({ xmlns: false })
  parser.on('error', (error) => { throw new Error(`Malformed FCPXML at ${error.message}`) })
  parser.on('xmldecl', ({ encoding }) => {
    if (encoding && !/^utf-8$/i.test(encoding)) throw new Error('Export the FCPXML document as UTF-8 and try again')
  })
  parser.on('doctype', (value) => {
    if (value.trim() !== 'fcpxml') throw new Error('FCPXML supports only the plain <!DOCTYPE fcpxml> declaration')
  })
  parser.on('opentagstart', (tag) => {
    if (stack.length > FCPXML_LIMITS.depth) throw new Error(`FCPXML nesting is too deep at line ${parser.line}`)
    if (++elements > FCPXML_LIMITS.elements) throw new Error('FCPXML contains too many elements. Export a smaller sequence')
    const el: Element = { tag: tag.name, attrs: {}, children: [], line: parser.line }
    stack[stack.length - 1]!.children.push(el)
    stack.push(el)
  })
  parser.on('opentag', (tag) => {
    const attrs = Object.entries(tag.attributes)
    if (attrs.length > FCPXML_LIMITS.attributes || attrs.some(([key, value]) =>
      key.length > FCPXML_LIMITS.attributeLength || value.length > FCPXML_LIMITS.attributeLength)) {
      throw new Error('FCPXML attribute limits exceeded. Shorten metadata or export a smaller sequence')
    }
    stack[stack.length - 1]!.attrs = tag.attributes
  })
  parser.on('closetag', () => { stack.pop() })
  function text(value: string) {
    const el = stack[stack.length - 1]!
    const parent = stack.at(-2)?.tag
    const inMetadata = el.tag === 'string' && parent === 'array' &&
      stack.at(-3)?.tag === 'md' && stack.at(-4)?.tag === 'metadata' &&
      ['asset', 'asset-clip', 'sequence', 'sync-clip', 'title'].includes(stack.at(-5)?.tag ?? '')
    const inOmittedText = (el.tag === 'bookmark' && parent === 'media-rep') ||
      (el.tag === 'note' && ['sequence', 'sync-clip', 'title', 'asset-clip', 'audio', 'video'].includes(parent ?? '')) ||
      (el.tag === 'data' && stack.some(node => node.tag === 'title'))
    // Title text is interpreted only by the title importer. Keep reading here
    // so an unsupported title can give a remedy instead of an XML error.
    const inTitle = ['text', 'text-style'].includes(el.tag) && stack.some(node => node.tag === 'title')
    if (value.trim() && !inMetadata && !inTitle && !inOmittedText) fail(el, 'Unexpected text')
  }
  parser.on('text', text)
  parser.on('cdata', text)
  parser.write(xml).close()
  const root = document.children[0]
  if (!root || root.tag !== 'fcpxml') throw new Error('Choose a .fcpxml document with an <fcpxml> root')
  return root
}

function check(el: Element, attrs: readonly string[], children: readonly string[] = []) {
  const errors: string[] = []
  for (const name of Object.keys(el.attrs)) {
    if (!attrs.includes(name)) errors.push('FCPXML ' + location(el) + ': Unsupported attribute "' + name + '". Remove it or simplify the edit and export again')
  }
  for (const child of el.children) {
    if (!children.includes(child.tag)) errors.push('FCPXML ' + location(child) + ': Unsupported inside <' + el.tag + '>. Simplify the edit and export again')
  }
  if (errors.length) throw new FcpxmlError(el, errors)
}

function one(el: Element, tag: string): Element {
  const matches = el.children.filter((child) => child.tag === tag)
  if (matches.length !== 1) fail(el, `Expected exactly one <${tag}>, found ${matches.length}`)
  return matches[0]!
}

function required(el: Element, key: string): string {
  const value = el.attrs[key]
  if (!value?.trim()) fail(el, `Missing "${key}"`)
  return value
}

function time(el: Element, key: string, fallback?: ExactTime): ExactTime {
  const normalized = el.timing?.[key]
  if (normalized !== undefined) return normalized
  if (el.attrs[key] === undefined && fallback !== undefined) return fallback
  const raw = required(el, key)
  const match = /^(\d{1,16})(?:\/(\d{1,10}))?s$/.exec(raw)
  if (!match) fail(el, `"${key}" must be a non-negative rational time in seconds, for example 1001/30000s`)
  try { return multiplyTime(exactTime(Number(match[1]), Number(match[2] ?? 1)), US_PER_SECOND) }
  catch (error) {
    if (error instanceof TimeMappingError) fail(el, `"${key}" has an invalid or out-of-range time: ${raw}`)
    throw error
  }
}

function frames(value: ExactTime, format: Format, el: Element, key: string): number {
  const index = divideTime(value, format.frameDuration)
  if (index.den !== 1) fail(el, `"${key}" is between frames. Align it to the video frame grid and export again`)
  return index.num
}

function integer(el: Element, key: string): number {
  const raw = required(el, key)
  const number = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number)) fail(el, `"${key}" must be a whole number`)
  return number
}

function audioSampleRate(el: Element, key: string, zeroAllowed = false): number {
  const raw = required(el, key)
  // FCPXML sequence settings commonly use "44.1k" / "48k", whereas
  // source asset metadata may use integer Hz. Both describe source metadata,
  // not the 48 kHz lattice used internally by WeftCut's audio conformer.
  const match = /^(\d+)(?:\.(\d+))?k$/.exec(raw)
  const rate = match ? Number(raw.slice(0, -1)) * 1000 : Number(raw)
  if (!Number.isSafeInteger(rate) || rate < 0 || (!zeroAllowed && rate === 0) || rate > 384_000 ||
      (!match && !/^\d+$/.test(raw))) {
    fail(el, `Invalid audio sample rate "${raw}"`)
  }
  return rate
}

// Apple's predefined FFVideoFormat names carry the fields omitted from a
// <format>. Only progressive square-pixel presets with a known WeftCut rate
// are decoded here; guessing other names would silently change an edit.
function predefinedFormat(name: string | undefined): Omit<Format, 'namedDefaults'> | null {
  const match = /^FFVideoFormat(?:(1080|720)|(\d{3,5})x(\d{3,5}))p(2398|24|25|2997|30|50|5994|60)$/.exec(name ?? '')
  if (!match) return null
  const width = match[1] === '1080' ? 1920 : match[1] === '720' ? 1280 : Number(match[2])
  const height = match[1] ? Number(match[1]) : Number(match[3])
  const rate = match[4]!
  const fps = rate === '2398' ? { num: 24_000, den: 1001 }
    : rate === '2997' ? { num: 30_000, den: 1001 }
      : rate === '5994' ? { num: 60_000, den: 1001 }
        : { num: Number(rate), den: 1 }
  return { width, height, frameDuration: exactTime(1_000_000 * fps.den, fps.num),
    paspH: 1, paspV: 1 }
}

function colorName(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  const code = normalized?.split(/\s+/)[0]
  if (code === undefined || code === '1-1-1' || normalized === 'Rec. 709') return undefined
  if (normalized === 'Rec. 601 (NTSC)') return 'Rec. 601 NTSC'
  if (normalized === 'Rec. 601 (PAL)') return 'Rec. 601 PAL'
  switch (code) {
    case '9-16-9': return 'HDR (Rec. 2020 PQ)'
    case '9-18-9': return 'HDR (Rec. 2020 HLG)'
    case '9-1-9': return 'wide-gamut Rec. 2020'
    case '6-1-6': return 'Rec. 601 NTSC'
    case '5-1-6': return 'Rec. 601 PAL'
    default: return value
  }
}

function parseFormat(el: Element, sourceFormat = false): Format {
  check(el, ['id', 'name', 'frameDuration', 'width', 'height', 'colorSpace', 'fieldOrder', 'paspH', 'paspV'])
  const a = el.attrs
  if (a.fieldOrder !== undefined && a.fieldOrder !== 'progressive') {
    fail(el, 'This format is interlaced. Export a progressive copy at the same frame rate to keep the cuts in place.')
  }
  const sourceColor = colorName(a.colorSpace)
  const paspH = a.paspH === undefined ? 1 : integer(el, 'paspH')
  const paspV = a.paspV === undefined ? 1 : integer(el, 'paspV')
  if (paspH < 1 || paspV < 1 || paspH > 65_535 || paspV > 65_535) {
    fail(el, 'Pixel aspect ratio values must be between 1 and 65535')
  }
  if (!sourceFormat && paspH !== paspV) {
    fail(el, 'Non-square sequence pixel aspect ratios require a separate project-canvas conversion')
  }
  const preset = predefinedFormat(a.name)
  const namedDefaults = a.width === undefined || a.height === undefined || a.frameDuration === undefined
  if (namedDefaults && !preset) {
    fail(el, 'Format needs width, height and frameDuration, or a supported predefined progressive FFVideoFormat name. Do not guess missing settings')
  }
  const width = a.width === undefined ? preset!.width : integer(el, 'width')
  const height = a.height === undefined ? preset!.height : integer(el, 'height')
  if (sourceFormat ? width < 1 || height < 1 : canvasSizeError(width, height)) {
    fail(el, sourceFormat ? 'The source dimensions must be positive'
      : 'The sequence canvas must use even dimensions within WeftCut’s supported range. Export the timeline at a supported canvas size.')
  }
  const frameDuration = a.frameDuration === undefined ? preset!.frameDuration : time(el, 'frameDuration')
  if (frameDuration.num <= 0) fail(el, 'Video frameDuration must be positive')
  return { width, height, frameDuration, paspH, paspV, namedDefaults, sourceColor }
}

function parseStillFormat(el: Element): Pick<Asset, 'imageSize' | 'sourceColor'> {
  check(el, ['id', 'name', 'frameDuration', 'width', 'height', 'colorSpace', 'fieldOrder', 'paspH', 'paspV'])
  const a = el.attrs
  const preset = predefinedFormat(a.name)
  const width = a.width === undefined ? preset?.width : integer(el, 'width')
  const height = a.height === undefined ? preset?.height : integer(el, 'height')
  if (width === 0 || height === 0) fail(el, 'Still-image dimensions must be positive')
  const paspH = a.paspH === undefined ? 1 : integer(el, 'paspH')
  const paspV = a.paspV === undefined ? 1 : integer(el, 'paspV')
  if ((a.fieldOrder !== undefined && a.fieldOrder !== 'progressive') ||
      paspH !== paspV || paspH < 1 || paspH > 65_535) {
    fail(el, 'This still format needs square pixels and progressive scan. Export a square-pixel copy in the source editor.')
  }
  return { imageSize: width === undefined && height === undefined ? undefined : { width, height },
    sourceColor: colorName(a.colorSpace) }
}

function localPath(el: Element): OriginalMediaPath {
  try { return originalMediaPath(required(el, 'src')) }
  catch (error) { return fail(el, error instanceof Error ? error.message : String(error)) }
}

function parseAsset(el: Element, lookup: (ref: string, tag: string, from: Element) => Element): Asset {
  check(el, ['id', 'name', 'uid', 'src', 'start', 'duration', 'hasVideo', 'hasAudio', 'format',
    'audioSources', 'audioChannels', 'audioRate', 'videoSources', 'colorSpaceOverride'], ['media-rep', 'metadata'])
  const a = el.attrs
  if (a.hasVideo !== undefined && a.hasVideo !== '0' && a.hasVideo !== '1') fail(el, 'Invalid "hasVideo" flag')
  const hasVideo = a.hasVideo === '1'
  if (a.videoSources !== undefined && a.videoSources !== (hasVideo ? '1' : '0'))
    fail(el, 'Only a single video stream per asset is supported')
  if (a.hasAudio !== undefined && a.hasAudio !== '0' && a.hasAudio !== '1') fail(el, 'Invalid "hasAudio" flag')
  const hasAudio = a.hasAudio === '1'
  if (!hasVideo && !hasAudio) fail(el, 'The asset must declare video or audio')
  if (a.audioSources !== undefined && a.audioSources !== (hasAudio ? '1' : '0'))
    fail(el, 'Only one embedded audio stream per asset is supported')
  const audioChannels = a.audioChannels === undefined ? undefined : integer(el, 'audioChannels')
  const audioRate = a.audioRate === undefined ? undefined : audioSampleRate(el, 'audioRate', !hasAudio)
  if ((audioChannels !== undefined && (hasAudio ? (audioChannels < 1 || audioChannels > 8) : audioChannels !== 0)) ||
      (audioRate !== undefined && (hasAudio ? audioRate === 0 : audioRate !== 0))) {
    fail(el, 'Use an asset with at most one audio stream and 1–8 channels')
  }
  const duration = time(el, 'duration')
  // Still-image assets in FCPXML describe zero source duration: the enclosing
  // <video> gives the duration on the edit. Do not impose video-frame/source
  // duration checks on still artwork.
  const stillImage = hasVideo && !hasAudio && duration.num === 0
  let videoFormat: Asset['videoFormat']
  let imageSize: Asset['imageSize']
  let sourceColor: string | undefined
  if (a.format !== undefined) {
    if (!hasVideo) fail(el, 'Audio-only assets must not refer to a video format')
    const formatNode = lookup(a.format, 'format', el)
    if (stillImage) {
      const stillFormat = parseStillFormat(formatNode)
      imageSize = stillFormat.imageSize
      sourceColor = stillFormat.sourceColor
    } else {
      const source = parseFormat(formatNode, true)
      sourceColor = source.sourceColor
      videoFormat = { width: source.width, height: source.height, frameDuration: source.frameDuration,
        paspH: source.paspH, paspV: source.paspV }
    }
  }
  const hasMetadata = checkMetadata(el)
  if (a.colorSpaceOverride !== undefined) {
    if (!hasVideo) fail(el, 'Only visual media can have a color-space override')
    sourceColor = colorName(a.colorSpaceOverride)
  }
  const mediaNotices: string[] = []
  if (stillImage && (imageSize?.width === undefined || imageSize.height === undefined)) {
    mediaNotices.push('The source asset does not give the full image size. WeftCut reads the dimensions from the image file.')
  }
  if (hasMetadata) mediaNotices.push('Custom asset metadata is not copied to the project')
  const reference = parseAssetReference(el, mediaNotices)
  if (duration.num === 0 && !stillImage) fail(el, 'Asset duration must be positive')
  return { ...reference, start: time(el, 'start', ZERO_TIME), duration,
    hasVideo, hasAudio, stillImage, imageSize, sourceColor, videoFormat, audioChannels, audioRate, mediaNotices }
}

function parseAssetReference(el: Element, mediaNotices?: string[]): TimelineMediaReference {
  const a = el.attrs
  const representations = el.children.filter(child => child.tag === 'media-rep')
  const originalReps: Element[] = []
  const proxies: OriginalMediaPath[] = []
  for (const rep of representations) {
    check(rep, ['kind', 'src', 'sig', 'suggestedFilename'], ['bookmark'])
    if (rep.children.length > 1) fail(rep, 'A media representation can have only one bookmark')
    for (const bookmark of rep.children) check(bookmark, [])
    const kind = rep.attrs.kind ?? 'original-media'
    if (kind === 'original-media') originalReps.push(rep)
    else if (kind === 'proxy-media') {
      try { proxies.push(originalMediaPath(required(rep, 'src'))) }
      catch { mediaNotices?.push('A proxy path is unavailable for local relinking. Choose a local copy if you need it.') }
    } else fail(rep, 'This media representation is unsupported. Export a reference to the original file.')
  }
  if (a.src !== undefined && representations.length) fail(el, 'The asset specifies both a legacy URL and media representations. Export it with one original.')
  if (a.src === undefined && originalReps.length !== 1) {
    fail(el, 'The asset needs exactly one original media-rep. Relink the original in the source editor and export again.')
  }
  if (proxies.length) mediaNotices?.push('WeftCut prefers the original file. A proxy must be chosen explicitly.')
  if (representations.some(rep => rep.attrs.sig !== undefined)) mediaNotices?.push('Source media signature is not retained')
  if (representations.some(rep => rep.children.length)) mediaNotices?.push(
    'Apple file access bookmarks are left out. WeftCut uses the local media path or a replacement you choose.')
  if (representations.some(rep => rep.attrs.suggestedFilename !== undefined)) mediaNotices?.push(
    'Suggested media filenames are left out. WeftCut keeps the names of the local files.')
  const original = localPath(a.src !== undefined ? el : originalReps[0]!)
  return { ref: required(el, 'id'), name: a.name, ...original, proxies, uid: a.uid,
    signature: originalReps[0]?.attrs.sig }
}

function checkMetadata(owner: Element): boolean {
  const metadata = owner.children.filter(child => child.tag === 'metadata')
  if (metadata.length > 1) fail(owner, 'Only one metadata section is supported')
  if (!metadata.length) return false
  const group = metadata[0]!
  check(group, [], ['md'])
  for (const entry of group.children) {
    check(entry, ['key', 'value', 'type', 'editable', 'displayName', 'source', 'description'], ['array'])
    for (const array of entry.children) {
      check(array, [], ['string'])
      for (const item of array.children) check(item, [])
    }
  }
  return true
}

export interface FcpxmlSequenceChoice {
  index: number
  name: string
  event: string | null
  location: string
}

interface SequenceChoice {
  project: Element
  event: string | null
  library?: Element
}

function collectProjects(root: Element): SequenceChoice[] {
  check(root, ['version'], ['resources', 'import-options', 'project', 'library', 'event'])
  const version = required(root, 'version')
  if (!/^1\.(?:[6-9]|1[0-4])$/.test(version)) {
    fail(root, 'This file uses FCPXML ' + version + '. WeftCut reads versions 1.6 through 1.14. ' +
      'In Final Cut Pro, choose File → Export XML and select a supported XML version.')
  }
  one(root, 'resources')
  const importOptions = root.children.filter(child => child.tag === 'import-options')
  if (importOptions.length > 1) fail(root, 'More than one <import-options> element')
  for (const optionSet of importOptions) {
    check(optionSet, [], ['option'])
    for (const option of optionSet.children) check(option, ['key', 'value'])
  }
  const projects: SequenceChoice[] = []
  function fromEvent(event: Element, library?: Element) {
    check(event, ['name', 'uid'], ['project', 'collection-folder', 'keyword-collection', 'smart-collection',
      'clip', 'audition', 'mc-clip', 'ref-clip', 'sync-clip', 'asset-clip'])
    for (const project of event.children.filter(child => child.tag === 'project')) {
      projects.push({ project, event: event.attrs.name ?? null, library })
    }
  }
  for (const entry of root.children) {
    if (entry.tag === 'project') projects.push({ project: entry, event: null })
    else if (entry.tag === 'event') fromEvent(entry)
    else if (entry.tag === 'library') {
      check(entry, ['location', 'colorProcessing'], ['event', 'smart-collection'])
      if (!['standard', 'wide', 'wide-hdr'].includes(entry.attrs.colorProcessing ?? 'standard')) {
        fail(entry, 'Unrecognized library color processing. Export the sequence with an explicit output color format.')
      }
      for (const event of entry.children) if (event.tag === 'event') fromEvent(event, entry)
    }
  }
  if (projects.length === 0) fail(root, 'No project with a sequence was found')
  return projects
}

export function listFcpxmlSequences(xml: string): FcpxmlSequenceChoice[] {
  return collectProjects(readXml(xml)).map(({ project, event }, index) => ({
    index, name: project.attrs.name || `Untitled sequence ${index + 1}`,
    event, location: location(project),
  }))
}

export class TimelineEditFailure extends Error {
  constructor(
    readonly issues: TimelineCompatibilityItem[],
    readonly canOmitEffects: boolean,
    readonly mediaChanges: TimelineMediaChange[] = [],
    readonly mediaReview?: TimelineMediaReview,
  ) {
    super(issues.flatMap(issue => issue.notes).join('\n'))
  }
}

type EffectsPolicy = 'refuse' | 'inspect' | 'omit'

export function parseFcpxml(xml: string, sequenceIndex?: number, effects: EffectsPolicy = 'refuse', leaveTitleGaps = false): ImportTimeline {
  return parseSelectedTimeline(selectTimeline(xml, sequenceIndex), effects, leaveTitleGaps)
}

export function inspectFcpxml(xml: string, sequenceIndex: number | undefined, omitEffects: boolean, leaveTitleGaps: boolean):
  { timeline: ImportTimeline } | { issues: TimelineCompatibilityItem[]; sources: { asset: TimelineMediaReference; label?: string }[] } {
  const selection = selectTimeline(xml, sequenceIndex)
  const storyIssues: TimelineCompatibilityItem[] = []
  try {
    return { timeline: parseSelectedTimeline(selection, omitEffects ? 'omit' : 'inspect', leaveTitleGaps, storyIssues) }
  } catch (error) {
    if (!(error instanceof TimelineEditFailure || error instanceof FcpxmlError)) throw error
    const diagnostics = error instanceof TimelineEditFailure ? error.issues : [editDiagnostic(error, selection.seq, selection.byId)]
    const inventory = inspectIndependentSources(selection)
    const issues = new Map<string, TimelineCompatibilityItem>()
    for (const issue of [...diagnostics, ...storyIssues, ...inventory.issues]) {
      issues.set(JSON.stringify([issue.location, issue.lane, issue.timelineFrames, issue.notes]), issue)
    }
    return { issues: [...issues.values()], sources: inventory.sources }
  }
}

function editDiagnostic(error: FcpxmlError, seq: Element, byId: Map<string, Element>): TimelineCompatibilityItem {
  const el = error.element
  const spine = seq.children.find(child => child.tag === 'spine')
  const clock = spine?.children.includes(el) ? primaryDiagnosticClock(seq, byId) : undefined
  return mappingDiagnostic(error, clock ? explicitPrimaryRange(el, clock) : undefined)
}

function mappingDiagnostic(error: FcpxmlError, timelineFrames?: TimelineCompatibilityItem['timelineFrames']): TimelineCompatibilityItem {
  const el = error.element
  const lane = Number(el.attrs.lane ?? 0)
  return { label: el.attrs.name || el.attrs.id || el.tag, location: location(el),
    lane: Number.isSafeInteger(lane) ? lane : 0, status: 'unsupported', notes: error.details, timelineFrames }
}

function primaryDiagnosticClock(seq: Element, byId: Map<string, Element>) {
  const node = byId.get(seq.attrs.format)
  if (node?.tag !== 'format') return
  try {
    return { format: parseFormat(node), origin: time(seq, 'tcStart', ZERO_TIME) }
  } catch (error) {
    if (!(error instanceof FcpxmlError || error instanceof TimeMappingError)) throw error
  }
}

function explicitPrimaryRange(el: Element, { format, origin }: { format: Format; origin: ExactTime }) {
  if (el.attrs.offset === undefined || el.attrs.duration === undefined) return
  try {
    const start = subtractTime(time(el, 'offset'), origin)
    const end = addTime(start, time(el, 'duration'))
    const first = frames(start, format, el, 'offset')
    const last = frames(end, format, el, 'end')
    if (last > first && first >= 0) return { start: first, end: last }
  } catch (error) {
    if (!(error instanceof FcpxmlError || error instanceof TimeMappingError)) throw error
  }
}

function selectTimeline(xml: string, sequenceIndex: number | undefined) {
  const root = readXml(xml)
  const choices = collectProjects(root)
  if (sequenceIndex === undefined && choices.length > 1) {
    fail(root, `Found ${choices.length} project sequences. Choose which one to import`)
  }
  const index = sequenceIndex ?? 0
  if (!Number.isSafeInteger(index) || index < 0 || index >= choices.length) {
    fail(root, `Sequence index ${String(index)} is not available. Choose a listed sequence`)
  }
  const resources = one(root, 'resources')
  const { project, library } = choices[index]!
  const seq = one(project, 'sequence')
  const byId = new Map<string, Element>()
  for (const el of resources.children) {
    const id = required(el, 'id')
    if (byId.has(id)) fail(el, `Duplicate resource ID "${id}"`)
    byId.set(id, el)
  }
  return { seq, project, root, library, choices: choices.length, byId }
}

function inspectIndependentSources({ seq, byId }: ReturnType<typeof selectTimeline>) {
  const sources: { asset: TimelineMediaReference; label?: string }[] = []
  const issues: TimelineCompatibilityItem[] = []
  const assets = new Map<string, TimelineMediaReference | null>()
  let inventoryLimitReached = false
  const directMedia = new Set(['asset-clip', 'video', 'audio'])
  function inspect(el: Element) {
    if (!directMedia.has(el.tag)) return
    const ref = el.attrs.ref
    const node = byId.get(ref)
    if (node?.tag !== 'asset') return
    if (!assets.has(ref)) {
      if (assets.size >= FCPXML_LIMITS.mediaFiles) {
        if (!inventoryLimitReached) {
          issues.push({ label: 'Media inventory', location: location(seq), status: 'unsupported', lane: 0,
            notes: ['This sequence references too many media assets. Export the sequence in smaller parts.'] })
          inventoryLimitReached = true
        }
        return
      }
      try { assets.set(ref, parseAssetReference(node)) }
      catch (error) {
        if (!(error instanceof FcpxmlError)) throw error
        assets.set(ref, null)
        issues.push(editDiagnostic(error, seq, byId))
      }
    }
    const asset = assets.get(ref)
    if (asset) sources.push({ asset, label: el.attrs.name })
  }
  // An unsupported container can select, mute or retime its children. Walk
  // storylines with known structure and their direct connections.
  const spines = seq.children.filter(child => child.tag === 'spine')
  if (spines.length === 1) {
    function inspectPrimary(clip: Element) {
      inspect(clip)
      if (directMedia.has(clip.tag) || clip.tag === 'gap') {
        for (const connected of clip.children) inspect(connected)
      }
    }
    for (const clip of spines[0]!.children) {
      if (clip.tag !== 'sync-clip') {
        inspectPrimary(clip)
        continue
      }
      try {
        for (const item of synchronizedSpine(clip).children) inspectPrimary(item)
      } catch (error) {
        if (!(error instanceof FcpxmlError)) throw error
      }
    }
  }
  return { sources, issues }
}

function lookupResource(byId: Map<string, Element>, ref: string, tag: string, from: Element): Element {
  const item = byId.get(ref)
  if (item?.tag !== tag) fail(from, `Resource "${ref}" must refer to a <${tag}>`)
  return item
}

function parseSelectedTimeline(selection: ReturnType<typeof selectTimeline>, effects: EffectsPolicy, leaveTitleGaps: boolean,
  storyIssues?: TimelineCompatibilityItem[],
): ImportTimeline {
  const { seq, project, byId } = selection
  const context: SequenceContext = {
    byId, effects, leaveTitleGaps, storyIssues, compounds: new Map(), active: new Set(), multicams: new Map(), multicamSegments: 0, reviewedPlacements: 0,
  }
  let timeline: ImportTimeline
  try {
    check(project, ['id', 'name', 'uid', 'modDate'], ['sequence'])
    timeline = parseSequence(seq, project, context, selection)
  } catch (error) {
    if (error instanceof TimeMappingError) fail(seq, `Timing is outside the supported range (${error.code}). Check the clip timing or export a shorter sequence.`)
    throw error
  }
  const measured = new Map<ImportTimeline, { placements: number; depth: number }>()
  function measure(current: ImportTimeline): { placements: number; depth: number } {
    const cached = measured.get(current)
    if (cached) return cached
    let placements = current.clips.length + current.groups.length
    let depth = 0
    for (const group of current.groups) {
      const child = measure(group.timeline)
      placements += child.placements
      depth = Math.max(depth, child.depth + 1)
      if (placements > FCPXML_LIMITS.expandedPlacements || depth > FCPXML_LIMITS.compoundDepth) {
        fail(seq, 'Repeated compound clips make this timeline too large or deeply nested. Export a smaller sequence.')
      }
    }
    const result = { placements, depth }
    measured.set(current, result)
    return result
  }
  measure(timeline)
  return timeline
}

interface SequenceContext {
  byId: Map<string, Element>
  effects: EffectsPolicy
  leaveTitleGaps: boolean
  storyIssues?: TimelineCompatibilityItem[]
  compounds: Map<string, ImportTimeline>
  active: Set<string>
  multicams: Map<Element, Map<string, MulticamAngle>>
  multicamSegments: number
  reviewedPlacements: number
}

type ClipComponent = 'all' | 'audio' | 'video'
interface MulticamAngle {
  node: Element
  entries?: { node: Element; start: ExactTime; end: ExactTime }[]
}

const syncRemedy = 'Open the synchronized clip in the source editor and place its picture and sound directly on the timeline, or render them together before exporting.'
const syncStoryTags = ['asset-clip', 'video', 'audio', 'gap']

function synchronizedSpine(el: Element): Element {
  if (el.children.some(child => child.tag === 'sync-source')) {
    fail(el, 'This clip selects or adjusts audio by role. WeftCut cannot yet reproduce that audio routing. ' + syncRemedy)
  }
  check(el, ['name', 'offset', 'start', 'duration', 'enabled', 'lane', 'format', 'tcStart', 'tcFormat', 'modDate'],
    ['spine', ...syncStoryTags, 'adjust-conform', 'note', 'metadata'])
  const spines = el.children.filter(child => child.tag === 'spine')
  const direct = el.children.filter(child => syncStoryTags.includes(child.tag))
  const primary = direct.filter(child => (child.attrs.lane ?? '0') === '0')
  if (spines.length > 1 || (spines.length === 1 && primary.length > 0) || (!spines.length && !primary.length)) {
    fail(el, 'This synchronized clip needs one internal storyline. ' + syncRemedy)
  }
  const spine = spines[0] ?? { tag: 'spine', attrs: {}, children: primary, line: el.line }
  check(spine, ['name'], [...syncStoryTags, 'transition'])
  const connections = direct.filter(child => (child.attrs.lane ?? '0') !== '0').map(child => {
    if (child.tag === 'gap') fail(child, 'A connected gap needs its own storyline.')
    return { ...child, sequenceConnection: true as const }
  })
  return { ...spine, attrs: {}, children: [...spine.children, ...connections] }
}

function synchronizedGroup(el: Element, context: SequenceContext, options: {
  format: Format; fps: ImportTimeline['fps']; parentFormat: string; depth: number
  firstFrame: number; endFrame: number; duration: ExactTime
}): TimelineGroup {
  const { format, fps, parentFormat, depth, firstFrame, endFrame, duration } = options
  const attrs = el.attrs
  const childSpine = synchronizedSpine(el)
  if (attrs.tcStart !== undefined) time(el, 'tcStart')
  const sourceStart = time(el, 'start', ZERO_TIME)
  let earliest = sourceStart
  for (const child of childSpine.children) {
    if (!syncStoryTags.includes(child.tag)) continue
    const childOffset = time(child, 'offset', ZERO_TIME)
    if (compareTime(childOffset, earliest) < 0) earliest = childOffset
    if (child.sequenceConnection) continue
    const asset = context.byId.get(child.attrs.ref)
    const localStart = time(child, 'start', asset?.tag === 'asset' ? time(asset, 'start', ZERO_TIME) : ZERO_TIME)
    for (const connection of child.children) {
      if (!syncStoryTags.includes(connection.tag)) continue
      const connectedOffset = addTime(childOffset, subtractTime(time(connection, 'offset'), localStart))
      if (compareTime(connectedOffset, earliest) < 0) earliest = connectedOffset
    }
  }
  // Translate both clocks by a whole number of frames relative to the
  // parent trim. Connected audio can start on either side of the picture.
  const leadFrames = floorTime(divideTime(subtractTime(earliest, sourceStart), format.frameDuration))
  const origin = addTime(sourceStart, multiplyTime(format.frameDuration, exactTime(leadFrames)))
  const storyline = { ...childSpine, children: childSpine.children.map(child =>
    syncStoryTags.includes(child.tag) && child.attrs.offset === undefined
      ? { ...child, timing: { ...child.timing, offset: ZERO_TIME } } : child) }
  const sourceIn = subtractTime(sourceStart, origin)
  const sourceOut = addTime(sourceIn, duration)
  const conforms = el.children.filter(node => node.tag === 'adjust-conform')
  if (conforms.length > 1) fail(el, 'Only one spatial conform operation is supported on a synchronized clip.')
  if (conforms[0]) check(conforms[0], ['type'])
  const conform = conforms[0]?.attrs.type ?? 'fit'
  if (conform !== 'fit' && conform !== 'fill' && conform !== 'none') fail(el, 'Spatial conform must be fit, fill or none.')
  const metadata = el.children.filter(node => node.tag === 'note' || node.tag === 'metadata')
  const label = attrs.name || 'Synchronized clip'
  const childSequence: Element = { tag: 'sequence', line: el.line,
    attrs: { format: attrs.format ?? parentFormat, ...(attrs.tcFormat !== undefined ? { tcFormat: attrs.tcFormat } : {}) },
    timing: { tcStart: origin }, children: [storyline, ...metadata] }
  const nested = parseSequence(childSequence, { ...el, attrs: { name: label } }, context, undefined, depth + 1)
  if (nested.fps.num !== fps.num || nested.fps.den !== fps.den) {
    fail(el, 'This synchronized clip runs at a different frame rate from its parent.')
  }
  if (compareTime(sourceOut, nested.authoredDuration) > 0) {
    fail(el, 'The synchronized trim extends past its internal storyline.')
  }
  return { timeline: nested, label, enabled: attrs.enabled !== '0', firstFrame, endFrame,
    sourceIn, sourceOut, conform, kind: 'synchronized' }
}

const multicamRemedy = 'Keep the selected angles by flattening this multicam edit to ordinary clips in the source editor, then export again.'

function multicamSequence(el: Element, context: SequenceContext, fps: ImportTimeline['fps']): {
  sequence: Element; names: string[]; duration: ExactTime; label: string
} {
  const unsupported = (node: Element, reason: string): never => fail(node, reason + ' ' + multicamRemedy)
  check(el, ['name', 'ref', 'offset', 'start', 'duration', 'enabled', 'srcEnable', 'lane', 'modDate'],
    ['mc-source', 'adjust-volume'])
  if ((el.attrs.lane ?? '0') !== '0' || !['0', '1'].includes(el.attrs.enabled ?? '1')) {
    unsupported(el, 'This multicam placement needs a primary lane and a valid enabled flag.')
  }
  const media = context.byId.get(required(el, 'ref'))
  if (media?.tag !== 'media') return unsupported(el, 'This multicam clip has no media definition.')
  const multicam = media.children[0]
  if (media.children.length !== 1 || multicam?.tag !== 'multicam') return unsupported(el, 'This media does not define a multicam edit.')
  const formatId = required(multicam, 'format')
  const formatNode = context.byId.get(formatId)
  if (formatNode?.tag !== 'format') return unsupported(multicam, 'The multicam format is missing.')
  const format = parseFormat(formatNode)
  if (compareTime(format.frameDuration, exactTime(1_000_000 * fps.den, fps.num)) !== 0) {
    unsupported(multicam, 'The multicam uses a different frame rate from the sequence.')
  }
  const duration = time(el, 'duration')
  const origin = time(multicam, 'tcStart', ZERO_TIME)
  const start = time(el, 'start', origin)
  const end = addTime(start, duration)
  if (duration.num <= 0 || compareTime(start, origin) < 0) unsupported(el, 'The multicam cut has an invalid source range.')
  if (multicam.attrs.duration !== undefined && compareTime(end, addTime(origin, time(multicam, 'duration'))) > 0) {
    unsupported(el, 'The cut extends past the multicam definition.')
  }
  const selection = el.attrs.srcEnable ?? 'all'
  if (selection !== 'all' && selection !== 'video' && selection !== 'audio') unsupported(el, 'The selected media components are unknown.')
  let angles = context.multicams.get(multicam)
  if (!angles) {
    check(media, ['id', 'name', 'uid', 'modDate'], ['multicam'])
    check(multicam, ['format', 'tcStart', 'tcFormat', 'duration', 'renderFormat'], ['mc-angle', 'metadata'])
    angles = new Map()
    for (const node of multicam.children) {
      if (node.tag !== 'mc-angle') continue
      const id = required(node, 'angleID')
      if (angles.has(id)) unsupported(node, 'Two angles use the same identifier.')
      angles.set(id, { node })
    }
    context.multicams.set(multicam, angles)
  }

  const picks = new Map<string, { component: ClipComponent; adjustments: Element[] }>()
  const seen = new Set<string>()
  let usedVideo = false
  let usedAudio = false
  for (const node of el.children.filter(child => child.tag === 'mc-source')) {
    const id = required(node, 'angleID')
    const enable = node.attrs.srcEnable ?? 'all'
    if (!angles.has(id) || seen.has(id)) unsupported(node, 'The selected angle is missing or is listed twice.')
    seen.add(id)
    if (enable !== 'all' && enable !== 'video' && enable !== 'audio' && enable !== 'none') {
      unsupported(node, 'The angle selection is unknown.')
    }
    const video = enable !== 'none' && enable !== 'audio' && selection !== 'audio'
    const audio = enable !== 'none' && enable !== 'video' && selection !== 'video'
    if (!video && !audio) continue
    check(node, ['angleID', 'srcEnable'], ['adjust-conform', 'adjust-transform', 'adjust-blend'])
    if ((video && usedVideo) || (audio && usedAudio)) unsupported(node, 'More than one angle is active for the same media component.')
    usedVideo ||= video
    usedAudio ||= audio
    picks.set(id, { component: video && audio ? 'all' : video ? 'video' : 'audio', adjustments: node.children })
  }
  if (!picks.size || (selection === 'video' && !usedVideo) || (selection === 'audio' && !usedAudio)) {
    unsupported(el, 'No usable camera or audio angle was explicitly selected.')
  }

  const label = el.attrs.name || media.attrs.name || 'Multicam edit'
  const names: string[] = []
  const clips: Element[] = []
  const volume = el.children.filter(child => child.tag === 'adjust-volume')
  for (const [id, { component, adjustments: angleAdjustments }] of picks) {
    const angle = angles.get(id)!
    const name = angle.node.attrs.name || id
    names.push(name + (component === 'all' ? '' : ' (' + component + ')'))
    if (!angle.entries) {
      check(angle.node, ['name', 'angleID'], ['asset-clip', 'video', 'audio', 'gap'])
      let previousEnd = origin
      angle.entries = angle.node.children.map(node => {
        const entryStart = time(node, 'offset', origin)
        const asset = node.tag === 'gap' ? undefined : context.byId.get(required(node, 'ref'))
        if (asset && asset.tag !== 'asset') unsupported(node, 'This angle contains a nested edit.')
        const span = time(node, 'duration', asset && node.tag === 'asset-clip' ? time(asset, 'duration') : undefined)
        const entryEnd = addTime(entryStart, span)
        if (span.num <= 0 || compareTime(entryStart, previousEnd) < 0) {
          unsupported(node, 'The angle has an overlap or an invalid duration.')
        }
        previousEnd = entryEnd
        return { node, start: entryStart, end: entryEnd }
      })
    }
    const entries = angle.entries
    let low = 0
    let high = entries.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (compareTime(entries[mid]!.end, start) <= 0) low = mid + 1
      else high = mid
    }
    let covered = start
    for (let index = low; index < entries.length && compareTime(covered, end) < 0; index++) {
      const entry = entries[index]!
      const node = entry.node
      if (compareTime(entry.start, covered) > 0) break
      const cutEnd = compareTime(entry.end, end) < 0 ? entry.end : end
      if (++context.multicamSegments > FCPXML_LIMITS.expandedPlacements) {
        unsupported(el, 'The multicam edit expands into too many segments. Export a smaller sequence.')
      }
      if (node.tag === 'gap') {
        check(node, ['name', 'offset', 'start', 'duration'])
      } else {
        const attrs = node.attrs
        const asset = context.byId.get(required(node, 'ref'))
        if (asset?.tag !== 'asset') return unsupported(node, 'This angle’s file is missing from the resource list.')
        const original = node.tag === 'video' || node.tag === 'audio' ? node.tag : attrs.srcEnable ?? 'all'
        if (original !== 'all' && original !== 'video' && original !== 'audio') unsupported(node, 'The angle’s clip selection is unknown.')
        const video = asset.attrs.hasVideo === '1' && original !== 'audio' && component !== 'audio'
        const audio = asset.attrs.hasAudio === '1' && original !== 'video' && component !== 'video'
        if ((!video && !audio) || (component === 'video' && !video) || (component === 'audio' && !audio)) {
          unsupported(node, 'The angle’s file lacks the selected ' + component + ' media.')
        }
        check(node, ['name', 'ref', 'offset', 'start', 'duration', 'enabled', 'format', 'tcFormat', 'audioRole', 'videoRole', 'role',
          ...(node.tag === 'asset-clip' ? ['srcEnable'] : [])],
        ['adjust-conform', 'adjust-transform', 'adjust-blend', 'adjust-volume'])
        const sourceStart = time(node, 'start', time(asset, 'start', ZERO_TIME))
        if (asset.attrs.hasVideo === '1' && time(asset, 'duration').num === 0) {
          unsupported(node, 'This angle contains a still image with no source clock.')
        }
        const adjustments = [
          ...node.children.filter(child => child.tag === 'adjust-volume' ? audio : video),
          ...(video ? angleAdjustments : []),
          ...(audio ? volume : []),
        ]
        if (new Set(adjustments.map(child => child.tag)).size !== adjustments.length) {
          unsupported(node, 'More than one setting controls the same angle adjustment.')
        }
        const { role, ...rest } = attrs
        const videoRole = node.tag === 'video' ? role : undefined
        if (videoRole !== undefined && attrs.videoRole !== undefined && videoRole !== attrs.videoRole) {
          unsupported(node, 'The camera clip has conflicting video role labels.')
        }
        clips.push({ ...node, tag: 'asset-clip', attrs: { ...rest, name: attrs.name || name,
          ...(videoRole === undefined ? {} : { videoRole }),
          lane: video ? '1' : '-1', audioRole: attrs.audioRole ?? (node.tag === 'audio' ? role : undefined) ?? 'dialogue',
          srcEnable: video && audio ? 'all' : video ? 'video' : 'audio' },
        timing: { offset: subtractTime(covered, start), duration: subtractTime(cutEnd, covered),
          start: addTime(sourceStart, subtractTime(covered, entry.start)) },
        children: adjustments })
      }
      covered = cutEnd
    }
    if (compareTime(covered, end) < 0) unsupported(el, 'The cut reaches a part of angle “' + name + '” with no clip or explicit gap.')
  }
  if (!clips.length) unsupported(el, 'The selected range contains only gaps.')
  const gap: Element = { tag: 'gap', attrs: {}, timing: { duration }, children: clips, line: el.line }
  const spine: Element = { tag: 'spine', attrs: {}, children: [gap], line: el.line }
  const attrs = { format: formatId, tcFormat: multicam.attrs.tcFormat, renderFormat: multicam.attrs.renderFormat }
  return { names, duration, label, sequence: { tag: 'sequence',
    attrs: Object.fromEntries(Object.entries(attrs).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    timing: { duration }, children: [spine, ...multicam.children.filter(child => child.tag === 'metadata')], line: el.line } }
}

function parseSequence(seq: Element, project: Element, context: SequenceContext,
  selection?: { root: Element; library?: Element; choices: number }, depth = 0,
): ImportTimeline {
  const { effects, leaveTitleGaps, byId, compounds, active } = context
  check(seq, ['format', 'tcStart', 'tcFormat', 'duration', 'audioLayout', 'audioRate', 'renderFormat', 'keywords'],
    ['spine', 'note', 'metadata'])
  if (depth > FCPXML_LIMITS.compoundDepth) {
    fail(seq, 'This timeline contains too many levels of nested clips. Export a smaller sequence.')
  }
  const hasMetadata = checkMetadata(seq)
  const sequenceNotes = seq.children.filter(child => child.tag === 'note')
  if (sequenceNotes.length > 1) fail(seq, 'Only one sequence note is supported')
  for (const sequenceNote of sequenceNotes) check(sequenceNote, [])
  const crossDissolveUid = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265'
  function dissolveFilter(el: Element): Element | undefined {
    const filter = el.children[0]
    if (el.children.length !== 1 || filter?.tag !== 'filter-video' || filter.children.length) return undefined
    const effect = byId.get(filter.attrs.ref)
    return effect?.tag === 'effect' && effect.attrs.uid === crossDissolveUid ? filter : undefined
  }
  const unsupported: TimelineCompatibilityItem[] = []
  const primaryIssues = new Map<Element, TimelineCompatibilityItem>()
  const blockedStoryItems = new Set<Element>()
  const collecting = context.storyIssues !== undefined
  const omittedEffects: TimelineCompatibilityItem[] = []
  const omittedTitles: TimelineCompatibilityItem[] = []
  const supportedStory = new Set(['spine', 'gap', 'asset-clip', 'video', 'audio', 'marker', 'chapter-marker',
    'adjust-conform', 'adjust-volume', 'adjust-transform', 'adjust-blend', 'timeMap', 'timept'])
  const remedies: Record<string, string> = {
    transition: 'WeftCut cannot recreate this transition. Render the adjoining clips with the transition, or replace it with a cut before exporting.',
    title: 'WeftCut cannot recreate this title. Render it into a clip, or export it as an overlay with transparency and replace the title.',
    'sync-clip': syncRemedy,
    'mc-clip': 'Choose the camera angles you want to keep, then flatten the multicam edit to ordinary clips before exporting.',
    'ref-clip': 'Open this compound clip in the source editor and put its contents directly on the timeline, or render it as one clip.',
    timeMap: 'WeftCut cannot recreate this speed change. Render the retimed clip, then replace it in the source edit before exporting.',
    'filter-video': 'WeftCut cannot recreate this effect. Render the clip with the effect applied or remove the effect before exporting.',
    param: 'WeftCut cannot recreate these effect parameters. Render the effect or replace it with a supported static adjustment.',
  }
  const clipElements = ['asset-clip', 'video', 'audio']
  const parameterTree = (node: Element): boolean =>
    ['param', 'keyframeAnimation', 'keyframe', 'data'].includes(node.tag) && node.children.every(parameterTree)
  const titlePresentation = new Set(['param', 'keyframeAnimation', 'keyframe', 'data', 'text', 'text-style',
    'text-style-def', 'note', 'adjust-conform', 'adjust-transform', 'adjust-blend', 'adjust-crop', 'crop-rect',
    'trim-rect', 'pan-rect', 'adjust-corners', 'filter-video', 'metadata', 'md', 'array', 'string'])
  const titleAttributes = new Set(['ref', 'name', 'lane', 'offset', 'start', 'duration', 'enabled', 'role', 'modDate'])
  const safeTitleChild = (node: Element): boolean =>
    titlePresentation.has(node.tag) && node.children.every(safeTitleChild)
  function scanStory(parent: Element, depth: number, primary?: Element) {
    const kept: Element[] = []
    for (const child of parent.children) {
      // Nonlinear, reverse and incomplete maps get the ordinary retime remedy.
      // The affine subset is validated against the clip window below.
      if (clipElements.includes(parent.tag) &&
          (child.tag === 'note' || (child.tag === 'metadata' && parent.tag === 'asset-clip'))) {
        kept.push(child)
        continue
      }
      const candidateMap = child.tag !== 'timeMap' ||
        (['asset-clip', 'video', 'audio'].includes(parent.tag) && child.children.length === 2 &&
          child.children.every(point => point.tag === 'timept' && point.attrs.interp === 'linear'))
      if (parent.tag === 'spine' &&
          (['ref-clip', 'mc-clip', 'sync-clip'].includes(child.tag) || (child.tag === 'transition' && dissolveFilter(child)))) {
        kept.push(child)
        continue
      }
      const title = child.tag === 'title'
      const primaryTitle = title && depth === 0 && (child.attrs.lane ?? '0') === '0'
      const connectedTitle = title && depth === 1 && [...clipElements, 'gap'].includes(parent.tag) &&
        /^[1-9]\d*$/.test(child.attrs.lane ?? '') && Number.isSafeInteger(Number(child.attrs.lane))
      const canLeaveTitleGap = (primaryTitle || connectedTitle) &&
        Object.keys(child.attrs).every(key => titleAttributes.has(key)) &&
        ['0', '1'].includes(child.attrs.enabled ?? '1') && child.children.every(safeTitleChild)
      if (canLeaveTitleGap && effects !== 'refuse') {
        const info = { location: location(child), label: child.attrs.name || 'Title',
          lane: Number(child.attrs.lane ?? 0), recovery: 'leave-title-gap' as const }
        const issue: TimelineCompatibilityItem = leaveTitleGaps
          ? { ...info, status: 'approximated',
            notes: ['This title will be left out. Its timeline interval stays in place, with underlying picture and sound kept.'] }
          : { ...info, status: 'unsupported', notes: [remedies.title!,
            'You can also leave this title out and keep its timeline interval.'] }
        if (leaveTitleGaps) omittedTitles.push(issue)
        else unsupported.push(issue)
        const { offset, duration, lane, start } = child.attrs
        const timingAttrs = Object.fromEntries(Object.entries({ offset, duration, lane, start })
          .filter((entry): entry is [string, string] => entry[1] !== undefined))
        kept.push({ ...child, tag: primaryTitle ? 'gap' : 'title', attrs: timingAttrs, children: [], titleGap: issue })
        continue
      }
      if (!candidateMap || !supportedStory.has(child.tag)) {
        const remedy = Object.hasOwn(remedies, child.tag) ? remedies[child.tag]
          : 'Simplify or render this part in the source editor before exporting.'
        const safeToOmit = clipElements.includes(parent.tag) &&
          ['filter-video', 'filter-audio'].includes(child.tag) && child.children.every(parameterTree)
        const info = { location: location(child), label: child.attrs.name || child.tag,
          lane: Number(parent.attrs.lane ?? 0) || 0,
          ...(safeToOmit ? { recovery: 'omit-effect' as const } : {}) }
        if (effects === 'omit' && safeToOmit) {
          omittedEffects.push({ ...info, status: 'approximated',
            notes: ['This effect will be left out. The clip and its cut times will be kept.'] })
          continue
        }
        const issue: TimelineCompatibilityItem = { ...info, status: 'unsupported',
          notes: ['FCPXML ' + location(child) + ': Unsupported inside <' + parent.tag + '>. ' + remedy] }
        unsupported.push(issue)
        if (depth === 0) primaryIssues.set(child, issue)
        if (!safeToOmit) blockedStoryItems.add(primary ?? child)
        if (effects === 'inspect' && safeToOmit) continue
      } else {
        const scanned = scanStory(child, depth + 1, primary ?? child)
        if (depth === 0 && blockedStoryItems.has(child)) blockedStoryItems.add(scanned)
        kept.push(scanned)
        continue
      }
      kept.push(child)
    }
    return { ...parent, children: kept }
  }
  const spine = scanStory(one(seq, 'spine'), 0)
  const diagnosticClock = primaryIssues.size > 0 ? primaryDiagnosticClock(seq, byId) : undefined
  if (diagnosticClock) {
    for (const [el, issue] of primaryIssues) issue.timelineFrames = explicitPrimaryRange(el, diagnosticClock)
  }
  context.storyIssues?.push(...unsupported)
  if (!collecting && (unsupported.some(issue => !issue.recovery) || (effects === 'refuse' && unsupported.length))) {
    throw new TimelineEditFailure(unsupported, false)
  }
  const notices: TimelineCompatibilityItem[] = [...omittedEffects, ...omittedTitles]
  const notice = (el: Element, note: string) => notices.push({ location: location(el),
    label: el.attrs.name || el.tag, lane: 0, status: 'converted', notes: [note] })
  if (selection && selection.choices > 1) notice(project, 'Only the selected sequence is imported; other sequences remain in the source document')
  if (selection?.root.children.some(el => el.tag === 'library' || el.tag === 'event') ||
      project.attrs.id || project.attrs.uid || project.attrs.modDate) {
    notice(project, 'Only the selected edit is imported. Library and event organization, standalone clips, collections and source metadata are not copied')
  }
  const library = selection?.library
  const libraryColor = library?.attrs.colorProcessing
  if (library && libraryColor !== undefined) notice(library,
    'Library color processing is left out. WeftCut checks the sequence and file color formats.')
  if (seq.attrs.renderFormat !== undefined) notice(seq, 'The source editor’s render codec is left out. Choose an export format in WeftCut.')
  if (seq.attrs.keywords !== undefined || sequenceNotes.length || hasMetadata) notice(seq,
    'Sequence keywords, notes and custom metadata are left out.')
  for (const options of (selection?.root.children.filter(el => el.tag === 'import-options') ?? [])) {
    for (const option of options.children) notice(option, 'Source-editor import option is not applied: ' + (option.attrs.key ?? '(unnamed)') + ' = ' + (option.attrs.value ?? ''))
  }
  if (seq.attrs.audioLayout || seq.attrs.audioRate) notice(seq,
    'Sequence audio output settings (' + (seq.attrs.audioLayout ?? 'default layout') + ', ' +
    (seq.attrs.audioRate ?? 'default rate') + ') use the destination project output settings; editing uses 48 kHz samples')
  const tcFormat = seq.attrs.tcFormat ?? 'NDF'
  if (tcFormat !== 'NDF' && tcFormat !== 'DF') fail(seq, 'Sequence tcFormat must be NDF or DF')
  const sequenceOrigin = time(seq, 'tcStart', ZERO_TIME)
  const audioLayout = seq.attrs.audioLayout ?? 'stereo'
  if (!['mono', 'stereo', 'surround'].includes(audioLayout))
    fail(seq, `Unsupported sequence audio layout "${audioLayout}"`)
  // Sequence audio is presentation metadata; source media can use other sample
  // rates and channel layouts, which the existing conform pipeline converts.
  if (seq.attrs.audioRate !== undefined) audioSampleRate(seq, 'audioRate')

  const lookup = (ref: string, tag: string, from: Element) => lookupResource(byId, ref, tag, from)
  const formatNode = lookup(required(seq, 'format'), 'format', seq)
  const format = parseFormat(formatNode)
  const outputColor = format.sourceColor ?? (formatNode.attrs.colorSpace === undefined &&
    libraryColor !== undefined && libraryColor !== 'standard' ? 'a library using wide color processing' : undefined)
  const fps = FPS_OPTIONS.find(({ num, den }) =>
    compareTime(format.frameDuration, exactTime(1_000_000 * den, num)) === 0) ??
    fail(seq, 'Choose a supported WeftCut timeline frame rate')
  if (tcFormat === 'DF' && !(fps.den === 1001 && [30_000, 60_000].includes(fps.num))) {
    fail(seq, 'Drop-frame display timecode requires 30000/1001 or 60000/1001 fps')
  }
  const storyItems = collecting ? spine.children.filter(item => !blockedStoryItems.has(item)) : spine.children
  check({ ...spine, children: storyItems }, [], ['gap', 'asset-clip', 'video', 'audio', 'transition', 'ref-clip', 'mc-clip', 'sync-clip'])
  const clips: TimelineClip[] = []
  const groups: ImportTimeline['groups'] = []
  const assets = new Map<string, Asset>()
  const dissolves: NonNullable<ImportTimeline['dissolves']> = []
  const mappingIssues: TimelineCompatibilityItem[] = []
  let previousPrimary: TimelineClip | undefined
  let previousPrimaryUnknown = false
  let transitionUnknown = false
  let pendingDissolve: { el: Element; from: TimelineClip; start: ExactTime; end: ExactTime } | undefined
  let primaryEnd = ZERO_TIME
  let lastEnd = ZERO_TIME
  let splitAudioEnd = ZERO_TIME
  const connected: { element: Element; clip: TimelineClip }[] = []

  function readClip(el: Element, parent?: { offset: ExactTime; start: ExactTime }) {
    const a = el.attrs
    const gap = el.tag === 'gap' || el.titleGap !== undefined
    check(el, gap
      ? ['name', 'lane', 'offset', 'start', 'duration']
      : ['name', 'lane', 'offset', 'start', 'duration', 'ref', 'enabled', 'audioRole', 'videoRole', 'format', 'tcFormat', 'srcEnable', 'role',
        ...(el.tag === 'asset-clip' ? ['audioStart', 'audioDuration', 'modDate'] : ['srcID'])],
    gap ? parent ? [] : ['asset-clip', 'video', 'audio', 'title']
      : ['marker', 'chapter-marker', 'adjust-conform', 'adjust-volume', 'adjust-transform', 'adjust-blend', 'timeMap', 'note',
        ...(el.tag === 'asset-clip' ? ['metadata'] : []), ...(parent ? [] : ['asset-clip', 'video', 'audio', 'title'])])
    const lane = Number(a.lane ?? '0')
    if (parent) {
      if (!/^-?[1-9]\d*$/.test(a.lane ?? '') || !Number.isSafeInteger(lane))
        fail(el, 'A connected clip needs a nonzero integer lane')
    } else if ((a.lane ?? '0') !== '0') {
      fail(el, 'Connected clips must be nested inside their primary clip or gap')
    }
    const localOffset = parent ? time(el, 'offset') : time(el, 'offset', sequenceOrigin)
    const offset = parent
      ? addTime(parent.offset, subtractTime(localOffset, parent.start))
      : subtractTime(localOffset, sequenceOrigin)
    if (offset.num < 0) fail(el, 'The clip starts before the timeline origin')
    const notes: string[] = []
    if (a.srcID !== undefined && a.srcID !== '1') {
      fail(el, 'This clip selects source stream ' + a.srcID + '. Export the selected stream as its own file and use it in the source edit.')
    }
    const clipNotes = el.children.filter(child => child.tag === 'note')
    if (clipNotes.length > 1) fail(el, 'Only one clip note is supported')
    if (clipNotes.length) check(clipNotes[0]!, [])
    const hasClipMetadata = checkMetadata(el)
    if (a.modDate !== undefined || clipNotes.length || hasClipMetadata) {
      notes.push('Clip notes and source-editor metadata, when present, are left out.')
    }
    if (el.sequenceConnection) notes.push('This clip keeps its timing on a separate track in the synchronized Group.')
    else if (parent && !el.timing) notes.push('Connected anchor relationship is replaced by independent placement; moving the former anchor will not move this clip')
    if (a.tcFormat === 'DF') notes.push('Clip drop-frame display metadata becomes zero-based non-drop-frame timecode')
    if (!['0', '1'].includes(a.enabled ?? '1') || (a.tcFormat !== undefined && a.tcFormat !== 'NDF' && a.tcFormat !== 'DF')) {
      fail(el, 'The clip has an invalid enabled flag or timecode')
    }
    const ref = gap ? undefined : required(el, 'ref')
    const assetNode = ref === undefined ? undefined : lookup(ref, 'asset', el)
    let asset = ref === undefined ? undefined : assets.get(ref)
    if (assetNode && ref !== undefined && !asset) {
      asset = parseAsset(assetNode, lookup)
      assets.set(ref, asset)
      if (assetNode.attrs.colorSpaceOverride !== undefined && asset.sourceColor === undefined) {
        notice(assetNode, 'The Rec. 709 color override is not copied. WeftCut checks the colors declared by the actual file.')
      }
      if (assetNode.attrs.uid !== undefined) notice(assetNode, 'Source asset UID is not retained')
      for (const detail of asset.mediaNotices) notice(assetNode, detail)
    }
    const component = el.tag === 'video' || el.tag === 'audio' ? el.tag : a.srcEnable ?? 'all'
    if (!['all', 'video', 'audio'].includes(component) || (el.tag !== 'asset-clip' && a.srcEnable !== undefined)) {
      fail(el, 'Choose all media, audio only, or video only on an asset clip')
    }
    const hasVideo = asset?.hasVideo === true && component !== 'audio'
    const hasAudio = asset?.hasAudio === true && component !== 'video'
    if (asset && !hasVideo && !hasAudio) fail(el, 'The file does not declare the video or audio this clip requests')
    const duration = time(el, 'duration', el.tag === 'asset-clip' ? asset?.duration : undefined)
    if (duration.num <= 0) fail(el, 'The clip needs a positive duration')
    const end = addTime(offset, duration)
    const audioOnly = asset !== undefined && !hasVideo
    const firstFrame = audioOnly ? floorTime(divideTime(offset, format.frameDuration)) : frames(offset, format, el, 'offset')
    const endFrame = audioOnly ? ceilTime(divideTime(end, format.frameDuration)) : frames(end, format, el, 'end')
    if (!audioOnly && endFrame <= firstFrame) fail(el, 'Duration must span at least one video frame')
    if (el.titleGap) el.titleGap.timelineFrames = { start: firstFrame, end: endFrame }
    if (!parent) {
      if (compareTime(offset, primaryEnd) < 0 && !pendingDissolve) {
        fail(el, 'Overlaps the preceding item. Remove the overlap or transition and export again')
      }
      primaryEnd = end
    }
    if (compareTime(end, lastEnd) > 0) lastEnd = end
    const start = time(el, 'start', asset?.start ?? ZERO_TIME)
    for (const child of el.children) {
      if (clipElements.includes(child.tag) || child.titleGap) readClip(child, { offset, start })
    }
    if (!asset || !assetNode) {
      if (a.name) notice(el, 'Named gap is represented as empty timeline space; its label is not retained')
      return
    }
    if ((lane < 0 && hasVideo) || (lane > 0 && !hasVideo))
      fail(el, 'Place connected video in positive lanes and connected audio-only clips in negative lanes')
    if (a.format !== undefined && a.format !== assetNode.attrs.format && a.format !== seq.attrs.format) {
      const candidate = lookup(a.format, 'format', el)
      if (asset.stillImage) {
        const other = parseStillFormat(candidate)
        const sourceSize = asset.imageSize
        if ((sourceSize?.width !== undefined && other.imageSize?.width !== undefined && other.imageSize.width !== sourceSize.width) ||
            (sourceSize?.height !== undefined && other.imageSize?.height !== undefined && other.imageSize.height !== sourceSize.height) ||
            (candidate.attrs.colorSpace !== undefined && other.sourceColor !== asset.sourceColor)) {
          fail(el, 'The still clip declares a different size or color space from its source. Export it with a matching image format.')
        }
        if (other.imageSize) {
          asset = { ...asset, imageSize: { width: sourceSize?.width ?? other.imageSize.width,
            height: sourceSize?.height ?? other.imageSize.height } }
        }
        const original = assetNode.attrs.format === undefined ? undefined : lookup(assetNode.attrs.format, 'format', el)
        if (candidate.attrs.frameDuration !== original?.attrs.frameDuration) {
          notes.push('The still clip’s format frame rate does not affect when the image appears. Its duration comes from the timeline.')
        }
      } else {
        const other = parseFormat(candidate, true)
        const same = (known: Pick<Format, 'width' | 'height' | 'frameDuration' | 'paspH' | 'paspV'>) =>
          known.width === other.width && known.height === other.height &&
          compareTime(known.frameDuration, other.frameDuration) === 0 &&
          known.paspH * other.paspV === known.paspV * other.paspH
        if (other.sourceColor !== undefined && other.sourceColor !== format.sourceColor && other.sourceColor !== asset.sourceColor) {
          fail(el, 'The clip adds a color format that differs from both the source and sequence. Export it as an SDR Rec. 709 clip.')
        }
        if (!same(format) && (!asset.videoFormat || !same(asset.videoFormat))) {
          fail(el, 'The clip format differs from its source and timeline. Export the clip with a matching format.')
        }
      }
    }
    const conformance = el.children.filter(child => child.tag === 'adjust-conform')
    if (conformance.length > 1) fail(el, 'Only one spatial conform operation is supported')
    let conform: 'fit' | 'fill' | 'none' = 'fit'
    if (conformance.length) {
      const operation = conformance[0]!
      check(operation, ['type'])
      conform = (operation.attrs.type ?? 'fit') as typeof conform
      if (!['fit', 'fill', 'none'].includes(conform)) fail(operation, 'Spatial conform must be fit, fill or none')
      if (!hasVideo) fail(operation, 'Spatial conform requires a video or image clip')
    }
    const volumeOps = el.children.filter(child => child.tag === 'adjust-volume')
    if (volumeOps.length > 1) fail(el, 'Only one static volume operation is supported')
    let volumeDb = 0
    if (volumeOps.length) {
      const operation = volumeOps[0]!
      check(operation, ['amount'])
      if (!hasAudio) fail(operation, 'Volume adjustment requires source audio')
      const raw = operation.attrs.amount ?? '0dB'
      if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)dB$/.test(raw)) {
        fail(operation, 'Only static dB volume adjustments are supported; keyframed, relative and infinite gain require an audio conversion')
      }
      volumeDb = Number(raw.slice(0, -2))
      if (!Number.isFinite(volumeDb) || volumeDb < -30 || volumeDb > 20) {
        fail(operation, 'Volume gain must be between -30dB and +20dB, within WeftCut editable range')
      }
    }
    const transformOps = el.children.filter(child => child.tag === 'adjust-transform')
    const blendOps = el.children.filter(child => child.tag === 'adjust-blend')
    if (transformOps.length > 1 || blendOps.length > 1) {
      fail(el, 'Only one static transform and one static blend operation per clip are supported')
    }
    if (!hasVideo && (transformOps.length || blendOps.length)) {
      fail(el, 'Visual adjustments require a video or image clip')
    }
    let staticTransform: TimelineClip['staticTransform']
    if (transformOps.length) {
      const operation = transformOps[0]!
      check(operation, ['enabled', 'position', 'scale', 'rotation', 'anchor'])
      if (operation.attrs.enabled !== undefined && !['0', '1'].includes(operation.attrs.enabled)) {
        fail(operation, 'Invalid transform enabled flag')
      }
      function pair(value: string, attribute: string): [number, number] {
        const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(value)
        if (!match) fail(operation, 'Static transform ' + attribute + ' needs two finite numbers')
        const x = Number(match[1]), y = Number(match[2])
        if (![x, y].every(Number.isFinite)) fail(operation, 'Invalid static transform vector')
        return [x, y]
      }
      const anchor = pair(operation.attrs.anchor ?? '0 0', 'anchor')
      if (anchor[0] !== 0 || anchor[1] !== 0) {
        fail(operation, 'Nonzero anchor offsets require a verified pivot conversion')
      }
      if (operation.attrs.enabled === '0') notes.push('Disabled transform and its stored parameter values are not retained')
      if (operation.attrs.enabled !== '0') {
        const pos = pair(operation.attrs.position ?? '0 0', 'position')
        const scale = pair(operation.attrs.scale ?? '1 1', 'scale')
        const rotation = Number(operation.attrs.rotation ?? '0')
        if (scale.some(n => n <= 0 || n > 10) || !Number.isFinite(rotation) ||
            Math.abs(rotation) > 360 || pos.some(n => Math.abs(n) > 1000)) {
          fail(operation, 'Static transform must have positive 0–10 scales, ±360° rotation and ±1000% positions')
        }
        staticTransform = { xPercent: pos[0], yPercent: pos[1],
          scaleX: scale[0], scaleY: scale[1], rotation }
      }
    }
    let opacity: number | undefined
    if (blendOps.length) {
      const operation = blendOps[0]!
      check(operation, ['amount', 'mode'])
      if (!['0', 'normal'].includes(operation.attrs.mode ?? '0')) {
        fail(operation, 'Only normal blend mode can be imported without a verified compositor mapping')
      }
      const raw = operation.attrs.amount ?? '1'
      if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(raw)) {
        fail(operation, 'Static opacity must be between 0 and 1')
      }
      opacity = Number(raw)
    }
    if (a.role !== undefined && el.tag !== 'audio' && el.tag !== 'video') {
      fail(el, 'Use audioRole or videoRole to assign a role on this clip and export again.')
    }
    for (const role of new Set([a.videoRole, el.tag === 'video' ? a.role : undefined])) {
      if (role !== undefined && role !== 'video') {
        notes.push('The video role label “' + role + '” is left out.')
      }
    }
    const role = a.audioRole ?? (el.tag === 'audio' ? a.role : undefined)
    const mainRole = role?.split('.')[0]
    const knownRole = mainRole === undefined ? 'dialogue' : FCPXML_AUDIO_ROLES.get(mainRole.toLowerCase())
    if (!hasAudio && role !== undefined && role !== 'dialogue') {
      notes.push('The audio role label “' + role + '” is left out because this placement uses picture only.')
    }
    if (asset.start.num !== 0) notes.push('Source timecode origin is normalized to file-relative source trims')
    const maps = el.children.filter(child => child.tag === 'timeMap')
    let splitAudio: TimelineClip['splitAudio']
    if (a.audioStart !== undefined || a.audioDuration !== undefined) {
      const audioStart = time(el, 'audioStart', start)
      const audioDuration = time(el, 'audioDuration', duration)
      const delta = subtractTime(audioStart, start)
      if (!hasAudio) {
        notes.push('Separate audio trim is left out because the clip does not use audio.')
      } else if (delta.num !== 0 || compareTime(audioDuration, duration) !== 0) {
        if (maps.length) fail(el, 'This clip combines a split audio edit with a speed change. Render it with its audio in the source editor and export again.')
        const audioIn = subtractTime(audioStart, asset.start)
        if (audioIn.num < 0 || audioDuration.num <= 0) {
          fail(el, 'The separate audio trim starts before the source file or has no duration. Correct the audio trim and export again.')
        }
        const timelineStart = addTime(offset, delta)
        const timelineEnd = addTime(timelineStart, audioDuration)
        if (timelineEnd.num <= 0) {
          fail(el, 'The entire audio trim is before the timeline begins. Move the edit forward in the source editor and export again.')
        }
        const beforeTimeline = timelineStart.num < 0
        splitAudio = {
          timelineStart: beforeTimeline ? ZERO_TIME : timelineStart,
          timelineEnd,
          sourceIn: beforeTimeline ? subtractTime(audioIn, timelineStart) : audioIn,
          sourceOut: addTime(audioIn, audioDuration),
          clippedBeforeZero: beforeTimeline,
        }
        if (compareTime(timelineEnd, splitAudioEnd) > 0) splitAudioEnd = timelineEnd
      }
    }
    let sourceIn = subtractTime(start, asset.start)
    let sourceOut = addTime(sourceIn, duration)
    let playbackRate: ExactTime | undefined
    let preservePitch: boolean | undefined
    if (maps.length) {
      const map = maps[0]!
      check(map, ['frameSampling', 'preservesPitch'], ['timept'])
      const remedy = 'Render the speed change into a new clip in the source editor, replace this clip, and export again.'
      if (maps.length !== 1 || asset.stillImage || el.children.some(child =>
        ['asset-clip', 'video', 'audio', 'marker', 'chapter-marker'].includes(child.tag))) {
        fail(map, 'This speed change includes markers, connected clips, or other timing WeftCut cannot reproduce. ' + remedy)
      }
      if ((map.attrs.frameSampling ?? 'floor') !== 'floor' || !['0', '1'].includes(map.attrs.preservesPitch ?? '1')) {
        fail(map, 'WeftCut cannot reproduce this frame interpolation or pitch setting. ' + remedy)
      }
      const [first, last] = map.children
      for (const point of [first!, last!]) check(point, ['time', 'value', 'interp'])
      const startTime = time(first!, 'time')
      const endTime = time(last!, 'time')
      const startValue = time(first!, 'value')
      const endValue = time(last!, 'value')
      if (compareTime(endTime, startTime) <= 0 || compareTime(endValue, startValue) <= 0 ||
        compareTime(start, startTime) < 0 || compareTime(addTime(start, duration), endTime) > 0) {
        fail(map, 'WeftCut can import forward constant speed when the map covers the whole clip. ' + remedy)
      }
      playbackRate = divideTime(subtractTime(endValue, startValue), subtractTime(endTime, startTime))
      sourceIn = subtractTime(addTime(startValue, multiplyTime(subtractTime(start, startTime), playbackRate)), asset.start)
      sourceOut = addTime(sourceIn, multiplyTime(duration, playbackRate))
      preservePitch = map.attrs.preservesPitch !== '0'
    }
    if (sourceIn.num < 0) fail(el, 'Trim begins before the asset’s source timecode. Correct the source in-point and export again.')
    if (asset.stillImage && sourceIn.num !== 0)
      fail(el, 'Still-image clips must start at 0s in the source')
    const markers = el.children.filter(child => child.tag === 'marker' || child.tag === 'chapter-marker').map((mark) => {
      const notes: string[] = []
      const chapter = mark.tag === 'chapter-marker'
      check(mark, chapter ? ['start', 'duration', 'value', 'note', 'posterOffset'] : ['start', 'duration', 'value', 'note', 'completed'])
      const label = required(mark, 'value')
      const { completed } = mark.attrs
      if (completed !== undefined && completed !== '0' && completed !== '1') fail(mark, 'Invalid marker to-do status')
      if (completed !== undefined) notes.push('Marker “' + label + '” keeps its text. Its to-do status is left out.')
      if (chapter) notes.push('Chapter “' + label + '” becomes a timeline marker. Chapter and poster-frame settings are left out.')
      const markerDuration = time(mark, 'duration', format.frameDuration)
      const at = time(mark, 'start')
      const local = subtractTime(at, start)
      if (local.num < 0 || compareTime(local, duration) >= 0) fail(mark, 'Marker lies outside the clip trim')
      const timelineAt = addTime(offset, local)
      const markerFrame = divideTime(timelineAt, format.frameDuration)
      const nearest = roundTime(markerFrame)
      const frame = Math.min(nearest, endFrame - 1)
      if (frame !== nearest) {
        notes.push('Marker “' + label + '” stays on frame ' + frame + ', the last frame of its clip. The nearest frame is outside the clip.')
      } else if (markerFrame.den !== 1) {
        notes.push('Marker “' + label + '” moved to the nearest timeline frame (' + frame + ').')
      }
      let rangeEnd: number | null = null
      if (compareTime(markerDuration, format.frameDuration) > 0) {
        if (compareTime(addTime(local, markerDuration), duration) > 0) {
          fail(mark, 'The marker range extends past the clip trim. Shorten the marker or extend the clip.')
        }
        const rangeFrame = divideTime(addTime(timelineAt, markerDuration), format.frameDuration)
        rangeEnd = roundTime(rangeFrame)
        if (rangeFrame.den !== 1) notes.push('The end of marker “' + label + '” moved to timeline frame ' + rangeEnd + '.')
      } else if (markerDuration.num > 0) {
        notes.push('Marker “' + label + '” becomes a point marker')
      }
      return { label, note: mark.attrs.note, frame, endFrame: rangeEnd, source: subtractTime(at, asset.start), notes }
    })
    const clip: TimelineClip = { label: a.name || assetNode.attrs.name, enabled: a.enabled !== '0', asset, lane,
      timelineStart: offset, timelineEnd: end, firstFrame, endFrame, sourceIn, sourceOut, hasVideo, splitAudio, playbackRate, preservePitch,
      audioRole: hasAudio ? knownRole ?? 'dialogue' : null,
      ...(hasAudio && role !== undefined && (knownRole === undefined || role !== mainRole) ?
        { sourceAudioRole: { label: role, usesDialogueFallback: knownRole === undefined } } : {}),
      conform, volumeDb, opacity, staticTransform, markers, notes, location: location(el) }
    if (parent) connected.push({ element: el, clip })
    else clips.push(clip)
  }

  function readStoryItem(el: Element) {
    if (el.sequenceConnection) {
      readClip(el, { offset: ZERO_TIME, start: sequenceOrigin })
      return
    }
    if (el.tag === 'sync-clip') {
      const attrs = el.attrs
      if (pendingDissolve || (attrs.lane ?? '0') !== '0' || !['0', '1'].includes(attrs.enabled ?? '1')) {
        fail(el, 'This synchronized placement needs a primary lane, no overlapping transition and a valid enabled flag. ' + syncRemedy)
      }
      const start = subtractTime(time(el, 'offset', sequenceOrigin), sequenceOrigin)
      const duration = time(el, 'duration')
      const end = addTime(start, duration)
      if (start.num < 0 || duration.num <= 0 || compareTime(start, primaryEnd) < 0) {
        fail(el, 'The synchronized placement overlaps another edit or has an invalid timeline range. ' + syncRemedy)
      }
      try {
        groups.push(synchronizedGroup(el, context, { format, fps, parentFormat: seq.attrs.format, depth,
          firstFrame: frames(start, format, el, 'offset'), endFrame: frames(end, format, el, 'end'), duration }))
      } catch (error) {
        if (error instanceof FcpxmlError && !error.message.includes(syncRemedy)) fail(el, error.message + ' ' + syncRemedy)
        if (error instanceof TimelineEditFailure) {
          for (const issue of error.issues) issue.notes.push(syncRemedy)
        }
        throw error
      }
      previousPrimary = undefined
      primaryEnd = end
      if (compareTime(end, lastEnd) > 0) lastEnd = end
      notice(el, 'The synchronized clip becomes an editable Group. Picture and sound keep their timing inside the Group.')
      if (attrs.tcStart !== undefined) notice(el, 'The synchronized clip’s display timecode is left out. This does not move its edits.')
      if (attrs.modDate !== undefined) notice(el, 'The source modification date is left out.')
      if (el.children.some(child => child.tag === 'spine' && child.attrs.name)) {
        notice(el, 'The internal storyline name is left out.')
      }
      return
    }
    if (el.tag === 'mc-clip') {
      let multicam: ReturnType<typeof multicamSequence>
      let nested: ImportTimeline
      try {
        multicam = multicamSequence(el, context, fps)
        nested = parseSequence(multicam.sequence, { ...el, attrs: { name: multicam.label } }, context, undefined, depth + 1)
      } catch (error) {
        if (error instanceof FcpxmlError && !error.message.includes(multicamRemedy)) {
          fail(el, error.message + ' ' + multicamRemedy)
        }
        throw error
      }
      const { names, duration, label } = multicam
      const start = subtractTime(time(el, 'offset', sequenceOrigin), sequenceOrigin)
      const end = addTime(start, duration)
      if (pendingDissolve || start.num < 0 || compareTime(start, primaryEnd) < 0) {
        fail(el, 'The multicam placement overlaps another edit. ' + multicamRemedy)
      }
      const firstFrame = frames(start, format, el, 'offset')
      const endFrame = frames(end, format, el, 'end')
      groups.push({ timeline: nested, label, enabled: el.attrs.enabled !== '0', firstFrame, endFrame,
        sourceIn: ZERO_TIME, sourceOut: duration, conform: 'fit', kind: 'multicam' })
      previousPrimary = undefined
      primaryEnd = end
      if (compareTime(end, lastEnd) > 0) lastEnd = end
      notice(el, 'Selected angles become editable clips in a Group: ' + names.join(', ') +
        '. Unused angles are left out. Angle switching stays in the source editor.')
      if (el.attrs.modDate !== undefined) notice(el, 'The source multicam modification date is left out.')
      return
    }
    if (el.tag === 'ref-clip') {
      const remedy = 'Open the compound clip in the source editor and put its contents on the timeline, or render it as one clip.'
      const attrs = el.attrs
      check(el, ['name', 'ref', 'offset', 'start', 'duration', 'enabled', 'format', 'srcEnable', 'lane'], ['adjust-conform'])
      if (pendingDissolve || (attrs.lane ?? '0') !== '0' || (attrs.srcEnable ?? 'all') !== 'all' ||
          !['0', '1'].includes(attrs.enabled ?? '1')) fail(el, remedy)
      const ref = required(el, 'ref')
      const media = lookup(ref, 'media', el)
      if (media.children.length !== 1 || media.children[0]?.tag !== 'sequence') fail(el, remedy)
      const child = media.children[0]
      if (attrs.format !== undefined && attrs.format !== child.attrs.format && attrs.format !== seq.attrs.format) fail(el, remedy)
      if (active.has(ref)) fail(el, 'This compound clip refers to itself through another clip. ' + remedy)
      let nested = compounds.get(ref)
      if (!nested) {
        if (active.size >= FCPXML_LIMITS.compoundDepth || compounds.size + active.size >= FCPXML_LIMITS.compounds) {
          fail(el, 'There are too many nested compound clips to import together. Export a smaller sequence.')
        }
        check(media, ['id', 'name', 'uid', 'modDate'], ['sequence'])
        active.add(ref)
        try {
          nested = parseSequence(child, media, context, undefined, depth + 1)
          compounds.set(ref, nested)
        } finally {
          active.delete(ref)
        }
      }
      if (nested.fps.num !== fps.num || nested.fps.den !== fps.den) {
        fail(el, 'This compound clip runs at a different frame rate from its parent. ' + remedy)
      }
      const start = subtractTime(time(el, 'offset', sequenceOrigin), sequenceOrigin)
      const duration = time(el, 'duration')
      const end = addTime(start, duration)
      if (start.num < 0 || duration.num <= 0 || compareTime(start, primaryEnd) < 0) fail(el, 'The compound placement overlaps or falls outside its parent sequence. ' + remedy)
      const childOrigin = time(child, 'tcStart', ZERO_TIME)
      const sourceIn = subtractTime(time(el, 'start', childOrigin), childOrigin)
      const sourceOut = addTime(sourceIn, duration)
      if (sourceIn.num < 0 || compareTime(sourceOut, nested.authoredDuration) > 0) {
        fail(el, 'The compound trim extends outside its sequence. ' + remedy)
      }
      frames(sourceIn, format, el, 'start')
      const conformNode = el.children[0]
      if (el.children.length > 1) fail(el, 'Only one spatial conform operation is supported on a compound clip')
      if (conformNode) check(conformNode, ['type'])
      const conform = conformNode?.attrs.type ?? 'fit'
      if (conform !== 'fit' && conform !== 'fill' && conform !== 'none') fail(el, 'Spatial conform must be fit, fill or none')
      const label = attrs.name || media.attrs.name || 'Compound clip'
      groups.push({ timeline: nested, label, enabled: attrs.enabled !== '0',
        firstFrame: frames(start, format, el, 'offset'), endFrame: frames(end, format, el, 'end'),
        sourceIn, sourceOut, conform, kind: 'compound' })
      previousPrimary = undefined
      primaryEnd = end
      if (compareTime(end, lastEnd) > 0) lastEnd = end
      notice(el, 'This compound clip becomes an editable Group. Other placements of the same compound share its contents.')
      if (childOrigin.num !== 0) notice(el, 'The compound’s source timecode origin is normalized to zero')
      return
    }
    if (el.tag === 'transition') {
      const filter = dissolveFilter(el)!
      check(el, ['name', 'offset', 'duration', 'start'], ['filter-video'])
      check(filter, ['ref', 'name'])
      const from = previousPrimary
      if (pendingDissolve || !from || compareTime(from.timelineEnd, primaryEnd) !== 0 ||
          !from.hasVideo || from.audioRole || !from.enabled) {
        fail(el, 'A cross dissolve needs two adjacent enabled video-only clips. Render the transition in the source editor if it includes other media.')
      }
      const start = subtractTime(time(el, 'offset'), sequenceOrigin)
      const duration = time(el, 'duration')
      const end = addTime(start, duration)
      if (compareTime(start, from.timelineStart) <= 0 || compareTime(end, from.timelineEnd) !== 0) {
        fail(el, 'The cross dissolve does not match the outgoing clip’s overlap. Render it in the source editor to keep its timing.')
      }
      pendingDissolve = { el, from, start, end }
      return
    }
    const before = clips.length
    readClip(el)
    previousPrimary = clips[before]
    if (!pendingDissolve) return
    const { el: transition, from, start, end } = pendingDissolve
    pendingDissolve = undefined
    const to = clips[before]
    if (!to || !to.hasVideo || to.audioRole || !to.enabled ||
        compareTime(to.timelineStart, start) !== 0 || compareTime(to.timelineEnd, end) <= 0) {
      fail(transition, 'The cross dissolve does not match two video-only clips with an explicit overlap. Render it in the source editor to keep its timing.')
    }
    const previous = dissolves.at(-1)
    if (previous && frames(start, format, transition, 'offset') < previous.endFrame) {
      fail(transition, 'Overlapping cross dissolves need to be rendered in the source editor.')
    }
    dissolves.push({ from, to, firstFrame: frames(start, format, transition, 'offset'), endFrame: frames(end, format, transition, 'end') })
    notices.push({ location: location(transition), label: transition.attrs.name || 'Cross Dissolve', lane: 0,
      status: 'approximated', notes: ['WeftCut uses its editable crossfade over the original overlap. The blend may look slightly different.'] })
  }
  function reportMappingFailure(error: unknown, placement: Element) {
    if (!collecting) throw error
    if (error instanceof TimelineEditFailure) {
      const range = depth === 0 ? explicitPrimaryRange(placement, { format, origin: sequenceOrigin }) : undefined
      for (const issue of error.issues) mappingIssues.push({ ...issue, timelineFrames: range })
    } else if (error instanceof FcpxmlError) {
      const range = depth === 0 && !placement.sequenceConnection && error.element === placement
        ? explicitPrimaryRange(placement, { format, origin: sequenceOrigin }) : undefined
      mappingIssues.push(mappingDiagnostic(error, range))
    } else if (error instanceof TimeMappingError) {
      mappingIssues.push({ label: placement.attrs.name || placement.tag, location: location(placement),
        lane: 0, status: 'unsupported',
        notes: ['This edit uses timing outside the supported range. Check its start and duration in the source editor.'] })
    } else throw error
  }

  for (const el of spine.children) {
    if (!collecting) {
      readStoryItem(el)
      continue
    }
    if (++context.reviewedPlacements > FCPXML_LIMITS.expandedPlacements) {
      fail(seq, 'This timeline expands into too many edits to review. Export a smaller sequence.')
    }
    // A failed edit cannot establish its neighbours' overlap or transition.
    // Resume independent placement checks at the next known edit boundary.
    if (el.tag === 'transition' && (previousPrimaryUnknown || blockedStoryItems.has(el))) {
      pendingDissolve = undefined
      transitionUnknown = true
      continue
    }
    if (blockedStoryItems.has(el)) {
      previousPrimaryUnknown = true
      if (pendingDissolve) transitionUnknown = true
      pendingDissolve = undefined
      continue
    }
    const checkpoint = { clips: clips.length, groups: groups.length, connected: connected.length,
      dissolves: dissolves.length, notices: notices.length, primaryEnd, lastEnd, splitAudioEnd }
    const dependsOnDissolve = pendingDissolve !== undefined || el.tag === 'transition'
    if (transitionUnknown && !el.sequenceConnection) primaryEnd = ZERO_TIME
    try {
      readStoryItem(el)
      if (!el.sequenceConnection && el.tag !== 'transition') {
        previousPrimaryUnknown = false
        transitionUnknown = false
      }
    } catch (error) {
      reportMappingFailure(error, el)
      clips.length = checkpoint.clips
      groups.length = checkpoint.groups
      connected.length = checkpoint.connected
      dissolves.length = checkpoint.dissolves
      notices.length = checkpoint.notices
      primaryEnd = checkpoint.primaryEnd
      lastEnd = checkpoint.lastEnd
      splitAudioEnd = checkpoint.splitAudioEnd
      if (el.sequenceConnection) continue
      transitionUnknown ||= dependsOnDissolve
      pendingDissolve = undefined
      previousPrimaryUnknown = true
      previousPrimary = undefined
    }
  }
  if (pendingDissolve) {
    try { fail(pendingDissolve.el, 'The cross dissolve has no incoming clip. Render it in the source editor.') }
    catch (error) { reportMappingFailure(error, pendingDissolve.el) }
  }
  const laneEnds = new Map<number, ExactTime>()
  connected.sort((a, b) => a.clip.lane - b.clip.lane || compareTime(a.clip.timelineStart, b.clip.timelineStart))
  for (const { element, clip } of connected) {
    if (compareTime(clip.timelineStart, laneEnds.get(clip.lane) ?? ZERO_TIME) < 0) {
      try { fail(element, 'Overlaps another clip on the same connected lane. Move one clip to a different lane') }
      catch (error) { reportMappingFailure(error, element) }
      continue
    }
    laneEnds.set(clip.lane, clip.timelineEnd)
    clips.push(clip)
  }
  if (mappingIssues.length || (collecting && unsupported.some(issue => !issue.recovery))) {
    throw new TimelineEditFailure([...mappingIssues, ...unsupported], false)
  }
  let sequenceDuration = time(seq, 'duration', lastEnd)
  if (compareTime(sequenceDuration, lastEnd) < 0) fail(seq, 'Declared duration ends before the last storyline item')
  if (compareTime(splitAudioEnd, sequenceDuration) > 0) {
    sequenceDuration = splitAudioEnd
    notice(seq, 'The timeline is extended to keep split audio’s time after the last picture.')
  }
  const frameCount = divideTime(sequenceDuration, format.frameDuration)
  const durationFrames = ceilTime(frameCount)
  if (frameCount.den !== 1) notice(seq, 'The timeline end was extended to the next video frame to cover the full edit.')
  if (!clips.length && !groups.length && !omittedTitles.length && !unsupported.length) {
    fail(spine, 'The primary storyline needs at least one media clip or Group')
  }
  return { name: project.attrs.name, canvas: { width: format.width, height: format.height },
    fps: { num: fps.num, den: fps.den }, authoredDuration: sequenceDuration, durationFrames, clips, groups, dissolves, notices, omittedEffects, omittedTitles, editIssues: unsupported,
    normalizedTimecode: sequenceOrigin.num !== 0, dropFrameTimecode: tcFormat === 'DF',
    namedFormatDefaults: format.namedDefaults, sourceColor: outputColor }
}
