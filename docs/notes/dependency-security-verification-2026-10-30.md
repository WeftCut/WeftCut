# Dependency security audit — 2026-10-30

macOS arm64, Node 24.20.0, Rust 1.98.1, cargo-audit 0.22.2, advisory-db
`ee1a49a2` (2026-10-29). Scoped update: npm `@hono/node-server` 2.1.5, `qs`
6.17.1 (also the `typed-rest-client` override floor); Rust `imbl` 7.0.2,
`rustls` 0.23.46, `rustls-webpki` 0.103.16, `webpki-roots` 1.0.11,
`ffmpeg-sidecar` 2.7.0, `zip` 9.1.3.

## What remains, and why it was left

- npm: 3 low-severity alerts, all one deepmerge advisory via
  `shadcn` / `@shadcn/registry` (devDependency, no published fix). No
  moderate or higher.
- Rust: 8 vulnerability records and 11 unsound warnings remain, in
  quinn-proto, zstd/zstd-safe and Tokio. quinn-proto is not enabled by the
  feature set; application zstd calls use bulk compress/decompress, not the
  stream, dictionary or seekable APIs the advisories name. This is a judgement,
  not a proof of unreachability.
- No advisory exclusions or severity filters were added; keep it that way
  rather than suppressing these.

Validation: core lib tests 787 passed, conformance 20, eval/conversion 63/14,
workspace Clippy `-D warnings`, typecheck, MCP unit tests; cross-platform
coverage left to main-branch CI.
