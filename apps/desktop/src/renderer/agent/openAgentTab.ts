import { getCommand } from "../commands/registry";
import { useAgentActivity, type AgentPanelTab } from "./activityStore";

/// Shows the agent panel on one tab: the tab first, so the panel opens on it
/// rather than flashing the one it last showed.
export function openAgentTab(tab: AgentPanelTab): void {
  useAgentActivity.setState({ tab });
  void getCommand("openAgentPanel")?.run();
}
