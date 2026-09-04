// @vitest-environment jsdom
//
// Covers the Settings "Agent" tab (AgentSection): a generic setup prompt for
// agent self-configuration plus one copyable config snippet per agent client
// (Codex TOML / Claude / Cursor JSON, and raw connection facts under Generic —
// MCP fixes the protocol, never the config file). Codex and Claude also get a
// `mcp add` one-liner beside the snippet. With the stdio shim installed
// (shim_path set) the stdio config is the primary snippet — no token in it —
// and HTTP-direct moves behind an "advanced" disclosure; without it (dev
// before build:cli) the HTTP snippet renders as primary, token masked until
// revealed, copy always carrying the real token. The shipped agent skill gets
// its own block, present only once a skill folder is staged (skills_dir set).
// Token rotation sits above both layouts: it never puts the secret on screen,
// so unlike Reveal and Copy it has no reason to hide behind the disclosure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ipc = vi.hoisted(() => ({
  getMcpInfo: vi.fn(),
  resetMcpToken: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});

import i18n from "../i18n";
import { AgentSection } from "./AgentSection";

/// shim_path absent → the pre-shim, HTTP-primary layout (dev fallback).
const INFO = {
  url: "http://127.0.0.1:4711/mcp",
  bearer_token: "secret-token",
  skills_dir: null,
};

const INFO_SHIM = {
  ...INFO,
  exe_path: "C:\\Program Files\\WeftCut\\WeftCut.exe",
  appimage: null,
  user_data: "C:\\ud",
  shim_path: "C:\\ud\\cli\\weftcut-mcp.cjs",
  skills_dir: "C:\\ud\\skills",
};

const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }));

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  ipc.getMcpInfo.mockReset().mockResolvedValue(INFO);
  ipc.resetMcpToken.mockReset();
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
});

/** Rendered snippet text (the first <pre> in the panel). */
async function snippetText(): Promise<string> {
  const pre = await screen.findByRole("tabpanel");
  return pre.querySelector("pre")?.textContent ?? "";
}

/** The CLI one-liner box (the second <pre>), null on tabs that have no CLI. */
async function cliText(): Promise<string | null> {
  const panel = await screen.findByRole("tabpanel");
  return panel.querySelectorAll("pre")[1]?.textContent ?? null;
}

