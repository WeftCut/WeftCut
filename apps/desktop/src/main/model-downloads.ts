import path from "node:path";
import fs from "node:fs";
import { CONTENT_CATALOG } from "../shared/content-catalog";
import type { ModelProfile } from "../shared/inference-models";
import { removePartial, type ContentDeps } from "./contentDownload";

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function real(file: string): string { try { return fs.realpathSync(file); } catch { return path.resolve(file); } }

export function createModelDownloads(content: ContentDeps) {
  const root = path.resolve(content.downloadsDir);
  const directory = (id: string) => {
    if (!CONTENT_CATALOG.some(item => item.id === id)) throw new Error("Unknown content");
    const target = path.resolve(root, id);
    if (target === root || !within(root, target) || !within(real(root), real(target))) throw new Error("Unsafe download path");
    return target;
  };
  const bytes = (file: string): number => {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return 0;
      return stat.isDirectory() ? fs.readdirSync(file).reduce((n, name) => n + bytes(path.join(file, name)), 0) : stat.size;
    } catch { return 0; }
  };
  return {
    downloadedBytes: (id: string) => bytes(directory(id)) + bytes(path.join(content.partialDir, `${id}.part`)),
    referencesContent: (profile: ModelProfile, id: string) => {
      const target = directory(id);
      return [profile.local?.binary, profile.local?.model, profile.local?.tokens, profile.local?.mmproj]
        .some(file => !!file && (within(target, path.resolve(file)) || within(real(target), real(file))));
    },
    removeContent: (id: string) => {
      const target = directory(id);
      const partial = path.resolve(content.partialDir, `${id}.part`);
      if (!within(path.resolve(content.partialDir), partial)) throw new Error("Unsafe partial path");
      content.fs.rm(target);
      removePartial(content, id);
    },
  };
}
