import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// Session-scoped collapse memory, keyed `${layerKind}:${sectionId}`. An
// override survives selection changes within the run — expanding Advanced on
// one Video layer keeps it open for the next — but nothing persists across
// app restart (no localStorage).
const collapseMemory = new Map<string, boolean>();

/// Mounted sections listening for an expand request, one entry per instance.
/// A Set of callbacks rather than a store: the request is an EVENT — "open
/// this" — and a piece of state saying "open" would have to be cleared by
/// whoever consumed it, which is a second thing to get wrong when two sections
/// share a key.
const expandListeners = new Set<(key: string) => void>();

/// Wipe the session memory. Exported for tests.
export function clearPropSectionMemory(): void {
  collapseMemory.clear();
}

/// Open one section from outside the panel — what a command does after
/// revealing the Attribute Panel (`commands/pauseCommands.ts`).
///
/// Writes the memory AND pokes the mounted instances, and both halves are
/// needed: a section that is not mounted yet (the Panel was closed, or another
/// layer is selected) reads the memory in its `useState` initializer when it
/// finally mounts, and one already on screen only learns about the request
/// through the callback.
export function requestPropSectionExpand(
  layerKind: string,
  sectionId: string,
): void {
  const key = `${layerKind}:${sectionId}`;
  collapseMemory.set(key, false);
  for (const notify of expandListeners) notify(key);
}

/// Collapsible property-panel section. Collapsing UNMOUNTS the children (a
/// hidden keyframe row shouldn't keep evaluating), and the header is the only
/// chrome.
export function PropSection({
  layerKind,
  sectionId,
  title,
  defaultCollapsed = false,
  children,
}: {
  layerKind: string;
  sectionId: string;
  title: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const key = `${layerKind}:${sectionId}`;
  const [collapsed, setCollapsed] = useState(
    () => collapseMemory.get(key) ?? defaultCollapsed,
  );
  // Selection switched layer kinds on this mounted instance: re-derive from
  // memory so a sibling kind's override can't leak across (React's documented
  // render-phase state adjustment).
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setCollapsed(collapseMemory.get(key) ?? defaultCollapsed);
  }

  // An expand request that arrives while this instance is on screen. Keyed, so
  // a request for another section leaves this one alone; the memory is already
  // written by the time the callback runs, so this only catches up the view.
  useEffect(() => {
    const notify = (requested: string) => {
      if (requested === key) setCollapsed(false);
    };
    expandListeners.add(notify);
    return () => {
      expandListeners.delete(notify);
    };
  }, [key]);

  const toggle = () => {
    const next = !collapsed;
    collapseMemory.set(key, next);
    setCollapsed(next);
  };

  return (
    <section className="prop-section" aria-label={title}>
      <button
        type="button"
        className="prop-section-header"
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        {collapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
        <span className="prop-section-title">{title}</span>
      </button>
      {collapsed ? null : children}
    </section>
  );
}
