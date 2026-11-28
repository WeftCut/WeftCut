/// Regenerate `cli/companion/panel/panel.html`, the side-panel view both
/// servers embed (the `weftcut` binary and the app). Run it after changing
/// anything under `cli/companion/panel/` or `cli/companion/ui/`, and commit the
/// result: `build-side-panel.test.mjs` fails while the committed file is stale.
import { writeFileSync } from 'node:fs'
import { PANEL_HTML, renderPanelHtml } from './build-side-panel-lib.mjs'

writeFileSync(PANEL_HTML, await renderPanelHtml())
console.log(`wrote ${PANEL_HTML}`)
