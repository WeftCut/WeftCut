# Local inference paths on Windows

## Failure and fix

The bundled whisper.cpp 1.9.1 and sherpa-onnx 1.13.4 Windows CLIs lose
characters outside the system code page when their C runtime constructs narrow
`argv`. Passing Rust `OsString` correctly to `CreateProcessW` is necessary but
insufficient. Changing the console output encoding does not change this.
[Whisper's entry point](https://github.com/ggml-org/whisper.cpp/blob/v1.9.1/examples/cli/cli.cpp#L899)
explicitly retains system-code-page arguments. Whisper's output-file failure
can also return exit code zero: the expected result must actually be read, and
its failure must retain the engine's stderr.

Reproduced with synthetic one-second PCM: ASCII and ASCII-with-spaces inputs
worked; Unicode input failed; Unicode output returned zero without a result;
Unicode model paths failed. A Unicode child working directory with ASCII
relative file names worked, including when the executable and DLLs were in a
Unicode directory. sherpa exhibited the same narrow-argument problem.

`inference_files::InferenceFiles` owns a unique temporary directory per run.
Audio and image inputs become ASCII relative file names. Windows speech model
and token paths get aliases when they contain non-ASCII characters. Child-only
`current_dir` passes the actual directory through the native OS API, so a
Unicode user profile or TEMP directory is supported too. Relative configured
paths are resolved before changing the child's cwd; bare executable names
retain PATH lookup. No global cwd, code-page setting, source rename, or runtime
binary patch is used.

Aliases use hard links first. Cross-volume or unsupported-filesystem fallback
copies the file and may require additional temporary disk space for weights.
The blocking copy retains ownership of its temporary directory if the calling
future is cancelled. Aliases are read-only inputs to the engines; cleanup
removes links/copies, never the source. Existing aliases are never overwritten.

llama.cpp b10103 already reads Unicode model/projector paths correctly. Its
`--image` argument, however, splits on commas, including commas in a username
or directory. Qwen3-VL and MiniCPM-V share the same adapter, which now supplies
comma-free relative image aliases on **all platforms**. Model/projector paths
remain native absolute paths, preserving adjacent files such as split GGUFs.

## Audit and validation

| Route | Result |
| --- | --- |
| Whisper | Real adapter failed before fix; JSON-full and SRT succeeded after fix, including Unicode executable/DLL, model, source, cache, and TEMP directories. |
| FunASR / Paraformer | Real adapter failed before fix; succeeded after fix with Unicode executable/DLL, model, tokens, audio, and TEMP paths. |
| Qwen3-VL | Real adapter failed before fix on a comma-containing image path; succeeded after fix with Unicode model/projector/runtime and Unicode/comma source/frame directories. |
| MiniCPM-V | Uses the corrected Qwen/llama adapter. Separate MiniCPM weights were not installed for live inference; the live test supports them via `WEFTCUT_VLM_STYLE=minicpm`. |
| Cloud speech / TTS / BYO vision endpoint | Local media is read/written via Rust/Tokio filesystem APIs and sent as bytes/base64; no native CLI filename decoding or comma-list boundary. Audited locally, no paid network inference invoked. |
| FFmpeg audio/frame extraction | Preserves OS path arguments; exercised with Unicode/comma source and cache paths in the live tests. |

Fast tests cover alias contents, cleanup/source preservation, concurrent runs,
copy fallback, overwrite refusal, invalid aliases, original-path diagnostics,
relative executable resolution, and missing output despite successful exit.

Run from `apps/desktop`:

```powershell
cargo test --manifest-path native/Cargo.toml --lib --features test-noop
cargo fmt --check --all --manifest-path native/Cargo.toml
```

The opt-in tests generate their own media and require installed engine files:

- `WEFTCUT_WHISPER_CLI`, `WEFTCUT_WHISPER_MODEL`
- `WEFTCUT_FUNASR_CLI`, `WEFTCUT_FUNASR_MODEL`, `WEFTCUT_FUNASR_TOKENS`
- `WEFTCUT_VLM_CLI`, `WEFTCUT_VLM_MODEL`, `WEFTCUT_VLM_MMPROJ`
- Optional `WEFTCUT_VLM_STYLE`: `qwen` (default) or `minicpm`

Set TEMP/TMP to an existing writable directory containing Chinese, Japanese,
emoji and commas **before launching the test process**. Do not mutate the
parent process environment inside a parallel Rust test. Ensure FFmpeg is
available using the normal application resolver.

```powershell
cargo test --manifest-path native/Cargo.toml --lib --features test-noop live_unicode -- --ignored --nocapture --test-threads=1
```

The three installed-engine tests were observed failing before the fix and
passing afterward on Windows. The final run passed 623 ordinary Rust tests
and all three opt-in engine tests; formatting and package Clippy checks passed.
After rebuilding the native addon, `Backend.invoke("settings_verify_model", …)`
also verified Whisper, FunASR and Qwen using Unicode runtime/model/config/cache
paths and a Unicode/comma TEMP directory, without changing the user's active
model settings or project.

Linux/macOS behavior is covered by portable
code/tests but was not executed on those operating systems in this repair.
Rebuild the addon (`npm run napi:build`) before verifying through Electron or
the `Backend` API; an already-running app retains its previously loaded addon.
