import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { countFixedWaits, tablePath } from './fixed-waits.mjs'

test('no test gained a fixed wait without the table saying so', async () => {
  const table = JSON.parse(await readFile(tablePath, 'utf8'))
  const counts = await countFixedWaits()
  const changed = [...new Set([...Object.keys(table), ...Object.keys(counts)])]
    .filter(file => (table[file] ?? 0) !== (counts[file] ?? 0))
    .map(file => `  ${file}: ${table[file] ?? 0} in the table, ${counts[file] ?? 0} in the file`)
  assert.deepEqual(changed, [], [
    'The fixed waits in these tests changed:',
    ...changed,
    'A new one should wait for a witness instead (docs/agents/testing.md § Assert the intent, not a measurement).',
    'For a pacing interval or a quiet window, or after removing one, run `node scripts/fixed-waits.mjs --write` and commit the table.',
  ].join('\n'))
})
