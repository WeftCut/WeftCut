// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real i18n (same side-effect import AppMenuBar pulls in): the assertions
// below run against the en-US strings, so a missing help.* key fails here.
import "../i18n";
import { HelpMenu } from "./HelpMenu";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { APP_SETTINGS_DEFAULTS } from "../../shared/app-settings";
import {
  ISSUES_URL,
  LICENSE_URL,
  RELEASES_URL,
  REPO_URL,
  THIRD_PARTY_NOTICES_URL,
} from "./links";

const VERSIONS = {
  app: "1.2.3",
  electron: "39.0.0",
  chrome: "142.0.0",
  platform: "linux",
  arch: "x64",
};

function stubApi() {
  const open = vi.fn().mockResolvedValue(undefined);
  const versions = vi.fn().mockResolvedValue(VERSIONS);
  const check = vi.fn().mockResolvedValue({ phase: "current" });
  (window as unknown as { api: unknown }).api = {
    shell: { open },
    app: { versions },
    diagnostics: {
      summary: vi.fn().mockResolvedValue({ available: true, environment: 'WeftCut 1.2.3 | linux x64', previousSession: null }),
    },
    updates: { check, status: vi.fn().mockResolvedValue({ phase: "current" }) },
  };
  return { open, versions, check };
}

afterEach(() => {
  cleanup();
  useAppSettingsStore.setState({ settings: APP_SETTINGS_DEFAULTS });
});

describe("HelpMenu", () => {
  it("checks updates inside the app and offers the release page", async () => {
    const { open, check } = stubApi();
    render(<HelpMenu />);

    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("Check for Updates…"));
    expect(check).toHaveBeenCalledOnce();
    expect(await screen.findByText("You are up to date.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Check for Updates" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View Releases" }));
    expect(open).toHaveBeenCalledWith(RELEASES_URL);
  });

  it("shows a progress bar while an update downloads", async () => {
    stubApi();
    const downloading = { phase: "downloading", version: "1.2.4", percent: 42 };
    const api = (window as unknown as { api: { updates: Record<string, unknown> } }).api;
    api.updates.check = vi.fn().mockResolvedValue(downloading);
    api.updates.status = vi.fn().mockResolvedValue(downloading);
    render(<HelpMenu />);

    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("Check for Updates…"));
    expect(await screen.findByText("Downloading 1.2.4… 42%")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
  });

  it("prepares a GitHub draft only after the user opens the report dialog and chooses GitHub", async () => {
    const { open } = stubApi();
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("Report an Issue…"));
    expect(open).not.toHaveBeenCalled();
    const button = await screen.findByRole('button', { name: 'Open GitHub Issue' });
    expect(screen.getByRole("dialog", { name: "Report an Issue" })).toBeTruthy();
    await screen.findByText('WeftCut 1.2.3 | linux x64');
    fireEvent.click(button);
    expect(open).toHaveBeenCalledOnce();
    const url = new URL(open.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe(`${ISSUES_URL}/new`);
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('version')).toContain('WeftCut 1.2.3');
  });

  it("shows the main-process version identity in the About dialog", async () => {
    const { versions } = stubApi();
    render(<HelpMenu />);

    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("About WeftCut"));

    expect(versions).toHaveBeenCalledOnce();
    expect(await screen.findByText("Version 1.2.3")).toBeTruthy();
  });

  it("links the license lines in the About dialog to the repo files", async () => {
    const { open } = stubApi();
    render(<HelpMenu />);

    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("About WeftCut"));

    fireEvent.click(await screen.findByRole("button", { name: "MIT" }));
    expect(open).toHaveBeenCalledWith(LICENSE_URL);

    fireEvent.click(
      screen.getByRole("button", { name: "THIRD-PARTY-NOTICES.md" }),
    );
    expect(open).toHaveBeenCalledWith(THIRD_PARTY_NOTICES_URL);

    fireEvent.click(screen.getByRole("button", { name: "Project Page" }));
    expect(open).toHaveBeenCalledWith(REPO_URL);
  });

  describe("an offered update", () => {
    const offer = (status: { phase: string; version?: string }) => {
      stubApi();
      const read = vi.fn().mockResolvedValue(status);
      (window as unknown as { api: { updates: Record<string, unknown> } }).api.updates.status = read;
      return read;
    };
    /** Past the first status read and the render it causes. */
    const statusSeen = async (read: ReturnType<typeof vi.fn>) => {
      await waitFor(() => expect(read).toHaveBeenCalled());
      await act(async () => {});
    };
    const helpLabel = () => screen.getByRole("button", { name: /Help/ }).querySelector(".menu-trigger-label")!;

    it("marks the menu and its Check for Updates row", async () => {
      offer({ phase: "available", version: "1.2.4" });
      render(<HelpMenu />);
      await waitFor(() => expect(helpLabel().classList).toContain("is-marked"));
      // The dot is visual; assistive technology hears the same news.
      const help = screen.getByRole("button", { name: "Help, A new version is available" });
      fireEvent.click(help);
      const label = await screen.findByText("Check for Updates…");
      expect(label.classList).toContain("is-marked");
      expect(screen.getByRole("menuitem", { name: "Check for Updates…, A new version is available" })).toBeTruthy();
    });

    it("leaves the menu unmarked with nothing offered", async () => {
      const read = offer({ phase: "current" });
      render(<HelpMenu />);
      await statusSeen(read);
      expect(helpLabel().classList).not.toContain("is-marked");
    });

    it("leaves the menu unmarked for a skipped version, whose row stays one click away", async () => {
      useAppSettingsStore.setState((s) => ({ settings: { ...s.settings, skipped_update_version: "1.2.4" } }));
      const read = offer({ phase: "available", version: "1.2.4" });
      render(<HelpMenu />);
      await statusSeen(read);
      expect(helpLabel().classList).not.toContain("is-marked");
      fireEvent.click(screen.getByRole("button", { name: /Help/ }));
      expect((await screen.findByText("Check for Updates…")).classList).not.toContain("is-marked");
    });
  });
});
