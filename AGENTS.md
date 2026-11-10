# WeftCut — agent instructions

Project glossary and domain vocabulary live in [`CONTEXT.md`](CONTEXT.md);
architectural decisions in [`docs/adr/`](docs/adr/).

## Contributing from a fork

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening an upstream issue or PR: it decides whether the work needs an accepted issue first and what the PR must show. Open upstream PRs one at a time, and only when your human asks.

## Working rules

- **Parallel agents get their own worktree.** Each agent writing to the repo alongside another works in its own `git worktree` and branch, so no agent moves the checkout under another.
- **Subagents edit, the parent commits.** Delegated agents change files only; the agent that started them reviews the diff and makes the commits.
- **Prefer replacing to layering.** When a change supersedes a code path, remove the old one in the same change. Keep both only where something outside the change still depends on the old one (saved projects, a published MCP contract), and say why in the PR.
- **Committed content is invented.** Code, tests, fixtures, docs and commit messages carry no real names, project material or machine paths; use placeholders such as `/home/u` or `C:\Users\u`.

## Agent skills

### Issue tracker

Public issues live on GitHub. The maintainer's specs are local markdown under `.scratch/<feature>/`, gitignored and absent from a fresh clone. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Testing

Tests are grouped by runner, not one directory: colocated Vitest unit tests in `src/`, Rust tests in `native/`, Playwright E2E in `apps/desktop/e2e/`. `npm run check` runs the local equivalent of CI's unit, lint and Rust gates. For the full layout map and run commands, see `docs/agents/testing.md`.

A test asserts the property it is about (order, cause, ownership, a bound the product enforces), never a number measured on one machine. Before writing or rewriting a test, read `docs/agents/testing.md` § Assert the intent, not a measurement.

### Code comments

Before writing or editing a comment, read `docs/comment-style.md`.
