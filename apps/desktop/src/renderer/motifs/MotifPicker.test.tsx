// @vitest-environment jsdom
//
// The Motifs panel: its two groups and what each row says and offers
// (spec § Project Motifs, "Panel"; § Library, "Guards"), and the fallback
// form: prop edits buffer in local form state (NO IPC per edit) and leave as
// ONE whole-props object on submit — the opposite commit model from the
// property panel's per-key patches. Also pins the ColorInput contract: the
// swatch edits the RGB triplet while the buffered value keeps a default's
// trailing alpha (shown in full by the `<code>` readout) until the user
// actually picks a color.
//
// Field queries use case-insensitive patterns so they match the label whether
// it renders as the raw prop key or its Title Case form.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { LibraryMotifRow, MotifCatalog, MotifSummary, ProjectMotifRow } from "../ipc";

const ipcMocks = vi.hoisted(() => ({
  listMotifCatalog: vi.fn(),
  addMotif: vi.fn(),
  importMotif: vi.fn(),
  exportMotif: vi.fn(),
  deleteLibraryMotif: vi.fn(),
  listMotifVersions: vi.fn(),
  restoreMotifVersion: vi.fn(),
  updateProjectMotif: vi.fn(),
  removeProjectMotif: vi.fn(),
  planSaveToLibrary: vi.fn(),
  saveToLibrary: vi.fn(),
  listMotifProposals: vi.fn(async () => []),
  getMotifCover: vi.fn(() => new Promise(() => {})),
  motifTrustSummary: vi.fn(),
  trustMotif: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipcMocks };
});
// The picker adds through the composition-scoped wrapper; the same mock
// stands in so the assertions below read the args it was handed.
vi.mock("../ipc/compositionScoped", () => ({
  addMotifIn: ipcMocks.addMotif,
}));
vi.mock("../render/motifs/syncCatalog", () => ({ syncProjectMotifsFromBackend: vi.fn(async () => {}) }));
vi.mock("@/bridge/events", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@/bridge/dialog", () => ({ open: vi.fn(), save: vi.fn() }));
// The preview's CDP capture has no jsdom stand-in; a never-settling promise
// parks every preview in its loading state, which the form doesn't depend on.
const capture = vi.hoisted(() => vi.fn((..._args: unknown[]) => new Promise<Blob>(() => {})));
vi.mock("../render/motifs/host", () => ({ captureMotifFramePngBlob: capture }));

// The App's command that mounts the panel; the panel itself is rendered here.
const openPicker = vi.hoisted(() => vi.fn());
vi.mock("../commands/registry", async (importActual) => ({
  ...(await importActual<typeof import("../commands/registry")>()),
  getCommand: (id: string) => (id === "openMotifPicker" ? { id, run: openPicker } : undefined),
}));

import { MotifPicker } from "./MotifPicker";
import { openMotifsPanelAt } from "./openMotifsPanel";
import { open, save } from "@/bridge/dialog";
import { setProjectMotifs } from "../render/motifs/catalog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setProjectMotifs();
});

const MOTIF: MotifSummary = {
  id: "badge",
  name: "Badge",
  version: 1,
  size: [640, 360],
  default_duration_s: 5,
  content_hash: "lib-rev",
  props_schema: {
    title: { type: "string", default: "Hello", max_length: 40 },
    // Translucent default: only the untouched buffered value may keep the
    // trailing alpha; the swatch itself can never produce one.
    accent: { type: "color", default: "#000000cc" },
    ring: { type: "color", default: "#ff4d4d" },
    speed: { type: "number", default: 1, min: 0, max: 4 },
    effect: { type: "enum", default: "karaoke", options: ["typewriter", "karaoke"] },
  },
};

