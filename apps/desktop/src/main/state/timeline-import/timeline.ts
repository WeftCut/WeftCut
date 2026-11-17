import type { TimelineCompatibilityItem } from '../../../shared/timelineImport'
import type { ExactTime } from '../../../shared/timeMapping'
import type { AudioRole, Rational } from '../model'

import type { OriginalMediaPath } from './mediaPath'

export interface TimelineMediaReference extends OriginalMediaPath {
  ref: string
  name?: string
  proxies?: OriginalMediaPath[]
  uid?: string
  signature?: string
}

export interface TimelineSource extends TimelineMediaReference {
  duration: ExactTime
  hasVideo: boolean
  /** FCPXML's zero-duration asset is a still image displayed for the clip's timeline span. */
  stillImage?: boolean
  sourceColor?: string
  imageSize?: { width?: number; height?: number }
  videoFormat?: { width: number; height: number; frameDuration: ExactTime; paspH: number; paspV: number }
  hasAudio?: boolean
  audioChannels?: number
  audioRate?: number
}

export interface TimelineSourceWindow {
  sourceIn: ExactTime
  sourceOut: ExactTime
}

export interface TimelineClip extends TimelineSourceWindow {
  label?: string
  enabled?: boolean
  hasVideo: boolean
  asset: TimelineSource
  lane: number
  timelineStart: ExactTime
  timelineEnd: ExactTime
  firstFrame: number
  endFrame: number
  splitAudio?: TimelineSourceWindow & { timelineStart: ExactTime; timelineEnd: ExactTime; clippedBeforeZero: boolean }
  playbackRate?: ExactTime
  preservePitch?: boolean
  audioRole: AudioRole | null
  sourceAudioRole?: { label: string; usesDialogueFallback: boolean }
  conform?: 'fit' | 'fill' | 'none'
  volumeDb?: number
  opacity?: number
  staticTransform?: { xPercent: number; yPercent: number; scaleX: number; scaleY: number; rotation: number }
  markers: { label: string; note?: string; frame: number; endFrame: number | null; source: ExactTime; notes: string[] }[]
  location: string
  notes: string[]
}

export interface TimelineGroup {
  kind: 'compound' | 'multicam' | 'synchronized'
  timeline: ImportTimeline
  label: string
  enabled: boolean
  firstFrame: number
  endFrame: number
  sourceIn: ExactTime
  sourceOut: ExactTime
  conform: 'fit' | 'fill' | 'none'
}

export interface ImportTimeline {
  name?: string
  canvas?: { width: number; height: number }
  fps: Rational
  authoredDuration: ExactTime
  durationFrames: number
  clips: TimelineClip[]
  groups: TimelineGroup[]
  dissolves?: { from: TimelineClip; to: TimelineClip; firstFrame: number; endFrame: number }[]
  notices: TimelineCompatibilityItem[]
  editIssues?: TimelineCompatibilityItem[]
  omittedEffects?: TimelineCompatibilityItem[]
  omittedTitles?: TimelineCompatibilityItem[]
  normalizedTimecode?: boolean
  dropFrameTimecode?: boolean
  namedFormatDefaults?: boolean
  sourceColor?: string
}
