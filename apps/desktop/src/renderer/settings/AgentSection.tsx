import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  RotateCcwIcon,
} from "lucide-react";
import { getMcpInfo, resetMcpToken, type McpInfoView } from "../ipc";
import { Button } from "@/components/ui/button";

const REFRESH_INTERVAL_MS = 1000;
const MASKED_TOKEN = "••••••••••••••••";

/// Agent clients with a known MCP config format, in sidebar order. Each gets
/// its own snippet tab. `generic` is not a fourth format: MCP standardises the
/// protocol, never the config file, so the tab for "some other client" shows
/// the raw connection facts and leaves the wrapper to that client's docs.
type ClientId = "codex" | "claude" | "cursor" | "generic";
const CLIENTS: readonly ClientId[] = ["codex", "claude", "cursor", "generic"];

/// The stdio launch triple for the shim. `command` is the WeftCut binary
/// acting as the Node runtime (ELECTRON_RUN_AS_NODE) — or the .AppImage file
/// on Linux, where the mounted binary path dies with the session.
interface StdioCfg {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function stdioCfgFrom(info: McpInfoView): StdioCfg | null {
  if (!info.shim_path) return null;
  return {
    command: info.appimage ?? info.exe_path,
    args: [info.shim_path],
    env: { ELECTRON_RUN_AS_NODE: "1", WEFTCUT_USERDATA: info.user_data },
  };
}

/// Render `key: value` rows with the values column-aligned — what the
/// `generic` tab shows in place of a config snippet. One row per arg and per
/// env entry, so a value containing a space stays unambiguous.
function factsBlock(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([k]) => k.length)) + 2;
  return rows.map(([k, v]) => `${k}:`.padEnd(width) + v).join("\n");
}

/// Shell-quote one CLI argument. Whitespace forces quoting, and so does a
/// backslash: a bare Windows path survives PowerShell but a POSIX shell eats
/// the separators (`C:\ud` → `C:ud`), and Windows users do run these in Git
/// Bash. Nothing needs escaping *inside* the quotes — these values are
/// filesystem paths, a URL, and `KEY=value` pairs, none of which can carry a
/// double quote, and a double-quoted backslash is literal in both shells.
function shq(s: string): string {
  return /[\s\\]/.test(s) ? `"${s}"` : s;
}

/// Ready-to-paste stdio config for one client. JSON.stringify doubles as the
/// TOML basic-string encoder — TOML's escape set is a superset of JSON's, so
/// Windows backslash paths survive both formats.
function buildStdioSnippet(client: ClientId, cfg: StdioCfg): string {
  if (client === "generic") {
    return factsBlock([
      ["transport", "stdio"],
      ["command", cfg.command],
      ...cfg.args.map((a) => ["arg", a] as const),
      ...Object.entries(cfg.env).map(([k, v]) => ["env", `${k}=${v}`] as const),
    ]);
  }
  if (client === "codex") {
    const env = Object.entries(cfg.env)
      .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
      .join(", ");
    return [
      "[mcp_servers.weftcut]",
      `command = ${JSON.stringify(cfg.command)}`,
      `args = [${cfg.args.map((a) => JSON.stringify(a)).join(", ")}]`,
      `env = { ${env} }`,
    ].join("\n");
  }
  const server = client === "claude" ? { type: "stdio", ...cfg } : cfg;
  return JSON.stringify({ mcpServers: { weftcut: server } }, null, 2);
}

/// Ready-to-paste HTTP-direct config for one client (the advanced path).
/// Formats follow each client's official docs:
/// - codex:   `~/.codex/config.toml`, `[mcp_servers.<name>]` table; HTTP
///   servers declare `url` + static `http_headers` (no inline bearer field).
/// - claude:  `.mcp.json` / `~/.claude.json`; a `url` entry is an error
///   without `"type": "http"`.
/// - cursor:  `~/.cursor/mcp.json`; `url` + `headers`, no `type` field.
/// - generic: the endpoint and header alone, no wrapper.
function buildHttpSnippet(client: ClientId, url: string, token: string): string {
  if (client === "generic") {
    return factsBlock([
      ["transport", "streamable HTTP"],
      ["url", url],
      ["header", `Authorization: Bearer ${token}`],
    ]);
  }
  if (client === "codex") {
    return [
      "[mcp_servers.weftcut]",
      `url = "${url}"`,
      `http_headers = { "Authorization" = "Bearer ${token}" }`,
    ].join("\n");
  }
  const server =
    client === "claude"
      ? { type: "http", url, headers: { Authorization: `Bearer ${token}` } }
      : { url, headers: { Authorization: `Bearer ${token}` } };
  return JSON.stringify({ mcpServers: { weftcut: server } }, null, 2);
}

