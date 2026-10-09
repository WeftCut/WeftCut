/// Stable hash of a cacheKey for use as an on-disk directory name.
///
/// Two independent FNV-1a 64-bit lanes (different offset bases), each
/// rendered as 16 zero-padded lowercase hex chars and concatenated — a
/// 128-bit hash, dependency-free and synchronous (this feeds per-frame
/// disk paths, so an async crypto/blake3 digest is off the table). The
/// input is hashed as its UTF-16LE byte stream (low byte, then high byte,
/// per code unit), so non-ASCII prop values (e.g. zh-CN) mix fully.
/// The dir name is JS-owned (`Cache/raster/` is not created by the Rust
/// `CacheLayout`), so it does NOT need to match Rust's blake3 scheme.
///
/// Why 128 bits: a collision is NOT self-healing — two colliding keys share
/// the `<hash>` dir and their frame `<i>.wfrm` files would CLOBBER each other,
/// since `0.wfrm` means frame 0 of WHICHEVER key wrote last. With the handful
/// of live keys a workspace ever has, the birthday bound against a 2^128
/// space (≈2^64 keys to a 50% collision) is negligible; the old 32-bit space
/// (≈2^16 keys to 50%) was only "probably fine" and one bad roll silently
/// corrupted two Motifs' baked frames.
export function hashCacheKey(cacheKey: string): string {
  return fnv1a64Hex(cacheKey, 0xcbf29ce484222325n) + fnv1a64Hex(cacheKey, 0x9e3779b97f4a7c15n);
}

const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/// One FNV-1a 64-bit lane over the UTF-16LE byte stream of `s`, from the
/// given offset basis, rendered as 16 zero-padded lowercase hex chars.
function fnv1a64Hex(s: string, offset: bigint): string {
  let h = offset;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    h = ((h ^ BigInt(unit & 0xff)) * FNV64_PRIME) & MASK64;
    h = ((h ^ BigInt(unit >>> 8)) * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}
