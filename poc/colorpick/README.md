# Color picker capability probe

Standalone experimental harness, not production picker code. It imports the
real EffectChain, shaders and coordinate helper, but does not launch the editor,
open a project, or change the existing picker. Keep it while the outstanding
platform cells in FINDINGS.md need verification; absorb useful gates and remove
the harness when the production replacement is validated.

From the repository root, with its existing installed dependencies:

```sh
node poc/colorpick/run.mjs
```

This briefly covers every connected display with a generated color/checker
fixture and then a frozen screenshot plus magnifier. It runs the real Pixi
effect comparison, checks capture pixels, clicks to commit, and cancels a second
session. Windows uses OS SendInput for click/Esc, guarded by the exact title and
foreground identity of a probe window. Hover uses Playwright. The original cursor
position is restored. Other OSes currently use CDP input only.

For hands-on use after the automated probe:

```sh
node poc/colorpick/run.mjs --interactive
```

The remaining controller's Start button captures your desktop. Click/Enter
commits, Esc cancels, arrow keys move one physical sample pixel. Each session
automatically cancels after 30 seconds. Close the controller to exit.

Generated `out/` contains the bundle, isolated Electron profile, `results.json`,
renderer screenshots and actual desktop screenshots with the overlay visible.
It is ignored by the repository. Automated screenshots contain generated test
content; interactive desktop captures stay in memory, not in saved evidence.

The harness assumes no other app takes the foreground during its few-second
run. Multi-display and non-Windows support are experimental: a passing run on
one Windows screen is not a cross-platform certification. Screen capture may
require OS consent on other platforms.

See [FINDINGS.md](FINDINGS.md) for measured outcomes and remaining work.
