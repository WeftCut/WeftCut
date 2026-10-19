// A transcription or description that could not get processing resources,
// said the way a person can act on. The native refusal (ADR 0120) is one long
// English sentence written for logs and for agents — "resource-capacity-exceeded:
// Waited 60 s before sampling clip frames: the CPU and memory budget is held by
// 2 other lease(s) …" — and shown raw it read as a crash dump in a Chinese UI.
//
// The sentence stays the record (log details, the agent's answer, a
// collapsible "technical details"); what a person reads first is a short
// summary keyed by WHY admission refused, and, where a setting can help, a way
// to the Performance pane.

import type { TFunction } from "i18next";

import { isResourceCapacityError } from "../../shared/resource-policy";
import type { ComputeTool } from "../ipc";

/// Why admission refused, read off the native sentence. The phrases matched are
/// the ones `native/src/resources.rs` writes (`acquire_user_compute`'s refusal,
/// the queue cap, the per-claim allowance); anything else carrying the
/// `resource-capacity-exceeded` tag is `busy`.
export type ComputeResourceReason =
  | "memory"
  | "finalization"
  | "budget"
  | "allowance"
  | "queue"
  | "busy";

const REASONS: ReadonlyArray<readonly [ComputeResourceReason, RegExp]> = [
  ["memory", /memory is under pressure/i],
  ["finalization", /export is finishing|finish exporting|export finalization/i],
  ["budget", /budget is held/i],
  ["allowance", /MiB allowance|increase the memory target/i],
  ["queue", /too many queued tasks/i],
];

/// The reason, or null when `text` is not a resource refusal at all.
export function computeResourceReason(text: string): ComputeResourceReason | null {
  if (!isResourceCapacityError(text)) return null;
  for (const [reason, pattern] of REASONS) if (pattern.test(text)) return reason;
  return "busy";
}

/// Whether the Performance pane holds a setting that can change the outcome.
/// An export finishing and a full queue clear on their own; nothing there helps.
export const settingsCanHelp = (reason: ComputeResourceReason): boolean =>
  reason !== "finalization" && reason !== "queue";

/// The short, localized summary for a resource refusal, or null for any other
/// failure (which keeps its own sentence).
export function computeRefusalSummary(t: TFunction, tool: ComputeTool, text: string): string | null {
  const reason = computeResourceReason(text);
  if (reason === null) return null;
  const task = t(tool === "transcribe_clip" ? "compute.refusal.task_transcribe" : "compute.refusal.task_describe");
  return t(`compute.refusal.${reason}`, { task });
}

/// `computeRefusalSummary`, falling back to the failure's own text.
export const computeFailureText = (t: TFunction, tool: ComputeTool, text: string): string =>
  computeRefusalSummary(t, tool, text) ?? text;
