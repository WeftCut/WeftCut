import { useEffect, useLayoutEffect, useRef } from "react";
import type { ActionId } from "../shortcuts/defs";
import { runCommandWithLogging } from "../shortcuts/useShortcuts";

/// The unified user-invocable command surface: providers registered here are
/// the one catalog the search palette reads. Module-level, playbackStore-style:
/// readers don't thread props; components register providers on mount.
export interface CommandDef {
  /// Unique id. Shortcut-backed commands reuse their ActionId string so
  /// ids stay one namespace.
  id: string;
  labelKey: string;
  /// Set for shortcut-backed commands — the palette shows the effective
  /// binding via useEffectiveBindings(actionId).
  actionId?: ActionId;
  /// Evaluated at palette render time; absent = always enabled.
  enabled?: () => boolean;
  /// Current state of a checkable command (armed tool, active mode).
  /// Evaluated at render time, like `enabled`; absent = not checkable.
  checked?: () => boolean;
  run: () => void | Promise<void>;
}

type Provider = () => CommandDef[];

const providers = new Set<Provider>();
const listeners = new Set<() => void>();
let version = 0;

/// Ids already reported as colliding. A duplicate is a wiring mistake worth
/// saying out loud once — but `listCommands()` runs per LOOKUP, and the Quick
/// Actions strip alone resolves ~25 ids per render, so warning per call turns
/// one mistake into hundreds of console lines a second. Keyed by id, so a
/// second, different collision still gets its line.
const warnedDuplicateIds = new Set<string>();

/// Bump the registry version and wake its subscribers. Exported because a
/// provider's `enabled` gate changes what `listCommands()` answers with no
/// provider mounting or unmounting — see `useCommandProvider`.
export function notifyCommandRegistry(): void {
  version++;
  for (const l of listeners) l();
}

/// Monotonic registry version — `useSyncExternalStore` snapshot for consumers
/// that must re-render when providers mount/unmount (the command menus).
/// `listCommands()` itself can't be the snapshot: it builds a fresh array per
/// call, which useSyncExternalStore would read as "changed every render".
export function commandRegistryVersion(): number {
  return version;
}

export function registerCommandProvider(p: Provider): () => void {
  providers.add(p);
  notifyCommandRegistry();
  return () => {
    if (providers.delete(p)) notifyCommandRegistry();
  };
}

/// Registry-change signal — the search index re-snapshots command labels
/// when providers mount/unmount (App mount lands after wireSearchIndex).
export function subscribeCommandRegistry(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function listCommands(): CommandDef[] {
  const out: CommandDef[] = [];
  const seen = new Set<string>();
  for (const p of providers) {
    for (const d of p()) {
      if (seen.has(d.id)) {
        if (!warnedDuplicateIds.has(d.id)) {
          warnedDuplicateIds.add(d.id);
          console.warn(`commands: duplicate id "${d.id}" ignored`);
        }
        continue;
      }
      seen.add(d.id);
      // Every registry dispatch logs one `Shortcut` row — the same row the
      // keyboard and native-menu dispatchers emit — so a palette-chosen Save
      // reads like the Ctrl+S that would have run it. Wrapped here, not in the
      // surfaces (palette / in-app menu bar / Quick Actions), so a new surface
      // or provider is covered with nothing to remember. No double-log:
      // providers hand in raw handlers, and the keyboard path dispatches from
      // its own HandlerMap without consulting the registry.
      out.push({ ...d, run: () => runCommandWithLogging(d.id, d.labelKey, d.run) });
    }
  }
  return out;
}

export function getCommand(id: string): CommandDef | undefined {
  return listCommands().find((c) => c.id === id);
}

/// React binding: register a provider for this component's lifetime.
/// `getDefs` is read through a ref so handler identities may churn per
/// render without re-registering (same pattern as useShortcuts).
///
/// `enabled: false` keeps the registration but contributes nothing, which is
/// what an INSTANTIABLE Panel kind needs (ADR 0053): every open timeline Panel
/// mounts a provider for the same ten ids, and only one of them may answer for
/// them. Ungated, the ids collide and `listCommands()` keeps whichever Panel
/// mounted FIRST — so the palette and the strip would edit a different
/// timeline than the keyboard does, and log the collision on every lookup.
export function useCommandProvider(
  getDefs: () => CommandDef[],
  options: { enabled?: boolean } = {},
): void {
  const enabled = options.enabled ?? true;
  const ref = useRef(getDefs);
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    ref.current = getDefs;
    enabledRef.current = enabled;
  }, [getDefs, enabled]);
  useEffect(
    () =>
      registerCommandProvider(() => (enabledRef.current ? ref.current() : [])),
    [],
  );
  // The gate flipping changes what the registry answers with no provider
  // mounting or unmounting, so the surfaces that snapshot it
  // (`commandRegistryVersion`) have nothing else to redraw on. Only a CHANGE
  // is worth a notify: registration already sent one, and a second on every
  // provider's mount would re-snapshot the search index for nothing.
  const notified = useRef(enabled);
  useEffect(() => {
    if (notified.current === enabled) return;
    notified.current = enabled;
    notifyCommandRegistry();
  }, [enabled]);
}
