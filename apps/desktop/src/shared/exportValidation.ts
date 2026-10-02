import {
  AUDIO_BITRATES, AUDIO_CHANNELS, AUDIO_SAMPLE_RATES,
  bitrateConstraintIssue, computeBitrate, exportOutputExtension,
  isAudioCodecContainerValid, isBitDepthValid, isCodecContainerValid,
  isIntermediateCodec, mergeSettings, resolveOutputDims,
  type ExportSettings,
} from "./exportSettings";

export class ExportValidationError extends Error {
  readonly code = "invalid_params";
  constructor(message: string) {
    super(message);
    this.name = "ExportValidationError";
  }
}

const enumSchema = (values: readonly unknown[]) => ({ enum: [...values] });
const nullablePositive = { type: ["number", "null"], exclusiveMinimum: 0 };
const nullablePositiveInteger = { type: ["integer", "null"], minimum: 1 };
const audioProperties = {
  include: { type: "boolean" },
  codec: enumSchema(["aac", "opus"]),
  bitrate: enumSchema(AUDIO_BITRATES),
  sampleRate: enumSchema([...AUDIO_SAMPLE_RATES, null]),
  channels: enumSchema([...AUDIO_CHANNELS, null]),
};
const properties = {
  includeVideo: { type: "boolean" }, includeAudio: { type: "boolean" },
  resolutionHeight: nullablePositiveInteger, fps: nullablePositiveInteger,
  codec: enumSchema(["h264", "av1", "hevc", "prores", "dnxhr"]),
  quality: enumSchema(["low", "medium", "high", "custom"]),
  customBitrate: nullablePositiveInteger,
  rateMode: enumSchema(["vbr", "cbr", "quality"]),
  maxBitrate: nullablePositive, bufferSize: nullablePositive,
  proresProfile: enumSchema(["proxy", "lt", "422", "hq"]),
  dnxhrProfile: enumSchema(["lb", "sq", "hq"]),
  crf: { type: ["integer", "null"], minimum: 0, maximum: 51 },
  preset: enumSchema(["fast", "medium", "slow"]),
  keyframeIntervalSec: { type: "number", exclusiveMinimum: 0 },
  hwAccel: enumSchema(["auto", "software"]),
  encoderEngine: enumSchema(["auto", "native", "webcodecs"]),
  decodeEngine: enumSchema(["auto", "ffmpeg", "webcodecs"]),
  bitDepth: enumSchema([8, 10]), container: enumSchema(["mp4", "mov", "mkv"]),
  audio: { type: "object", additionalProperties: false, properties: audioProperties },
};

/** Partial overrides; defaults come from the project's persisted settings. */
export const EXPORT_SETTINGS_SCHEMA = {
  type: "object", additionalProperties: false, properties,
};

export const EXPORT_COMPATIBILITY = {
  containersByCodec: {
    h264: ["mp4", "mov", "mkv"], hevc: ["mp4", "mov", "mkv"],
    av1: ["mp4", "mkv"], prores: ["mov"], dnxhr: ["mov"],
  },
  bitDepthsByCodec: { h264: [8], hevc: [8, 10], av1: [8, 10], prores: [10], dnxhr: [8] },
  audioOnlyExtensions: { aac: "m4a", opus: "mka" },
  opusVideoContainers: ["mkv"],
  nativeOnly: ["intermediate codecs", "10-bit video", "constant-quality rate control"],
  experimental10bitOptIn: ["hevc", "av1"],
};

type SchemaRule = {
  type?: string | string[]; enum?: readonly unknown[];
  minimum?: number; maximum?: number; exclusiveMinimum?: number;
};

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExportValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateFields(value: Record<string, unknown>, rules: Record<string, SchemaRule>, name: string): void {
  for (const [key, actual] of Object.entries(value)) {
    const rule = rules[key];
    if (!rule) throw new ExportValidationError(`Unknown ${name}.${key}`);
    if (rule.enum) {
      if (!rule.enum.includes(actual)) throw new ExportValidationError(`Invalid ${name}.${key}`);
      continue;
    }
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (actual === null && types.includes("null")) continue;
    const validType = types.some((type) => type === "integer"
      ? typeof actual === "number" && Number.isSafeInteger(actual)
      : type === typeof actual && actual !== null);
    if (!validType) throw new ExportValidationError(`Invalid ${name}.${key}`);
    if (typeof actual === "number" && (!Number.isFinite(actual)
      || (rule.minimum != null && actual < rule.minimum)
      || (rule.maximum != null && actual > rule.maximum)
      || (rule.exclusiveMinimum != null && actual <= rule.exclusiveMinimum))) {
      throw new ExportValidationError(`Invalid ${name}.${key}`);
    }
  }
}

