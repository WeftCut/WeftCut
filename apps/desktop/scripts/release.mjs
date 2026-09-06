import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export function validateVersion(version) {
  if (typeof version !== 'string' || !STABLE.test(version)) {
    throw new Error(`Expected a stable SemVer without leading zeroes, got ${version}`)
  }
  return version
}
export function compareVersions(a, b) {
  const left = validateVersion(a).split('.').map(BigInt)
  const right = validateVersion(b).split('.').map(BigInt)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  }
  return 0
}
export function planRelease(version, releases) {
  validateVersion(version)
  const published = releases.filter(r => !r.isDraft && STABLE.test(r.tagName?.slice(1)) && r.tagName.startsWith('v'))
  if (published.some(r => compareVersions(version, r.tagName.slice(1)) < 0)) {
    throw new Error('Release version must not go backwards')
  }
  return version !== '0.0.0' && !published.some(r => r.tagName === `v${version}`)
}

async function readPackages(root) {
  return Promise.all(['package.json', 'apps/desktop/package.json', 'package-lock.json']
    .map(async file => [file, JSON.parse(await fs.readFile(path.join(root, file), 'utf8'))]))
}
export async function readVersion(root = ROOT) {
  const [[, top], [, desktop], [, lock]] = await readPackages(root)
  const version = validateVersion(desktop.version)
  if ([top.version, lock.version, lock.packages[''].version, lock.packages['apps/desktop'].version]
    .some(v => v !== version)) throw new Error('Package and lockfile versions differ; run npm run version:release -- <version>')
  return version
}
export async function setVersion(version, root = ROOT) {
  validateVersion(version)
  const entries = await readPackages(root)
  if (compareVersions(version, entries[1][1].version) <= 0) throw new Error('New version must increase')
  for (const [file, data] of entries) {
    data.version = version
    if (file === 'package-lock.json') {
      data.packages[''].version = version
      data.packages['apps/desktop'].version = version
    }
    await fs.writeFile(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`)
  }
}

// One update manifest per OS, and the installers it must reference.
// electron-builder expands `${arch}` per target: `x64` on Windows and `arm64` on
// macOS (the Apple Silicon runner's host arch; there is no Intel build), but the
// Linux targets keep their packaging conventions — `x86_64` for AppImage and
// `amd64` for deb — even though both build with arch=x64.
const MANIFESTS = {
  'latest.yml': ['x64.exe'],
  'latest-linux.yml': ['x86_64.AppImage', 'amd64.deb'],
  'latest-mac.yml': ['arm64.dmg'],
}
const installersOf = version => Object.fromEntries(Object.entries(MANIFESTS)
  .map(([manifest, suffixes]) => [manifest, suffixes.map(suffix => `WeftCut-${version}-${suffix}`)]))

// Refuse a partial or stale release BEFORE creating/uploading a draft. Stream
// hashes: an installer can approach 1 GB and must not be buffered into memory.
export async function validateAssets(directory, version) {
  validateVersion(version)
  const { parse } = await import('yaml')
  const installers = installersOf(version)
  // The NSIS blockmap drives differential Windows updates, so it is required;
  // electron-builder writes AppImage and DMG blockmaps too, but nothing
  // consumes them (Linux updates download whole, macOS does not self-update).
  const required = [
    ...Object.values(installers).flat(), `WeftCut-${version}-x64.exe.blockmap`, ...Object.keys(installers),
  ]
  const names = await fs.readdir(directory)
  for (const file of required) {
    if (!names.includes(file) || !(await fs.stat(path.join(directory, file))).isFile()) {
      throw new Error(`Missing release asset: ${file}`)
    }
  }
  const allowed = new Set([
    ...required, `WeftCut-${version}-x86_64.AppImage.blockmap`, `WeftCut-${version}-arm64.dmg.blockmap`,
  ])
  for (const name of names) {
    if (!allowed.has(name)) throw new Error(`Unexpected release asset: ${name}`)
  }
  for (const [manifest, expected] of Object.entries(installers)) {
    const info = parse(await fs.readFile(path.join(directory, manifest), 'utf8'))
    if (info?.version !== version || !Array.isArray(info.files) || !info.files.length) {
      throw new Error(`Invalid version/files in ${manifest}`)
    }
    const referenced = new Set()
    for (const file of info.files) {
      const name = decodeURIComponent(file.url)
      if (!expected.includes(name)) throw new Error(`Unexpected file in ${manifest}: ${name}`)
      referenced.add(name)
      const absolute = path.join(directory, name)
      const stat = await fs.stat(absolute)
      if (file.size !== stat.size) throw new Error(`Size mismatch: ${name}`)
      const hash = createHash('sha512')
      for await (const chunk of createReadStream(absolute)) hash.update(chunk)
      if (hash.digest('base64') !== file.sha512) throw new Error(`Checksum mismatch: ${name}`)
    }
    if (expected.some(name => !referenced.has(name))) throw new Error(`Incomplete ${manifest}`)
  }
  return names.map(name => path.join(directory, name))
}

// Prepended to every release's generated changelog (gh puts --notes ahead of
// the notes it generates). The releases page is the only download page, and the
// macOS steps are not guessable: the build is ad-hoc signed, not notarized, so
// Gatekeeper blocks the first launch (electron-builder.yml §mac has the why).
export function releaseNotes(version) {
  const { 'latest.yml': [exe], 'latest-linux.yml': [appImage, deb], 'latest-mac.yml': [dmg] } = installersOf(version)
  const code = text => '`' + text + '`'
  return [
    '## Install',
    '',
    `- **Windows** — run ${code(exe)}. The app keeps itself current: new versions download in the background and install when you quit.`,
    `- **Linux** — ${code(appImage)} (mark it executable first) or ${code(deb)}. Self-updates like Windows.`,
    `- **macOS (Apple Silicon, macOS 13 or newer)** — open ${code(dmg)} and drag WeftCut into Applications. ` +
      'The build is ad-hoc signed and not notarized (WeftCut has no Apple Developer ID), so macOS blocks the first launch: ' +
      'open the app once, click **Done**, then go to **System Settings → Privacy & Security** and click **Open Anyway**. ' +
      'If macOS calls the app *damaged* instead, clear the download quarantine in Terminal and open it again:',
    '',
    '  ```sh',
    '  xattr -dr com.apple.quarantine /Applications/WeftCut.app',
    '  ```',
    '',
    '  macOS builds do not self-update; watch this page for new versions.',
    '',
  ].join('\n')
}

function gh(args) {
  return execFileSync('gh', [...args, '--repo', process.env.GITHUB_REPOSITORY], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function listReleases() {
  return JSON.parse(gh(['release', 'list', '--limit', '1000', '--json', 'tagName,isDraft']))
}
async function main() {
  const [command, arg] = process.argv.slice(2)
  if (command === 'version') return setVersion(arg)
  const version = await readVersion()
  if (command === 'validate') return console.log(`Release version: ${version}`)
  if (!process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required')
  if (command === 'plan') {
    const publish = planRelease(version, listReleases())
    await fs.appendFile(process.env.GITHUB_OUTPUT, `version=${version}\npublish=${publish}\n`)
    console.log(`${version}: ${publish ? 'publish after all CI gates pass' : 'already released'}`)
    return
  }
  if (command !== 'publish') throw new Error(`Unknown release command: ${command}`)
  if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')) throw new Error('GITHUB_SHA is required')
  const files = await validateAssets(path.resolve(arg), version)
  const releases = listReleases()
  if (!planRelease(version, releases)) return console.log(`${version} already published; leaving it untouched`)
  const tag = `v${version}`
  if (releases.some(r => r.tagName === tag)) {
    const draft = JSON.parse(gh(['release', 'view', tag, '--json', 'targetCommitish']))
    if (draft.targetCommitish !== process.env.GITHUB_SHA) throw new Error('Existing draft belongs to another commit; remove the draft before retrying')
  } else {
    // A pre-existing tag could point at a different commit. Refuse it; this
    // pipeline owns its version tags, created with the draft at this exact SHA.
    const remote = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' }).trim()
    if (remote) throw new Error(`Tag ${tag} already exists without a matching draft`)
    gh(['release', 'create', tag, '--target', process.env.GITHUB_SHA, '--draft', '--title', `WeftCut ${version}`,
      '--generate-notes', '--notes', releaseNotes(version)])
  }
  gh(['release', 'upload', tag, ...files, '--clobber'])
  // The update provider sees the release only once every OS is complete.
  gh(['release', 'edit', tag, '--draft=false', '--latest'])
  console.log(`Published ${tag}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
