import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PANEL_HTML, renderPanelHtml } from './build-side-panel-lib.mjs'

// The view's `ui://` address is a hash of this file (docs/adr/0186): a host
// keeps a view by its address, so a change to the UI that skipped the
// regeneration would reach no one already holding the old view.
test('the committed side-panel view is what its sources build', async () => {
  assert.ok(
    readFileSync(PANEL_HTML, 'utf8') === (await renderPanelHtml()),
    'cli/companion/panel/panel.html is stale: run `node scripts/build-side-panel.mjs` in apps/desktop and commit it',
  )
})

test('the view loads nothing: no script, style or image is fetched', async () => {
  const html = await renderPanelHtml()
  assert.doesNotMatch(html, /<script[^>]+src=/)
  assert.doesNotMatch(html, /<link[^>]+href=/)
  // The one image the UI shows, the app icon, travels inside the document.
  assert.doesNotMatch(html, /\/companion\/ui\/icon\.svg['"]/)
  // A stylesheet reference names a fragment or carries its data, nothing else.
  assert.doesNotMatch(html, /url\((?!['"]?(#|%23|data:))/)
})
