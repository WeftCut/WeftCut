// @vitest-environment jsdom
//
// The project trust dialog (ADR 0182): what it says of the waiting Motifs,
// that Trust names the revisions the user was shown and never a later set,
// that only Later and its equivalents record a dismissal, and that asking an
// agent copies a read-only prompt and leaves the dialog open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "../i18n";
import type { MotifTrustSummary, ProjectTrustMotif, ProjectTrustSummary } from "../ipc";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock("@/bridge/ipc", () => ({ invoke: (cmd: string, args?: unknown) => bridge.invoke(cmd, args) }));
vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    bridge.listeners.set(event, handler);
    return () => bridge.listeners.delete(event);
  }),
}));

import { ProjectTrustDialog } from "./ProjectTrustDialog";

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(async () => {
  cleanup();
  bridge.invoke.mockReset();
  bridge.listeners.clear();
  writeText.mockClear();
  await i18n.changeLanguage("en-US");
});

const SEEN = "a".repeat(64);
const OTHER = "b".repeat(64);
const CHANGED = "c".repeat(64);
const files: MotifTrustSummary = { files: 2, bytes: 2048, binary: 0, scripts: [], workers: [], wasm: [], minified: [], unscanned: [] };
const motif = (motif_id: string, revision: string, summary: Partial<MotifTrustSummary> = {}): ProjectTrustMotif =>
  ({ motif_id, name: null, revision, summary: { ...files, ...summary } });
const state = (motifs: ProjectTrustMotif[], over: Partial<ProjectTrustSummary> = {}): ProjectTrustSummary =>
  ({ project: "Film", trusted: false, dismissed: false, prompt: true, motifs, ...over });

/** Answers the dialog's channels: summaries in turn (the last one after), and
 *  `trust` for trust_project. */
function backend(states: ProjectTrustSummary[], trust: () => unknown = () => ({ trusted: true })) {
  bridge.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "project_trust_summary") return states.length > 1 ? states.shift() : states[0];
    if (cmd === "trust_project") return trust();
    if (cmd === "dismiss_project_trust") return { dismissed: true };
    throw new Error(`unexpected ${cmd}`);
  });
}

const calls = (cmd: string) => bridge.invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const dialog = () => screen.getByRole("dialog", { name: "Run this project's Motifs?" });
const list = () => dialog().querySelector("details.project-trust-list") as HTMLDetailsElement;
const rows = () => [...list().querySelectorAll("li")].map((li) => li.textContent);

async function open(states: ProjectTrustSummary[], trust?: () => unknown) {
  backend(states, trust);
  const onClose = vi.fn();
  render(<ProjectTrustDialog onClose={onClose} />);
  await screen.findByText(/has \d+ Motifs? that/);
  return onClose;
}

describe("the project trust dialog", () => {
  it("names the project and the count, its list collapsed, each row with WebAssembly, Workers or minified code only when present", async () => {
    await open([state([
      motif("plain", SEEN),
      motif("heavy", OTHER, { wasm: ["sim.wasm"], workers: ["worker.js"], minified: [{ path: "a.js", longest_line: 40_000 }] }),
    ])]);
    expect(within(dialog()).getByText(/^Film has 2 Motifs that have not run on this computer\./)).toBeTruthy();
    expect(calls("project_trust_summary")).toEqual([{ summaries: true }]);
    expect(list().open).toBe(false);
    expect(within(list()).getByText("Show 2 Motifs")).toBeTruthy();
    expect(rows()).toEqual([
      "plain2 files · 2.0 KB",
      "heavy2 files · 2.0 KB · WebAssembly · Workers · Minified code",
    ]);
  });

  it("lists a Motif by its name when it has one", async () => {
    await open([state([{ ...motif("lower-third-2", SEEN), name: "Lower Third" }])]);
    expect(rows()).toEqual(["Lower Third2 files · 2.0 KB"]);
  });

  it("trusts exactly the revisions it showed, and closes without dismissing", async () => {
    const onClose = await open([state([motif("one", SEEN), motif("two", OTHER)])]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Trust this project" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(calls("trust_project")).toEqual([{ revisions: { one: SEEN, two: OTHER } }]);
    expect(calls("dismiss_project_trust")).toEqual([]);
  });

  it("on a refused Trust shows what the folder holds now, and trusts that only when asked again", async () => {
    let refuse = true;
    const onClose = await open(
      [state([motif("one", SEEN)]), state([motif("one", CHANGED), motif("added", OTHER)])],
      () => { if (refuse) throw new Error('{"error":"RevisionConflict"}'); return { trusted: true }; },
    );
    fireEvent.click(within(dialog()).getByRole("button", { name: "Trust this project" }));
    expect(await within(dialog()).findByText("The project's Motifs changed. This is what its folder holds now.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(list().open).toBe(true);
    expect(rows().map((r) => r!.split("2 files")[0])).toEqual(["one", "added"]);
    expect(within(dialog()).getByText(/^Film has 2 Motifs/)).toBeTruthy();

    refuse = false;
    fireEvent.click(within(dialog()).getByRole("button", { name: "Trust this project" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(calls("trust_project")).toEqual([
      { revisions: { one: SEEN } },
      { revisions: { one: CHANGED, added: OTHER } },
    ]);
  });

  it("records a dismissal on Later and on Escape", async () => {
    const later = await open([state([motif("one", SEEN)])]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Later" }));
    expect(later).toHaveBeenCalledOnce();
    await waitFor(() => expect(calls("dismiss_project_trust")).toHaveLength(1));
    cleanup();

    const escape = await open([state([motif("one", SEEN)])]);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(escape).toHaveBeenCalledOnce());
    await waitFor(() => expect(calls("dismiss_project_trust")).toHaveLength(2));
    expect(calls("trust_project")).toEqual([]);
  });

  it("copies a read-only prompt for an agent and stays open", async () => {
    const onClose = await open([state([motif("one", SEEN), motif("two", OTHER)])]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Ask an agent to check first" }));
    expect(await within(dialog()).findByRole("status")).toHaveProperty("textContent",
      "Copied. Paste it to your agent; it only reads the files and runs nothing.");
    const prompt = writeText.mock.calls[0]![0];
    expect(prompt).toContain("project://session");
    expect(prompt).toContain("read_motif");
    expect(prompt).toContain("one, two");
    expect(onClose).not.toHaveBeenCalled();
    expect(calls("dismiss_project_trust")).toEqual([]);
  });

  it("closes itself, undismissed, once the project is trusted elsewhere", async () => {
    const onClose = await open([state([motif("one", SEEN)]), state([], { trusted: true, prompt: false })]);
    await act(async () => { bridge.listeners.get("motifs:changed")!(); });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(calls("dismiss_project_trust")).toEqual([]);
  });

  it("with no Motif waiting, says so and trusts the folder with an empty set", async () => {
    backend([state([], { prompt: false })]);
    const onClose = vi.fn();
    render(<ProjectTrustDialog onClose={onClose} />);
    expect(await screen.findByText(/^Motifs run code that came with the project\. Trust Film/)).toBeTruthy();
    expect(dialog().querySelector("details")).toBeNull();
    expect(within(dialog()).queryByRole("button", { name: "Ask an agent to check first" })).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Trust this project" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(calls("trust_project")).toEqual([{ revisions: {} }]);
  });
});
