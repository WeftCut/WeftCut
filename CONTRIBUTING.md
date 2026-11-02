# Contributing to WeftCut

Thanks for helping out. These rules keep contributions consistent and reviews
focused.

Use whatever tools you like, coding agents included. The bar is the same either
way: you can explain every change in your PR and answer questions about it. A
low-quality PR may be closed without a detailed review.

## Start in the right place

**Open a PR directly** for a small bug fix. Show the reproduction in the PR.

**Open an issue first, and wait for it to be accepted,** for anything else:

- a new capability, setting or MCP tool
- any change to the UI, small fixes included
- a large change of any kind, refactors and performance work included

An issue is accepted once the maintainer says so in it. An open issue alone is
not acceptance.

Issues labelled [`help wanted`](https://github.com/WeftCut/WeftCut/labels/help%20wanted)
are good places to start. They can be broad, so say in the issue which piece you
want to take and wait for it to be accepted. Questions and early ideas go in
[Discussions](https://github.com/WeftCut/WeftCut/discussions), and security
reports follow [SECURITY.md](SECURITY.md).

## What is not being taken right now

- **More UI languages.** None will be added before v1.0.
- **Remote use.** Browser gateways, server deployment and network-facing MCP
  wait on a design and discussion, and are low priority today. Start a
  discussion rather than a PR.
- **Paths for one specific setup.** Work that serves a single GPU, distribution
  or deployment belongs in your fork. General improvements are welcome,
  including platform fixes that help everyone on that platform.

## Prepare the PR

1. **Keep work in progress in your fork.** Open an upstream PR once it is ready
   for review. Drafts get no CI, and GitHub caps how many PRs one contributor
   can have open here.
2. **One topic per PR.** A cross-fork PR can only target `main`, so a stack
   repeats its prerequisite's diff. Send the next one after the first has merged.
3. **Start from the latest `main`** and run `npm run check` there. It rebuilds
   the native addons and runs the local equivalent of CI's `checks` and
   `rust-test` jobs. `npm run check -- --skip-rust` runs the TypeScript half
   against the addons you already built, so use it only when they match your
   tree. Run the E2E specs your change touches as well. See
   [testing](docs/agents/testing.md) for setup and layers.
4. **Fill in the [PR template](.github/pull_request_template.md).** The evidence
   the change needs:
   - A bug fix: a regression test that fails without the fix. Where a test cannot
     be written, say how you verified it.
   - Performance work: before and after numbers, how they were measured, and on
     what hardware.
   - A platform claim: name the platforms you actually ran it on.
   - Every behavior change in the diff, listed in the description.

## Conventions

- **PR titles** follow Conventional Commits: `type(scope): summary`, with `!`
  for a breaking change, as in `fix(export): …` or `feat(mcp)!: …`. External PRs
  are squash-merged, so the title becomes the commit message on `main`.
- **Vocabulary** comes from [CONTEXT.md](CONTEXT.md).
- **Comments** follow [the comment style](docs/comment-style.md).
- **Documentation** goes where [the domain guide](docs/agents/domain.md) puts it.
- **Tests and fixtures** use invented content, with no real names, manuscripts
  or machine paths.
- **Dependencies** come with a reason and their license in the PR description,
  and `package-lock.json` resolves from `registry.npmjs.org` only.

## Left to the maintainer

Raise these in your issue or PR description, and the maintainer decides how they
land:

- **Version numbers.** Merging a version bump publishes a release.
- **`.github/`,** workflows and CI configuration.
- **ADRs.** Describe the decision and its constraint; numbers and files are
  assigned here.
- **`AGENTS.md` and `CLAUDE.md`,** which steer every agent working in this repo.

## What to expect

A PR may be merged, sent back with changes, or closed, sometimes with a short
reason only. An idea worth taking may be reimplemented on `main` to fit the
current architecture, with credit to you.

Contributions are accepted under the [MIT License](LICENSE).
