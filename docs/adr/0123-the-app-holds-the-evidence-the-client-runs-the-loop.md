# ADR 0123: The agent harness — the app holds the evidence, the client runs the loop

Status: Proposed

Extends [ADR 0046](0046-agent-guidance-ships-as-one-skill.md): still one
skill, single-sourced, its names pinned by the conformance gate. Builds on the
review baseline and the Tack ([ADR 0115](0115-agent-review-lives-beside-the-project-not-in-it.md),
[ADR 0119](0119-review-is-settled-as-a-whole.md)). Detailed decisions — the
TASTE schema and style packages, `graphic_role`, the lint, `render_frames`, the
critic, unattended authorization — each get their own ADR when implemented.

## Context

The skill and the `initialize` instructions teach an agent how a session
should go, and the tool descriptions teach each call. Nothing teaches how the
result should look or sound, and nothing in the loop can tell a good cut from
a bad one except the user's eyes. Output therefore tracks the model: a strong
model makes reasonable choices, a weaker one falls to the distribution centre
(centred white text, dissolves everywhere, even shot lengths), and two
sessions of the same model disagree. We want a named style to come out the
same whichever model drives, and the user's review to be the last check
rather than the only one.

open-design solves the same problem for design artifacts by owning the loop:
its daemon composes design system, craft rules and skill into the system
prompt, walks a pipeline of stages, and stops on a closed vocabulary of
observed signals. WeftCut cannot do that. It is an MCP server; Claude Code,
Codex, Claude Desktop and others run their own loops and their own prompts.

What WeftCut does own is every boundary the agent's work crosses: what a new
layer looks like when created, what a tool accepts, what is measured about
the timeline, what ending a session or starting an export reports, and what
the user approves.

## Decision

**The app holds the evidence; the client runs the loop.** The harness is not
a prompt we inject but what the app knows and enforces at its own boundaries,
plus process knowledge in the skill. A client that follows the skill gets a
complete loop; a client that does not still gets the defaults, the
refusals and the evidence.

**Knowledge comes in layers with a fixed precedence.**

| Layer | Carries | Override |
|---|---|---|
| Etiquette | Checkpoints, sessions, ask-first, tacks vs markers, guards no mode skips | None |
| Craft | Brand-agnostic production rules as numbers (safe areas, minimum holds, cut handles, fades, loudness) and named anti-patterns | A style may tighten, never loosen; the user's explicit request may, and is still reported |
| Style | Fonts, palette, type scale per graphic role, caption style, transitions, motion timings, rhythm, frozen exemplars | Project |
| Project TASTE | `extends` a style, plus this project's overrides | The user's explicit request |
| Recipe | One task type's stages, exit conditions and deliverable | — |

Style is data, served by the app and readable by tools and lint; recipe is
process, carried in the skill. A style never prescribes order; a recipe never
names a font. This is ADR 0046's boundary rule extended from tool contracts to
values.

**A recipe composes stages from a closed catalog** — intake, plan, build,
audit, look, critique, handoff — and stops on a closed vocabulary:
`audit.clean`, `critique.clear`, `user.confirmed`, `rounds`. Build and its
checks repeat at most three rounds; whatever is left becomes tacks and is
reported. Each recipe is one skill file, `recipes/<name>.md`, and the MCP
prompt of the same name is generated from that file, taking an optional
style. One source per recipe; a recipe naming a stage or signal outside the
catalog fails the conformance gate.

**The app answers with evidence the loop can stop on.** Audit findings are
keyed to a project revision so the app can say whether an audit is fresh;
ending a work session reports audit freshness, open tacks and the count of
unreviewed changes; export runs the audit. The review baseline remains the
gate for results: whatever a recipe did, the user sees it as unreviewed
changes and settles it as a whole.

**Every rule sits on the lowest rung that can hold it.** Correct by
construction (tool defaults from style tokens, schema) → refused by the tool
→ checked by the lint → instructed in the skill → reviewed by the critic or
the user. Prose carries only what no rung below can. Rules are numbers or are
explicitly marked as taste; weaker models execute thresholds reliably and
adjectives unreliably.

**No self-certification.** The generating agent's opinion of its own work is
never an exit condition. The lint is deterministic, the critic runs in a
separate context with read-only tools and reports findings rather than a
gating score, and the user approves.

**A Motif is one element.** One graphic role, one entrance and exit; a
multi-element overlay is several layers planned before code is written, and
its staggering lives on the timeline. This is a base rule of the authoring
contract for every Motif under every style, because a Motif that draws the
whole frame shuts out the user's footage, locks timing inside the page, and
is opaque to tokens, lint, review and caching. Scope findings are warnings,
never refusals.

**Success is measured as the model gap, on a local bench.** The same recipe,
style and fixture run under a strong and a weaker model should land close
together on what the bench measures: audit findings, intent checklist,
rounds, cost. The bench drives agents through a client-neutral interface
(Claude first), records the entity-level review diff as the account of what
the agent did, and logs the defaults each model falls to. A rule enters
because a run showed the default it fixes and leaves when removing it
changes nothing. Anti-pattern lists grow from these observations, never in
one batch up front.

## Considered options

- **Prompt injection through the server.** `initialize` instructions are
  the only prompt every client receives, and they are a floor, not a loop;
  growing them into a harness would tax every session and still not drive
  stages.
- **A server-side critic or model.** Rejected with the README's position
  that intelligence lives outside the app; a local 4B model is not a
  reliable judge of taste.
- **Numeric aesthetic scores as a gate.** A model scoring taste is the
  model certifying itself; scores are reported, findings gate.
- **A skill series, one skill per recipe or style.** Each description is
  standing context in every session; ADR 0046's single skill with disclosed
  sibling files still holds, and styles are data, not skills.
- **A large style catalog up front.** One built-in style is polished on the
  bench before a second exists; each built-in becomes a new default look.
- **Two prompt paths.** open-design maintains a legacy and a strategy path
  that have drifted apart; recipes, their prompts and the craft numbers the
  lint reads are each single-sourced.

## Consequences

- The skill gains `craft/` and `recipes/` beside `SKILL.md`; the conformance
  gate covers them and the stage and signal vocabulary.
- `docs/motif-authoring.md` gains a scope section and the layer plan; it
  still ships verbatim in the skill.
- New app surfaces — `project://taste`, `graphic_role`, `check_composition`,
  `render_frames`, handoff evidence on `end_agent_session` — are introduced
  by their own ADRs, in that order.
- The bench is local and outside CI; the lint's unit tests are app code and
  run in CI.
- Weaker models become a supported way to drive WeftCut, and the measure of
  that support is a number we publish per recipe.

## Where this lives

- `skills/weftcut/` — `SKILL.md`, `craft/`, `recipes/`; `docs/motif-authoring.md`.
- `apps/desktop/native/src/mcp/prompts.rs` — recipe prompts, generated.
- `apps/desktop/src/main/state/__tests__/mcp.skill-conformance.test.ts` — the gate.
- Working spec: `.scratch/agent-harness/spec.md` (local).
