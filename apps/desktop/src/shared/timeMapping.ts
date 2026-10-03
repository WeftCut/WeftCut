/** Exact microseconds (or a dimensionless ratio). Canonical JSON: reduced,
 * positive denominator, both components safe integers; zero is always 0/1.
 * Arithmetic lives in weftcut-eval, through renderer/timeMapping.ts. */
export interface ExactTime {
  readonly num: number;
  readonly den: number;
}

export type TimeRatio = ExactTime;

export interface TimeMap {
  readonly kind: 'Affine';
  readonly rate: TimeRatio;
}

/** Content is unwrapped: an animated image takes the modulo only at sampling.
 * Neither this window nor its origin is rounded at a split or Group boundary. */
export interface ContentTiming {
  readonly time_map: TimeMap;
  readonly content_in: ExactTime;
  readonly content_out: ExactTime;
}

export interface ExactRange {
  readonly start: ExactTime;
  readonly end: ExactTime;
}

export type RetimeTarget =
  | { readonly kind: 'Rate'; readonly value: TimeRatio }
  | { readonly kind: 'Duration'; readonly duration_us: number };

export type FrameInterpolation =
  | { readonly kind: 'FrameSampling' }
  | { readonly kind: 'FrameBlending' }
  | { readonly kind: 'OpticalFlow' };

/** Integer microseconds plus a proper fractional remainder form ONE exact
 * coordinate. Omitted remainders are zero; no second floating-point clock. */
export interface TimingFields {
  time_map?: TimeMap;
  source_phase?: { in: ExactTime; out: ExactTime };
  /** Unwrapped window for content without the media src_in/src_out fields. */
  content_window?: { in_us: number; out_us: number };
  fade_phase?: { in: ExactTime; out: ExactTime };
  preserve_pitch?: boolean;
  frame_interpolation?: FrameInterpolation;
}

export type TimeMappingErrorCode =
  | 'InvalidNumber'
  | 'ZeroDenominator'
  | 'Overflow'
  | 'NonCanonical'
  | 'NonPositiveRate'
  | 'InvalidRange'
  | 'UnknownTimeMap';

export class TimeMappingError extends Error {
  constructor(readonly code: TimeMappingErrorCode) {
    super(code);
    this.name = 'TimeMappingError';
  }
}
