// Times the project-open inventory walk the way MotifFrameStore.inventory()
// does it (open each frame file, read its 20-byte header, stat, close) against
// a stat-only walk. Run it on a cache that has not been touched since boot to
// see the cold cost, then again for the warm cost.
//   node inventory-walk.cjs <workspace>/Cache/raster
const fs = require('node:fs/promises'); const path = require('node:path');
async function frames(root) {
  const out = [];
  for (const d of await fs.readdir(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    for (const e of await fs.readdir(dir, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.wfrm')) out.push(path.join(dir, e.name));
  }
  return out;
}
async function statOnly(files) { const t = performance.now(); for (const f of files) await fs.stat(f); return Math.round(performance.now() - t); }
async function openReadStat(files) {
  const t = performance.now();
  for (const f of files) { const fh = await fs.open(f, 'r'); try { await fh.read(Buffer.alloc(20), 0, 20, 0); await fh.stat(); } finally { await fh.close(); } }
  return Math.round(performance.now() - t);
}
(async () => {
  const files = await frames(process.argv[2]);
  const statColdMs = await statOnly(files);
  const openColdMs = await openReadStat(files);
  const openWarmMs = await openReadStat(files);
  console.log(JSON.stringify({ files: files.length, statColdMs, openColdMs, openWarmMs, openColdPerFileMs: +(openColdMs / files.length).toFixed(2) }));
})();
