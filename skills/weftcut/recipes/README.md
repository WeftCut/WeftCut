# Recipes

A recipe is how one kind of job runs from request to handoff: the stages it
goes through, what to do in each that no tool description says, and when to
stop. One file per kind of job.

Before a batch job, look here for a file whose description matches the job.
If one does, follow it stage by stage. If none does, use the batch loop in
SKILL.md, one folder up.

## Stages

A recipe lists stages from this catalog, in this order, leaving out the ones
it does not need. It never adds one of its own.

- `intake` — read the state the job starts from: the tracks, open tacks, what
  the user asked for.
- `plan` — say in plain words what will change, where, and how the user will
  know it worked; wait for the user's go-ahead unless they already gave it.
- `build` — make the changes, inside a work session.
- `audit` — run `check_composition` and settle what it finds: every `hard`
  finding fixed, every `warning` fixed or tacked with the reason.
- `look` — inspect rendered frames of what changed.
- `critique` — have the work reviewed by a reader that did not do it.
- `handoff` — leave tacks on what is unresolved, end the work session, and
  report.

`build` and the checks listed after it (`audit`, `look`, `critique`) make one
round. A recipe that uses a check stage says how to run it.

## Signals

What ends the rounds is written with these signals and nothing else:

- `audit.clean` — `check_composition` at the project's current state reports
  no `hard` finding (the session's end confirms the check is still current).
- `critique.clear` — the critique raised no blocking finding.
- `user.confirmed` — the user said the result is what they asked for.
- `rounds` — the number of rounds run so far.

Your own opinion of the work is never a signal: each one is observed — a
check result, the user's word, a count.

Rounds stop at three. Whatever is still wrong after the last round becomes
tacks on the ranges it concerns and is named in your report. Do not start
another round unless the user asks for one.

## File format

The shape of a recipe file (an illustration, not a recipe that exists):

```markdown
---
name: tidy-pauses
description: Cut the pauses out of a talking-head clip and leave the doubtful ones for the user.
stages: [intake, plan, build, handoff]
until: "user.confirmed || rounds >= 3"
---

## intake
What to read before anything changes.

## plan
What the plan must say before the user is asked.

## build
How to make the change, and what to verify from each committed record.

## handoff
The deliverable, what becomes a tack, and what the report says.
```

- `name` — the file name without `.md`: lowercase words joined by hyphens.
- `description` — one sentence: the job this recipe is for.
- `stages` — the stages it runs, in catalog order.
- `until` — the condition that ends the rounds: signals joined with `||`
  (either) and `&&` (both); `rounds` appears only as `rounds >= N` with N at
  most 3. Required when `build` is listed, and then one of its `||` branches
  is `rounds >= N` alone, so the rounds always end. Left out when there is no
  `build`: the stages then run once, in order.
- The body has one `## <stage>` section per listed stage, in the same order,
  holding what to do in that stage. The `handoff` section names the
  deliverable.
