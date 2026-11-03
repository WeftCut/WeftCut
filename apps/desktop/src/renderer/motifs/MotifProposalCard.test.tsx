// @vitest-environment jsdom
//
// ADR 0046's gate in the panel: an agent's `install_motif` shows up as a card
// in the Motifs panel, with the frozen package in the preview player, the
// change against the installed version and the clips that will rebind.
// Approve publishes it through the renderer-only `approve_motif_proposal`
// channel; Reject sends the note through `reject_motif_proposal`. The real
// IPC wrappers run; only the bridge is stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "../i18n";
import type { MotifProposal, MotifSummary } from "../ipc";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  changed: [] as Array<() => void>,
}));
vi.mock("@/bridge/ipc", () => ({ invoke: (cmd: string, args?: unknown) => bridge.invoke(cmd, args) }));
vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    if (event === "motifs:changed") bridge.changed.push(handler);
    return () => {};
  }),
}));
vi.mock("@/bridge/dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const capture = vi.hoisted(() => vi.fn((..._args: unknown[]) => new Promise<Blob>(() => {})));
vi.mock("../render/motifs/host", () => ({ captureMotifFramePngBlob: capture }));

import { setUserMotifs } from "../render/motifs/catalog";
import { MotifPicker } from "./MotifPicker";
import { MotifProposalIndicator } from "./MotifProposalIndicator";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  bridge.changed.length = 0;
  setUserMotifs([]);
});

const INSTALLED: MotifSummary = {
  id: "badge", name: "Badge", version: 1, size: [640, 360], default_duration_s: 5, status: "installed",
  props_schema: { title: { type: "string", default: "Hello" } },
};
const PROPOSAL: MotifProposal = {
  motif_id: "badge-draft", proposal_id: "p-1", state: "awaiting_approval", revision: "rev-9",
  target: { id: "badge", version: 1 }, proposed_at: "2026-11-01T00:00:00.000Z", preview_id: "badge-draft--proposal",
  manifest: { id: "badge-draft", name: "Badge", version: 1, size: [640, 360], default_duration_s: 5, fonts: [], props_schema: { title: { type: "string", default: "Hello" }, tagline: { type: "string", default: "New" } } } as never,
  diff: { files: { added: ["logo.png"], removed: [], changed: ["index.html"] }, props: { added: ["tagline"], removed: [], changed: [] } },
  rebinds: [],
};

/** The main process as the panel sees it: one pending proposal until approved. */
function serve() {
  let pending = [PROPOSAL];
  bridge.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_motifs") return [INSTALLED];
    if (cmd === "list_motif_proposals") return pending;
    if (cmd === "approve_motif_proposal") { pending = []; return { motif_id: "badge", publication: { state: "approved", version: 2 } }; }
    if (cmd === "reject_motif_proposal") { pending = []; return { state: "rejected" }; }
    if (cmd === "motif_get_cover") return new Promise(() => {});
    throw new Error(`unexpected ${cmd}`);
  });
}
const emitChanged = () => { for (const h of bridge.changed) h(); };

function renderPanel() {
  render(
    <MotifPicker
      onClose={vi.fn()} onAdded={vi.fn()} onDraftPlaced={vi.fn()} compositionId="comp"
      currentTimeUs={0} tracks={[]} fpsNum={30} fpsDen={1} compWidth={1920} compHeight={1080}
    />,
  );
}

describe("the Motifs panel's approval card", () => {
  it("renders a pending proposal: the frozen package's preview, its target, props and diff", async () => {
    serve();
    renderPanel();
    const card = await screen.findByRole("article", { name: "Proposed publication: Badge" });
    expect(within(card).getByText("Replaces “badge” version 1 → 2")).toBeTruthy();
    expect(within(card).getByText(/Files — added: logo\.png · removed: none · changed: index\.html/)).toBeTruthy();
    expect(within(card).getByText(/Props — added: tagline/)).toBeTruthy();
    expect(within(card).getByText("No clips in this project change.")).toBeTruthy();
    // The preview player captures the frozen package, at the proposed revision.
    await waitFor(() => expect(capture.mock.calls.some((c) => c[0] === "badge-draft--proposal" && c[6] === "rev-9")).toBe(true));
  });

  it("Approve publishes through the renderer-only channel, and the card goes", async () => {
    serve();
    renderPanel();
    const card = await screen.findByRole("article", { name: "Proposed publication: Badge" });
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("approve_motif_proposal", { motif_id: "badge-draft", proposal_id: "p-1" }));
    expect(bridge.invoke).not.toHaveBeenCalledWith("install_motif", expect.anything());
    emitChanged(); // main emits motifs:changed after the publication
    await waitFor(() => expect(screen.queryByRole("article", { name: "Proposed publication: Badge" })).toBeNull());
  });

  it("Reject sends the user's note", async () => {
    serve();
    renderPanel();
    const card = await screen.findByRole("article", { name: "Proposed publication: Badge" });
    fireEvent.change(within(card).getByRole("textbox", { name: "Note for the agent (optional)" }), { target: { value: "bigger title" } });
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("reject_motif_proposal", { motif_id: "badge-draft", proposal_id: "p-1", note: "bigger title" }));
  });

  it("the status-bar note shows only while a proposal waits", async () => {
    serve();
    render(<MotifProposalIndicator />);
    expect(await screen.findByRole("button", { name: /Motif awaiting approval/ })).toBeTruthy();
    bridge.invoke.mockImplementation(async () => []);
    emitChanged();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Motif awaiting approval/ })).toBeNull());
  });
});
