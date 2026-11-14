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
import {
  getMcpInfo,
  reinstallSkills,
  resetMcpToken,
  type McpInfoView,
  type SkillsInstallView,
} from "../ipc";
import { reveal as revealInShell } from "@/bridge/shell";
import { AppInput } from "../components/AppInput";
import { Button } from "@/components/ui/button";
import { AppIcon } from "@/components/AppIcon";
import { rendererOS, type RendererOS } from "../platform";
import {
  AGENT_HOSTS,
  httpCommand,
  httpSnippet as hostHttpSnippet,
  placePath,
  stdioCommand,
  stdioSnippet as hostStdioSnippet,
  type AgentHost,
  type AgentHostOs,
  type StdioEntry,
} from "../../shared/agentHosts";

const REFRESH_INTERVAL_MS = 1000;
const MASKED_TOKEN = "••••••••••••••••";

const HOST_OS: Record<RendererOS, AgentHostOs> = {
  mac: "mac",
  windows: "windows",
  linux: "linux",
};

function stdioEntryFrom(info: McpInfoView): StdioEntry | null {
  if (!info.cli_path) return null;
  return { command: info.cli_path, args: ["mcp"] };
}

/// The staged skill folder — the thing that gets copied, named by both the
/// install prompt and the manual block. The separator is inferred from the
/// parent path instead of normalised: the renderer has no `path`, and the
/// folder is shown to the user verbatim as the main process reported it.
function skillFolder(skillsDir: string): string {
  return `${skillsDir}${skillsDir.includes("\\") ? "\\" : "/"}weftcut`;
}

