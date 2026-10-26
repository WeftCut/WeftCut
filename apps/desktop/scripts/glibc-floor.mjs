// The oldest glibc the Linux package must load on, and the check that holds
// the shipped native code to it (issue #73).
//
// 2.28 is the highest requirement among the files that must load for the app
// to start: Electron itself needs 2.25 and the BtbN libav* set needs 2.28. Our
// own two addons are linked against napi-rs's glibc 2.17 sysroot
// (napi-linux-sysroot.mjs), so they sit well under it. The bundled libva is NOT
// held to it: ffmpeg dlopens it lazily for the optional VAAPI lane, and an older
// glibc only costs that lane (software decode remains).
//
// Two rules, both read from `objdump -T`:
//   1. No undefined symbol may need a GLIBC_x.y version above the floor.
//   2. No STRONG undefined symbol may be unversioned. A cross link whose C was
//      compiled by the host compiler instead of the sysroot's leaves exactly
//      that behind (`__isoc23_sscanf` from a C23-default gcc, `renameat2` from a
//      wrapper the sysroot's libc lacks): rule 1 cannot see it, yet the loader
//      refuses the library wherever the symbol is missing. Weak references are
//      fine — Rust std probes for newer libc functions that way and falls back.
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

export const GLIBC_FLOOR = '2.28'

/** Numeric compare of dotted versions ('2.9' < '2.28'). */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// An undefined entry: address, the 7 flag columns, *UND*, a tab, the size,
// then either "(VERSION) name" or padding and the bare name.
const UND = /^[0-9a-f]+ (.{7}) \*UND\*\t[0-9a-f]+ +(?:\(([^)]+)\) +)?(\S+)$/

/**
 * Pure: the violations in one library's `objdump -T` output, as readable lines.
 * Empty when the library holds to `floor`.
 */
export function glibcViolations(objdumpText, floor = GLIBC_FLOOR) {
  const violations = []
  for (const line of objdumpText.split('\n')) {
    const m = UND.exec(line)
    if (!m) continue
    const [, flags, version, name] = m
    if (version) {
      const glibc = /^GLIBC_(\d+(?:\.\d+)+)$/.exec(version)
      if (glibc && compareVersions(glibc[1], floor) > 0) {
        violations.push(`${name} needs ${version}`)
      }
    } else if (flags[1] !== 'w') {
      violations.push(`${name} is a strong unversioned import`)
    }
  }
  return violations
}

/**
 * Run the check over `files`, throwing one error that names every violation.
 * `label` prefixes the message so the caller (a build wrapper, afterPack) is
 * identifiable in a long log.
 */
export function assertGlibcFloor(files, { label, floor = GLIBC_FLOOR } = {}) {
  if (files.length === 0) throw new Error(`${label} no Linux libraries to check — the glob that finds them no longer matches.`)
  const failures = []
  for (const file of files) {
    let text
    try {
      text = execFileSync('objdump', ['-T', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    } catch (e) {
      throw new Error(`${label} could not run \`objdump -T ${file}\` (install binutils): ${e.message}`)
    }
    const violations = glibcViolations(text, floor)
    if (violations.length) failures.push(`  ${basename(file)}:\n${violations.map((v) => `    ${v}`).join('\n')}`)
  }
  if (failures.length) {
    throw new Error(
      `${label} these libraries would not load on glibc ${floor} (issue #73):\n${failures.join('\n')}\n` +
        'A versioned need above the floor means a newer libc symbol was linked; an unversioned strong import ' +
        'usually means C code was compiled by the host compiler instead of the sysroot toolchain ' +
        '(see scripts/napi-linux-sysroot.mjs).',
    )
  }
}