export interface ExportComposition {
  width: number; height: number; fps_num: number; fps_den: number; duration_us: number;
}
export interface ExportRange { startUs: number; endUs: number }
export type ExportFrameSnap = (timeUs: number, fpsNum: number, fpsDen: number) => number;

/** Options remain inspectable for a newly-created, empty composition. */
export function resolveExportOptions(
  saved: unknown, composition: ExportComposition, snapFrameRound?: ExportFrameSnap,
): Omit<ReturnType<typeof resolveExportRequest>, "range"> & { validation_issue?: string } {
  if (!Number.isSafeInteger(composition.duration_us) || composition.duration_us < 0) {
    throw new ExportValidationError("composition.duration_us must be a nonnegative safe integer");
  }
  for (const key of ["width", "height", "fps_num", "fps_den"] as const) {
    if (!Number.isSafeInteger(composition[key]) || composition[key] <= 0) {
      throw new ExportValidationError(`composition.${key} must be a positive safe integer`);
    }
  }
  const settings = mergeSettings(saved == null ? null : object(saved, "saved settings") as Partial<ExportSettings>);
  const { audio, ...top } = settings;
  validateFields(top, properties, "settings");
  validateFields(audio as unknown as Record<string, unknown>, audioProperties, "settings.audio");
  let validation_issue: string | undefined;
  try {
    resolveExportRequest(saved, undefined,
      { ...composition, duration_us: Math.max(1, composition.duration_us) },
      undefined, true, snapFrameRound);
  } catch (error) {
    if (!(error instanceof ExportValidationError)) throw error;
    validation_issue = error.message;
  }
  return {
    settings, dimensions: resolveOutputDims(composition, settings),
    fps: settings.fps == null ? { num: composition.fps_num, den: composition.fps_den } : { num: settings.fps, den: 1 },
    extension: exportOutputExtension(settings),
    ...(validation_issue === undefined ? {} : { validation_issue }),
  };
}

/** Production callers pass the canonical wasm snap leaf. The fallback is for
 * pure consumers; BigInt keeps long rational-rate ranges off JS's product limit. */
const defaultSnap: ExportFrameSnap = (timeUs, num, den) => {
  const numerator = BigInt(timeUs) * BigInt(num);
  const denominator = 1_000_000n * BigInt(den);
  const frame = (numerator * 2n + denominator) / (denominator * 2n);
  return Number((frame * denominator * 2n + BigInt(num)) / (BigInt(num) * 2n));
};