const lib = (over: Partial<LibraryMotifRow> & { name?: string } = {}): LibraryMotifRow => {
  const { name, ...rest } = over;
  const id = rest.id ?? "badge";
  return { group: "library", id, status: "installed", revision: "lib-rev", in_project: null,
    motif: { ...MOTIF, id, ...(name ? { name } : {}) }, ...rest };
};
const proj = (over: Partial<ProjectMotifRow> & { name?: string } = {}): ProjectMotifRow => {
  const { name, ...rest } = over;
  const id = rest.id ?? "lower";
  const row: ProjectMotifRow = { group: "project", id, uid: `uid-${id}`, status: "ok", state: "in_sync", from: null,
    path: `/home/u/Film/Motifs/${id}`, revision: "proj-rev",
    motif: { ...MOTIF, id, name: name ?? id, content_hash: "proj-rev" }, ...rest };
  // As `listMotifCatalog` reads the wire: only an ok row carries its Motif,
  // and an untrusted one keeps the revision the trust card trusts.
  return row.status === "ok" ? row : { ...row, motif: null, revision: row.status === "untrusted" ? row.revision : null };
};
const untrusted = (id: string, over: Partial<ProjectMotifRow> = {}) =>
  proj({ id, status: "untrusted", state: "modified", revision: "c".repeat(64), diagnostic: "not trusted on this machine", ...over });

const onClose = vi.fn();
const onAdded = vi.fn().mockResolvedValue(undefined);

async function renderPicker(catalog: MotifCatalog = { project: [], library: [lib()] }) {
  ipcMocks.listMotifCatalog.mockResolvedValue(catalog);
  ipcMocks.addMotif.mockResolvedValue("layer-new");
  render(
    <MotifPicker
      onClose={onClose}
      onAdded={onAdded}
      onNewPlaced={vi.fn()}
      compositionId="comp-focused"
      currentTimeUs={1_000_000}
      tracks={[]}
      fpsNum={30}
      fpsDen={1}
      compWidth={1920}
      compHeight={1080}
    />,
  );
  // The form mounts once the catalog fetch lands and the first card is selected.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add to timeline" })).toBeTruthy(),
  );
}

const group = (name: "This project" | "Library") => screen.getByRole("region", { name });
const cardOf = (id: string, name: "This project" | "Library") => within(group(name)).getByTitle(id).closest(".motif-card")! as HTMLElement;
async function menuItem(card: HTMLElement, label: string) {
  fireEvent.contextMenu(card, { clientX: 30, clientY: 30 });
  return screen.findByRole("menuitem", { name: label });
}