describe("AgentSection", () => {
  it("shows the Codex TOML snippet first, with the token masked", async () => {
    render(<AgentSection />);
    const text = await snippetText();
    expect(text).toContain('[mcp_servers.weftcut]');
    expect(text).toContain(`url = "${INFO.url}"`);
    expect(text).toContain("Bearer •••");
    expect(text).not.toContain(INFO.bearer_token);
  });

  it("copies the real token even while masked", async () => {
    render(<AgentSection />);
    const copy = await screen.findByRole("button", { name: "Copy config" });
    await userEvent.click(copy);
    expect(clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(INFO.bearer_token),
    );
  });

  it("copies a generic English setup prompt with the connection details", async () => {
    render(<AgentSection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Copy setup prompt" }),
    );

    expect(clipboard.writeText).toHaveBeenCalledWith(
      expect.stringMatching(
        /Configure the WeftCut MCP server for me[\s\S]*URL: http:\/\/127\.0\.0\.1:4711\/mcp[\s\S]*Bearer secret-token[\s\S]*preserve all other settings/,
      ),
    );
  });

  it("copies the setup prompt in the displayed language", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<AgentSection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "复制配置提示词" }),
    );

    expect(clipboard.writeText).toHaveBeenCalledWith(
      expect.stringMatching(
        /请为我配置 WeftCut MCP 服务[\s\S]*Bearer secret-token[\s\S]*保留所有其他设置和 MCP 服务/,
      ),
    );
  });

  it("switches snippet format per client tab", async () => {
    render(<AgentSection />);
    await snippetText();

    await userEvent.click(screen.getByRole("tab", { name: "Claude" }));
    const claude = JSON.parse((await snippetText()).trim());
    expect(claude.mcpServers.weftcut.type).toBe("http");
    expect(claude.mcpServers.weftcut.url).toBe(INFO.url);

    await userEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    const cursor = JSON.parse((await snippetText()).trim());
    expect(cursor.mcpServers.weftcut.url).toBe(INFO.url);
    expect(cursor.mcpServers.weftcut.type).toBeUndefined();

    await userEvent.click(screen.getByRole("tab", { name: "Generic" }));
    const generic = await snippetText();
    expect(generic).not.toContain("mcpServers");
    expect(generic).toMatch(/^transport:\s+streamable HTTP$/m);
    expect(generic).toMatch(/^url:\s+/m);
    expect(generic).toContain(INFO.url);
    expect(generic).toMatch(/^header:\s+Authorization: Bearer /m);
  });

  it("offers no CLI one-liner where the client has none", async () => {
    render(<AgentSection />);
    await snippetText();
    // Claude Code can set a literal header; Codex's `mcp add --url` cannot,
    // and Cursor/Generic have no MCP CLI at all.
    expect(await cliText()).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    expect(await cliText()).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Generic" }));
    expect(await cliText()).toBeNull();
  });

  it("gives Claude an HTTP `mcp add` one-liner, token masked until revealed", async () => {
    render(<AgentSection />);
    await snippetText();
    await userEvent.click(screen.getByRole("tab", { name: "Claude" }));
    expect(await cliText()).toBe(
      `claude mcp add -s user -t http weftcut ${INFO.url} ` +
        '-H "Authorization: Bearer ••••••••••••••••"',
    );

    await userEvent.click(screen.getByRole("button", { name: "Reveal token" }));
    expect(await cliText()).toContain(
      `-H "Authorization: Bearer ${INFO.bearer_token}"`,
    );
  });

  it("reveals the token in the snippet on demand", async () => {
    render(<AgentSection />);
    const reveal = await screen.findByRole("button", { name: "Reveal token" });
    await userEvent.click(reveal);
    expect(await snippetText()).toContain(INFO.bearer_token);
  });

  it("hides the skill block while no skill folder is staged", async () => {
    render(<AgentSection />);
    await snippetText();
    expect(
      screen.queryByRole("heading", { name: "Teach your agent WeftCut" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy Skill prompt" }),
    ).toBeNull();
  });
});