/// Terminal one-liner that makes the client write its own config entry —
/// offered alongside the snippet because it finds the config file itself and
/// merges rather than replaces. `null` where no such command exists: Cursor
/// ships no MCP CLI, and `generic` has none by definition. Flags verified
/// against `codex mcp add --help` (0.152.0) and `claude mcp add --help`.
function buildStdioCli(client: ClientId, cfg: StdioCfg): string | null {
  const launch = [cfg.command, ...cfg.args].map(shq).join(" ");
  const env = Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`);
  if (client === "codex") {
    const flags = env.map((e) => `--env ${shq(e)}`).join(" ");
    return `codex mcp add weftcut ${flags} -- ${launch}`;
  }
  if (client === "claude") {
    const flags = env.map((e) => `-e ${shq(e)}`).join(" ");
    return `claude mcp add weftcut -s user ${flags} -- ${launch}`;
  }
  return null;
}

/// HTTP-direct one-liner. Claude Code alone can express the whole entry:
/// `codex mcp add --url` takes only `--bearer-token-env-var` (the *name* of an
/// env var to read), never a literal header, so Codex's HTTP entry stays
/// file-only and falls back to the snippet above it.
function buildHttpCli(
  client: ClientId,
  url: string,
  token: string,
): string | null {
  if (client !== "claude") return null;
  const header = shq(`Authorization: Bearer ${token}`);
  return `claude mcp add -s user -t http weftcut ${shq(url)} -H ${header}`;
}

/// Instruction that installs the shipped agent skill, addressed to the agent
/// rather than to the user — hence untranslated. The separator is inferred from
/// the parent path instead of normalised: the renderer has no `path`, and the
/// folder is shown to the user verbatim as the main process reported it.
function buildSkillPrompt(skillsDir: string): string {
  const sep = skillsDir.includes("\\") ? "\\" : "/";
  return (
    `Install the WeftCut skill: copy the folder "${skillsDir}${sep}weftcut" ` +
    `into your agent's skills directory (for Claude Code: ~/.claude/skills/weftcut), ` +
    `overwriting any previous copy. Re-copy after WeftCut updates.`
  );
}

