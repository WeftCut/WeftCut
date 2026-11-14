import { describe, expect, it } from "vitest";
import type { AppNotice } from "../../shared/ipc";
import type { UpdateStatus } from "../../shared/updates";
import { attentionView, type AttentionInput } from "./attentionView";

const input = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  notices: [],
  dismissedNotices: [],
  unreviewed: 0,
  update: null,
  dismissedUpdateVersion: undefined,
  ...over,
});
const keys = (items: { key: string }[]) => items.map((i) => i.key);
const offered: UpdateStatus = { phase: "available", version: "1.2.0" };

describe("attentionView", () => {
  it("lists nothing and shows no dot when nothing needs the user", () => {
    expect(attentionView(input())).toEqual({ active: [], level: null });
  });

  it("orders the most severe first, keeping notices, review, update in that order within a level", () => {
    const notices: AppNotice[] = [
      { level: "info", code: "native_decode_unavailable" },
      { level: "warn", code: "keyring_unavailable" },
      { level: "error", code: "agent_skill_unavailable" },
      { level: "info", code: "agent_skill_stale" },
    ];
    const view = attentionView(input({ notices, unreviewed: 2, update: offered }));
    expect(keys(view.active)).toEqual([
      "notice:agent_skill_unavailable",
      "notice:keyring_unavailable",
      "notice:native_decode_unavailable",
      "notice:agent_skill_stale",
      "review",
      "update",
    ]);
    expect(view.level).toBe("error");
  });

  it("drops a dismissed notice by its code alone, leaving the others", () => {
    const notices: AppNotice[] = [
      { level: "warn", code: "keyring_unavailable" },
      { level: "info", code: "native_decode_unavailable" },
    ];
    const view = attentionView(input({ notices, dismissedNotices: ["keyring_unavailable"] }));
    expect(keys(view.active)).toEqual(["notice:native_decode_unavailable"]);
    // The bell follows what is left, not what was dismissed.
    expect(view.level).toBe("info");
  });

  it("dismisses an update only for the version dismissed; a newer one shows again", () => {
    expect(attentionView(input({ update: offered, dismissedUpdateVersion: "1.2.0" })).active).toEqual([]);
    const newer = attentionView(input({ update: { phase: "available", version: "1.3.0" }, dismissedUpdateVersion: "1.2.0" }));
    expect(keys(newer.active)).toEqual(["update"]);
  });

  it("lists no update without a version to name", () => {
    expect(attentionView(input({ update: { phase: "available" } })).active).toEqual([]);
  });

  it("never dismisses the review, and drops it once nothing is unreviewed", () => {
    // No dismissal input reaches it: whatever the user dismissed, it stays.
    const view = attentionView(input({ unreviewed: 3, dismissedNotices: ["review"], dismissedUpdateVersion: "review" }));
    expect(view.active).toEqual([{ kind: "review", key: "review", level: "info", count: 3 }]);
    expect(attentionView(input({ unreviewed: 0 })).active).toEqual([]);
  });

  it("shows no dot when every item is dismissed", () => {
    const view = attentionView(input({
      notices: [{ level: "error", code: "agent_skill_unavailable" }],
      dismissedNotices: ["agent_skill_unavailable"],
      update: offered,
      dismissedUpdateVersion: "1.2.0",
    }));
    expect(view.active).toEqual([]);
    expect(view.level).toBeNull();
  });
});
