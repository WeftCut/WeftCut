# Frozen schema fixtures

One `v{n}.json` per **on-disk schema generation** — the input a migration step
reads. `migrate.completeness.test.ts` walks each one through the chain
(`state/migrate.ts`), then through `parseProject` + `validate`, and fails if a
registered step has no fixture at its `from` version.

## These files are frozen. Do not regenerate them.

A fixture's whole job is to be a *shape from the past*. Regenerating one from the
current model re-anchors it to today's shape, at which point the step it guards
is being tested against its own output and the test proves nothing. There is
deliberately **no generator script** in the repo for these — if a fixture looks
wrong, that is either a real migration bug or a deliberate follow-up step, never
a reason to rewrite the file.

Hand-editing one is allowed for two reasons, both mechanical: the version it
declares must match its filename, and an **additive** field is written in by
hand at the key position the in-memory object carries it — re-driving the actor
would re-mint every uuid and timestamp for no gain, and the three pinned fields
below cannot come from the actor at all. The byte-identity check in
`migrate.completeness.test.ts` is what proves the position right.

Until first release the rule has nothing to guard: `STEPS` is empty, so there is
no step to test against a past shape, and an incompatible shape change instead
rewrites the shape in place — `SCHEMA_VERSION` stays 1 — and regenerates
`v1.json` by driving the actor through the scenario below. The frozen rule
applies from the first post-release bump, when a step exists to be tested
against a past shape (ADR 0052).

## Provenance

`v1.json` was produced once by driving the real actor (`state/actor.ts`) with a
seeded id generator, then frozen. It holds two compositions: the root, built by
the scenario below, and a Group — a second `Composition` holding one `Color`
layer, composed from the same mutation primitives pre-compose calls
(`newComposition` + `applyAddLayer` + `applyDurationAutofit`) and referenced by
a `CompositionRef` layer on a fresh lane in the root, windowed to the Group's
full duration. The root scenario:

- a `Video` media item with audio, workspace paths, and a `Proxied` decode route
  carrying a landed full proxy, waveform and thumbnails
- A-roll: an auto-paired `VideoClip` + `Audio` layer, and the `Link` that pairing
  creates
- B-roll: two adjacent `Color` layers with a `Crossfade` transition across the
  join (so the authorized-overlap invariant is represented, not just the field)
- a spawned overlay lane (`label: null` — the derived-name case) holding a `Text`
  layer whose `x` track is keyframed across `Bezier`, `Elastic` and `Hold`
  segments
- a `blur` effect on that layer with a keyframed `strength` (`Linear`, `Bounce`)
- a point marker and a region marker
- `audio_roles.dialogue` off unity, `prefer_proxies` on, and one
  `proxy_overrides` entry

Three fields could not come from the actor and were pinned by hand at generation
time — `metadata.created_at` and `metadata.modified_at`, because `blankProject`
stamps wall-clock time, and `metadata.description`.

The coverage above is the point — a step that forgets a field is only caught if
the fixture *has* that field. When adding a fixture for a later version, aim at
the same breadth.
