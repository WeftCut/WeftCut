package main

// What the shim says in its own voice: the `initialize` answer, its two tools,
// and the wording of every state it reports. A client often shows a model only
// `code: message`, so each message carries what to do next.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// version is the app version this binary was built for, set at link time
// (scripts/build-weftcut-cli.mjs). A plain `go build` has no stamp.
var version = "0.0.0-dev"

const (
	serverName       = "weftcut-mcp"
	toolStatus       = "weftcut_status"
	toolLaunch       = "launch_weftcut"
	toolTimeoutEnv   = "WEFTCUT_MCP_TOOL_TIMEOUT_MS"
	toolMaxTotalEnv  = "WEFTCUT_MCP_TOOL_MAX_TOTAL_MS"
	userDataEnv      = "WEFTCUT_USERDATA"
	appEnv           = "WEFTCUT_APP"
	latestProtocol   = "2025-11-25"
	initializedNote  = "notifications/initialized"
	cancelledNote    = "notifications/cancelled"
	progressNote     = "notifications/progress"
	methodInitialize = "initialize"
	methodPing       = "ping"
	methodToolsList  = "tools/list"
	methodToolsCall  = "tools/call"
)

// supportedProtocols are the MCP versions the shim agrees to speak with a
// client: the list of the TypeScript SDK the app's server is built on, so a
// version granted here is one the app can be asked for too.
var supportedProtocols = []string{latestProtocol, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"}

// negotiate is the version an `initialize` asking for `asked` is answered with.
func negotiate(asked string) string {
	for _, v := range supportedProtocols {
		if v == asked {
			return asked
		}
	}
	return latestProtocol
}

// The `initialize` instructions: the one text the app's server and this binary
// both send. src/main/mcp/instructions.ts reads the same file.
//
//go:embed instructions.json
var instructionsJSON []byte

// instructions is the text for a server at v: the etiquette, then the closing
// line with its {version} filled in.
func instructions(v string) string {
	var text struct {
		Etiquette []string `json:"etiquette"`
		Closing   string   `json:"closing"`
	}
	if err := json.Unmarshal(instructionsJSON, &text); err != nil {
		panic("instructions.json: " + err.Error())
	}
	lines := append(text.Etiquette, strings.ReplaceAll(text.Closing, "{version}", v))
	return strings.Join(lines, "\n")
}

// initializeResult answers a client's `initialize` at the negotiated version.
// The capabilities are the shim's own: its catalog changes with the app's
// presence whatever the app itself declares.
func initializeResult(protocol string) json.RawMessage {
	return concat(
		`{"protocolVersion":`, quote(protocol),
		`,"capabilities":{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"listChanged":true}}`,
		`,"serverInfo":{"name":`, quote(serverName), `,"version":`, quote(version), `}`,
		`,"instructions":`, quote(instructions(version)), `}`,
	)
}

// syntheticTool is a tool the shim answers itself, listed whether or not the
// app is reachable: how an agent finds WeftCut and brings it up.
type syntheticTool struct {
	name       string
	definition json.RawMessage
}

var syntheticTools = []syntheticTool{
	{toolStatus, concat(
		`{"name":"weftcut_status","description":`, quote(
			"Report whether the WeftCut desktop app is currently running and reachable, and which "+
				"project it has open. Returns the endpoint state and what to do next when it is not running. "+
				"Costs nothing; call this first when WeftCut tools appear to be missing or failing."),
		`,"inputSchema":{"type":"object","properties":{},"additionalProperties":false}`,
		`,"annotations":{"readOnlyHint":true,"openWorldHint":false}}`,
	)},
	// Starts a process on this machine; a second call while it runs reports that.
	{toolLaunch, concat(
		`{"name":"launch_weftcut","description":`, quote(
			"Launch the WeftCut desktop app (opens its GUI window on the user’s machine) and "+
				"wait until its MCP endpoint is reachable. On success the full WeftCut tool catalog "+
				"becomes available in this session automatically (tools/list_changed). Safe to call "+
				"when already running — reports that instead of launching twice. Use after "+
				"weftcut_status says the app is not running."),
		`,"inputSchema":{"type":"object","properties":{},"additionalProperties":false}`,
		`,"annotations":{"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}`,
	)},
}

// The three notifications a client is sent whenever the app comes or goes.
var catalogChanged = []string{
	"notifications/tools/list_changed",
	"notifications/resources/list_changed",
	"notifications/prompts/list_changed",
}

// mismatch is an app that answered `initialize` at another protocol version
// than the client's session runs at: reachable, and not bridged.
type mismatch struct {
	endpoint string
	asked    string
	answered string
}

func (m mismatch) text() string {
	return fmt.Sprintf(
		"WeftCut is running at %s, but it answered MCP protocol %s where this session uses %s: "+
			"the app and this weftcut CLI come from different versions. "+
			"Ask the user to open WeftCut once so it refreshes the CLI, then restart this MCP server.",
		m.endpoint, m.answered, m.asked)
}

// downState is why requests cannot reach the app right now, read when the
// answer is written: the auth file is the app's and changes under the shim.
type downState struct {
	userData string
	auth     *auth
	mismatch *mismatch
}

// errorText is the message of a request that needed the app.
func (d downState) errorText() string {
	switch {
	case d.mismatch != nil:
		return d.mismatch.text()
	case d.auth == nil:
		return fmt.Sprintf("WeftCut has never been launched on this machine (no mcp_auth.json under %s). ", d.userData) +
			"Ask the user to open WeftCut once so it creates its MCP endpoint, then call weftcut_status."
	default:
		return fmt.Sprintf("WeftCut is not running (nothing answering at %s). ", d.auth.endpoint()) +
			"Call the launch_weftcut tool to start it, or ask the user to open WeftCut; " +
			"the full tool catalog appears in this session automatically once the app is up."
	}
}

// statusText is what weftcut_status reports while the app is not bridged.
func (d downState) statusText() string {
	switch {
	case d.mismatch != nil:
		return d.mismatch.text()
	case d.auth == nil:
		return fmt.Sprintf("WeftCut is not running, and has never been launched on this machine (no mcp_auth.json under %s).\n", d.userData) +
			"Ask the user to open WeftCut once so it creates its MCP endpoint, then call weftcut_status again."
	default:
		return fmt.Sprintf("WeftCut is not running (nothing answering at %s).\n", d.auth.endpoint()) +
			"Call launch_weftcut to start it, or ask the user to open WeftCut. " +
			"The full tool catalog appears automatically once the app is up."
	}
}

// statusUpText is what weftcut_status reports while bridged. projectLine is
// empty when the app's session view could not be read: the status still answers.
func statusUpText(app serverInfo, endpoint, projectLine string) string {
	lines := []string{fmt.Sprintf("WeftCut is running (%s %s).", app.Name, app.Version), "Endpoint: " + endpoint}
	// The instructions this binary sent name its own version; when the app
	// answering is another one, an agent comparing a skill copy needs both.
	if app.Version != version {
		lines = append(lines, fmt.Sprintf("This weftcut CLI is version %s, not the running app's %s.", version, app.Version))
	}
	if projectLine != "" {
		lines = append(lines, projectLine)
	}
	return strings.Join(append(lines, "The full tool catalog is available in this session."), "\n")
}

// projectLine reads the open project out of the app's answer to
// `read_project { view: "session" }`. Empty: the answer did not say.
func projectLine(response []byte) string {
	var r struct {
		Result struct {
			StructuredContent json.RawMessage `json:"structuredContent"`
			Content           []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if json.Unmarshal(response, &r) != nil {
		return ""
	}
	view := r.Result.StructuredContent
	if !present(view) && len(r.Result.Content) > 0 {
		view = json.RawMessage(r.Result.Content[0].Text)
	}
	fields, err := parseObject(view)
	if err != nil {
		return ""
	}
	raw, ok := fields.get("project")
	if !ok {
		return ""
	}
	if !present(raw) {
		return "Project: none open. Open or create the one the user asked for (open_project / create_project), or ask them which."
	}
	var project struct {
		Name string `json:"name"`
		Dir  string `json:"dir"`
	}
	if json.Unmarshal(raw, &project) != nil {
		return ""
	}
	return fmt.Sprintf("Project: %s (%s)", project.Name, project.Dir)
}

// duration reads as a person would say it: 300000 → "5 min", 45000 → "45 s".
func duration(d time.Duration) string {
	ms := d.Milliseconds()
	switch {
	case ms >= 60_000 && ms%60_000 == 0:
		return fmt.Sprintf("%d min", ms/60_000)
	case ms >= 1000:
		return fmt.Sprintf("%d s", (ms+500)/1000)
	default:
		return fmt.Sprintf("%d ms", ms)
	}
}

// toolTimeoutText tells an agent its call outlived the shim's wait while the
// app is alive: the job was left running, and how to keep waiting for it.
func toolTimeoutText(tool string, waited time.Duration, total bool) string {
	if tool == "" {
		tool = "the tool"
	}
	limit := fmt.Sprintf("within %s of no progress from the app", duration(waited))
	if total {
		limit = fmt.Sprintf("within the %s total limit set by %s", duration(waited), toolMaxTotalEnv)
	}
	return fmt.Sprintf("WeftCut is running, and %s is still working inside the app: it did not finish %s. ", tool, limit) +
		"The call was not cancelled. Call the same tool again with the same arguments to keep waiting — " +
		"an identical retry joins the in-flight job instead of starting a new one. " +
		fmt.Sprintf("To wait longer per call, raise %s (milliseconds) in this MCP server's env config.", toolTimeoutEnv)
}

// requestTimeoutText is the same for any other request, which the shim does
// cancel in the app.
func requestTimeoutText(method string, waited time.Duration) string {
	return fmt.Sprintf("WeftCut is running, but did not answer %s within %s. ", method, duration(waited)) +
		"Retry the request; call weftcut_status if it keeps happening."
}

const (
	alreadyRunningText = "WeftCut is already running — the full tool catalog is available."
	launchedText       = "WeftCut launched and its MCP endpoint is up. The full tool catalog is now available " +
		"in this session (tools/list_changed was sent)."
	noAppText = "This weftcut CLI does not know where the WeftCut app is installed. " +
		"Ask the user to open WeftCut once (the app records how to start it), " +
		"or set the " + appEnv + " environment variable to a launchable WeftCut executable."
	beforeInitializeText = "The client has not sent initialize: only initialize and ping are answered before it."
	duplicateIDText      = "A request with this id is still in flight."
)

func launchFailedText(app string, err error) string {
	return fmt.Sprintf("Failed to launch WeftCut (%s): %s", app, err)
}

func launchTimeoutText(app string, waited time.Duration) string {
	return fmt.Sprintf("WeftCut was launched (%s) but its MCP endpoint did not come up within %ds. ", app, int(waited.Seconds())) +
		"The app may still be starting — call weftcut_status to re-check."
}

const helpText = `weftcut — WeftCut on the command line

usage:
  weftcut mcp             MCP server on stdio (what client configs run)
  weftcut info            print endpoint, token, and whether the app is running
  weftcut print-config    print the mcpServers config fragment for MCP clients
  weftcut list-tools      connect to the running app and list its MCP tools
  weftcut help            this text
  weftcut --version       print the app version this binary was built for

The app's endpoint + bearer token are read from <userData>/mcp_auth.json at
every connect, so configs stay valid across app restarts, port changes, and
token rotations. Override the userData directory with WEFTCUT_USERDATA.
`