describe("AgentSection with the stdio shim installed", () => {
  beforeEach(() => {
    ipc.getMcpInfo.mockReset().mockResolvedValue(INFO_SHIM);
  });

  it("renders the stdio config as the primary snippet, with no token in it", async () => {
    render(<AgentSection />);
    const text = await snippetText();
    expect(text).toContain("[mcp_servers.weftcut]");
    expect(text).toContain("ELECTRON_RUN_AS_NODE");
    expect(text).toContain("weftcut-mcp.cjs");
    expect(text).not.toContain(INFO.url);
    expect(text).not.toContain(INFO.bearer_token);
  });

  it("stdio JSON snippet carries command/args/env and the discovery override", async () => {
    render(<AgentSection />);
    await snippetText();
    await userEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    const cursor = JSON.parse((await snippetText()).trim());
    expect(cursor.mcpServers.weftcut).toEqual({
      command: INFO_SHIM.exe_path,
      args: [INFO_SHIM.shim_path],
      env: { ELECTRON_RUN_AS_NODE: "1", WEFTCUT_USERDATA: INFO_SHIM.user_data },
    });
  });

  it("the Generic tab shows the launch triple with no config wrapper", async () => {
    render(<AgentSection />);
    await snippetText();
    await userEvent.click(screen.getByRole("tab", { name: "Generic" }));
    const text = await snippetText();
    expect(text).not.toContain("mcpServers");
    expect(text).toMatch(/^transport:\s+stdio$/m);
    expect(text).toContain(INFO_SHIM.exe_path);
    expect(text).toContain(INFO_SHIM.shim_path);
    expect(text).toMatch(/^env:\s+ELECTRON_RUN_AS_NODE=1$/m);
    expect(text).toMatch(/^env:\s+WEFTCUT_USERDATA=C:\\ud$/m);
  });

  it("gives Codex and Claude an `mcp add` one-liner with the paths quoted", async () => {
    render(<AgentSection />);
    // shq quotes on whitespace *or* a backslash: unquoted, a POSIX shell would
    // eat the Windows separators (C:\ud → C:ud) in Git Bash.
    const launch = `"${INFO_SHIM.exe_path}" "${INFO_SHIM.shim_path}"`;
    const userData = `"WEFTCUT_USERDATA=${INFO_SHIM.user_data}"`;

    expect(await cliText()).toBe(
      `codex mcp add weftcut --env ELECTRON_RUN_AS_NODE=1 --env ${userData} -- ${launch}`,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Claude" }));
    expect(await cliText()).toBe(
      `claude mcp add weftcut -s user -e ELECTRON_RUN_AS_NODE=1 -e ${userData} -- ${launch}`,
    );
  });

  it("copies the one-liner from its own button, not the snippet's", async () => {
    render(<AgentSection />);
    const cli = await cliText();
    await userEvent.click(
      screen.getByRole("button", { name: "Copy command" }),
    );
    expect(clipboard.writeText).toHaveBeenCalledWith(cli);
  });

  it("the setup prompt describes the stdio transport and leaks no token", async () => {
    render(<AgentSection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Copy setup prompt" }),
    );
    const prompt = clipboard.writeText.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Transport: stdio");
    expect(prompt).toContain(INFO_SHIM.exe_path);
    expect(prompt).toContain(`WEFTCUT_USERDATA=${INFO_SHIM.user_data}`);
    expect(prompt).not.toContain(INFO.bearer_token);
  });

  it("offers the staged skill folder as a paste-ready install prompt", async () => {
    render(<AgentSection />);
    expect(
      await screen.findByRole("heading", { name: "Teach your agent WeftCut" }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Copy Skill prompt" }),
    );
    const prompt = clipboard.writeText.mock.calls[0]?.[0] as string;
    expect(prompt).toContain(`"${INFO_SHIM.skills_dir}\\weftcut"`);
    expect(prompt).toContain("~/.claude/skills/weftcut");
  });

  it("HTTP direct moves behind the advanced disclosure, token still masked", async () => {
    render(<AgentSection />);
    await snippetText();
    expect(screen.queryByRole("button", { name: "Reveal token" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /HTTP direct/ }),
    );
    const panels = screen.getAllByRole("tabpanel");
    const http = panels[panels.length - 1]?.querySelector("pre")?.textContent ?? "";
    expect(http).toContain(`url = "${INFO.url}"`);
    expect(http).toContain("Bearer •••");
    expect(http).not.toContain(INFO.bearer_token);
    expect(screen.getByRole("button", { name: "Reveal token" })).toBeTruthy();
  });

  it("keeps Refresh token reachable while HTTP direct stays collapsed", async () => {
    ipc.resetMcpToken.mockResolvedValue("rotated-token");
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      render(<AgentSection />);
      // The pairing IS the assertion: with the shim installed — the recommended
      // path — Reveal is correctly out of reach, and rotation must not be, or a
      // user whose token leaked has to find an "advanced" disclosure to
      // invalidate it.
      const refresh = await screen.findByRole("button", {
        name: "Refresh token",
      });
      expect(screen.queryByRole("button", { name: "Reveal token" })).toBeNull();

      await userEvent.click(refresh);
      expect(ipc.resetMcpToken).toHaveBeenCalledTimes(1);
    } finally {
      confirmed.mockRestore();
    }
  });
});
