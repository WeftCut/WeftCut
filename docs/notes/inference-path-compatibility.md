# Local inference paths: non-ASCII and comma paths

## Findings

- **Windows whisper.cpp 1.9.1 and sherpa-onnx 1.13.4 CLIs lose characters
  outside the system code page** when their C runtime builds narrow `argv`
  ([whisper's entry point](https://github.com/ggml-org/whisper.cpp/blob/v1.9.1/examples/cli/cli.cpp#L899)
  keeps system-code-page arguments). Passing `OsString` to `CreateProcessW`
  correctly is not enough; changing the console encoding does not help.
  Unicode input, output and model paths all failed; a Unicode child working
  directory with ASCII relative file names worked, even with the executable
  and DLLs in a Unicode directory.
- **whisper-cli can exit 0 without writing its output file**, so the expected
  result must be read and a missing one reported with the engine's stderr.
- **llama.cpp b10103 `--image` splits on commas** (a comma in a username or
  directory breaks it); its model/projector paths read Unicode correctly.

## What the code does

`inference_files::InferenceFiles` gives each run a unique temp directory with
ASCII relative aliases for audio/image inputs (and, on Windows, for non-ASCII
speech model/token paths), and passes the real directory as the child-only
`current_dir`. Relative configured paths are resolved before the cwd change;
bare executable names keep PATH lookup. Aliases are hard links, falling back
to a copy across volumes (extra temp disk for weights); existing aliases are
never overwritten; cleanup removes aliases, never sources. The llama adapter
uses comma-free relative image aliases on all platforms; model/projector stay
absolute so split GGUFs keep their neighbours. No global cwd, code-page
change or binary patch.

## Probe (Windows, 2026-10-02)

Opt-in tests in `native/src/inference_paths_live_tests.rs` generate their own
media and need installed engines: `WEFTCUT_WHISPER_CLI`,
`WEFTCUT_WHISPER_MODEL`, `WEFTCUT_FUNASR_CLI`, `WEFTCUT_FUNASR_MODEL`,
`WEFTCUT_FUNASR_TOKENS`, `WEFTCUT_VLM_CLI`, `WEFTCUT_VLM_MODEL`,
`WEFTCUT_VLM_MMPROJ`, optional `WEFTCUT_VLM_STYLE=qwen|minicpm`. Set TEMP/TMP
to a writable directory containing CJK, emoji and commas before launching
(do not mutate the environment inside a parallel test):

```powershell
cargo test --manifest-path native/Cargo.toml --lib --features test-noop live_unicode -- --ignored --nocapture --test-threads=1
```

All three engine tests failed before the fix and passed after on Windows.
Linux/macOS are covered by portable tests only.
