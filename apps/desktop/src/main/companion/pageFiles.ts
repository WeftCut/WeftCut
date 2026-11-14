// apps/desktop/src/main/companion/pageFiles.ts
//
// The companion page's files as the app serves them, bundled into main at build
// time. They live in `apps/desktop/cli/companion/`, plain ES modules with no
// build step, so the `weftcut` binary's module can embed the same files.
import pageHtml from '../../../cli/companion/page.html?raw'
import pageJs from '../../../cli/companion/ui/page.js?raw'
import appJs from '../../../cli/companion/ui/app.js?raw'
import viewStateJs from '../../../cli/companion/ui/viewState.js?raw'
import timelineJs from '../../../cli/companion/ui/timeline.js?raw'
import stringsJs from '../../../cli/companion/ui/strings.js?raw'
import transportLoopbackJs from '../../../cli/companion/ui/transportLoopback.js?raw'
import appCss from '../../../cli/companion/ui/app.css?raw'

export interface PageFile { body: string; type: string }

const JS = 'text/javascript; charset=utf-8'

export const PAGE_HTML: PageFile = { body: pageHtml, type: 'text/html; charset=utf-8' }

/** `GET /companion/ui/<name>`. Flat: a name never holds a `/`. */
export const UI_FILES: ReadonlyMap<string, PageFile> = new Map([
  ['page.js', { body: pageJs, type: JS }],
  ['app.js', { body: appJs, type: JS }],
  ['viewState.js', { body: viewStateJs, type: JS }],
  ['timeline.js', { body: timelineJs, type: JS }],
  ['strings.js', { body: stringsJs, type: JS }],
  ['transportLoopback.js', { body: transportLoopbackJs, type: JS }],
  ['app.css', { body: appCss, type: 'text/css; charset=utf-8' }],
])

/** The page loads its own files and talks to its own origin, nothing else:
 *  no inline script or style, so a label that reached the DOM as markup could
 *  not run. */
export const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"
