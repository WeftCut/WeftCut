import { describe, expect, it } from "vitest";

import { panelIdOf, parsePanelId } from "./panelRegistry";

describe("Panel addresses", () => {
  it("addresses a kind that does not instantiate by the kind alone", () => {
    expect(panelIdOf("preview")).toBe("preview");
    expect(parsePanelId("preview")).toEqual({ kind: "preview", instance: null });
  });

  it("binds a timeline Panel to the composition it shows", () => {
    const id = panelIdOf("timeline", "comp-7");
    expect(id).toBe("timeline:comp-7");
    expect(parsePanelId(id)).toEqual({ kind: "timeline", instance: "comp-7" });
  });

  it("leaves the timeline unbound when no composition is named", () => {
    expect(panelIdOf("timeline", null)).toBe("timeline");
    expect(parsePanelId("timeline")).toEqual({ kind: "timeline", instance: null });
  });

  it("drops an instance a kind cannot carry, rather than minting an id the catalogue could not resolve", () => {
    expect(panelIdOf("media", "comp-7")).toBe("media");
    expect(parsePanelId("media:comp-7")).toBeNull();
  });

  it("rejects anything the catalogue does not name", () => {
    expect(parsePanelId("bogus")).toBeNull();
    expect(parsePanelId("timeline:")).toBeNull();
    expect(parsePanelId(7)).toBeNull();
    expect(parsePanelId(null)).toBeNull();
  });

  it("round-trips a composition id that itself contains the separator", () => {
    const id = panelIdOf("timeline", "a:b");
    expect(parsePanelId(id)).toEqual({ kind: "timeline", instance: "a:b" });
  });
});
