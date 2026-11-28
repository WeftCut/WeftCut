// The agent hosts WeftCut knows how to connect, as data, and the snippets each
// one takes (ADR 0167). Settings → Agent draws its tabs from this table; the
// host block of docs/mcp.md is rendered from it (main/mcp/agentHosts.test.ts).

/// What a host can show the edit in, beside the chat: a view in its own side
/// panel, a loopback page in its side browser, or nothing. Data only for now:
/// docs/mcp.md prints it, nothing in the app reads it yet.
export type AgentHostSurface = "panel" | "browser" | "none";

/// The shape of a host's MCP config entry.
/// - `codex-toml`: a `[mcp_servers.<name>]` table.
/// - `claude-code-json`: an `mcpServers` map whose entries carry `type`;
///   Claude Code rejects a `url` entry without `"type": "http"`.
/// - `mcp-servers-json`: an `mcpServers` map with no `type`.
/// - `dsh-plugin`: no config entry. The app writes a DeepSeek Harness plugin
///   that carries the entry and the side preview (`main/mcp/dshPluginInstall.ts`,
///   ADR 0183); the user adds its folder to the Harness once.
/// - `claude-extension`: no config entry. The app writes a Claude Desktop
///   extension (`.mcpb`) whose manifest carries the entry
///   (`main/mcp/claudeExtensionInstall.ts`, ADR 0187); the user opens it in
///   Claude Desktop once.
/// - `facts`: the connection facts with no wrapper, for a client this table
///   does not know. MCP standardises the protocol, never the config file.
export type AgentConfigFormat =
  | "codex-toml"
  | "claude-code-json"
  | "mcp-servers-json"
  | "dsh-plugin"
  | "claude-extension"
  | "facts";

/// One file a host reads its MCP entries from. `user` files apply everywhere,
/// `project` files to one project folder.
export interface AgentConfigPlace {
  path: string;
  scope: "user" | "project";
}

export interface AgentHost {
  id: string;
  /// Proper noun, shown untranslated unless the locale has a
  /// `connect.tabs.<id>` entry.
  name: string;
  format: AgentConfigFormat;
  /// Empty for `facts`, whose client's own docs say where its config goes, and
  /// for `dsh-plugin` and `claude-extension`, which write no config file of
  /// the host's.
  places: readonly AgentConfigPlace[];
  /// Whether the host's config can name a Streamable HTTP endpoint with a
  /// literal header.
  http: boolean;
  /// The host's own terminal command that writes the entry (or, for
  /// `dsh-plugin`, adds the plugin), if it has one.
  cli: "codex" | "claude" | "dsh" | null;
  /// What the host's desktop app offers. A terminal session of the same host
  /// shares its config and has no surface.
  surface: AgentHostSurface;
}

/// In the order the panel shows its tabs.
export const AGENT_HOSTS: readonly AgentHost[] = [
  {
    id: "codex",
    // The ChatGPT desktop app, Codex CLI and the IDE extension share this file.
    name: "ChatGPT / Codex",
    format: "codex-toml",
    places: [{ path: "~/.codex/config.toml", scope: "user" }],
    http: true,
    cli: "codex",
    surface: "panel",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    format: "claude-code-json",
    places: [
      { path: "~/.claude.json", scope: "user" },
      { path: ".mcp.json", scope: "project" },
    ],
    http: true,
    cli: "claude",
    // The Code tab of the Claude desktop app.
    surface: "browser",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    format: "claude-extension",
    places: [],
    // An extension runs a local command only.
    http: false,
    cli: null,
    surface: "none",
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    format: "dsh-plugin",
    places: [],
    // The plugin's entry runs the binary; an HTTP entry would be a second
    // `weftcut` server beside it.
    http: false,
    cli: "dsh",
    // A tab in the Harness's right sidebar, framing the side-browser page.
    surface: "browser",
  },
  {
    id: "cursor",
    name: "Cursor",
    format: "mcp-servers-json",
    places: [
      { path: "~/.cursor/mcp.json", scope: "user" },
      { path: ".cursor/mcp.json", scope: "project" },
    ],
    http: true,
    cli: null,
    surface: "browser",
  },
  {
    id: "generic",
    name: "Generic",
    format: "facts",
    places: [],
    http: true,
    cli: null,
    surface: "none",
  },
];

/// What a stdio host runs: the `weftcut` binary in the profile and its `mcp`
/// subcommand. No environment: the binary finds the profile from where it
/// sits (ADR 0165).
export interface StdioEntry {
  command: string;
  args: readonly string[];
}

/// The entry for the binary at `cliPath`: the one place a stdio config is
/// built. `weftcut print-config` prints the same (src/cli/integration.test.ts).
export function stdioEntry(cliPath: string): StdioEntry {
  return { command: cliPath, args: ["mcp"] };
}

/// The name every snippet registers the server under. The dsh plugin's row
/// keys its tool row to it too (`mcp__weftcut__open_side_preview`), and the
/// Claude Desktop extension is named it, as Claude keys its server by that name.
export const SERVER_NAME = "weftcut";
const SERVER = SERVER_NAME;

/// A path in the profile, beside the binary's `cli` folder. Derived from the
/// binary's path so the panel and the main-process writers cannot disagree;
/// either separator, as the path is the main process's.
function profilePath(cliPath: string, ...parts: string[]): string {
  const m = /^(.*)([\\/])cli\2[^\\/]+$/.exec(cliPath);
  if (m === null) throw new Error(`not a profile binary path: ${cliPath}`);
  return [m[1], ...parts].join(m[2]);
}