/// MCP connection info for external agents. Two connection paths: the stdio
/// shim (primary — survives app restarts, port changes, token rotations, and
/// the app being closed) and HTTP-direct (advanced — for clients without
/// stdio support). Until the shim is installed (dev before build:cli,
/// shim_path = null) the HTTP path renders as primary, which is also the
/// pre-shim layout. Also hands out the shipped agent skill folder, when one is
/// staged. Lives in the Settings "Agent" tab; like the other panes
/// it stays mounted across tab switches, so the poll below runs once.
export function AgentSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpInfoView | null>(null);
  const [client, setClient] = useState<ClientId>("codex");
  const [revealed, setRevealed] = useState(false);
  // Which copy button last fired, for its 1.5s "Copied!" flash. One key beats
  // a boolean per button now that six of them share the behaviour.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [httpOpen, setHttpOpen] = useState(false);

  // Poll until the MCP server is up. Once we have info, stop polling.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const next = await getMcpInfo();
        if (cancelled) return;
        if (next) {
          setInfo(next);
          return;
        }
      } catch {
        // ignore — server might still be starting
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, REFRESH_INTERVAL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  const stdio = useMemo(() => (info ? stdioCfgFrom(info) : null), [info]);

  const stdioSnippet = useMemo(
    () => (stdio ? buildStdioSnippet(client, stdio) : ""),
    [stdio, client],
  );

  const stdioCli = useMemo(
    () => (stdio ? buildStdioCli(client, stdio) : null),
    [stdio, client],
  );

  // Displayed HTTP snippet masks the token unless revealed; the copy below
  // always uses the real one.
  const httpSnippet = useMemo(() => {
    if (!info) return "";
    return buildHttpSnippet(
      client,
      info.url,
      revealed ? info.bearer_token : MASKED_TOKEN,
    );
  }, [info, client, revealed]);

  // Same masking rule as the snippet: the rendered command hides the token,
  // the copy carries the real one.
  const httpCli = useMemo(() => {
    if (!info) return null;
    return buildHttpCli(
      client,
      info.url,
      revealed ? info.bearer_token : MASKED_TOKEN,
    );
  }, [info, client, revealed]);

  /// Write to the clipboard and flash `key`'s button for 1.5s. The clear is
  /// guarded so a later copy's flash isn't cut short by an earlier timer.
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(
        () => setCopiedKey((k) => (k === key ? null : k)),
        1500,
      );
    } catch (e) {
      console.warn("clipboard copy failed:", e);
    }
  };

  const copyStdio = async () => {
    if (!stdio) return;
    await copy("stdio", buildStdioSnippet(client, stdio));
  };

  const copyStdioCli = async () => {
    if (!stdio) return;
    const cli = buildStdioCli(client, stdio);
    if (cli) await copy("stdio-cli", cli);
  };

  const copyHttp = async () => {
    if (!info) return;
    await copy("http", buildHttpSnippet(client, info.url, info.bearer_token));
  };

  const copyHttpCli = async () => {
    if (!info) return;
    const cli = buildHttpCli(client, info.url, info.bearer_token);
    if (cli) await copy("http-cli", cli);
  };

  // The prompt is generic — the agent figures out its own client config
  // format. With the shim installed it carries the stdio triple (no token to
  // leak); without it, the URL + token as before.
  const copyAgentPrompt = async () => {
    if (!info) return;
    const prompt = stdio
      ? t("connect.agent_prompt_stdio", {
          command: stdio.command,
          args: stdio.args.join(" "),
          userData: info.user_data,
        })
      : t("connect.agent_prompt", {
          url: info.url,
          token: info.bearer_token,
        });
    await copy("prompt", prompt);
  };

  const copySkillPrompt = async () => {
    if (!info?.skills_dir) return;
    await copy("skill", buildSkillPrompt(info.skills_dir));
  };

  const refreshToken = async () => {
    if (refreshing) return;
    if (!window.confirm(t("connect.refresh_confirm"))) return;
    setRefreshing(true);
    try {
      const next = await resetMcpToken();
      // Splice the new token into the cached view so every snippet recomputes
      // without waiting on the next getMcpInfo poll (the poll already stopped).
      setInfo((prev) => (prev ? { ...prev, bearer_token: next } : prev));
      // Auto-reveal so the user can immediately copy the new value into their
      // agent config — the refresh just invalidated what they had.
      setRevealed(true);
    } catch (e) {
      console.warn("reset bearer failed:", e);
    } finally {
      setRefreshing(false);
    }
  };

  /// Arrow keys move between client tabs (horizontal tablist).
  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = CLIENTS.indexOf(client);
    let next: ClientId | undefined;
    if (e.key === "ArrowRight") next = CLIENTS[(idx + 1) % CLIENTS.length];
    else if (e.key === "ArrowLeft")
      next = CLIENTS[(idx - 1 + CLIENTS.length) % CLIENTS.length];
    if (next) {
      e.preventDefault();
      setClient(next);
    }
  };

  if (!info) {
    return <p className="settings-status">{t("connect.starting")}</p>;
  }

  /// One tablist per snippet block; both share the `client` selection so
  /// switching tabs in the primary block also switches the advanced one.
  const clientTabs = (section: string) => (
    <div
      className="connect-tabs"
      role="tablist"
      aria-label={t("connect.snippets_heading")}
      onKeyDown={onTabsKeyDown}
    >
      {CLIENTS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`connect-tab-${section}-${id}`}
          aria-selected={client === id}
          aria-controls={`connect-snippet-panel-${section}`}
          tabIndex={client === id ? 0 : -1}
          className={client === id ? "connect-tab is-active" : "connect-tab"}
          onClick={() => setClient(id)}
        >
          {t(`connect.tabs.${id}`)}
        </button>
      ))}
    </div>
  );

  /// Copy-icon button that flashes a tick while `key` is the last thing copied.
  /// `what` names the payload for screen readers when it isn't a config blob.
  const copyButton = (key: string, onClick: () => void, what?: string) => {
    const copied = copiedKey === key;
    const label = copied ? t("connect.copied") : (what ?? t("connect.copy"));
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClick}
        title={label}
        aria-label={label}
      >
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      </Button>
    );
  };

  /// The optional second box under a config snippet: the same entry as a
  /// terminal command, rendered only for clients whose CLI can express it.
  const cliBlock = (cli: string | null, key: string, onCopy: () => void) =>
    cli ? (
      <div className="connect-snippet">
        <div className="connect-snippet-header">
          <span>{t("connect.cli_note")}</span>
          <div className="connect-snippet-actions">
            {copyButton(key, onCopy, t("connect.copy_command"))}
          </div>
        </div>
        <pre>
          <code>{cli}</code>
        </pre>
      </div>
    ) : null;

  const httpActions = () => (
    <div className="connect-snippet-actions">
      {copyButton("http", () => void copyHttp())}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => setRevealed((r) => !r)}
        title={revealed ? t("connect.hide") : t("connect.reveal")}
        aria-label={revealed ? t("connect.hide") : t("connect.reveal")}
      >
        {revealed ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
      </Button>
    </div>
  );

  const httpSnippetBlock = (section: string) => (
    <div
      className="connect-panel"
      role="tabpanel"
      id={`connect-snippet-panel-${section}`}
      aria-labelledby={`connect-tab-${section}-${client}`}
    >
      <div className="connect-snippet">
        <div className="connect-snippet-header">
          <span>{t(`connect.hint.${client}`)}</span>
          {httpActions()}
        </div>
        <pre>
          <code>{httpSnippet}</code>
        </pre>
      </div>
      {cliBlock(httpCli, "http-cli", () => void copyHttpCli())}
    </div>
  );

  return (
    <>
      <p className="settings-blurb">{t("connect.blurb")}</p>
      {/* Rotation is a safety action, so it sits at the top level next to the
          note that tells you when to reach for it. Reveal and Copy stay down
          in the HTTP block on purpose: those two put the secret on screen,
          and this panel is opened on streams. */}
      <div className="connect-token-note">
        <p>{t("connect.token_note")}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refreshToken()}
          disabled={refreshing}
          title={t("connect.refresh_hint")}
        >
          <RotateCcwIcon size={13} />
          {refreshing ? t("connect.refreshing") : t("connect.refresh")}
        </Button>
      </div>

      <section className="settings-section">
        <h3>{t("connect.prompt_heading")}</h3>
        <p className="settings-blurb">{t("connect.prompt_blurb")}</p>
        <div className="settings-key-input-row">
          <Button size="sm" onClick={() => void copyAgentPrompt()}>
            {copiedKey === "prompt" ? (
              <CheckIcon size={13} />
            ) : (
              <CopyIcon size={13} />
            )}
            {copiedKey === "prompt"
              ? t("connect.prompt_copied")
              : t("connect.copy_prompt")}
          </Button>
        </div>
      </section>

      {info.skills_dir && (
        <section className="settings-section">
          <h3>{t("connect.skill_heading")}</h3>
          <p className="settings-blurb">{t("connect.skill_blurb")}</p>
          <div className="settings-key-input-row">
            <Button size="sm" onClick={() => void copySkillPrompt()}>
              {copiedKey === "skill" ? (
                <CheckIcon size={13} />
              ) : (
                <CopyIcon size={13} />
              )}
              {copiedKey === "skill"
                ? t("connect.skill_copied")
                : t("connect.copy_skill_prompt")}
            </Button>
          </div>
        </section>
      )}

      <section className="settings-section">
        <h3>{t("connect.manual_heading")}</h3>
        {stdio ? (
          <>
            <p className="settings-blurb">{t("connect.stdio_note")}</p>
            {clientTabs("stdio")}
            <div
              className="connect-panel"
              role="tabpanel"
              id="connect-snippet-panel-stdio"
              aria-labelledby={`connect-tab-stdio-${client}`}
            >
              <div className="connect-snippet">
                <div className="connect-snippet-header">
                  <span>{t(`connect.hint_stdio.${client}`)}</span>
                  <div className="connect-snippet-actions">
                    {copyButton("stdio", () => void copyStdio())}
                  </div>
                </div>
                <pre>
                  <code>{stdioSnippet}</code>
                </pre>
              </div>
              {cliBlock(stdioCli, "stdio-cli", () => void copyStdioCli())}
            </div>
          </>
        ) : (
          <>
            {clientTabs("http")}
            {httpSnippetBlock("http")}
          </>
        )}
      </section>

      {stdio && (
        <section className="settings-section">
          <h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHttpOpen((o) => !o)}
              aria-expanded={httpOpen}
            >
              {httpOpen ? (
                <ChevronDownIcon size={13} />
              ) : (
                <ChevronRightIcon size={13} />
              )}
              {t("connect.http_heading")}
            </Button>
          </h3>
          {httpOpen && (
            <>
              <p className="settings-blurb">{t("connect.http_note")}</p>
              {clientTabs("http")}
              {httpSnippetBlock("http")}
            </>
          )}
        </section>
      )}
    </>
  );
}
