# WeftCut — agent instructions

Project glossary and domain vocabulary live in [`CONTEXT.md`](CONTEXT.md);
architectural decisions in [`docs/adr/`](docs/adr/).

## Contributing from a fork

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening an upstream issue or PR: it decides whether the work needs an accepted issue first and what the PR must show. Open upstream PRs one at a time, and only when your human asks.

## Agent skills

### Issue tracker

Public issues live on GitHub. The maintainer's specs are local markdown under `.scratch/<feature>/`, gitignored and absent from a fresh clone. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Testing

Tests are grouped by runner, not one directory: colocated Vitest unit tests in `src/`, Rust tests in `native/`, Playwright E2E in `apps/desktop/e2e/`. `npm run check` runs the local equivalent of CI's unit, lint and Rust gates. For the full layout map and run commands, see `docs/agents/testing.md`.

### Code comments

Before writing or editing a comment, read `docs/comment-style.md`.
