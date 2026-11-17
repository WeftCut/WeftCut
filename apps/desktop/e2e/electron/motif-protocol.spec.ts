import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

test('motif: protocol serves the library under <id>--library; a bare id is the open project\'s, so none is served without one', async () => {
  // launchApp awaits the first window, so app.whenReady() has completed and
  // the motif scheme is registered. No project is open on the start screen.
  const { app } = await launchApp()
  try {
    // Run in MAIN where net.fetch + the motif scheme are available.
    const res = await app.evaluate(async ({ net }) => {
      const ok = await net.fetch('motif://countdown--library/index.html')
      const body = await ok.text()
      const project = await net.fetch('motif://countdown/index.html')
      const miss = await net.fetch('motif://nope--library/index.html')
      return { okStatus: ok.status, hasDefine: body.includes('motif.define'), projectStatus: project.status, missStatus: miss.status }
    })
    expect(res.okStatus).toBe(200)
    expect(res.hasDefine).toBe(true)
    expect(res.projectStatus, 'a built-in id never wins over the project: with none open it names nothing').toBe(404)
    expect(res.missStatus).toBe(404)
  } finally {
    await app.close()
  }
})
