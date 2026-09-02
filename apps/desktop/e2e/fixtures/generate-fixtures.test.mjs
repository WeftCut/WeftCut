import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inflateSync } from 'node:zlib'

import { MATRIX, ensureFixtures } from './generate-fixtures.mjs'
import {
  drawtextFontFile,
  generateFixture,
  outputName,
  recipeOf,
  runFfmpeg,
} from './generate.mjs'

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function decodeRgbaPng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const imageData = []
  let width
  let height
  let offset = 8

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const checksum = buffer.readUInt32BE(dataEnd)
    assert.equal(checksum, crc32(buffer.subarray(offset + 4, dataEnd)), `${type} CRC`)

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart)
      height = buffer.readUInt32BE(dataStart + 4)
      assert.equal(buffer[dataStart + 8], 8)
      assert.equal(buffer[dataStart + 9], 6)
    } else if (type === 'IDAT') {
      imageData.push(buffer.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }

  return { width, height, scanlines: inflateSync(Buffer.concat(imageData)) }
}

/// Stand in for the real generator: write every file the entry's recipe claims,
/// tagged with `marker` so a later pass can tell regenerated from untouched.
function fakeGenerator(marker, generated) {
  return (entry, { outputDir }) => {
    generated.push(outputName(entry))
    for (const file of recipeOf(entry).files) {
      writeFileSync(path.join(outputDir, file), marker)
    }
  }
}

/// The threshold the editor's shot detector scans the floor at. Candidates are
/// read at the floor because that is the widest net: anything the fixture is
/// expected NOT to yield shows up here or nowhere.
const SCENE_FLOOR = 0.05
/// One frame of the shot fixture (30 fps). Candidate times are held to frame
/// granularity: a metric that moved would displace a candidate by whole frames,
/// while the `pts_time` ffmpeg prints is rounded.
const SHOT_FRAME_US = 1_000_000 / 30

/// Every other test here injects `run` and encodes nothing, so this is the one
/// place the suite needs a real ffmpeg. Without it the fixture cannot be
/// produced either, so there is nothing to measure rather than something
/// unmeasured.
function ffmpegOnPath() {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' })

  return !probe.error && probe.status === 0
}

/// The scene-cut candidates ffmpeg finds in `mediaPath`, read with the same
/// filter chain the editor's detector runs. Returned in stream order.
function sceneCandidates(mediaPath) {
  const probe = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-i', mediaPath,
      '-vf', `select='gt(scene,${SCENE_FLOOR})',metadata=print`,
      '-an', '-f', 'null', '-',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(probe.error, undefined)
  assert.equal(probe.status, 0, `ffmpeg failed:\n${probe.stderr}`)

  // `metadata=print` writes a frame line then a score line per candidate, both
  // to stderr and interleaved with ffmpeg's own banner and progress output — so
  // each is matched on its own and the score attaches to the frame before it.
  const candidates = []
  for (const line of probe.stderr.split(/\r?\n/)) {
    const time = /\bpts_time:(\d+(?:\.\d+)?)/.exec(line)
    if (time) candidates.push({ timeUs: Math.round(Number(time[1]) * 1_000_000) })
    const score = /\blavfi\.scene_score=(\d+(?:\.\d+)?)/.exec(line)
    if (score) candidates.at(-1).score = Number(score[1])
  }

  return candidates
}

async function withCapturedLogs(run) {
  const original = console.log
  const lines = []

  console.log = (...parts) => lines.push(parts.join(' '))
  try {
    await run()
  } finally {
    console.log = original
  }

  return lines
}

test('the fixture matrix has one unique output name per entry', () => {
  const names = MATRIX.map(outputName)

  assert.equal(new Set(names).size, names.length)
})

test('runFfmpeg preserves a spaced cwd and never invokes a shell', () => {
  const outputDir = path.join(tmpdir(), 'WeftCut fixtures with spaces')
  let invocation

  runFfmpeg(['-version'], {
    cwd: outputDir,
    spawn(command, args, options) {
      invocation = { command, args, options }
      return { status: 0 }
    },
  })

  assert.deepEqual(invocation, {
    command: 'ffmpeg',
    args: ['-version'],
    options: {
      cwd: outputDir,
      shell: false,
      stdio: 'inherit',
    },
  })
})