export function resolveExportRequest(
  saved: unknown, overrides: unknown, composition: ExportComposition,
  range?: ExportRange, allowExperimental10bit = false,
  snapFrameRound: ExportFrameSnap = defaultSnap,
): {
  settings: ExportSettings; range: ExportRange;
  dimensions: { width: number; height: number }; fps: { num: number; den: number }; extension: string;
} {
  const patch = overrides === undefined ? {} : object(overrides, "settings");
  const { audio, ...top } = patch;
  validateFields(top, properties, "settings");
  const audioPatch = audio === undefined ? {} : object(audio, "settings.audio");
  validateFields(audioPatch, audioProperties, "settings.audio");
  if (patch.includeAudio !== undefined && audioPatch.include !== undefined
    && patch.includeAudio !== audioPatch.include) {
    throw new ExportValidationError("includeAudio and audio.include must agree");
  }
  const base = mergeSettings(saved == null ? null : object(saved, "saved settings") as Partial<ExportSettings>);
  const settings = {
    ...base, ...top, audio: { ...base.audio, ...audioPatch },
  } as ExportSettings;
  settings.includeAudio = (patch.includeAudio ?? audioPatch.include ?? base.includeAudio) as boolean;
  settings.audio.include = settings.includeAudio;
  // Validate the final values too: mergeSettings deliberately repairs only
  // known legacy fields, never arbitrary malformed persisted JSON.
  const { audio: resolvedAudio, ...resolvedTop } = settings;
  validateFields(resolvedTop, properties, "settings");
  validateFields(resolvedAudio as unknown as Record<string, unknown>, audioProperties, "settings.audio");
  for (const [key, value] of Object.entries(composition)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ExportValidationError(`composition.${key} must be a positive safe integer`);
    }
  }
  if (composition.width < 2 || composition.height < 2) throw new ExportValidationError("Composition dimensions are too small");
  if (!settings.includeVideo && !settings.includeAudio) throw new ExportValidationError("Enable video or audio for export");
  if (settings.resolutionHeight != null && settings.resolutionHeight > composition.height) {
    throw new ExportValidationError("resolutionHeight cannot exceed composition height");
  }
  if (settings.fps != null && settings.fps > composition.fps_num / composition.fps_den) {
    throw new ExportValidationError("fps cannot exceed composition frame rate");
  }
  if (settings.includeVideo) {
    if (!isCodecContainerValid(settings.codec, settings.container)) throw new ExportValidationError("Codec is incompatible with container");
    if (!isBitDepthValid(settings.codec, settings.bitDepth)) throw new ExportValidationError("Codec is incompatible with bit depth");
    if (settings.includeAudio && !isAudioCodecContainerValid(settings.audio.codec, settings.container)) {
      throw new ExportValidationError("Audio codec is incompatible with video container");
    }
    if (settings.encoderEngine === "webcodecs"
      && (isIntermediateCodec(settings.codec) || settings.bitDepth === 10 || settings.rateMode === "quality")) {
      throw new ExportValidationError("Requested settings require native encoding");
    }
    if (!isIntermediateCodec(settings.codec) && settings.bitDepth === 10 && !allowExperimental10bit) {
      throw new ExportValidationError("10-bit delivery export requires allowExperimental10bit=true");
    }
    if (!isIntermediateCodec(settings.codec) && settings.quality === "custom"
      && settings.rateMode !== "quality" && settings.customBitrate == null) {
      throw new ExportValidationError("Custom quality requires customBitrate");
    }
  }
  const dimensions = resolveOutputDims(composition, settings);
  if (dimensions.width < 2 || dimensions.height < 2) throw new ExportValidationError("Resolved dimensions are too small");
  const fps = settings.fps == null
    ? { num: composition.fps_num, den: composition.fps_den }
    : { num: settings.fps, den: 1 };
  if (settings.includeVideo && bitrateConstraintIssue(settings,
    computeBitrate(settings, dimensions.width, dimensions.height, fps.num / fps.den))) {
    throw new ExportValidationError("maxBitrate cannot be below target bitrate");
  }
  let resolvedRange = { startUs: 0, endUs: composition.duration_us };
  if (range !== undefined) {
    const requested = object(range, "range");
    if (Object.keys(requested).some((key) => key !== "startUs" && key !== "endUs")
      || !Number.isSafeInteger(range.startUs) || !Number.isSafeInteger(range.endUs)
      || range.startUs < 0 || range.endUs > composition.duration_us || range.startUs >= range.endUs) {
      throw new ExportValidationError("range must be a nonempty half-open microsecond range within the composition");
    }
    resolvedRange = {
      startUs: snapFrameRound(range.startUs, composition.fps_num, composition.fps_den),
      endUs: snapFrameRound(range.endUs, composition.fps_num, composition.fps_den),
    };
    if (resolvedRange.startUs < 0 || resolvedRange.endUs > composition.duration_us
      || resolvedRange.startUs >= resolvedRange.endUs) {
      throw new ExportValidationError("range is empty or outside the composition after frame snapping");
    }
  }
  return { settings, range: resolvedRange, dimensions, fps, extension: exportOutputExtension(settings) };
}
