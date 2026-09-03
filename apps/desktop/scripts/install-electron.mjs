// Installs the Electron binary. The repo sets `ignore-scripts=true` in .npmrc,
// so `npm install` never runs electron's own postinstall (install.js), which is
// what downloads dist/. This script runs it explicitly, skipping the download
// only when the binary already present matches the pinned version.
//
// LANDMINE: the skip must compare versions, not just test for dist/. After a
// version bump an incremental `npm install` leaves the previous dist/ in place,
// and an existence check would silently run every e2e against the old engine.
//
// Honors electron's standard env vars (ELECTRON_MIRROR, electron_config_cache,
// ...) for machines that need a mirror to reach the GitHub release artifacts.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = join(HERE, '..') // apps/desktop

const require = createRequire(join(root, 'package.json'))
const electronPkgDir = dirname(require.resolve('electron/package.json'))
const version = require('electron/package.json').version
const distDir = join(electronPkgDir, 'dist')

// Mirror electron/index.js's own check: path.txt names the executable inside dist/.
const pathFile = join(electronPkgDir, 'path.txt')
const executable =
  existsSync(pathFile) && join(distDir, readFileSync(pathFile, 'utf8').trim())

// dist/version is written by electron's own install.js next to the binary.
const versionFile = join(distDir, 'version')
const presentVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : null

if (executable && existsSync(executable) && presentVersion === version) {
  console.log(`electron:install — electron@${version} binary already present, skipping.`)
  process.exit(0)
}

if (executable && existsSync(executable)) {
  console.log(
    `electron:install — present binary is electron@${presentVersion ?? 'unknown'}, ` +
      `pinned is ${version}; replacing dist/.`,
  )
  rmSync(distDir, { recursive: true, force: true })
}

console.log(`electron:install — downloading electron@${version} binary...`)
const result = spawnSync(process.execPath, [join(electronPkgDir, 'install.js')], {
  stdio: 'inherit',
  cwd: electronPkgDir,
  env: process.env,
})
if (result.error) throw result.error
if (result.status !== 0) {
  console.error(
    'electron:install — download failed. If github.com is unreachable, set ELECTRON_MIRROR ' +
      '(e.g. https://npmmirror.com/mirrors/electron/) and retry.',
  )
  process.exit(result.status ?? 1)
}
