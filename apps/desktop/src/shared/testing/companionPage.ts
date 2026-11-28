// The companion page's plain-JS modules (`apps/desktop/cli/companion/ui/`) as a
// unit test loads them, in the node environment and in jsdom alike.
//
// LANDMINE: not `new URL(path, import.meta.url)`. Under jsdom Vite treats the
// test as client code and rewrites that construct into the files' dev-server
// URLs (`/cli/companion/ui/…`); against `import.meta.url` that is a path from
// the filesystem root, which only happens to resolve on POSIX and lands on the
// drive root on Windows. A relative dynamic import is resolved from this file
// in both environments.

/** `name` without its extension. The modules have no declarations, so they
 *  load untyped. */
export function companionPageModule(name: string): Promise<any> {
  return import(`../../../cli/companion/ui/${name}.js`)
}

/** The side-panel view's modules (`apps/desktop/cli/companion/panel/`), loaded
 *  the same way. `panel.js` is left out: it is the entry the build bundles,
 *  and runs only inside a host's frame. */
export function companionPanelModule(name: string): Promise<any> {
  return import(`../../../cli/companion/panel/${name}.js`)
}
