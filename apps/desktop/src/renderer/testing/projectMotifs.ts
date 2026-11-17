// Renderer tests whose project holds the built-in Motifs. The render catalog
// resolves only the open project's Motifs (render/motifs/catalog.ts), so a
// test that places `countdown` seeds the catalog with the built-ins under
// their own ids, as placing them from the library would.
import { BUILTIN_MANIFESTS } from "../../shared/motifs/catalog";
import { setProjectMotifs } from "../render/motifs/catalog";

export function holdBuiltinMotifs(): void {
  setProjectMotifs([...BUILTIN_MANIFESTS.values()]);
}
