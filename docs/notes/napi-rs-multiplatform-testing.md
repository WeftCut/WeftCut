# NAPI-RS multi-platform testing and production symbol loading

Verified 2026-07-19 on Linux and macOS 26.5.2 arm64; the patterns below are
what electron-ci's `rust-test` job runs on all three OSes.

## Two execution modes

A Rust test target is a standalone executable; a `.node` is loaded inside a
Node/Electron host that supplies the `napi_*` symbols. A test binary has no
provider. Linux's loader resolves imports eagerly and rejects it at startup;
macOS and Windows only hid the gap through link tricks (`-undefined
dynamic_lookup`, napi's import library).

Layering:

1. Keep domain logic free of NAPI-RS types and test it with plain Rust tests
   (the `weftcut-eval` leaf).
2. Addon crates' unit tests compile with the test-only **`test-noop`** feature
   (`cargo test --features test-noop`) on every OS.
3. The real `.node` is validated only through the Electron E2E suite (JS
   conversions, exceptions, promises, GC, environment lifecycle).

`noop` is a test compilation mode; never enable it in a production build.

## `test-noop` differs per crate

- `@weftcut/core`: `["napi/noop", "napi-derive/noop"]`. Exported wrappers
  vanish, so `lib.rs` allows `dead_code` under this feature only (item-level
  `#[expect(dead_code)]` must sit on the outermost dead item).
- `@weftcut/native-decode`: `["napi/noop"]` only. It holds
  `ThreadsafeFunction<ExportSwMsg>` in non-test code; `napi-derive/noop`
  deletes the derived `ToNapiValue` the bound needs (33 compile errors).

Rule for a new addon crate: start with `["napi/noop"]`; add
`napi-derive/noop` only if no custom `#[napi(object)]` type is used at compile
time as a generic argument (`ThreadsafeFunction<CustomType>` is the usual
tripwire).

## `dyn-symbols` stays on

A NAPI-RS v3 default that both addons keep (`default-features = false` must
re-add it): `napi_*` entry points resolve by dynamic lookup at load time. It is
not a polyfill; the host must still provide every API called. Verify a change
by loading the real addon and passing E2E, never by Rust tests alone.

## Decode component per OS

`@weftcut/native-decode` is the only `ffmpeg-next` consumer (`@weftcut/core`
never links libav). Build needs `FFMPEG_DIR` + libclang; run needs the bundled
libav* on the loader path.

| | Windows | Linux | macOS |
|--|---------|-------|-------|
| HW lane | d3d11va | VAAPI copy-back | VideoToolbox |
| `FFMPEG_DIR` | `resources/ffmpeg-lgpl/win` | `.../linux` | `.../mac` (built from source) |
| libclang | `C:\Program Files\LLVM\bin` (wrapper default) | `libclang-dev`, auto-discovered | Xcode CLT via `xcrun` |
| runtime libs | DLLs prepended to PATH | `DT_RPATH=$ORIGIN` (`--disable-new-dtags`) + co-located `.so` | `@loader_path` install names + co-located `.dylib` |
| `cargo test` env | DLLs on PATH | `LD_LIBRARY_PATH=.../lib` | `DYLD_FALLBACK_LIBRARY_PATH=.../lib`, `--test-threads=1` |

macOS specifics:

- No LGPL-shared macOS FFmpeg prebuilt exists (BtbN is Windows/Linux only;
  evermeet, osxexperts, martin-riedl and Homebrew are GPL), so
  `fetch-ffmpeg-lgpl.mjs` builds the sha256-pinned source tarball. arm64 only.
- `rewriteMacInstallNames` rewrites ids and cross-references to
  `@loader_path/...` using names read from `otool -L`: cross-references name
  the major-versioned symlink, so a `-change` keyed on the real file name
  silently does nothing.
- SIP strips `DYLD_*` only for protected binaries, so the fallback path works
  for `cargo test`; the packaged `.node` needs no env.
- VideoToolbox decode tests run serially: concurrent ProRes sessions on the
  runner fail with VT -19092.

## Upstream references

NAPI-RS [testing guide](https://napi.rs/docs/more/testing-debugging) and
[Cargo features](https://napi.rs/docs/concepts/cargo-features); ast-grep's
`napi-noop-in-unit-test` feature and Rolldown's split Rust/Node suites follow
the same pattern.
