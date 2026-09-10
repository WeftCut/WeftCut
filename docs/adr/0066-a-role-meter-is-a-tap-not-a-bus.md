---
status: accepted
---

# A role meter is a tap, not a bus

Per-role metering inserts a **unity `GainNode` plus a leaf `AnalyserNode`** at
the one node every layer chain already fans into. It adds no processing and
changes no output sample, so it is **not** the per-role processing bus
[ADR 0023](0023-audio-mixes-by-role-not-track.md) defers: role gain still
reaches the mix by folding onto each member layer's envelope, and
`RoleMixSettings.effects` remains the named extension point that would turn the
fold into a real processing bus. Preview only — the export mixer is untouched.

## Context

Balancing a mix asks *which category of sound is loud right now*. A master
meter cannot answer it: one number over the summed output says how loud the
programme is and nothing about where the level came from, so an editor with
only that number judges the balance by ear while looking at a Panel full of
controls that show no levels.

Three properties of the preview graph make answering the question nearly free.
Every layer chain already terminates at one shared node, so the four roles
already sum somewhere. The role rides on the layer's audio view, so the graph
already knows which chain belongs to which role. And role gain is already
folded onto each member layer's own gain envelope — the preview twin of the
export planner's fold — so nothing about the gain math has to move for a
role's sum to be meterable.

The obstacle is vocabulary, not cost. ADR 0023 chose role as the mixing axis
and then deliberately declined to build a bus: "the per-block summing loop in
`mix_block` is unchanged — there is no separate per-role sum or insert", with a
per-role effect chain named as the deferred extension point. A node called a
*role bus* therefore reads as a reversal of that decision unless the difference
between a readout and a processing stage is written down. Writing it down is
what this record is for.

## Decision

- **Every canonical role owns a bus, and the bus is a tap.** `AudioGraph`
  creates one `GainNode` per role, connects it to the master input, and hangs
  an analyser off it as a **leaf** — the analyser terminates and feeds nothing
  onward. `AudioMixer` connects its `trim` node to `AudioGraph.roleBusInput`
  for its role rather than to the master input, so a layer chain reaches the
  master through exactly one role bus. Readings come back out as
  `MeterSnapshot`s through `roleMeterSnapshot` and `roleMeterSnapshots`, the
  latter so one publication carries all four roles from a single instant.
- **A tap neither implements nor contradicts the deferred bus.** ADR 0023's
  "no separate per-role sum or insert" is a statement about **DSP semantics**:
  nothing per-role may process the mix, insert into it, or re-sum it. A unity
  gain whose analyser is a leaf does none of those things — its presence is
  unobservable in the output by construction, not by measurement. Role effects
  inserts stay deferred exactly where ADR 0023 and
  [ADR 0063](0063-audio-effects-are-baked-conform-siblings.md) leave them.
- **The bus gain is unity, permanently.** Role gain is folded onto each member
  layer's own gain envelope in `AudioMixer.deriveFromView`, upstream of the
  fan-in, and that is the only place it is applied. Writing it at the bus as
  well would apply it twice — a −6 dB trim would sound at −12 dB and the meter
  would read the squared value. This is the change's one landmine: it is stated
  in a comment at the node, and the assertion that would catch a double-apply
  is split across two unit tests. `AudioGraph.test.ts` holds every role bus at
  unity from construction through `setMasterMute`; the role-gain half lives in
  `AudioMixer.test.ts`, which drives a gain through the fold and asserts it
  lands on the layer's envelope while the bus stays at unity — `AudioGraph`
  exposes no role-gain API to exercise, because role gain never reaches it.
- **Role gating stays skip, not attenuate.** The audio pass skips a gated
  role's layers rather than zeroing them, so nothing reaches that role's bus
  and its analyser reports true silence on its own. The meter therefore carries
  no mute/solo branch: a UI-side special case could only hide a meter that
  disagreed with what is audible, and a silent meter for a silenced role is
  both the correct reading and the one that matches the dimmed card. The gate
  and the Panel's dimming read the same `roleAudible` / `anyRoleSolo`
  predicate, so the two cannot part company.
- **The connection follows the role already on the audio view.**
  `AudioMixer.updateView` compares the incoming view's role against the bus it
  is wired to and re-points `trim` when they differ. The view is replaced
  whenever a layer's params change, which is exactly when a role change
  arrives, so no role parameter joins `AudioMixerInit` and there is no second
  copy of the role to keep in step. `trim`'s only downstream is its role bus,
  so a bare disconnect is exact.
- **Levels publish through the existing meter store, on the master's floor.**
  `masterMeterStore` is the single renderer publication seam for real analyser
  readings and owns the silence-floor contract (`SILENCE_DB`), so the per-role
  slice joins the master reading there — `publishRoleMeters` for a sample,
  `publishRoleMetersSilent` for a stopped tap — rather than in a second store
  that would duplicate or import that contract. Its selectors are **scalar**
  (`useRoleRmsDb`): a selector that builds a fresh `{ rmsDb, peakDb }` on every
  call hands `useSyncExternalStore` a new reference each time and re-renders
  forever. Per-role peak is published and kept but has no selector, because
  peak answers headroom and these meters answer balance.