/// The folder the app writes the DeepSeek Harness plugin to
/// (`main/mcp/dshPluginInstall.ts`).
export function dshPluginDir(cliPath: string): string {
  return profilePath(cliPath, "dsh-plugin");
}

/// The Claude Desktop extension the app writes
/// (`main/mcp/claudeExtensionInstall.ts`).
export function claudeExtensionPath(cliPath: string): string {
  return profilePath(cliPath, "claude-desktop", "weftcut.mcpb");
}

/// `key: value` rows with the values column-aligned. One row per arg, so a
/// value containing a space stays unambiguous.
function factsBlock(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([k]) => k.length)) + 2;
  return rows.map(([k, v]) => `${k}:`.padEnd(width) + v).join("\n");
}

/// Shell-quote one CLI argument for both shells these lines are pasted into:
/// PowerShell and a POSIX shell (Git Bash on Windows). Single quotes, because
/// inside them neither shell expands anything: in double quotes PowerShell
/// expands `$name` and backticks, a POSIX shell `$`, and a profile path may
/// hold either. A bare backslash would be eaten by a POSIX shell (`C:\ud` →
/// `C:ud`), so it forces quoting too. A single quote inside has no spelling
/// both shells read: a Windows path (drive or backslash) takes PowerShell's
/// `''`, anything else the POSIX `'\''`.
function shq(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  return /^[A-Za-z]:|\\/.test(s) ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`;
}

/// JSON.stringify doubles as the string encoder for TOML and YAML: TOML basic
/// strings and YAML double-quoted scalars both accept every JSON escape, so a
/// Windows backslash path survives all three formats.
const q = (s: string) => JSON.stringify(s);

/// Ready-to-paste stdio entry for one host.
export function stdioSnippet(host: AgentHost, entry: StdioEntry): string {
  switch (host.format) {
    case "facts":
      return factsBlock([
        ["transport", "stdio"],
        ["command", entry.command],
        ...entry.args.map((a) => ["arg", a] as const),
      ]);
    case "codex-toml":
      return [
        `[mcp_servers.${SERVER}]`,
        `command = ${q(entry.command)}`,
        `args = [${entry.args.map(q).join(", ")}]`,
      ].join("\n");
    case "dsh-plugin":
      // What the user hands the Harness: the plugin's folder.
      return dshPluginDir(entry.command);
    case "claude-extension":
      // What the user opens in Claude Desktop: the extension's file.
      return claudeExtensionPath(entry.command);
    case "claude-code-json":
    case "mcp-servers-json": {
      const server = { command: entry.command, args: entry.args };
      const typed =
        host.format === "claude-code-json" ? { type: "stdio", ...server } : server;
      return JSON.stringify({ mcpServers: { [SERVER]: typed } }, null, 2);
    }
  }
}

/// Ready-to-paste HTTP-direct entry, `null` where the host's config cannot
/// name one. Codex HTTP entries take static headers in `http_headers` (no
/// inline bearer field).
export function httpSnippet(
  host: AgentHost,
  url: string,
  token: string,
): string | null {
  if (!host.http) return null;
  const auth = `Bearer ${token}`;
  switch (host.format) {
    case "facts":
      return factsBlock([
        ["transport", "streamable HTTP"],
        ["url", url],
        ["header", `Authorization: ${auth}`],
      ]);
    case "codex-toml":
      return [
        `[mcp_servers.${SERVER}]`,
        `url = ${q(url)}`,
        `http_headers = { "Authorization" = ${q(auth)} }`,
      ].join("\n");
    case "dsh-plugin":
    case "claude-extension":
      return null;
    case "claude-code-json":
    case "mcp-servers-json": {
      const server = { url, headers: { Authorization: auth } };
      const typed =
        host.format === "claude-code-json" ? { type: "http", ...server } : server;
      return JSON.stringify({ mcpServers: { [SERVER]: typed } }, null, 2);
    }
  }
}

/// `claude mcp add` refuses a name the scope already holds (a 0.7.x entry, or
/// the other transport's), so the line removes it first. `;`, not
/// `&&`: the remove fails where there is nothing to remove, and the add must
/// run anyway. It separates commands in POSIX shells and PowerShell alike.
const claudeReplacing = (add: string): string =>
  `claude mcp remove ${SERVER} -s user; ${add}`;

/// Terminal one-liner that makes the host write its own entry: it finds the
/// config file itself and merges it into the rest. Flags verified against
/// `codex mcp add --help` and `claude mcp add --help`.
export function stdioCommand(host: AgentHost, entry: StdioEntry): string | null {
  const launch = [entry.command, ...entry.args].map(shq).join(" ");
  if (host.cli === "codex") return `codex mcp add ${SERVER} -- ${launch}`;
  if (host.cli === "claude")
    return claudeReplacing(`claude mcp add ${SERVER} -s user -- ${launch}`);
  // `web` is the profile `dsh web` runs; the desktop app's Plugins page takes
  // the same folder.
  if (host.cli === "dsh")
    return `dsh plugin --profile web add ${shq(dshPluginDir(entry.command))}`;
  return null;
}

/// HTTP-direct one-liner. Claude Code alone can express the whole entry:
/// `codex mcp add --url` takes only `--bearer-token-env-var` (the *name* of an
/// env var to read), never a literal header.
export function httpCommand(
  host: AgentHost,
  url: string,
  token: string,
): string | null {
  if (host.cli !== "claude") return null;
  const header = shq(`Authorization: Bearer ${token}`);
  return claudeReplacing(
    `claude mcp add -s user -t http ${SERVER} ${shq(url)} -H ${header}`,
  );
}