describe("two groups: this project and the library", () => {
  it("lists each group apart; project rows say what they need, a broken one names why", async () => {
    await renderPicker({
      project: [
        proj({ id: "same" }),
        proj({ id: "behind", state: "update_available" }),
        proj({ id: "edited", state: "modified" }),
        proj({ id: "mine", state: "project_only" }),
        proj({ id: "gone", status: "missing" }),
        proj({ id: "torn", status: "invalid", diagnostic: "manifest.json: Unexpected token" }),
      ],
      library: [lib({ status: "builtin", id: "countdown", in_project: "same" })],
    });
    const badge = (id: string) => cardOf(id, "This project").querySelector(".motif-card-status")?.textContent ?? null;
    expect(badge("same")).toBeNull();
    expect(badge("behind")).toBe("Update available");
    expect(badge("edited")).toBe("Modified");
    expect(badge("mine")).toBe("Project only");
    expect(badge("gone")).toBe("Missing");
    expect(within(cardOf("gone", "This project")).getByText("Motifs/gone/ is missing")).toBeTruthy();
    expect(within(cardOf("torn", "This project")).getByText("Motifs/torn/ is not a valid Motif")).toBeTruthy();
    // The library row says the project holds its lineage.
    expect(within(cardOf("countdown", "Library")).getByText("In this project")).toBeTruthy();
    // A broken project Motif cannot be placed: selecting it explains instead.
    fireEvent.click(within(group("This project")).getByTitle("gone"));
    expect(await screen.findByRole("heading", { name: "“gone” can't render" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to timeline" })).toBeNull();
    // An invalid package's own error stays, under the localized lead.
    fireEvent.click(within(group("This project")).getByTitle("torn"));
    const pane = (await screen.findByRole("heading", { name: "“torn” can't render" })).parentElement!;
    expect(within(pane).getByText("Motifs/torn/ is not a valid Motif")).toBeTruthy();
    expect(within(pane).getByText("manifest.json: Unexpected token")).toBeTruthy();
  });

  it("says when the project's copy of a library Motif cannot render", async () => {
    await renderPicker({
      project: [proj({ id: "gone", status: "missing" }), proj({ id: "torn", status: "invalid", diagnostic: "bad" })],
      library: [lib({ id: "badge", in_project: "gone" }), lib({ id: "other", in_project: "torn" })],
    });
    expect(within(cardOf("badge", "Library")).getByText("In this project · missing")).toBeTruthy();
    expect(within(cardOf("other", "Library")).getByText("In this project · invalid")).toBeTruthy();
  });

  it("says an untrusted Motif waits for Trust before its state, with no cover, preview or placement", async () => {
    ipcMocks.motifTrustSummary.mockResolvedValue({ motif_id: "received", revision: "c".repeat(64), trusted: false,
      summary: { files: 2, bytes: 4096, binary: 0, scripts: [], workers: [], wasm: [], minified: [], unscanned: [] } });
    await renderPicker({ project: [proj({ id: "lower" }), untrusted("received")], library: [lib({ id: "other", in_project: "received" })] });
    const card = cardOf("received", "This project");
    // The state (modified) stays behind the badge; the library's take still follows it.
    expect(card.querySelector(".motif-card-status")?.textContent).toBe("Not trusted");
    expect(within(card).getByText("Not trusted on this machine")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Update project copy" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Restore from library" })).toBeNull();
    expect(within(cardOf("other", "Library")).getByText("In this project · not trusted")).toBeTruthy();

    fireEvent.click(within(group("This project")).getByTitle("received"));
    const trust = await screen.findByRole("region", { name: "Not trusted on this machine" });
    await waitFor(() => expect(within(trust).getByText("2 files · 4.0 KB")).toBeTruthy());
    expect(ipcMocks.motifTrustSummary).toHaveBeenCalledWith("received");
    expect(within(trust).getByRole("button", { name: "Trust" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to timeline" })).toBeNull();
    expect((ipcMocks.getMotifCover.mock.calls as unknown[][]).some((c) => c[0] === "received")).toBe(false);
    expect(capture.mock.calls.some((c) => c[0] === "received")).toBe(false);
  });

  it("opens on the row a surface outside the panel asked for", async () => {
    ipcMocks.motifTrustSummary.mockResolvedValue({ motif_id: "received", revision: "c".repeat(64), trusted: false,
      summary: { files: 1, bytes: 10, binary: 0, scripts: [], workers: [], wasm: [], minified: [], unscanned: [] } });
    ipcMocks.listMotifCatalog.mockResolvedValue({ project: [proj({ id: "lower" }), untrusted("received")], library: [lib()] });
    openMotifsPanelAt({ group: "project", id: "received" });
    expect(openPicker).toHaveBeenCalledOnce();
    render(<MotifPicker onClose={onClose} onAdded={onAdded} onNewPlaced={vi.fn()} compositionId="comp-focused"
      currentTimeUs={0} tracks={[]} fpsNum={30} fpsDen={1} compWidth={1920} compHeight={1080} />);
    expect(await screen.findByRole("region", { name: "Not trusted on this machine" })).toBeTruthy();
    expect(within(group("This project")).getByTitle("received").getAttribute("aria-pressed")).toBe("true");
  });

  it("places a library Motif as a copy (fromLibrary) and a project Motif as itself; previews capture each from its own scope", async () => {
    await renderPicker({ project: [proj({ id: "lower" })], library: [lib({ id: "badge" })] });
    // The first renderable project row is selected; its preview is the project's.
    await waitFor(() => expect(capture.mock.calls.some((c) => c[0] === "lower" && c[5] === "proj-rev")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Add to timeline" }));
    await waitFor(() => expect(ipcMocks.addMotif).toHaveBeenCalledTimes(1));
    expect(ipcMocks.addMotif.mock.calls[0]![0]).not.toHaveProperty("fromLibrary");
    expect(ipcMocks.addMotif.mock.calls[0]![0]).toMatchObject({ motifId: "lower" });

    fireEvent.click(within(group("Library")).getByTitle("badge"));
    await waitFor(() => expect(capture.mock.calls.some((c) => c[0] === "badge--library")).toBe(true));
    expect(screen.getByText("Adding copies it into this project.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to timeline" }));
    await waitFor(() => expect(ipcMocks.addMotif).toHaveBeenCalledTimes(2));
    expect(ipcMocks.addMotif.mock.calls[1]![0]).toMatchObject({ motifId: "badge", fromLibrary: true });
  });
});

describe("project row actions", () => {
  it("updates a copy the library moved past, and restores a missing one from the library", async () => {
    ipcMocks.updateProjectMotif.mockResolvedValue({ unfinished: null });
    await renderPicker({
      project: [proj({ id: "behind", state: "update_available" }), proj({ id: "gone", status: "missing", state: "in_sync" }),
        proj({ id: "mine", state: "project_only" }), proj({ id: "same" })],
      library: [lib()],
    });
    // The card shows the short label beside its one-line meta; the name is the whole one.
    const update = within(cardOf("behind", "This project")).getByRole("button", { name: "Update project copy" });
    expect(update.textContent).toBe("Update");
    fireEvent.click(update);
    await waitFor(() => expect(ipcMocks.updateProjectMotif).toHaveBeenCalledWith("behind"));
    fireEvent.click(within(cardOf("gone", "This project")).getByRole("button", { name: "Restore from library" }));
    await waitFor(() => expect(ipcMocks.updateProjectMotif).toHaveBeenLastCalledWith("gone"));
    expect(screen.queryByText(/Unfinished files/)).toBeNull();
    // Nothing to take: a Motif the library lacks, or one already the same.
    expect(within(cardOf("mine", "This project")).queryByRole("button", { name: /Update|Restore/ })).toBeNull();
    expect(within(cardOf("same", "This project")).queryByRole("button", { name: /Update|Restore/ })).toBeNull();
  });

  it("says where a broken copy's unfinished files went when the library's version replaces it", async () => {
    ipcMocks.updateProjectMotif.mockResolvedValue({ unfinished: "Backups/motifs/unfinished/torn-2026-01-02T03-04-05-000Z" });
    await renderPicker({ project: [proj({ id: "torn", status: "invalid", diagnostic: "bad" })], library: [lib()] });
    fireEvent.click(within(cardOf("torn", "This project")).getByRole("button", { name: "Restore from library" }));
    expect(await screen.findByText("Unfinished files moved to Backups/motifs/unfinished/torn-2026-01-02T03-04-05-000Z.")).toBeTruthy();
  });

  it("shows the refusal when a Motif still in use is removed from the project, naming it as the panel does", async () => {
    ipcMocks.removeProjectMotif.mockRejectedValue(new Error(
      `Error invoking remote method 'backend:invoke': Error: ${JSON.stringify({ error: "MotifInUse", motif_id: "lower", referenced_by: ["l1", "l2"] })}`));
    setProjectMotifs([{ ...MOTIF, id: "lower", name: "Lower Third" }]);
    await renderPicker({ project: [proj({ id: "lower", name: "Lower Third" })], library: [] });
    fireEvent.click(await menuItem(cardOf("lower", "This project"), "Remove from project"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Motif “Lower Third” is used by 2 clips. Remove those clips first.");
    expect(ipcMocks.removeProjectMotif).toHaveBeenCalledWith("lower");
  });

  it("saves a Motif the library lacks at once, as a new one, at the revision planned", async () => {
    ipcMocks.planSaveToLibrary.mockResolvedValue({ revision: "proj-rev", replaces: null, diff: null });
    await renderPicker({ project: [proj({ id: "mine", state: "project_only" })], library: [] });
    fireEvent.click(await menuItem(cardOf("mine", "This project"), "Save to library"));
    await waitFor(() => expect(ipcMocks.saveToLibrary).toHaveBeenCalledExactlyOnceWith("mine", "proj-rev"));
    expect(screen.queryByRole("dialog", { name: /Replace/ })).toBeNull();
  });

  it("confirms replacing a library Motif on a card with the change, saying no project changes; Save as a new Motif beside it", async () => {
    ipcMocks.planSaveToLibrary.mockResolvedValue({
      revision: "proj-rev", replaces: { id: "badge", version: 3 },
      diff: { files: { added: [], removed: [], changed: ["index.html"] }, props: { added: ["tagline"], removed: [], changed: [] } },
    });
    ipcMocks.saveToLibrary.mockResolvedValue("badge");
    await renderPicker({ project: [proj({ id: "badge", state: "modified" })], library: [lib({ id: "badge", name: "Badge" })] });
    // Nothing to save on a row that matches the library.
    fireEvent.contextMenu(cardOf("badge", "This project"), { clientX: 30, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save to library" }));
    const confirm = await screen.findByRole("dialog", { name: "Replace “Badge” in the library?" });
    expect(ipcMocks.saveToLibrary).not.toHaveBeenCalled();
    expect(within(confirm).getByText(/becomes version 4 of “Badge”\. Projects that use it keep their own copies/)).toBeTruthy();
    expect(within(confirm).getByText(/Files — added: none · removed: none · changed: index\.html/)).toBeTruthy();
    expect(within(confirm).getByText(/Props — added: tagline/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(ipcMocks.saveToLibrary).toHaveBeenCalledExactlyOnceWith("badge", "proj-rev", { id: "badge", version: 3 }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Replace “Badge” in the library?" })).toBeNull());

    fireEvent.contextMenu(cardOf("badge", "This project"), { clientX: 30, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save to library" }));
    const again = await screen.findByRole("dialog", { name: "Replace “Badge” in the library?" });
    fireEvent.click(within(again).getByRole("button", { name: "Save as a new Motif" }));
    await waitFor(() => expect(ipcMocks.saveToLibrary).toHaveBeenLastCalledWith("badge", "proj-rev", undefined));
  });

  it("offers Save to library only where there is something to save", async () => {
    await renderPicker({ project: [proj({ id: "same" }), proj({ id: "behind", state: "update_available" })], library: [lib()] });
    for (const id of ["same", "behind"]) {
      await menuItem(cardOf(id, "This project"), "Remove from project");
      expect(screen.queryByRole("menuitem", { name: "Save to library" })).toBeNull();
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Remove from project" }), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Remove from project" })).toBeNull());
    }
  });
});

describe("library package actions", () => {
  it("exports the card acted on, from its scope, including through its context menu, without changing selection", async () => {
    await renderPicker({ project: [], library: [lib(), lib({ id: "other", name: "Other" })] });
    const card = cardOf("other", "Library");
    vi.mocked(save).mockResolvedValue("/shared/other.zip");
    fireEvent.click(within(card).getByRole("button", { name: "Export Motif ZIP" }));
    await waitFor(() => expect(ipcMocks.exportMotif).toHaveBeenCalledWith("other", "/shared/other.zip", "library"));
    expect(within(group("Library")).getByTitle("badge").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(await menuItem(card, "Export Motif ZIP"));
    await waitFor(() => expect(ipcMocks.exportMotif).toHaveBeenCalledTimes(2));
    expect(ipcMocks.exportMotif).toHaveBeenLastCalledWith("other", "/shared/other.zip", "library");
  });

  it("exports a project Motif from the project", async () => {
    await renderPicker({ project: [proj({ id: "lower" })], library: [] });
    vi.mocked(save).mockResolvedValueOnce("/shared/lower.zip");
    fireEvent.click(within(cardOf("lower", "This project")).getByRole("button", { name: "Export Motif ZIP" }));
    await waitFor(() => expect(ipcMocks.exportMotif).toHaveBeenCalledWith("lower", "/shared/lower.zip", undefined));
  });

  it("hides delete and version history for built-ins while retaining export and keyboard menu access", async () => {
    await renderPicker({ project: [], library: [lib({ status: "builtin" })] });
    fireEvent.keyDown(within(group("Library")).getByTitle("badge"), { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menuitem", { name: "Export Motif ZIP" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete Motif" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Version history" })).toBeNull();
  });

  it("lists an installed Motif's versions with the newest as current, and restores an older one", async () => {
    const at = (version: number) => ({ version, revision: `r${version}`, saved_at: new Date(2026, 0, version).toISOString() });
    ipcMocks.listMotifVersions.mockResolvedValueOnce([at(2), at(1)]).mockResolvedValueOnce([at(3), at(2), at(1)]);
    ipcMocks.restoreMotifVersion.mockResolvedValue(undefined);
    await renderPicker();
    fireEvent.click(await menuItem(cardOf("badge", "Library"), "Version history"));
    const dialog = await screen.findByRole("dialog", { name: "Versions of “Badge”" });
    expect(ipcMocks.listMotifVersions).toHaveBeenCalledWith("badge");
    const rows = () => within(dialog).getAllByRole("listitem");
    await waitFor(() => expect(rows()).toHaveLength(2));
    // The current version offers no restore; only the older one does.
    expect(within(rows()[0]!).getByText("Current")).toBeTruthy();
    expect(within(rows()[0]!).queryByRole("button")).toBeNull();
    fireEvent.click(within(rows()[1]!).getByRole("button", { name: "Restore version 1" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(ipcMocks.restoreMotifVersion).toHaveBeenCalledExactlyOnceWith("badge", 1);
    expect(within(rows()[0]!).getByText("Version 3")).toBeTruthy();
  });

  it("keeps the card menu open on a stationary scroll so Escape dismisses only the menu", async () => {
    const user = userEvent.setup();
    await renderPicker({ project: [], library: [lib({ status: "builtin" })] });
    await menuItem(cardOf("badge", "Library"), "Export Motif ZIP");
    // Chromium can emit a scroll when popup focus scrolls into view without
    // moving the card. Reproduce it before the user's Escape.
    fireEvent.scroll(document.querySelector(".motif-picker-list")!);
    expect(screen.getByRole("menuitem", { name: "Export Motif ZIP" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Export Motif ZIP" })).toBeNull());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the card menu when scrolling actually moves its card", async () => {
    await renderPicker();
    const card = cardOf("badge", "Library");
    let top = 40;
    vi.spyOn(card, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, top, 240, 80));
    fireEvent.contextMenu(card, { clientX: 30, clientY: 50 });
    await screen.findByRole("menuitem", { name: "Export Motif ZIP" });
    top -= 24;
    fireEvent.scroll(document.querySelector(".motif-picker-list")!);
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Export Motif ZIP" })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("confirms moving a library Motif to the trash, reports failures, then refreshes and selects a remaining item", async () => {
    const remaining = lib({ id: "other", name: "Other", status: "builtin" });
    await renderPicker({ project: [], library: [lib(), remaining] });
    fireEvent.click(await menuItem(cardOf("badge", "Library"), "Delete Motif"));
    const confirm = await screen.findByRole("dialog", { name: "Delete Motif" });
    expect(within(confirm).getByText(/Projects keep their own copies/)).toBeTruthy();
    expect(ipcMocks.deleteLibraryMotif).not.toHaveBeenCalled();
    ipcMocks.deleteLibraryMotif.mockRejectedValueOnce(new Error("File in use")).mockResolvedValueOnce(undefined);
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete Motif" }));
    expect(await screen.findByText("Error: File in use")).toBeTruthy();
    ipcMocks.listMotifCatalog.mockResolvedValue({ project: [], library: [remaining] });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete Motif" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete Motif" })).toBeNull());
    expect(ipcMocks.deleteLibraryMotif).toHaveBeenLastCalledWith("badge");
    expect(within(group("Library")).queryByTitle("badge")).toBeNull();
    expect(within(group("Library")).getByTitle("other").getAttribute("aria-pressed")).toBe("true");
  });

  it("imports a ZIP into the project, accepting only ZIP and respecting cancellation", async () => {
    await renderPicker();
    ipcMocks.importMotif.mockResolvedValue("scene");
    vi.mocked(open).mockResolvedValueOnce(null).mockResolvedValueOnce("/shared/scene.zip");
    const button = screen.getByRole("button", { name: "Import Motif" });
    fireEvent.click(button);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(ipcMocks.importMotif).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(ipcMocks.importMotif).toHaveBeenCalledWith("/shared/scene.zip"));
    expect(open).toHaveBeenLastCalledWith({ multiple: false, filters: [{ name: "Motif ZIP", extensions: ["zip"] }] });
  });

  it("shows export failures in the picker", async () => {
    await renderPicker();
    vi.mocked(save).mockResolvedValueOnce("/shared/badge.zip");
    ipcMocks.exportMotif.mockRejectedValueOnce(new Error("Disk full"));
    fireEvent.click(within(cardOf("badge", "Library")).getByRole("button", { name: "Export Motif ZIP" }));
    await waitFor(() => expect(screen.getByText("Error: Disk full")).toBeTruthy());
  });
});

function colorSwatch(pattern: RegExp): HTMLInputElement {
  const el = screen.getByLabelText(pattern) as HTMLInputElement;
  expect(el.type).toBe("color");
  return el;
}

/// The `<code>` readout beside a color swatch — the only place the buffered
/// (possibly alpha-bearing) value is visible.
function colorReadout(swatch: HTMLInputElement): string {
  const code = swatch.closest(".motif-picker-field")?.querySelector("code");
  expect(code).toBeTruthy();
  return code!.textContent ?? "";
}

describe("MotifPicker prop form", () => {
  it("buffers edits locally and submits the whole props object in one add", async () => {
    const user = userEvent.setup();
    await renderPicker();

    const title = screen.getByLabelText(/^title$/i);
    await user.clear(title);
    await user.type(title, "Live");
    // speed spans 0..4 → the shared ≤10-wide heuristic steps by 0.1.
    const speed = screen.getByLabelText(/^speed$/i) as HTMLInputElement;
    await user.click(speed);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(speed.value).toBe("1.1"));

    // Buffered: nothing has left the form yet.
    expect(ipcMocks.addMotif).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Add to timeline" }));
    await vi.waitFor(() => expect(ipcMocks.addMotif).toHaveBeenCalledTimes(1));
    // Whole-object semantics: every schema key rides along, edited or not —
    // including the untouched translucent default with its alpha intact.
    expect(ipcMocks.addMotif).toHaveBeenCalledWith({
      // The composition the picker was opened against — the auto-track path
      // has no track id to route by, so the add has to be told.
      compositionId: "comp-focused",
      motifId: "badge",
      // A library Motif: the placement copies it into the project.
      fromLibrary: true,
      tStartUs: 1_000_000,
      trackId: undefined,
      props: {
        title: "Live",
        accent: "#000000cc",
        ring: "#ff4d4d",
        speed: 1.1,
        effect: "karaoke",
      },
    });
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the full alpha-bearing value in the code readout while the swatch holds RGB only", async () => {
    await renderPicker();
    const accent = colorSwatch(/^accent$/i);
    expect(accent.value).toBe("#000000");
    expect(colorReadout(accent)).toBe("#000000cc");
  });

  it("drops the alpha once the user picks a color, and submits the pick", async () => {
    const user = userEvent.setup();
    await renderPicker();
    const accent = colorSwatch(/^accent$/i);
    fireEvent.change(accent, { target: { value: "#123456" } });
    expect(colorReadout(accent)).toBe("#123456");
    expect(ipcMocks.addMotif).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Add to timeline" }));
    await vi.waitFor(() => expect(ipcMocks.addMotif).toHaveBeenCalledTimes(1));
    const args = ipcMocks.addMotif.mock.calls[0]![0] as { props: Record<string, unknown> };
    expect(args.props["accent"]).toBe("#123456");
    // The other color stayed untouched at its default.
    expect(args.props["ring"]).toBe("#ff4d4d");
  });
});
