// weftcut is WeftCut on the command line. `weftcut mcp` is the stdio MCP
// server an agent's client runs: a passthrough to the running app's Streamable
// HTTP endpoint on loopback. The other subcommands are the terminal's view of
// the same connection.
//
// Exit codes: 0 ok, 1 a failure mid-way, 2 usage, 3 the app is not reachable
// (info, list-tools).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	os.Exit(run(os.Args[1:], processHost()))
}

func run(args []string, h host) int {
	// The bare command explains itself and starts nothing: a person who typed
	// it is not an MCP client, and a server would only sit on their terminal.
	if len(args) == 0 {
		fmt.Print(helpText)
		return 0
	}
	switch args[0] {
	case "mcp":
		return serve(h)
	case "info":
		return info(h)
	case "print-config":
		return printConfig()
	case "list-tools":
		return listTools(h)
	case "help", "--help", "-h":
		fmt.Print(helpText)
		return 0
	case "--version", "-V":
		fmt.Println("weftcut " + version)
		return 0
	}
	fmt.Fprintf(os.Stderr, "unknown command: %s\n\n%s", args[0], helpText)
	return 2
}

// terminalIdentity is who the terminal subcommands open their session as:
// the binary itself, at the newest protocol version it speaks.
func terminalIdentity() identity {
	return identity{
		protocol:     latestProtocol,
		clientInfo:   concat(`{"name":"weftcut","version":`, quote(version), `}`),
		capabilities: json.RawMessage(`{}`),
	}
}

func info(h host) int {
	userData := resolveUserDataDir(h)
	a := readAuth(userData)
	missing := ""
	if a == nil {
		missing = " (missing — launch WeftCut once)"
	}
	fmt.Printf("userData:  %s\n", userData)
	fmt.Printf("auth file: %s%s\n", filepath.Join(userData, authFileName), missing)
	if a == nil {
		fmt.Println("running:   no")
		return 3
	}
	fmt.Printf("endpoint:  %s\n", a.endpoint())
	fmt.Printf("token:     %s\n", a.Token)
	outcome := connect(context.Background(), userData, terminalIdentity())
	switch {
	case outcome.session != nil:
		outcome.session.end()
		fmt.Println("running:   yes")
		return 0
	case outcome.mismatch != nil:
		fmt.Printf("running:   yes, but it answered MCP protocol %s where this CLI asked for %s; open WeftCut once to refresh the CLI\n",
			outcome.mismatch.answered, outcome.mismatch.asked)
	default:
		fmt.Println("running:   no")
	}
	return 3
}

func listTools(h host) int {
	userData := resolveUserDataDir(h)
	outcome := connect(context.Background(), userData, terminalIdentity())
	if outcome.session == nil {
		switch a := readAuth(userData); {
		case outcome.mismatch != nil:
			fmt.Fprintf(os.Stderr, "WeftCut is running at %s, but it answered MCP protocol %s where this CLI asked for %s. Open WeftCut once to refresh the CLI.\n",
				outcome.mismatch.endpoint, outcome.mismatch.answered, outcome.mismatch.asked)
		case a == nil:
			fmt.Fprintf(os.Stderr, "WeftCut has never been launched on this machine (no mcp_auth.json under %s).\n", userData)
		default:
			fmt.Fprintf(os.Stderr, "WeftCut is not running (nothing answering at %s). Launch the app and retry.\n", a.endpoint())
		}
		return 3
	}
	session := outcome.session
	defer session.end()
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeouts.request)
	defer cancel()
	cursor := ""
	for page := 1; ; page++ {
		params := json.RawMessage(`{}`)
		if cursor != "" {
			params = concat(`{"cursor":`, quote(cursor), `}`)
		}
		response, err := session.call(ctx, fmt.Sprintf("%slist:%d", ownIDPrefix, page), methodToolsList, params)
		if err != nil {
			fmt.Fprintln(os.Stderr, "WeftCut stopped answering:", err)
			return 1
		}
		var listed struct {
			Result *struct {
				Tools []struct {
					Name        string `json:"name"`
					Description string `json:"description"`
				} `json:"tools"`
				NextCursor string `json:"nextCursor"`
			} `json:"result"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response, &listed); err != nil || listed.Result == nil {
			message := "an answer that is not a tools/list result"
			if listed.Error != nil {
				message = listed.Error.Message
			}
			fmt.Fprintln(os.Stderr, "WeftCut refused tools/list:", message)
			return 1
		}
		for _, tool := range listed.Result.Tools {
			if line := firstLine(tool.Description); line != "" {
				fmt.Printf("%s — %s\n", tool.Name, line)
			} else {
				fmt.Println(tool.Name)
			}
		}
		if cursor = listed.Result.NextCursor; cursor == "" {
			return 0
		}
	}
}

// printConfig prints the fragment a client config needs: this binary and the
// subcommand. No URL, token or environment: the binary finds the profile from
// where it sits and reads the endpoint from it at every connect.
func printConfig() int {
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot tell where this binary is:", err)
		return 1
	}
	type entry struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}
	config := map[string]map[string]entry{"mcpServers": {"weftcut": {Command: exe, Args: []string{"mcp"}}}}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(config); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Print(out.String())
	return 0
}
