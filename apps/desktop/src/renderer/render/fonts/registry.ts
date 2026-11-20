// THE font authority: all runtime font acquisition — bundled bytes, catalog
// face bytes, and the hand-out-copies transfer policy — lives in this module.
// Don't grow private font loaders at use sites. Deliberate exception: motif
// capture host pages load their own fonts via explicit document.fonts.load
// (they run in a separate CDP browser context this module can't reach, and
// their explicit-load discipline carries the deterministic-capture guarantee).
//
// Bundled fonts and the catalog faces Text layers resolve to
// (./textFaces.ts) are loaded into BOTH the preview Compositor (main thread,
// document.fonts) and the export Worker (self.fonts), so burned-in text
// renders like the preview. See docs/render.md "Fonts".

// Vite `?url` resolves each asset to a same-origin URL at build time.
import notoCjkUrl from "../../../../assets/fonts/NotoSansSC-VF.ttf?url";
import liberationUrl from "../../../../assets/fonts/LiberationSans-Regular.woff2?url";

import type { FaceRef } from "../../../shared/fonts/types";
import { syncFaces } from "./loadFontsIntoFaceSet";
export { BUNDLED_FONT_FAMILIES } from "../../../shared/fonts";

// Re-exported, not defined here: the main process stamps this family onto every
// new Text layer and cannot import from renderer/. See src/shared/fonts.ts.
export { DEFAULT_CAPTION_FONT_FAMILY } from "../../../shared/fonts";

const FONT_URLS: Record<string, string> = {
  "Liberation Sans": liberationUrl,
  "Noto Sans SC": notoCjkUrl,
};

/// Memoized fetch cache. Bundled fonts are immutable build assets, so each
/// realm (main thread and the export Worker import separate module instances)
/// pays the fetches once instead of twice per export. Reset on rejection so a
/// transient fetch failure doesn't poison the session — the next call retries.
let bundledFontBytesCache: Promise<Record<string, ArrayBuffer>> | null = null;

/// Fetch every bundled font's bytes. Used to FontFace-register them into a
/// face set (document.fonts for preview, self.fonts for the export Worker).
/// LANDMINE: always returns fresh copies of the cached buffers — the export
/// harness posts these to the Worker as TRANSFERABLES (runExport's
/// postMessage), which DETACHES the sender's copy. Handing out the cache
/// directly would detach it on the first export and silently blank the fonts
/// of every later export.
export async function loadBundledFontBytes(): Promise<Record<string, ArrayBuffer>> {
  if (!bundledFontBytesCache) {
    const p = fetchBundledFontBytes().catch((err: unknown) => {
      // Only clear if no newer attempt has replaced the slot meanwhile.
      if (bundledFontBytesCache === p) bundledFontBytesCache = null;
      throw err;
    });
    bundledFontBytesCache = p;
  }
  const cached = await bundledFontBytesCache;
  const out: Record<string, ArrayBuffer> = {};
  for (const [family, buf] of Object.entries(cached)) {
    out[family] = buf.slice(0);
  }
  return out;
}

async function fetchBundledFontBytes(): Promise<Record<string, ArrayBuffer>> {
  const out: Record<string, ArrayBuffer> = {};
  for (const [family, url] of Object.entries(FONT_URLS)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to load bundled font ${family}: ${res.status}`);
    out[family] = await res.arrayBuffer();
  }
  return out;
}

/// One catalog face as a standalone font file, or null when the face is gone.
/// Asked of main on every call and kept nowhere: a registered face lives in
/// its face set, and export asks again, which main answers from the file's
/// stamp without hashing. Each answer is a buffer only its caller holds, so
/// export may transfer it (the bundled cache's LANDMINE does not arise).
/// MAIN-THREAD ONLY: touches window.api — the export Worker receives bytes
/// fetched here in its start request.
export async function faceBytes(sha256: string): Promise<ArrayBuffer | null> {
  const bytes = await window.api.font.bytes(sha256);
  if (!bytes || bytes.byteLength === 0) return null;
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return (whole ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer;
}

/// Make `faceSet`'s catalog faces exactly `refs` (`syncFaces`), bytes from
/// `faceBytes`. Resolves with the hashes that could not be registered.
/// MAIN-THREAD ONLY.
export function ensureFaces(faceSet: FontFaceSet, refs: readonly FaceRef[]): Promise<string[]> {
  return syncFaces(faceSet, refs.map((ref) => ({ ref, bytes: () => faceBytes(ref.sha256) })));
}