/// MCP connection info for external agents. Two connection paths: stdio
/// through the `weftcut` binary (primary — survives app restarts, port
/// changes, token rotations, and the app being closed) and HTTP-direct
/// (advanced — for clients without stdio support). Until the binary is
/// installed (an unpackaged run before build:cli, cli_path = null) the HTTP
/// path renders as primary. The shipped agent skill rides along both routes: the setup
/// prompt asks the agent to copy it, and the manual section names the app's own
/// copy. That copy is all the panel can see — the agent's copy lives in the
/// client's skills directory and goes stale on upgrade — so the panel says so
/// instead of claiming it installed. The app copy's state is reported whatever
/// it is, because a shipped app cannot reach anything but `current` without
/// something being broken. Lives in the
/// Settings "Agent" tab; like the other panes it stays mounted across tab
/// switches, so the poll below runs once.
export function AgentSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpInfoView | null>(null);
  const [host, setHost] = useState<AgentHost>(AGENT_HOSTS[0]!);
  const [revealed, setRevealed] = useState(false);
  // Which copy button last fired, for its 1.5s "Copied!" flash. One key beats
  // a boolean per button now that six of them share the behaviour.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [httpOpen, setHttpOpen] = useState(false);
  const [retryingSkill, setRetryingSkill] = useState(false);

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

  const stdio = useMemo(() => (info ? stdioEntryFrom(info) : null), [info]);

  const stdioSnippet = useMemo(
    () => (stdio ? hostStdioSnippet(host, stdio) : ""),
    [stdio, host],
  );

  const stdioCli = useMemo(
    () => (stdio ? stdioCommand(host, stdio) : null),
    [stdio, host],
  );

  // Displayed HTTP snippet masks the token unless revealed; the copy below
  // always uses the real one.
  const httpSnippet = useMemo(() => {
    if (!info) return null;
    return hostHttpSnippet(
      host,
      info.url,
      revealed ? info.bearer_token : MASKED_TOKEN,
    );
  }, [info, host, revealed]);

  // Same masking rule as the snippet: the rendered command hides the token,
  // the copy carries the real one.
  const httpCli = useMemo(() => {
    if (!info) return null;
    return httpCommand(
      host,
      info.url,
      revealed ? info.bearer_token : MASKED_TOKEN,
    );
  }, [info, host, revealed]);

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
    await copy("stdio", hostStdioSnippet(host, stdio));
  };

  const copyStdioCli = async () => {
    if (!stdio) return;
    const cli = stdioCommand(host, stdio);
    if (cli) await copy("stdio-cli", cli);
  };

  const copyHttp = async () => {
    if (!info) return;
    const snippet = hostHttpSnippet(host, info.url, info.bearer_token);
    if (snippet) await copy("http", snippet);
  };

  const copyHttpCli = async () => {
    if (!info) return;
    const cli = httpCommand(host, info.url, info.bearer_token);
    if (cli) await copy("http-cli", cli);
  };

  /// Both halves of setup as one message. The MCP half is generic — the agent
  /// figures out its own client config format; with the binary installed it
  /// carries the stdio command (no token to leak), without it the URL + token.
  /// The skill half is appended only when there is a folder to hand over, so a
  /// dev tree before `build:skills` still gets a prompt that works.
  const copySetupPrompt = async () => {
    if (!info) return;
    const mcp = stdio
      ? t("connect.agent_prompt_stdio", {
          command: stdio.command,
          args: stdio.args.join(" "),
        })
      : t("connect.agent_prompt", {
          url: info.url,
          token: info.bearer_token,
        });
    const skill = info.skills.dir
      ? t("connect.agent_prompt_skill", {
          folder: skillFolder(info.skills.dir),
        })
      : null;
    await copy("prompt", skill ? `${mcp}\n\n${skill}` : mcp);
  };

  const copySkillPath = async () => {
    if (!info?.skills.dir) return;
    await copy("skill-path", skillFolder(info.skills.dir));
  };

  /// Reveal the skill folder in the OS file manager — selected in Explorer /
  /// Finder, the containing folder on Linux (see main/openPath.ts). A failure
  /// (folder deleted, no file manager on the box) is logged rather than
  /// surfaced: the path is on screen right next to the button, which is the
  /// fallback the user needs.
  const revealSkillFolder = () => {
    if (!info?.skills.dir) return;
    void revealInShell(skillFolder(info.skills.dir)).catch((e: unknown) => {
      console.warn("reveal skill folder failed:", e);
    });
  };

  /// Re-run the install and take whatever it found. The poll above stopped at
  /// the first `info`, so the new state has to be spliced in here; the main
  /// process separately re-broadcasts the notice list, which is what clears the
  /// skill notice from the notification center.
  const retrySkill = async () => {
    if (retryingSkill) return;
    setRetryingSkill(true);
    try {
      const skills = await reinstallSkills();
      setInfo((prev) => (prev ? { ...prev, skills } : prev));
    } catch (e) {
      // Leave the fault on screen: it is still the truth, and the button the
      // user just pressed is still there to press again.
      console.warn("reinstall skills failed:", e);
    } finally {
      setRetryingSkill(false);
    }
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

  /// Arrow keys move between host tabs (horizontal tablist).
  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = AGENT_HOSTS.indexOf(host);
    const n = AGENT_HOSTS.length;
    let next: AgentHost | undefined;
    if (e.key === "ArrowRight") next = AGENT_HOSTS[(idx + 1) % n];
    else if (e.key === "ArrowLeft") next = AGENT_HOSTS[(idx - 1 + n) % n];
    if (next) {
      e.preventDefault();
      setHost(next);
    }
  };

  if (!info) {
    return <p className="settings-status">{t("connect.starting")}</p>;
  }

  /// Where the selected host's snippet goes, from the table's places on this
  /// OS. A host with none (Generic) is told to follow its own docs.
  const hint = () => {
    if (host.places.length === 0) return t("connect.hint_facts");
    const places = host.places.map((place) => {
      const path = placePath(place, HOST_OS[rendererOS]);
      return place.scope === "project"
        ? t("connect.place_project", { path })
        : path;
    });
    return t("connect.paste_into", {
      places: places.join(t("connect.place_or")),
    });
  };

  /// One tablist per snippet block; both share the `host` selection so
  /// switching tabs in the primary block also switches the advanced one.
  const hostTabs = (section: string) => (
    <div
      className="connect-tabs"
      role="tablist"
      aria-label={t("connect.snippets_heading")}
      onKeyDown={onTabsKeyDown}
    >
      {AGENT_HOSTS.map((h) => (
        <button
          key={h.id}
          type="button"
          role="tab"
          id={`connect-tab-${section}-${h.id}`}
          aria-selected={host === h}
          aria-controls={`connect-snippet-panel-${section}`}
          tabIndex={host === h ? 0 : -1}
          className={host === h ? "connect-tab is-active" : "connect-tab"}
          onClick={() => setHost(h)}
        >
          {t(`connect.tabs.${h.id}`, { defaultValue: h.name })}
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
        {copied ? <AppIcon icon={CheckIcon} size="body" /> : <AppIcon icon={CopyIcon} size="body" />}
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

  /// The line that explains a skill state other than `current`, in the
  /// register its severity deserves: amber for `stale` (the folder is there and
  /// worth handing out, it is just not this version's), red for a folder that
  /// is not there at all.
  const skillFaultNote = (skills: SkillsInstallView) =>
    skills.state === "current" ? null : (
      <div
        className={`connect-skill-fault ${
          skills.state === "stale" ? "settings-warn" : "settings-error"
        }`}
      >
        <p>
          {skills.state === "stale" ? `${t("connect.skill_stale")} ` : ""}
          {t(`connect.skill_fault.${skills.fault}`)}
        </p>
        {/* Offered for every fault, not just the transient-looking ones: each
            is cleared by something outside WeftCut (a freed disk, a restored
            quarantine, a repaired install), and only re-running the install
            can tell whether that has happened yet. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void retrySkill()}
          disabled={retryingSkill}
        >
          <AppIcon icon={RotateCcwIcon} size="label" />
          {retryingSkill
            ? t("connect.skill_retrying")
            : t("connect.skill_retry")}
        </Button>
      </div>
    );

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
        {revealed ? <AppIcon icon={EyeOffIcon} size="body" /> : <AppIcon icon={EyeIcon} size="body" />}
      </Button>
    </div>
  );

  /// A host whose config cannot name an HTTP endpoint gets a line saying so
  /// in place of the snippet.
  const httpSnippetBlock = (section: string) => (
    <div
      className="connect-panel"
      role="tabpanel"
      id={`connect-snippet-panel-${section}`}
      aria-labelledby={`connect-tab-${section}-${host.id}`}
    >
      {httpSnippet === null ? (
        <p className="settings-blurb">
          {t("connect.http_unsupported", { host: host.name })}
        </p>
      ) : (
        <div className="connect-snippet">
          <div className="connect-snippet-header">
            <span>{hint()}</span>
            {httpActions()}
          </div>
          <pre>
            <code>{httpSnippet}</code>
          </pre>
        </div>
      )}
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
          <AppIcon icon={RotateCcwIcon} size="label" />
          {refreshing ? t("connect.refreshing") : t("connect.refresh")}
        </Button>
      </div>

      {/* Connecting the server and installing the skill are one act — one
          message, pasted into one agent — so they are one button. The skill
          state is presented whatever it is: a shipped build that reached
          anything but `current` has had both of its build gates fail, so the
          absence is a defect the user can act on, and the fault here is what
          explains a prompt that carries only the MCP half. */}
      <section className="settings-section">
        <h3>{t("connect.prompt_heading")}</h3>
        <p className="settings-blurb">{t("connect.prompt_blurb")}</p>
        {skillFaultNote(info.skills)}
        <div className="settings-key-input-row">
          <Button size="sm" onClick={() => void copySetupPrompt()}>
            {copiedKey === "prompt" ? (
              <AppIcon icon={CheckIcon} size="label" />
            ) : (
              <AppIcon icon={CopyIcon} size="label" />
            )}
            {copiedKey === "prompt"
              ? t("connect.prompt_copied")
              : t("connect.copy_prompt")}
          </Button>
        </div>
      </section>

      <section className="settings-section">
        <h3>{t("connect.manual_heading")}</h3>
        {stdio ? (
          <>
            <p className="settings-blurb">{t("connect.stdio_note")}</p>
            {hostTabs("stdio")}
            <div
              className="connect-panel"
              role="tabpanel"
              id="connect-snippet-panel-stdio"
              aria-labelledby={`connect-tab-stdio-${host.id}`}
            >
              <div className="connect-snippet">
                <div className="connect-snippet-header">
                  <span>{hint()}</span>
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
            {hostTabs("http")}
            {httpSnippetBlock("http")}
          </>
        )}
        {/* The skill's manual counterpart to the setup prompt above: a user
            doing this by hand needs the folder itself, and only this section
            addresses that user. Client-independent — the destination differs
            per client, the source never does. Shaped like the export dialog's
            output-location row — a read-only path field with Browse beside
            it — rather than the snippet <pre>: this is one value to take away
            or act on, not a blob to paste. */}
        <div className="connect-path-block">
          <div className="connect-snippet-header">
            <span>{t("connect.skill_path_heading")}</span>
            {info.skills.dir && (
              <div className="connect-snippet-actions">
                {copyButton(
                  "skill-path",
                  () => void copySkillPath(),
                  t("connect.copy_path"),
                )}
              </div>
            )}
          </div>
          {info.skills.dir ? (
            <>
              <div className="connect-path">
                <AppInput
                  value={skillFolder(info.skills.dir)}
                  onValueChange={() => {}}
                  readOnly
                  mono
                  title={skillFolder(info.skills.dir)}
                  className="connect-path-input"
                  ariaLabel={t("connect.skill_path_heading")}
                />
                <Button
                  onClick={revealSkillFolder}
                  title={t("connect.open_location")}
                >
                  {t("connect.browse")}
                </Button>
              </div>
              {/* The copy an agent reads is not this one, and nothing here can
                  see it: say so, rather than let a healthy app copy pass for an
                  up-to-date agent. */}
              <p className="settings-blurb">{t("connect.skill_copy_note")}</p>
            </>
          ) : (
            // Points at the section that already diagnosed it rather than
            // repeating the diagnosis: one fault, one explanation.
            <p className="settings-blurb">
              {t("connect.skill_path_unavailable")}
            </p>
          )}
        </div>
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
                <AppIcon icon={ChevronDownIcon} size="label" />
              ) : (
                <AppIcon icon={ChevronRightIcon} size="label" />
              )}
              {t("connect.http_heading")}
            </Button>
          </h3>
          {httpOpen && (
            <>
              <p className="settings-blurb">{t("connect.http_note")}</p>
              {hostTabs("http")}
              {httpSnippetBlock("http")}
            </>
          )}
        </section>
      )}
    </>
  );
}
