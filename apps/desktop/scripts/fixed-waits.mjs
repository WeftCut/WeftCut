// The table of fixed waits in the tests (scripts/fixed-waits.json) and the
// count it is checked against. `node scripts/fixed-waits.mjs --write`
// regenerates the table; see docs/agents/testing.md § Assert the intent, not a
// measurement.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export const tablePath = fileURLToPath(new URL('./fixed-waits.json', import.meta.url))

/** A wait whose length is a number written at the call. One named by a
 * constant is not counted: the constant is where its reason is written. */
const FIXED_WAIT = /\bwaitForTimeout\(\s*[\d_]+\s*\)|\bsetTimeout\(\s*\w+\s*,\s*[\d_]+\s*\)|\b(?:sleep|wait|delay)\(\s*[\d_]+\s*\)/g

/** The E2E specs with their helpers, and the unit tests. */
const SCOPES = [
  { directory: 'e2e/electron', test: name => name.endsWith('.ts') },
  { directory: 'src', test: name => /\.(test|spec)\.tsx?$/.test(name) },
]

async function filesUnder(directory, test) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(file, test)
    return entry.isFile() && test(entry.name) ? [file] : []
  }))
  return nested.flat()
}

/** Fixed waits per file, keyed by its path under apps/desktop, files without one left out. */
export async function countFixedWaits() {
  const counts = {}
  for (const { directory, test } of SCOPES) {
    for (const file of await filesUnder(path.join(root, directory), test)) {
      const found = (await readFile(file, 'utf8')).match(FIXED_WAIT)?.length ?? 0
      if (found) counts[path.relative(root, file).split(path.sep).join('/')] = found
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    await writeFile(tablePath, `${JSON.stringify(await countFixedWaits(), null, 2)}\n`)
  } else {
    console.log(JSON.stringify(await countFixedWaits(), null, 2))
  }
}
