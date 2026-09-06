// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real i18n (same side-effect import AppMenuBar pulls in): the assertions
// below run against the en-US strings, so a missing help.* key fails here.
import "../i18n";
import { HelpMenu } from "./HelpMenu";
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
    updates: { check, status: vi.fn().mockResolvedValue({ phase: "current" }) },
  };
  return { open, versions, check };
}

afterEach(cleanup);

describe("HelpMenu", () => {
  it("checks updates inside the app and offers the release page", async () => {
    const { open, check } = stubApi();
    render(<HelpMenu />);

    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("Check for Updates…"));
    expect(check).toHaveBeenCalledOnce();
    expect(await screen.findByText("You are up to date.")).toBeTruthy();
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

  it("sends the issue reporter to the repo's page", async () => {
    const { open } = stubApi();
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("Report an Issue…"));
    expect(open).toHaveBeenCalledWith(ISSUES_URL);
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
});
