// Opens the Motifs panel on one row, for a surface outside it that sends the
// user there (the property panel's untrusted Motif). The command registry's
// commands take no arguments, so the row waits here for the panel to take it
// as it mounts.
import { getCommand } from "../commands/registry";
import { rowKey, type MotifRow } from "./motifRows";

let pending: string | null = null;

export function openMotifsPanelAt(row: Pick<MotifRow, "group" | "id">): void {
  const open = getCommand("openMotifPicker");
  pending = open ? rowKey(row) : null;
  void open?.run();
}

/** The row a surface asked the panel to open on, once; null when none did. */
export function takeMotifsPanelRow(): string | null {
  const key = pending;
  pending = null;
  return key;
}
