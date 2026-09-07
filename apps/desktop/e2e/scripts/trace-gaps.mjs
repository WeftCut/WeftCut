// Reads a Chromium trace recorded by `playback-perf.mjs --trace` and answers one
// question: when the renderer main thread stopped serving frames, WHAT was it
// doing? LoAF and `longtask` can only say "no script over 5 ms" — this reads the
// actual task tree, so a stall that lives in a Mojo dispatch, a GPU command-buffer
// wait, or a GC pause is named by the trace event that spans it.
//
//   node scripts/trace-gaps.mjs <trace.json> [--min-ms 30] [--top 10] [--all-threads]
//
// Output, in order:
//   1. the processes/threads it found and which it took as the renderer
//   2. renderer-main busy share, and every top-level task ≥ --min-ms with the
//      chain of nested events that owns most of its time
//   3. every GAP ≥ --min-ms between top-level tasks (the thread not running any
//      task at all), with what the GPU main thread and the renderer IO thread were
//      doing inside that gap
//   4. totals by event name on the renderer main thread (events ≥ 2 ms)
//
// Local-only diagnostic beside the harness; nothing imports it.

import fs from "node:fs";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node trace-gaps.mjs <trace.json> [--min-ms 30] [--top 10]");
  process.exit(2);
}
const argNum = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const MIN_MS = argNum("min-ms", 30);
const TOP = argNum("top", 10);
const ALL_THREADS = argv.includes("--all-threads");

const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const events = Array.isArray(raw) ? raw : raw.traceEvents;

// ── Metadata ───────────────────────────────────────────────────────────────
const procName = new Map(); // pid → name
const procLabels = new Map(); // pid → labels
const threadName = new Map(); // `${pid}:${tid}` → name
for (const e of events) {
  if (e.ph !== "M") continue;
  if (e.name === "process_name") procName.set(e.pid, e.args?.name ?? "");
  else if (e.name === "process_labels") procLabels.set(e.pid, e.args?.labels ?? "");
  else if (e.name === "thread_name") threadName.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");
}

// ── Complete events per thread (X, plus B/E folded into X) ─────────────────
const byThread = new Map(); // key → [{ts,dur,name,cat,args}]
const openStacks = new Map(); // key → stack for B/E
const push = (key, ev) => {
  let arr = byThread.get(key);
  if (!arr) byThread.set(key, (arr = []));
  arr.push(ev);
};
for (const e of events) {
  const key = `${e.pid}:${e.tid}`;
  if (e.ph === "X") {
    push(key, { ts: e.ts, dur: e.dur ?? 0, name: e.name, cat: e.cat, args: e.args });
  } else if (e.ph === "B") {
    let st = openStacks.get(key);
    if (!st) openStacks.set(key, (st = []));
    st.push(e);
  } else if (e.ph === "E") {
    const st = openStacks.get(key);
    const b = st?.pop();
    if (b) push(key, { ts: b.ts, dur: e.ts - b.ts, name: b.name, cat: b.cat, args: { ...(b.args ?? {}), ...(e.args ?? {}) } });
  }
}
for (const arr of byThread.values()) arr.sort((a, b) => a.ts - b.ts || b.dur - a.dur);

// ── Pick the renderer + its threads ─────────────────────────────────────────
const threadsNamed = (pid, name) =>
  [...threadName.entries()].filter(([k, n]) => k.startsWith(`${pid}:`) && n === name).map(([k]) => k);
const rendererPids = [...procName.entries()].filter(([, n]) => n === "Renderer").map(([pid]) => pid);
let rendererPid = null;
let best = -1;
for (const pid of rendererPids) {
  const mains = threadsNamed(pid, "CrRendererMain");
  const n = mains.reduce((s, k) => s + (byThread.get(k)?.length ?? 0), 0);
  if (n > best) { best = n; rendererPid = pid; }
}
const gpuPid = [...procName.entries()].find(([, n]) => n === "GPU Process")?.[0] ?? null;
const browserPid = [...procName.entries()].find(([, n]) => n === "Browser")?.[0] ?? null;

