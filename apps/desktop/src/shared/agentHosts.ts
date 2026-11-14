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
/// - `dsh-patch-yaml`: a DeepSeek Harness patch layer that inserts one
///   `@deepseek-ai/dsh-mcp-client` row.
/// - `facts`: the connection facts with no wrapper, for a client this table
///   does not know. MCP standardises the protocol, never the config file.
export type AgentConfigFormat =
  | "codex-toml"
  | "claude-code-json"
  | "mcp-servers-json"
  | "dsh-patch-yaml"
  | "facts";

export type AgentHostOs = "mac" | "windows" | "linux";

/// One file a host reads its MCP entries from. `user` files apply everywhere,
/// `project` files to one project folder.
export interface AgentConfigPlace {
  path: string | Readonly<Record<AgentHostOs, string>>;
  scope: "user" | "project";
}

export interface AgentHost {
  id: string;
  /// Proper noun, shown untranslated unless the locale has a
  /// `connect.tabs.<id>` entry.
  name: string;
  format: AgentConfigFormat;
  /// Empty for `facts`: the client's own docs say where its config goes.
  places: readonly AgentConfigPlace[];
  /// Whether the host's config can name a Streamable HTTP endpoint with a
  /// literal header. Claude Desktop's file takes local commands only.
  http: boolean;
  /// The host's own terminal command that writes the entry, if it has one.
  cli: "codex" | "claude" | null;
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
    format: "mcp-servers-json",
    places: [
      {
        path: {
          mac: "~/Library/Application Support/Claude/claude_desktop_config.json",
          windows: "%APPDATA%\\Claude\\claude_desktop_config.json",
          linux: "~/.config/Claude/claude_desktop_config.json",
        },
        scope: "user",
      },
    ],
    http: false,
    cli: null,
    surface: "none",
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    format: "dsh-patch-yaml",
    // The home-level patch layer: it applies to every profile, the desktop
    // app's included.
    places: [{ path: "~/.dsh/cordis.patch.yml", scope: "user" }],
    http: true,
    cli: null,
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

/// The name every snippet registers the server under.
const SERVER = "weftcut";

export function placePath(place: AgentConfigPlace, os: AgentHostOs): string {
  return typeof place.path === "string" ? place.path : place.path[os];
}

/// `key: value` rows with the values column-aligned. One row per arg, so a
/// value containing a space stays unambiguous.
function factsBlock(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([k]) => k.length)) + 2;
  return rows.map(([k, v]) => `${k}:`.padEnd(width) + v).join("\n");
}

/// Shell-quote one CLI argument. Whitespace forces quoting, and so does a
/// backslash: a bare Windows path survives PowerShell but a POSIX shell eats
/// the separators (`C:\ud` → `C:ud`), and Windows users do run these in Git
/// Bash. Nothing needs escaping *inside* the quotes: these values are
/// filesystem paths, a URL and a header, none of which can carry a double
/// quote, and a double-quoted backslash is literal in both shells.
function shq(s: string): string {
  return /[\s\\]/.test(s) ? `"${s}"` : s;
}

/// JSON.stringify doubles as the string encoder for TOML and YAML: TOML basic
/// strings and YAML double-quoted scalars both accept every JSON escape, so a
/// Windows backslash path survives all three formats.
const q = (s: string) => JSON.stringify(s);

function dshRow(config: readonly string[]): string {
  return [
    "- insert:",
    `    - id: mcp-${SERVER}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    `        serverName: ${SERVER}`,
    ...config.map((line) => `        ${line}`),
  ].join("\n");
}

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
    case "dsh-patch-yaml":
      return dshRow([
        "transport: stdio",
        `command: ${q(entry.command)}`,
        `args: [${entry.args.map(q).join(", ")}]`,
      ]);
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
    case "dsh-patch-yaml":
      return dshRow([
        "transport: streamable-http",
        `url: ${q(url)}`,
        "headers:",
        `  Authorization: ${q(auth)}`,
      ]);
    case "claude-code-json":
    case "mcp-servers-json": {
      const server = { url, headers: { Authorization: auth } };
      const typed =
        host.format === "claude-code-json" ? { type: "http", ...server } : server;
      return JSON.stringify({ mcpServers: { [SERVER]: typed } }, null, 2);
    }
  }
}

/// Terminal one-liner that makes the host write its own entry: it finds the
/// config file itself and merges rather than replaces. Flags verified against
/// `codex mcp add --help` and `claude mcp add --help`.
export function stdioCommand(host: AgentHost, entry: StdioEntry): string | null {
  const launch = [entry.command, ...entry.args].map(shq).join(" ");
  if (host.cli === "codex") return `codex mcp add ${SERVER} -- ${launch}`;
  if (host.cli === "claude") return `claude mcp add ${SERVER} -s user -- ${launch}`;
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
  return `claude mcp add -s user -t http ${SERVER} ${shq(url)} -H ${header}`;
}
