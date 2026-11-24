import { expect, test } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invokeCmd, launchApp, newProject, rootSummary, tmpDir } from "./helpers/driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// An AV source: one import, and `add_media_layer` lays a linked video + Audio
// pair, so the layer count has more than one layer to keep.
const FIXTURE = path.resolve(__dirname, "../fixtures/media/test_1080p_30fps_audio.mp4");

interface Tracks {
  tracks: Array<{ id: string; role: string | null; layers: Array<{ id: string }> }>;
}
interface MediaSummary {
  media: Array<{ id: string; label: string; path: string; available: boolean }>;
}

const layerCount = async (page: Parameters<typeof rootSummary>[0]) =>
  (await rootSummary<Tracks>(page)).tracks.reduce((n, t) => n + t.layers.length, 0);

test.describe("packed project", () => {
  test.skip(
    !existsSync(FIXTURE),
    `AV fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  );

  test("a pack unpacked into a new folder opens with the same media available and the same layers", async () => {
    test.setTimeout(150_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-pack-src-"),
        name: "pack-source",
        canvas: { width: 640, height: 480, fpsNum: 30, fpsDen: 1 },
      });
      const mediaId = await invokeCmd<string>(page, "import_media", { path: FIXTURE });
      const aRoll = (await rootSummary<Tracks>(page)).tracks.find((t) => t.role === "a-roll");
      expect(aRoll, "the blank skeleton carries an A roll").toBeTruthy();
      await invokeCmd<string>(page, "add_media_layer", { trackId: aRoll!.id, mediaId, tStartUs: 0 });
      const layers = await layerCount(page);
      const media = (await invokeCmd<MediaSummary>(page, "project_summary")).media.map((m) => m.label).sort();
      expect(layers).toBeGreaterThan(0);
      // `import_media` answers before its copy into Media/ lands, and until
      // then the record names the source outside the folder. A pack holds the
      // folder only, so the project must carry its media before it is packed.
      const source = await invokeCmd<string>(page, "workspace_dir");
      await expect
        .poll(
          async () =>
            (await invokeCmd<MediaSummary>(page, "project_summary")).media.every(
              (m) => !path.relative(source, m.path).startsWith(".."),
            ),
          { timeout: 60_000, message: "every imported file is copied into the project's Media/" },
        )
        .toBe(true);

      const outDir = tmpDir("weftcut-pack-out-");
      const archive = path.join(outDir, "pack-source.weftcut");
      // Resolves when the pack is complete: the run is the witness.
      expect(await invokeCmd(page, "project_pack", { archive })).toMatchObject({ outcome: "done", archive });
      // Only the pack is left: its partial file was renamed, never kept.
      expect(readdirSync(outDir)).toEqual(["pack-source.weftcut"]);

      const parent = tmpDir("weftcut-unpack-");
      const dir = path.join(parent, "pack-source");
      expect(await invokeCmd(page, "project_unpack", { archive, parent })).toEqual({ outcome: "done", dir });
      await expect.poll(async () => (await invokeCmd<{ dir: string } | null>(page, "project_open_state"))?.dir).toBe(dir);

      expect(await layerCount(page)).toBe(layers);
      const unpacked = (await invokeCmd<MediaSummary>(page, "project_summary")).media;
      expect(unpacked.map((m) => m.label).sort()).toEqual(media);
      for (const m of unpacked) {
        expect(m.available, `${m.label} is available`).toBe(true);
        expect(path.relative(dir, m.path).startsWith(".."), `${m.path} is inside the unpacked folder`).toBe(false);
      }
      expect(existsSync(path.join(dir, ".gitignore"))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
