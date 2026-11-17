// @vitest-environment jsdom
//
// The trust card (ADR 0174): what it says of an untrusted Motif's files, and
// that Trust names the revision the user was shown, never a later one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "../i18n";
import type { MotifTrustCard, MotifTrustSummary } from "../ipc";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/bridge/ipc", () => ({ invoke: (cmd: string, args?: unknown) => bridge.invoke(cmd, args) }));

import { TrustCard } from "./TrustCard";

afterEach(() => { cleanup(); bridge.invoke.mockReset(); });

const SEEN = "a".repeat(64);
const CHANGED = "b".repeat(64);
const empty: MotifTrustSummary = { files: 2, bytes: 2048, binary: 0, scripts: [], workers: [], wasm: [], minified: [], unscanned: [] };
const card = (revision: string, summary: Partial<MotifTrustSummary> = {}): MotifTrustCard =>
  ({ motif_id: "received", revision, trusted: false, summary: { ...empty, ...summary } });

/** Answers the card's channels: summaries in turn, then `trust` for trust_motif. */
function backend(summaries: MotifTrustCard[], trust: () => unknown = () => ({ trusted: true })) {
  bridge.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "motif_trust_summary") return summaries.length > 1 ? summaries.shift() : summaries[0];
    if (cmd === "trust_motif") return trust();
    throw new Error(`unexpected ${cmd}`);
  });
}

const labels = () => [...document.querySelectorAll(".motif-trust-summary dt")].map((dt) => dt.textContent);
const trustButton = () => screen.getByRole("button", { name: "Trust" });

describe("the trust card", () => {
  it("says the Motif is not trusted and lists only the findings its files show", async () => {
    backend([card(SEEN, {
      scripts: [{ path: "index.html", bytes: 900 }, { path: "lib/run.js", bytes: 40_960 }],
      minified: [{ path: "lib/run.js", longest_line: 48_213 }],
    })]);
    render(<TrustCard motifId="received" />);
    await waitFor(() => expect(labels()).toEqual(["Files", "Scripts", "Long minified lines"]));
    expect(screen.getByRole("heading", { name: "Not trusted on this machine" })).toBeTruthy();
    expect(screen.getByText("This Motif came with the project; its code has not run here.")).toBeTruthy();
    const summary = document.querySelector(".motif-trust-summary") as HTMLElement;
    expect(within(summary).getByText("2 files · 2.0 KB")).toBeTruthy();
    expect(within(summary).getByText("index.html (900 B), lib/run.js (40.0 KB)")).toBeTruthy();
    expect(within(summary).getByText(/^lib\/run\.js \(48,213 characters\)$/)).toBeTruthy();
    expect(screen.getByText(/read_motif reads its files as text and never runs them/)).toBeTruthy();
    expect(bridge.invoke).toHaveBeenCalledWith("motif_trust_summary", { motif_id: "received" });
  });

  it("lists Worker, WebAssembly and unscanned findings when the files show them", async () => {
    backend([card(SEEN, { binary: 1, workers: ["worker.js"], wasm: ["core.wasm"], unscanned: ["clip.bin"] })]);
    render(<TrustCard motifId="received" />);
    await waitFor(() => expect(labels()).toEqual(["Files", "Workers", "WebAssembly", "Too large to scan"]));
    expect(screen.getByText("2 files · 2.0 KB · 1 not text")).toBeTruthy();
  });

  it("trusts the revision the summary was read from", async () => {
    backend([card(SEEN)]);
    render(<TrustCard motifId="received" />);
    await waitFor(() => expect(labels()).toEqual(["Files"]));
    fireEvent.click(trustButton());
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("trust_motif", { motif_id: "received", revision: SEEN }));
  });

  it("shows the files again when they changed under the card, and trusts only the revision shown next", async () => {
    backend([card(SEEN), card(CHANGED, { workers: ["worker.js"] })], () => {
      throw new Error(`Motif revision conflict: the current revision is ${CHANGED}; look at the Motif again before trusting it`);
    });
    render(<TrustCard motifId="received" />);
    await waitFor(() => expect(labels()).toEqual(["Files"]));
    fireEvent.click(trustButton());
    await screen.findByText("Its files changed. This is what they hold now.");
    expect(labels()).toEqual(["Files", "Workers"]);
    expect(screen.queryByRole("alert")).toBeNull();
    bridge.invoke.mockClear();
    backend([card(CHANGED, { workers: ["worker.js"] })]);
    fireEvent.click(trustButton());
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("trust_motif", { motif_id: "received", revision: CHANGED }));
    expect(bridge.invoke).not.toHaveBeenCalledWith("trust_motif", { motif_id: "received", revision: SEEN });
  });

  it("shows a refusal that is not a change of files as it is", async () => {
    backend([card(SEEN)], () => { throw new Error("No project is open"); });
    render(<TrustCard motifId="received" />);
    await waitFor(() => expect(labels()).toEqual(["Files"]));
    fireEvent.click(trustButton());
    expect((await screen.findByRole("alert")).textContent).toContain("No project is open");
    expect(screen.queryByText("Its files changed. This is what they hold now.")).toBeNull();
  });
});