test('ensureFixtures calls the JavaScript generator in the target directory', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut-fixture-test-'))
  const outputDir = path.join(parent, 'media with spaces')
  const entry = { fps: 30, format: 'mp4' }
  const calls = []

  try {
    await ensureFixtures(outputDir, {
      matrix: [entry],
      generate(current, options) {
        calls.push({ current, options })
        writeFileSync(path.join(options.outputDir, outputName(current)), 'fixture')
      },
    })

    assert.deepEqual(calls, [{
      current: entry,
      options: { outputDir },
    }])
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('every matrix entry runs through the JavaScript generator in a spaced path', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture matrix '))

  try {
    for (const [index, entry] of MATRIX.entries()) {
      const outputDir = path.join(parent, `entry ${index}`)
      const calls = []

      generateFixture(entry, {
        outputDir,
        run(args, options) {
          calls.push(args)
          assert.equal(options.cwd, outputDir)
          assert.ok(args.every((arg) => typeof arg === 'string'))
          assert.ok(args.every((arg) => !arg.includes(outputDir)))
          writeFileSync(path.join(options.cwd, args.at(-1)), 'fixture')
        },
      })

      assert.ok(calls.length > 0, `${outputName(entry)} did not invoke ffmpeg`)
      assert.ok(
        existsSync(path.join(outputDir, outputName(entry))),
        `${outputName(entry)} was not produced`,
      )
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('Windows font paths use WINDIR and are escaped for drawtext', () => {
  const font = drawtextFontFile({
    platform: 'win32',
    env: { WINDIR: String.raw`D:\Windows` },
    fileExists: (candidate) => candidate === String.raw`D:\Windows\Fonts\consola.ttf`,
  })

  assert.equal(font, String.raw`D\:/Windows/Fonts/consola.ttf`)
})

test('the JavaScript generator writes a valid chart PNG and manifest itself', () => {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'weftcut-chart-test-'))

  try {
    generateFixture({ color: '709ltd' }, {
      outputDir,
      run(args, options) {
        writeFileSync(path.join(options.cwd, args.at(-1)), 'fixture')
      },
    })

    const png = readFileSync(path.join(outputDir, 'color_chart.png'))
    const image = decodeRgbaPng(png)
    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'color_manifest.json'), 'utf8'))
    const firstPixel = image.scanlines.subarray(1, 5)

    assert.equal(image.width, 1920)
    assert.equal(image.height, 1080)
    assert.equal(image.scanlines[0], 0)
    assert.deepEqual([...firstPixel], [255, 0, 0, 255])
    assert.equal(manifest.patches.length, 20)
    assert.deepEqual(manifest.patches[0], {
      id: 'red', x: 0, y: 0, w: 384, h: 270, rgb: [255, 0, 0],
    })
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('every matrix entry claims exactly the files it publishes', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture claims '))

  try {
    for (const [index, entry] of MATRIX.entries()) {
      const outputDir = path.join(parent, `entry ${index}`)

      generateFixture(entry, {
        outputDir,
        run(args, options) {
          writeFileSync(path.join(options.cwd, args.at(-1)), 'fixture')
        },
      })

      assert.deepEqual(
        readdirSync(outputDir).sort(),
        recipeOf(entry).files,
        `${outputName(entry)} publishes files its recipe does not claim`,
      )
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('the imageset and colour entries claim more than they are named for', () => {
  assert.deepEqual(recipeOf({ imageset: true }).files, [
    'test_chart_320x240.bmp',
    'test_chart_320x240.gif',
    'test_chart_320x240.jpg',
    'test_chart_320x240.png',
    'test_chart_320x240.tiff',
    'test_chart_320x240.webp',
    'test_chart_320x240_manifest.json',
  ])
  assert.deepEqual(recipeOf({ colorProres: true }).files, [
    'color_chart.png',
    'color_manifest.json',
    'test_1080p_color_709ltd_prores.mov',
  ])
  assert.deepEqual(recipeOf({ color: '601full' }).files, [
    'color_chart.png',
    'color_manifest.json',
    'test_1080p_color_601full.mp4',
  ])
})

test('recipeOf is stable across calls and moves when a recipe argument does', () => {
  // The mp3 tones entry is the one that would fail: it hands ffmpeg a scratch
  // cover-art input, so a per-call unique name there would regenerate the
  // fixture forever. The cover is deleted again, hence never a claimed file.
  const mp3 = { audiotones: true, aformat: 'mp3' }

  assert.deepEqual(recipeOf(mp3), recipeOf(mp3))
  assert.deepEqual(recipeOf(mp3).files, ['test_tones_10s.mp3'])
  assert.notEqual(recipeOf(mp3).hash, recipeOf({ audiotones: true, aformat: 'flac' }).hash)
  assert.notEqual(
    recipeOf({ fps: 30, format: 'mp4' }).hash,
    recipeOf({ fps: 30, format: 'mp4', gop: 60 }).hash,
  )
})

test('a moved recipe deletes and regenerates only its own entry', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture recipe '))
  const outputDir = path.join(parent, 'media with spaces')
  const untouched = { fps: 60, format: 'mp4' }
  const before = { fps: 30, format: 'mp4' }
  // Same output name, different argv: the keyframe cadence rides in the recipe
  // and not in the filename, which is exactly what existence cannot see.
  const after = { fps: 30, format: 'mp4', gop: 60 }
  const first = []
  const second = []

  try {
    await withCapturedLogs(() => ensureFixtures(outputDir, {
      matrix: [before, untouched],
      generate: fakeGenerator('pass one', first),
    }))
    const skipped = await withCapturedLogs(() => ensureFixtures(outputDir, {
      matrix: [after, untouched],
      generate: fakeGenerator('pass two', second),
    }))

    assert.deepEqual(first, ['test_1080p_30fps.mp4', 'test_1080p_60fps.mp4'])
    assert.deepEqual(second, ['test_1080p_30fps.mp4'])
    assert.equal(readFileSync(path.join(outputDir, 'test_1080p_30fps.mp4'), 'utf8'), 'pass two')
    assert.equal(readFileSync(path.join(outputDir, 'test_1080p_60fps.mp4'), 'utf8'), 'pass one')
    assert.ok(skipped.includes('[fixtures] skip (recipe matches): test_1080p_60fps.mp4'))

    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, 2)
    assert.equal(manifest.entries['test_1080p_30fps.mp4'].hash, recipeOf(after).hash)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a lost side-file regenerates the entry that publishes it', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture sidefile '))
  const outputDir = path.join(parent, 'media with spaces')
  const matrix = [{ imageset: true }, { fps: 30, format: 'mp4' }]
  const first = []
  const second = []

  try {
    await withCapturedLogs(() => ensureFixtures(outputDir, {
      matrix,
      generate: fakeGenerator('pass one', first),
    }))
    // The imageset's canonical name survives, so an existence check on it alone
    // reports the entry as satisfied.
    rmSync(path.join(outputDir, 'test_chart_320x240.webp'))
    await withCapturedLogs(() => ensureFixtures(outputDir, {
      matrix,
      generate: fakeGenerator('pass two', second),
    }))

    assert.deepEqual(first, ['test_chart_320x240.png', 'test_1080p_30fps.mp4'])
    assert.deepEqual(second, ['test_chart_320x240.png'])
    assert.ok(existsSync(path.join(outputDir, 'test_chart_320x240.webp')))
    assert.equal(readFileSync(path.join(outputDir, 'test_1080p_30fps.mp4'), 'utf8'), 'pass one')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a missing manifest regenerates every entry', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture manifest '))
  const outputDir = path.join(parent, 'media with spaces')
  const matrix = [{ fps: 30, format: 'mp4' }, { fps: 60, format: 'mp4' }]
  const first = []
  const second = []

  try {
    await withCapturedLogs(() => ensureFixtures(outputDir, {
      matrix,
      generate: fakeGenerator('pass one', first),
    }))
    rmSync(path.join(outputDir, 'manifest.json'))
    await withCapturedLogs(() => ensureFixtures(outputDir, {
      matrix,
      generate: fakeGenerator('pass two', second),
    }))

    assert.deepEqual(second, first)
    assert.equal(readFileSync(path.join(outputDir, 'test_1080p_60fps.mp4'), 'utf8'), 'pass two')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a failed pass still records the entries it verified', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture partial '))
  const outputDir = path.join(parent, 'media with spaces')
  const good = { fps: 30, format: 'mp4' }
  const bad = { fps: 60, format: 'mp4' }
  const first = []
  const second = []

  try {
    await assert.rejects(
      withCapturedLogs(() => ensureFixtures(outputDir, {
        matrix: [good, bad],
        generate(entry, options) {
          if (entry === bad) throw new Error('ffmpeg exploded')
          fakeGenerator('pass one', first)(entry, options)
        },
      })),
      /ffmpeg exploded/,
    )

    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    assert.deepEqual(Object.keys(manifest.entries), ['test_1080p_30fps.mp4'])

    await withCapturedLogs(() => ensureFixtures(outputDir, {
      matrix: [good, bad],
      generate: fakeGenerator('pass two', second),
    }))

    assert.deepEqual(second, ['test_1080p_60fps.mp4'])
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a file no entry claims is reported and left alone', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture unclaimed '))
  const outputDir = path.join(parent, 'media with spaces')

  try {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(path.join(outputDir, 'stray file.mp4'), 'not mine')
    writeFileSync(path.join(outputDir, '.gitkeep'), '')

    const lines = await withCapturedLogs(() => ensureFixtures(outputDir, {
      matrix: [{ fps: 30, format: 'mp4' }],
      generate: fakeGenerator('fixture', []),
    }))

    assert.deepEqual(
      lines.filter((line) => line.startsWith('[fixtures] unclaimed')),
      ['[fixtures] unclaimed, kept: stray file.mp4'],
    )
    assert.ok(existsSync(path.join(outputDir, 'stray file.mp4')))
    assert.ok(existsSync(path.join(outputDir, '.gitkeep')))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('the shot fixture yields exactly the cuts and scores its manifest records', async (t) => {
  if (!ffmpegOnPath()) {
    t.skip('no ffmpeg on PATH, so the fixture cannot be produced either')
    return
  }
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture shot '))
  const outputDir = path.join(parent, 'media with spaces')
  const entry = { shotCuts: true }
  const name = outputName(entry)

  try {
    // Real encode, then re-measure: the scene metric belongs to ffmpeg, so only
    // ffmpeg can say whether a release has moved it, and that has to redden the
    // fixture suite rather than a spec that consumes the fixture. Cheap enough
    // to earn its place here — three flat colours at 320x180.
    await withCapturedLogs(() => ensureFixtures(outputDir, { matrix: [entry] }))

    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    const expected = manifest.entries[name].sceneCuts
    const measured = sceneCandidates(path.join(outputDir, name))

    assert.ok(expected?.length > 0, `${name} records no expected cuts`)
    assert.equal(
      measured.length,
      expected.length,
      `expected ${expected.length} candidates, measured ${JSON.stringify(measured)}`,
    )
    for (const [index, cut] of expected.entries()) {
      assert.ok(
        Math.abs(measured[index].timeUs - cut.timeUs) < SHOT_FRAME_US,
        `cut ${index}: recorded ${cut.timeUs}us, measured ${measured[index].timeUs}us`,
      )
      assert.equal(
        measured[index].score.toFixed(3),
        cut.score.toFixed(3),
        `cut ${index} at ${cut.timeUs}us: score`,
      )
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
