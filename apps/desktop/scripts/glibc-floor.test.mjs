import assert from 'node:assert/strict'
import { test } from 'node:test'
import { glibcViolations } from './glibc-floor.mjs'

/// `objdump -T` output around the given symbol lines, as the real tool prints
/// it: a file header, then one entry per line with a tab before the size.
const dump = (...lines) =>
  `\nlib.node:     file format elf64-x86-64\n\nDYNAMIC SYMBOL TABLE:\n${lines.join('\n')}\n`

const und = (version, name, flags = '     DF') =>
  `0000000000000000 ${flags} *UND*\t0000000000000000 ${version ? `(${version}) ` : '             '}${name}`

test('imports at or under the floor pass, whatever their library', () => {
  const text = dump(
    und('GLIBC_2.2.5', 'mprotect'),
    und('GLIBC_2.28', 'fcntl64'),
    und('LIBAVFORMAT_62', 'avformat_open_input'),
    und('GCC_3.0', '_Unwind_SetGR'),
    '000000000011aa60 g    DF .text\t00000000000000ac  LIBAVUTIL_60 av_log',
  )
  assert.deepEqual(glibcViolations(text), [])
})

test('a host-glibc link is named symbol by symbol (the v0.5.3 core addon)', () => {
  const text = dump(und('GLIBC_2.34', 'dlopen'), und('GLIBC_2.38', '__isoc23_sscanf'), und('GLIBC_2.39', 'pidfd_spawnp'))
  assert.deepEqual(glibcViolations(text), [
    'dlopen needs GLIBC_2.34',
    '__isoc23_sscanf needs GLIBC_2.38',
    'pidfd_spawnp needs GLIBC_2.39',
  ])
})

test('versions compare numerically, not as strings', () => {
  assert.deepEqual(glibcViolations(dump(und('GLIBC_2.9', 'pipe2'))), [])
  assert.deepEqual(glibcViolations(dump(und('GLIBC_2.3.4', 'x'))), [])
  assert.deepEqual(glibcViolations(dump(und('GLIBC_2.28', 'fcntl64')), '2.27'), ['fcntl64 needs GLIBC_2.28'])
})

// The sysroot link that compiled aws-lc with the host gcc: the version check
// alone saw nothing above 2.16 in this library, yet it cannot load before 2.38.
test('a strong unversioned import fails even when every version is old', () => {
  const text = dump(und('GLIBC_2.16', 'memcpy'), und(null, '__isoc23_sscanf', '     D '), und(null, 'renameat2', '     D '))
  assert.deepEqual(glibcViolations(text), [
    '__isoc23_sscanf is a strong unversioned import',
    'renameat2 is a strong unversioned import',
  ])
})

test("weak unversioned imports are Rust std's runtime probes and pass", () => {
  const text = dump(und(null, 'pidfd_spawnp', '  w   D '), und(null, '__gmon_start__', '  w   D '))
  assert.deepEqual(glibcViolations(text), [])
})
