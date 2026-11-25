import { describe, expect, it } from "vitest";

import { bundledReleaseNotes, launchReleaseNotes, parseReleaseNotes } from "./releaseNotes";

describe("bundled release notes", () => {
  it("bundles docs/release-notes by version", () => {
    expect([...bundledReleaseNotes().keys()]).toContain("0.9.0");
  });

  // The dialog renders only what the parser reads; a construct it does not
  // know fails here rather than showing garbled in the app.
  it.each([...bundledReleaseNotes()])("%s parses with the supported markdown", (_version, markdown) => {
    expect(parseReleaseNotes(markdown).length).toBeGreaterThan(0);
  });
});

describe("launchReleaseNotes", () => {
  const notes = new Map([["0.9.0", "notes 0.9"], ["0.8.1", "notes 0.8.1"]]);

  it("opens the running version's notes until they are seen", () => {
    expect(launchReleaseNotes("0.9.0", undefined, notes)).toBe("notes 0.9");
    expect(launchReleaseNotes("0.9.0", "0.8.1", notes)).toBe("notes 0.9");
    expect(launchReleaseNotes("0.9.0", "0.9.0", notes)).toBeNull();
  });

  it("stays quiet for a version without notes, even when older notes are unseen", () => {
    expect(launchReleaseNotes("0.9.1", "0.8.1", notes)).toBeNull();
  });
});

describe("parseReleaseNotes", () => {
  it("reads headings, wrapped paragraphs and inline marks", () => {
    expect(parseReleaseNotes("## Upgrading\n\n**Bold** then *em*\nand `code`.")).toEqual([
      { kind: "heading", inlines: [{ kind: "text", text: "Upgrading" }] },
      {
        kind: "paragraph",
        inlines: [
          { kind: "strong", text: "Bold" },
          { kind: "text", text: " then " },
          { kind: "em", text: "em" },
          { kind: "text", text: " and " },
          { kind: "code", text: "code" },
          { kind: "text", text: "." },
        ],
      },
    ]);
  });

  it("nests list items by indent and joins their wrapped lines", () => {
    const blocks = parseReleaseNotes(
      ["- one", "  wrapped", "  - child", "    wrapped too", "- two", "", "After."].join("\n"),
    );
    const text = (s: string) => [{ kind: "text", text: s }];
    expect(blocks).toEqual([
      {
        kind: "list",
        items: [
          { inlines: text("one wrapped"), children: [{ inlines: text("child wrapped too"), children: [] }] },
          { inlines: text("two"), children: [] },
        ],
      },
      { kind: "paragraph", inlines: text("After.") },
    ]);
  });

  it.each([
    ["a top-level heading", "# Title"],
    ["a link", "See [the docs](https://example.com)."],
    ["a numbered list", "1. first"],
    ["a quote", "> quoted"],
    ["a star bullet", "* item"],
    ["an unbalanced mark", "a **bold"],
  ])("refuses %s", (_name, markdown) => {
    expect(() => parseReleaseNotes(markdown)).toThrow();
  });
});