- **The UI tap is a second timer, leased by its readers.** A meter has to move
  rather than step, which the deliberately slow agent-facing master push cannot
  provide without breaking its own rate contract, so the fast per-role sampling
  is a separate timer. It runs only while something holds a ref-counted demand
  lease (`acquireRoleMeterDemand`) *and* the transport is playing, and it
  publishes one all-silent sample when it stops — a held last reading would
  claim level over a mix that has gone silent. A Panel nobody has open spends
  no frame budget.
- **Metering is preview-only.** A readout is not a rendering decision, and the
  export mixer has no per-role summing stage to meter. The gate decision itself
  runs the shared `weftcut-eval` leaf (`role_audible`) that the export planner
  links, so the preview meter and the export mix agree by construction and the
  change carries no dual-engine parity obligation.

## Considered options

- **Build the real per-role bus now** — `RoleMixSettings.effects`, with DSP per
  role. Rejected: metering needs none of it, and a processing bus has to answer
  where role gain is applied, what the export path does with the same chain,
  and whether an insert is realtime or baked — questions
  [ADR 0063](0063-audio-effects-are-baked-conform-siblings.md) settled for clip
  effects and that a readout does not raise at all.
- **Set the role gain on the bus node and drop the per-layer fold.** Rejected:
  the fold is the preview twin of the export planner's fold, so the export path
  would keep folding while the preview did not, and one model with two thin
  renderers would become two models. The bus is also preview-only, which makes
  it the wrong home for anything both engines have to agree on.
- **Attenuate a gated role's bus to zero instead of skipping its layers.**
  Rejected: the skip rules are shared with the export planner, so a
  preview-only second gate is a place the two engines could drift — and the
  meter reads silence either way, so the drift is the only thing bought.
- **Give per-role levels their own store.** Rejected: the silence-floor
  contract has one home, and a second store would either restate it or import
  it across modules. The per-role slice is a slice, not a subsystem.
- **Raise the existing agent-facing meter push to meter rate and read roles off
  it.** Rejected: that timer's slow rate is the contract of an MCP resource for
  level checks, and at that rate a level meter steps rather than moves. Two
  timers with two purposes cost less than one rate that serves neither.
- **Pass the role into the mixer's constructor.** Rejected: the role already
  rides on the audio view, and a constructor copy is a second source of truth
  that a role change has to remember to update.
- **Per-channel (left/right) role metering.** Deferred: the analysers read
  combined channels for the master and the roles alike, so splitting is one
  change for both rather than a role-only feature.

## Consequences

- The preview graph carries four extra gain nodes and four analysers. Every one
  of them is either a leaf or a unity gain whose only downstream is the master
  input, so the samples that reach the destination are exactly the ones the
  layer chains produce, and neither engine has a per-role summing stage.
- A role meter shows that role's **contribution to the mix**, gain already
  applied — including a live fader audition, because the audition override
  feeds the same fold. Moving a fader moves its meter before anything is
  recorded.
- A muted, self-muted or solo-silenced role reads the silence floor with no
  code asking whether it is gated. The meter cannot disagree with the gate,
  because it sits downstream of it.
- The master reading's own consumers are unaffected: the dev PerfHUD and the
  MCP resource see the master only, and the per-role slice publishes beside it
  at its own rate in the same store.
- **A future real role bus would have to change five things**, and they are
  worth naming so none of them arrives by drift. The unity invariant goes
  first: role gain would have to leave `AudioMixer.deriveFromView` and be
  written at the bus in exactly one place, so the unity assertion is the guard
  that fails first and should be re-decided rather than deleted. The analyser
  stops being a leaf, so "metering cannot alter output" becomes a claim to test
  rather than a property of the shape. Gating can no longer be pure skip: an
  insert whose tail outlives its layers has to be summed even when every member
  layer is skipped, which is the first place the shared
  `role_audible` predicate would need a preview-side exception. Export gains a
  per-role summing stage, and with it the dual-engine parity obligation this
  change does not carry. And `RoleMixSettings.effects` becomes project state,
  with the schema, undo and MCP surface that implies.

## References

- [ADR 0023](0023-audio-mixes-by-role-not-track.md) — audio mixes by role, not
  by track (the fold, and the per-role insert this is deliberately not).
- [ADR 0019](0019-audio-mixes-in-rust-over-conform-pcm.md) — audio mixes in
  Rust over conform PCM (the master meter this extends).
- [ADR 0025](0025-shared-eval-wasm-leaf-crate.md) — the shared `weftcut-eval`
  leaf both engines run the role gate through.
- [ADR 0063](0063-audio-effects-are-baked-conform-siblings.md) — audio effects
  are baked conform siblings (where a per-role insert is named again as
  deferred).
- [`audio.md`](../audio.md) § Preview mixer and § Roles — the topology, the
  skip rules, and the Role Mixer Panel.
