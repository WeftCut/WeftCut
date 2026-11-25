// The short notes the app shows after an update: docs/release-notes/in-app/<version>.md,
// bundled at build time, parsed into a small block tree. See docs/releases.md.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string };

export interface ListItem {
  inlines: Inline[];
  children: ListItem[];
}

export type Block =
  | { kind: "heading"; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; items: ListItem[] };

const BUNDLED = import.meta.glob<string>("../../../../../docs/release-notes/in-app/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const NOTES_BY_VERSION = new Map(
  Object.entries(BUNDLED).map(([file, text]) => [file.slice(file.lastIndexOf("/") + 1, -".md".length), text]),
);

export function bundledReleaseNotes(): ReadonlyMap<string, string> {
  return NOTES_BY_VERSION;
}

export interface ReleaseNotes {
  version: string;
  markdown: string;
}

/// The notes that describe the running version: the newest notes at or below
/// it. Only versions that change something carry notes, and an update lands
/// on the latest patch, so 0.9.0's notes still describe 0.9.1.
export function currentReleaseNotes(
  appVersion: string,
  notes: ReadonlyMap<string, string> = NOTES_BY_VERSION,
): ReleaseNotes | null {
  let best: ReleaseNotes | null = null;
  for (const [version, markdown] of notes) {
    if (compareVersions(version, appVersion) > 0) continue;
    if (best === null || compareVersions(version, best.version) > 0) best = { version, markdown };
  }
  return best;
}

/// The notes to open at launch, or null once the user has closed them (or any
/// newer ones).
export function launchReleaseNotes(
  appVersion: string,
  seenVersion: string | undefined,
  notes: ReadonlyMap<string, string> = NOTES_BY_VERSION,
): ReleaseNotes | null {
  const current = currentReleaseNotes(appVersion, notes);
  if (current === null) return null;
  if (seenVersion !== undefined && compareVersions(seenVersion, current.version) >= 0) return null;
  return current;
}

/// Plain x.y.z versions (docs/releases.md); a missing part counts as 0.
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// The notes also become the GitHub release body, so they are plain markdown;
// this reads only the part of it they use and throws on anything else, so a
// construct the dialog would garble fails the bundled-notes test instead.
const UNSUPPORTED_LINE = /^\s*(#(?!## |# )|>|\d+\.\s|```|\||[*+]\s)/;

export function parseReleaseNotes(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { indent: number; item: ListItem; text: string[] }[] | null = null;
  let roots: ListItem[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", inlines: parseInlines(paragraph.join(" ")) });
    paragraph = [];
  };
  const closeItems = (toDepth: number) => {
    while (list && list.length > toDepth) {
      const open = list.pop()!;
      open.item.inlines = parseInlines(open.text.join(" "));
    }
  };
  const flushList = () => {
    if (!list) return;
    closeItems(0);
    blocks.push({ kind: "list", items: roots });
    list = null;
    roots = [];
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") {
      flushParagraph();
      continue;
    }
    if (UNSUPPORTED_LINE.test(line) || /\[[^\]]*\]\(/.test(line)) {
      throw new Error(`Unsupported release-notes markdown: ${line}`);
    }
    const heading = /^#{2,3} (.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", inlines: parseInlines(heading[1]!) });
      continue;
    }
    const bullet = /^( *)- (.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      const indent = bullet[1]!.length;
      list ??= [];
      while (list.length > 0 && list[list.length - 1]!.indent >= indent) closeItems(list.length - 1);
      const item: ListItem = { inlines: [], children: [] };
      if (list.length === 0) {
        if (indent !== 0) throw new Error(`Indented list item without a parent: ${line}`);
        roots.push(item);
      } else {
        list[list.length - 1]!.item.children.push(item);
      }
      list.push({ indent, item, text: [bullet[2]!] });
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (list && list.length > 0 && paragraph.length === 0) {
      // A continuation line belongs to the deepest item it is indented under.
      while (list.length > 0 && indent <= list[list.length - 1]!.indent) closeItems(list.length - 1);
      if (list.length > 0) {
        list[list.length - 1]!.text.push(line.trim());
        continue;
      }
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

const INLINE = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;

function parseInlines(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ kind: "strong", text: match[1] });
    else if (match[2] !== undefined) out.push({ kind: "em", text: match[2] });
    else out.push({ kind: "code", text: match[3]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  // Marks do not nest: a stray `*` or backtick, outside a mark or inside one,
  // would show literally.
  if (out.some((part) => part.kind !== "code" && /[*`]/.test(part.text))) {
    throw new Error(`Unbalanced or nested emphasis or code in release notes: ${text}`);
  }
  return out;
}
