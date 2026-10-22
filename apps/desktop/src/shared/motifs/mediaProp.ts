// apps/desktop/src/shared/motifs/mediaProp.ts
//
// The `media` prop variant (ADR 0132): a still picture from the project's
// media pool, drawn inside a Motif. Its value is a string, so props stay
// scalar everywhere they travel (inspector, diff, tokens, cache keys):
//   ""                   no picture; the Motif draws its own fallback;
//   "<media_id>"         an image in the pool;
//   "<media_id>@<t_us>"  one frame of a video in the pool, at source time t_us.
// The capture host swaps the value for a same-origin URL before `setup`, so a
// Motif reads `props.<key>` as an image URL, or "" when there is none.

const MEDIA_REF_RE = /^([0-9A-Za-z][0-9A-Za-z-]{0,63})(?:@(\d{1,13}))?$/;

export interface MediaRef { media_id: string; t_us: number | null }

/** The ref a media prop value names, or null for "" and anything malformed. */
export function parseMediaRef(value: unknown): MediaRef | null {
  if (typeof value !== "string" || value === "") return null;
  const m = MEDIA_REF_RE.exec(value);
  if (!m) return null;
  return { media_id: m[1]!, t_us: m[2] === undefined ? null : Number(m[2]) };
}

/** Whether `value` is a well-formed media prop value ("" included). */
export function isMediaPropValue(value: unknown): boolean {
  return value === "" || parseMediaRef(value) !== null;
}

export function formatMediaRef(ref: MediaRef): string {
  return ref.t_us === null ? ref.media_id : `${ref.media_id}@${Math.max(0, Math.round(ref.t_us))}`;
}

/** The identity of the picture a ref resolves to: the file's content hash, and
 *  the frame time for a video. It goes into frame cache keys and the served
 *  URL, so replacing a media file invalidates the frames drawn from it. */
export function mediaPictureKey(fileHash: string, ref: MediaRef): string {
  return ref.t_us === null ? fileHash : `${fileHash}@${ref.t_us}`;
}

/** The path, under a Motif's own origin, the capture host serves a picture
 *  from: `motif://<id>/.media/<picture key>`. */
export const MOTIF_MEDIA_DIR = ".media";

/** Why `props` cannot be placed: a media prop naming an item the pool lacks,
 *  one that is not an image or a video, or an image given a frame time. Null
 *  when every media prop is "" or names a usable picture. */
export function mediaPropProblem(
  schema: Readonly<Record<string, { type: string }>>,
  props: Readonly<Record<string, unknown>>,
  pool: Readonly<Record<string, { kind: string }>>,
): string | null {
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.type !== "media") continue;
    const ref = parseMediaRef(props[key]);
    if (!ref) continue;
    const item = pool[ref.media_id];
    if (!item) return `prop \`${key}\` names media ${ref.media_id}, which is not in the project — import_media it first`;
    if (item.kind !== "Image" && item.kind !== "Video") return `prop \`${key}\` names ${item.kind} media ${ref.media_id}; a picture is an Image, or a Video at "<id>@<t_us>"`;
    if (item.kind === "Image" && ref.t_us !== null) return `prop \`${key}\` gives a frame time to image ${ref.media_id}; only a video takes "@<t_us>"`;
  }
  return null;
}