const fmtMs = (us) => (us / 1000).toFixed(1);
console.log(`trace: ${file}`);
console.log(`events: ${events.length}  processes: ${[...procName.entries()].map(([p, n]) => `${p}=${n}${procLabels.get(p) ? `[${procLabels.get(p)}]` : ""}`).join(" ")}`);
if (rendererPid === null) { console.error("no Renderer process with a CrRendererMain thread"); process.exit(2); }
const mainKey = threadsNamed(rendererPid, "CrRendererMain")[0];
const ioKey = threadsNamed(rendererPid, "Chrome_ChildIOThread")[0];
const compositorKey = threadsNamed(rendererPid, "Compositor")[0];
const gpuMainKey = gpuPid !== null ? threadsNamed(gpuPid, "CrGpuMain")[0] : undefined;
const gpuIoKey = gpuPid !== null ? threadsNamed(gpuPid, "Chrome_ChildIOThread")[0] : undefined;
const browserMainKey = browserPid !== null ? threadsNamed(browserPid, "CrBrowserMain")[0] : undefined;
console.log(`renderer pid ${rendererPid} (${procLabels.get(rendererPid) ?? "no label"}) main=${mainKey} io=${ioKey} compositor=${compositorKey}; gpu main=${gpuMainKey} gpu io=${gpuIoKey}; browser main=${browserMainKey}`);

if (ALL_THREADS) {
  console.log("\nthreads (events):");
  for (const [k, arr] of [...byThread.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 40))
    console.log(`  ${k.padEnd(14)} ${(threadName.get(k) ?? "?").padEnd(28)} ${arr.length}`);
}

// ── Depth-0 tasks on the renderer main thread ──────────────────────────────
const main = byThread.get(mainKey) ?? [];
const tMin = main.length ? main[0].ts : 0;
const tMax = main.reduce((m, e) => Math.max(m, e.ts + e.dur), tMin);
// A depth-0 event is one not contained by any earlier-starting, still-open
// event; the array is sorted by ts (ties: longer first), so a single sweep with
// a "current outermost end" suffices.
const top = [];
let outerEnd = -Infinity;
for (const e of main) {
  if (e.ts >= outerEnd) { top.push(e); outerEnd = e.ts + e.dur; }
}
const busyUs = top.reduce((s, e) => s + e.dur, 0);
console.log(`\nrenderer main: ${fmtMs(tMax - tMin)} ms traced · ${top.length} top-level tasks · busy ${(100 * busyUs / Math.max(1, tMax - tMin)).toFixed(1)} %`);

