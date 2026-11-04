/** A difference between two plain-data snapshots that crosses IPC in place of
 *  the second one. `diffSnapshot` stops at any branch both sides share by
 *  reference, so its cost follows what changed, not how much the snapshot holds
 *  (ADR 0157). */
export type SnapshotPath = readonly (string | number)[];
export type SnapshotPatch =
  /** Set this path to a value. */
  | { path: SnapshotPath; value: unknown }
  /** Remove this key. */
  | { path: SnapshotPath; remove: true }
  /** Rebuild this `id`-keyed array: a number keeps that element of the array as
   *  it stood, an object carries a new one. Later patches address the result. */
  | { path: SnapshotPath; items: readonly (number | { value: unknown })[] }
  /** Restore this object's key order. Consumers iterate records, and an undo
   *  returns a key to its old place where a patch would have appended it. */
  | { path: SnapshotPath; keys: readonly string[] };

type Mutable = Record<string | number, unknown>;
const isBranch = (value: unknown): value is object => typeof value === 'object' && value !== null;
const idOf = (value: unknown): string | null => {
  const id = isBranch(value) ? (value as { id?: unknown }).id : null;
  return typeof id === 'string' ? id : null;
};

function diffArray(before: readonly unknown[], after: readonly unknown[], path: SnapshotPath, out: SnapshotPatch[]): void {
  const beforeIds = before.map(idOf), afterIds = after.map(idOf);
  if (before.length === after.length && afterIds.every((id, i) => id === beforeIds[i])) {
    for (let i = 0; i < after.length; i++) walk(before[i], after[i], [...path, i], out);
    return;
  }
  const at = new Map(beforeIds.map((id, i) => [id, i]));
  if (at.size !== before.length || new Set(afterIds).size !== after.length || at.has(null) || afterIds.includes(null)) {
    out.push({ path, value: after });
    return;
  }
  out.push({ path, items: after.map((value, i) => at.get(afterIds[i]) ?? { value }) });
  after.forEach((value, i) => {
    const from = at.get(afterIds[i]);
    if (from !== undefined) walk(before[from], value, [...path, i], out);
  });
}

function walk(before: unknown, after: unknown, path: SnapshotPath, out: SnapshotPatch[]): void {
  if (Object.is(before, after)) return;
  if (!isBranch(before) || !isBranch(after) || Array.isArray(before) !== Array.isArray(after)) {
    out.push({ path, value: after });
    return;
  }
  if (Array.isArray(before)) { diffArray(before, after as unknown[], path, out); return; }
  const a = before as Mutable, b = after as Mutable;
  const beforeKeys = Object.keys(a), afterKeys = Object.keys(b);
  for (const key of beforeKeys) if (!Object.hasOwn(b, key)) out.push({ path: [...path, key], remove: true });
  for (const key of afterKeys) {
    if (Object.hasOwn(a, key)) walk(a[key], b[key], [...path, key], out);
    else out.push({ path: [...path, key], value: b[key] });
  }
  const kept = beforeKeys.filter(key => Object.hasOwn(b, key));
  const appended = afterKeys.filter(key => !Object.hasOwn(a, key));
  if ([...kept, ...appended].some((key, i) => key !== afterKeys[i])) out.push({ path, keys: afterKeys });
}

export function diffSnapshot(before: unknown, after: unknown): SnapshotPatch[] {
  const out: SnapshotPatch[] = [];
  walk(before, after, [], out);
  return out;
}

/** `base` is not modified. Only the branches the patches walk are copied, each
 *  once however many patches pass through it, and every other branch keeps its
 *  reference: that identity is what lets subscribers skip unchanged work. */
export function applySnapshotPatches<T>(base: T, patches: readonly SnapshotPatch[]): T {
  const owned = new WeakSet<object>();
  const own = (node: unknown): Mutable => {
    if (!isBranch(node)) throw new Error('Snapshot patch walks through a value that is not a branch');
    if (owned.has(node)) return node as Mutable;
    const copy = (Array.isArray(node) ? [...node] : { ...node }) as Mutable;
    owned.add(copy);
    return copy;
  };
  const resolve = (patch: SnapshotPatch, current: unknown): unknown => {
    if ('value' in patch) return patch.value;
    if ('items' in patch) {
      if (!Array.isArray(current)) throw new Error('Snapshot patch rebuilds a value that is not an array');
      const next = patch.items.map(item => typeof item === 'number' ? current[item] : item.value);
      owned.add(next);
      return next;
    }
    if ('keys' in patch) {
      const from = current as Mutable, next: Mutable = {};
      for (const key of patch.keys) next[key] = from[key];
      owned.add(next);
      return next;
    }
    throw new Error('Snapshot patch cannot remove the root');
  };
  let root: unknown = base;
  for (const patch of patches) {
    if (patch.path.length === 0) { root = resolve(patch, root); continue; }
    root = own(root);
    let node = root as Mutable;
    for (const key of patch.path.slice(0, -1)) node = node[key] = own(node[key]);
    const key = patch.path[patch.path.length - 1]!;
    if ('remove' in patch) delete node[key];
    else node[key] = resolve(patch, node[key]);
  }
  return root as T;
}
