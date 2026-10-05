---
status: accepted
---

# Machine performance budgets are runtime settings

Preview GPU admission, picture retention and Motif/timeline caches used numeric
constants distributed across main and renderer modules. Some values were tuned
on one machine; changing hardware required editing implementation files.

The shared performance-settings module owns the policy fields, defaults, units,
ranges and validation. App settings own persistence and cross-window delivery.
A performance patch merges individual fields; null restores the shipping
profile. Main publishes a runtime snapshot after a successful atomic disk write,
and renderer settings hydration publishes the corresponding renderer snapshot.
The Settings performance pane and future machine detection use this same write
interface. No detection or inferred hardware profile is introduced here.

Simple settings map Less / Standard / Maximum to fixed numeric budgets in a
separate shared preset module. Maximum preserves the existing shipping profile;
the other tiers reduce it. Full presets replace all performance fields, while
independent cache and parallel-video controls patch only their owned fields.
The per-video buffer count stays advanced-only for independent adjustments.
Advanced settings remain available in a collapsed section on the same page.
Selection is derived from actual saved values, including a Custom state; no
preset ID is persisted or replayed on upgrade. This keeps existing user values
stable if the preset mapping changes. Automatic detection and calibration are
deferred; Maximum names the highest offered preset, not detected machine capacity.

Consumers read policy at admission or maintenance time. Lowering a limit can
leave usage above it until existing leases close or cache maintenance runs;
it never revokes a live texture. Pool-slot counts apply to newly opened decoder
sessions. Minimum frame retention and texture synchronization remain correctness
constraints. This makes the 128 MiB/eight-pool allocation limits in ADR 0078
configurable defaults while preserving its lease accounting, retirement and
fallback rules. The preview ownership decisions in ADR 0082 remain unchanged.

Keeping one small runtime snapshot per process avoids filesystem reads on hot
paths and dependency cycles from render resources into the React settings store.
Only settings bootstrap/commit/hydration publishes it. New controls must use the
existing app-settings command path to notify other windows. Invalid runtime
patches fail atomically; malformed disk values recover per field.

Scope, activation timing, caveats and example calls are documented in
[performance-settings.md](../performance-settings.md). Native disk caches and
other schedulers require separate lifecycle work before joining this interface.