const describe = (e) => {
  const a = e.args ?? {};
  const bits = [];
  if (a.src_func) bits.push(a.src_func);
  if (a.src_file) bits.push(String(a.src_file).split(/[\\/]/).slice(-2).join("/"));
  const mojo = a.chrome_mojo_event_info ?? a.chrome_mojo_event_info_deprecated;
  if (mojo?.mojo_interface_tag) bits.push(`mojo:${mojo.mojo_interface_tag}${mojo.ipc_hash ? `#${mojo.ipc_hash}` : ""}`);
  if (a.data?.functionName) bits.push(`fn:${a.data.functionName}@${String(a.data.url ?? "").split("/").pop()}:${a.data.lineNumber ?? ""}`);
  if (a.data?.type) bits.push(`type:${a.data.type}`);
  if (a.name && typeof a.name === "string") bits.push(a.name);
  if (a.interface_name) bits.push(`if:${a.interface_name}`);
  if (a.method) bits.push(`m:${a.method}`);
  if (a.frame) bits.push(`frame`);
  return bits.length ? ` {${bits.join(" · ")}}` : "";
};

const childrenOf = (arr, e) => arr.filter((c) => c !== e && c.ts >= e.ts && c.ts + c.dur <= e.ts + e.dur);
const chain = (arr, e, depth = 0, out = []) => {
  const kids = childrenOf(arr, e).sort((a, b) => b.dur - a.dur);
  const directs = kids.filter((k) => !kids.some((o) => o !== k && o.ts <= k.ts && o.ts + o.dur >= k.ts + k.dur && o.dur > k.dur));
  const topKids = directs.slice(0, 3);
  for (const k of topKids) {
    out.push(`${"  ".repeat(depth + 2)}${fmtMs(k.dur)} ms  ${k.name}${describe(k)}  [${k.cat}]`);
    if (k === directs[0] && depth < 6) chain(arr, k, depth + 1, out);
  }
  return out;
};

const longTasks = top.filter((e) => e.dur >= MIN_MS * 1000).sort((a, b) => b.dur - a.dur);
console.log(`\n== top-level tasks ≥ ${MIN_MS} ms: ${longTasks.length} (showing ${Math.min(TOP, longTasks.length)} longest) ==`);
for (const e of longTasks.slice(0, TOP)) {
  console.log(`\n@${fmtMs(e.ts - tMin)} ms  ${fmtMs(e.dur)} ms  ${e.name}${describe(e)}  [${e.cat}]`);
  for (const line of chain(main, e)) console.log(line);
}

// ── Gaps between top-level tasks ───────────────────────────────────────────
const overlapping = (key, a, b, n = 5) => {
  const arr = byThread.get(key);
  if (!arr) return [];
  return arr
    .filter((e) => e.ts < b && e.ts + e.dur > a && e.dur >= 1000)
    .sort((x, y) => y.dur - x.dur)
    .slice(0, n);
};
const gaps = [];
for (let i = 1; i < top.length; i++) {
  const gap = top[i].ts - (top[i - 1].ts + top[i - 1].dur);
  if (gap >= MIN_MS * 1000) gaps.push({ a: top[i - 1].ts + top[i - 1].dur, b: top[i].ts, gap, prev: top[i - 1], next: top[i] });
}
gaps.sort((x, y) => y.gap - x.gap);
console.log(`\n== gaps ≥ ${MIN_MS} ms with NO top-level task on renderer main: ${gaps.length} (showing ${Math.min(TOP, gaps.length)} longest) ==`);
for (const g of gaps.slice(0, TOP)) {
  console.log(`\n@${fmtMs(g.a - tMin)} ms  gap ${fmtMs(g.gap)} ms   after: ${g.prev.name}${describe(g.prev)} (${fmtMs(g.prev.dur)} ms)   before: ${g.next.name}${describe(g.next)} (${fmtMs(g.next.dur)} ms)`);
  for (const [label, key] of [["gpu main", gpuMainKey], ["gpu io", gpuIoKey], ["renderer io", ioKey], ["compositor", compositorKey], ["browser main", browserMainKey]]) {
    if (!key) continue;
    const ov = overlapping(key, g.a, g.b);
    if (ov.length) console.log(`    ${label}: ${ov.map((e) => `${e.name}${describe(e)} ${fmtMs(e.dur)}ms@${fmtMs(e.ts - tMin)}`).join(" | ")}`);
  }
}

// ── Totals by name (renderer main, events ≥ 2 ms) ──────────────────────────
const totals = new Map();
for (const e of main) {
  if (e.dur < 2000) continue;
  const k = `${e.name}${e.args?.src_func ? ` {${e.args.src_func}}` : ""}${e.args?.data?.functionName ? ` {fn:${e.args.data.functionName}}` : ""}`;
  const t = totals.get(k) ?? { n: 0, dur: 0, max: 0 };
  t.n++; t.dur += e.dur; t.max = Math.max(t.max, e.dur);
  totals.set(k, t);
}
console.log(`\n== renderer main, events ≥ 2 ms, by total duration (top ${TOP * 2}) ==`);
for (const [k, t] of [...totals.entries()].sort((a, b) => b[1].dur - a[1].dur).slice(0, TOP * 2))
  console.log(`  ${fmtMs(t.dur).padStart(9)} ms  n=${String(t.n).padStart(5)}  max ${fmtMs(t.max).padStart(7)} ms  ${k}`);

// ── GPU main: long events (the other half of a cross-process wait) ─────────
if (gpuMainKey) {
  const gpu = byThread.get(gpuMainKey) ?? [];
  const longGpu = gpu.filter((e) => e.dur >= 10_000).sort((a, b) => b.dur - a.dur).slice(0, TOP);
  console.log(`\n== GPU main thread events ≥ 10 ms (${longGpu.length} shown) ==`);
  for (const e of longGpu) console.log(`  @${fmtMs(e.ts - tMin)} ms  ${fmtMs(e.dur)} ms  ${e.name}${describe(e)}  [${e.cat}]`);
}
