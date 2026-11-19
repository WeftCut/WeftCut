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
  displayedColour,
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

/// The denoise fixture's levels are asserted to a wide dB tolerance on purpose:
/// what a consumer depends on is the SHAPE — a quiet noise-only head and a much
/// louder tone after it — and pink noise is stochastic even under a fixed seed.
/// A tolerance this size still catches the failures that matter (a lost tone, a
/// missing or leaked noise bed, a mis-scaled `amix`), which all move a level by
/// far more than a dB.
const AUDIO_LEVEL_TOL_DB = 1.0
/// How far the tone window must sit above the noise-only head. The gate that
/// consumes this fixture asserts the tone SURVIVES a denoise pass, which is only
/// meaningful while the tone dominates its window by a wide margin.
const NOISY_SPEECH_MIN_SNR_DB = 20

/// `mediaPath` decoded to mono f32 at 48 kHz — the same interpretation the
/// analyzer's envelope mode reads an export under.
function monoPcm48k(mediaPath) {
  const probe = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-i', mediaPath,
      '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-',
    ],
    { maxBuffer: 1 << 28 },
  )
  assert.equal(probe.error, undefined)
  assert.equal(probe.status, 0, `ffmpeg failed:\n${probe.stderr}`)

  const samples = new Float32Array(probe.stdout.length / 4)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = probe.stdout.readFloatLE(index * 4)
  }
  return samples
}

/// RMS of `[inUs, outUs)` in dBFS.
function rmsDbfs(samples, inUs, outUs) {
  const lo = Math.round((inUs / 1_000_000) * 48_000)
  const hi = Math.min(samples.length, Math.round((outUs / 1_000_000) * 48_000))
  assert.ok(hi > lo, `empty window ${inUs}-${outUs}us in ${samples.length} samples`)

  let sumSquares = 0
  for (let index = lo; index < hi; index += 1) sumSquares += samples[index] ** 2
  return 20 * Math.log10(Math.sqrt(sumSquares / (hi - lo)))
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
  assert.deepEqual(recipeOf({ colorUntagged: 'sd' }).files, [
    'color_chart_720x480.png',
    'color_manifest_720x480.json',
    'test_480p_color_601ltd_untagged.mp4',
  ])
  assert.deepEqual(recipeOf({ colorUntagged: 'hd' }).files, [
    'color_chart.png',
    'color_manifest.json',
    'test_1080p_color_709ltd_untagged.mp4',
  ])
  assert.deepEqual(recipeOf({ colorUntagged: 'wide' }).files, [
    'color_chart_1280x544.png',
    'color_manifest_1280x544.json',
    'test_1280x544_color_709ltd_untagged.mp4',
  ])
  assert.deepEqual(recipeOf({ colorRgb: 'h264' }).files, [
    'color_chart.png',
    'color_manifest.json',
    'test_1080p_color_rgb_h264.mp4',
  ])
  assert.deepEqual(recipeOf({ colorRgb: 'qtrle' }).files, [
    'color_chart.png',
    'color_manifest.json',
    'test_1080p_color_rgb_qtrle.mov',
  ])
  assert.deepEqual(recipeOf({ colorGamut: '2020-hevc10' }).files, [
    'color_chart.png',
    'color_manifest.json',
    'test_1080p_color_2020_hevc10.mp4',
  ])
  assert.deepEqual(recipeOf({ colorGamut: 'pal' }).files, [
    'color_chart_720x576.png',
    'color_manifest_720x576.json',
    'test_576p_color_pal.mp4',
  ])
})

test('displayedColour converts into BT.709 primaries as the golden defines, and BT.709 not at all', () => {
  // Independent values: exact rational matrices from the published xy
  // chromaticities and D65, the display transfer a 2.4 power both ways.
  const expected = {
    bt2020: { red: [255, 0, 0], orange: [255, 94, 0], skin: [226, 142, 114], navy: [0, 62, 93], lime: [0, 208, 0] },
    bt470bg: { green: [0, 255, 40], orange: [255, 128, 20], lime: [115, 200, 65] },
    smpte170m: { red: [248, 48, 0], green: [73, 251, 0], blue: [38, 46, 255], skin: [197, 151, 120] },
  }
  const authored = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], orange: [255, 128, 0], skin: [200, 150, 120], navy: [30, 60, 90], lime: [120, 200, 60] }
  for (const [primaries, patches] of Object.entries(expected)) {
    for (const [id, rgb] of Object.entries(patches)) {
      assert.deepEqual(displayedColour(authored[id], primaries), rgb, `${primaries} ${id}`)
    }
    // Greys are the same in every set of primaries.
    for (const v of [0, 16, 64, 128, 192, 235, 255]) {
      assert.deepEqual(displayedColour([v, v, v], primaries), [v, v, v], `${primaries} grey ${v}`)
    }
  }
  assert.deepEqual(displayedColour([120, 200, 60], 'bt709'), [120, 200, 60])
  assert.throws(() => displayedColour([0, 0, 0], 'smpte432'))
})

test('the tagged colour charts carry their colour tags and decode as their matrix', async (t) => {
  if (!ffmpegOnPath()) {
    t.skip('no ffmpeg on PATH, so the fixture cannot be produced either')
    return
  }
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture gamut '))
  const outputDir = path.join(parent, 'media with spaces')
  const shapes = [
    {
      entry: { colorGamut: '2020-h264' }, manifest: 'color_manifest.json', matrix: 'bt2020',
      tags: { color_space: 'bt2020nc', color_primaries: 'bt2020', color_transfer: 'bt2020-10', color_range: 'tv' },
      pixFmt: 'yuv420p',
    },
    {
      entry: { colorGamut: '2020-hevc10' }, manifest: 'color_manifest.json', matrix: 'bt2020',
      tags: { color_space: 'bt2020nc', color_primaries: 'bt2020', color_transfer: 'bt2020-10', color_range: 'tv' },
      pixFmt: 'yuv420p10le',
    },
    {
      // The tagged BT.601 chart, whose primaries the native lanes convert too.
      entry: { color: '601ltd' }, manifest: 'color_manifest.json', matrix: 'smpte170m',
      tags: { color_space: 'smpte170m', color_primaries: 'smpte170m', color_transfer: 'smpte170m', color_range: 'tv' },
      pixFmt: 'yuv420p',
    },
    {
      entry: { colorGamut: 'pal' }, manifest: 'color_manifest_720x576.json', matrix: 'bt470',
      tags: { color_space: 'bt470bg', color_primaries: 'bt470bg', color_transfer: 'smpte170m', color_range: 'tv' },
      pixFmt: 'yuv420p',
    },
  ]

  try {
    await withCapturedLogs(() => ensureFixtures(outputDir, { matrix: shapes.map(({ entry }) => entry) }))

    for (const { entry, manifest, matrix, tags, pixFmt } of shapes) {
      const name = outputName(entry)
      const media = path.join(outputDir, name)
      const probe = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=pix_fmt,color_space,color_range,color_primaries,color_transfer',
        '-of', 'json', media,
      ], { encoding: 'utf8' })
      assert.equal(probe.status, 0, `ffprobe failed:\n${probe.stderr}`)
      const stream = JSON.parse(probe.stdout).streams[0]
      assert.equal(stream.pix_fmt, pixFmt, `${name}: pixel format`)
      for (const [field, value] of Object.entries(tags)) assert.equal(stream[field], value, `${name}: ${field}`)

      // The chart was converted with its own matrix: decoding with it gives the
      // authored patches back, primaries untouched.
      const { width, height, patches } = JSON.parse(readFileSync(path.join(outputDir, manifest), 'utf8'))
      const rgb = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-i', media, '-frames:v', '1',
        '-vf', `scale=in_color_matrix=${matrix}:in_range=tv`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { maxBuffer: 1 << 26 })
      assert.equal(rgb.status, 0, `ffmpeg failed:\n${rgb.stderr}`)
      assert.equal(rgb.stdout.length, width * height * 3)
      for (const patch of patches) {
        const at = ((patch.y + Math.floor(patch.h / 2)) * width + patch.x + Math.floor(patch.w / 2)) * 3
        for (let c = 0; c < 3; c += 1) {
          assert.ok(
            Math.abs(rgb.stdout[at + c] - patch.rgb[c]) <= 3,
            `${name}: ${patch.id} reads ${[...rgb.stdout.subarray(at, at + 3)]}, authored ${patch.rgb}`,
          )
        }
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('the untagged colour charts carry no colour tag and decode as the matrix they state', async (t) => {
  if (!ffmpegOnPath()) {
    t.skip('no ffmpeg on PATH, so the fixture cannot be produced either')
    return
  }
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture untagged '))
  const outputDir = path.join(parent, 'media with spaces')
  const shapes = [
    { entry: { colorUntagged: 'sd' }, manifest: 'color_manifest_720x480.json', stated: 'smpte170m', other: 'bt709' },
    { entry: { colorUntagged: 'hd' }, manifest: 'color_manifest.json', stated: 'bt709', other: 'smpte170m' },
    { entry: { colorUntagged: 'wide' }, manifest: 'color_manifest_1280x544.json', stated: 'bt709', other: 'smpte170m' },
  ]

  try {
    await withCapturedLogs(() => ensureFixtures(outputDir, { matrix: shapes.map(({ entry }) => entry) }))

    for (const { entry, manifest, stated, other } of shapes) {
      const name = outputName(entry)
      const media = path.join(outputDir, name)
      const probe = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=color_space,color_range,color_primaries,color_transfer',
        '-of', 'json', media,
      ], { encoding: 'utf8' })
      assert.equal(probe.status, 0, `ffprobe failed:\n${probe.stderr}`)
      const stream = JSON.parse(probe.stdout).streams[0]
      for (const field of ['color_space', 'color_range', 'color_primaries', 'color_transfer']) {
        assert.ok(
          stream[field] === undefined || stream[field] === 'unknown',
          `${name}: ${field} is ${stream[field]}, expected no tag`,
        )
      }
      // mediabunny reads the container's colr atom, ffprobe the VUI: both
      // must be empty for the source to be untagged on every lane.
      assert.ok(!readFileSync(media).includes('colr'), `${name} carries a colr atom`)

      // The chart was converted with the stated matrix: decoding with it
      // reproduces the authored patches more closely than the other matrix.
      const { width, height, patches } = JSON.parse(readFileSync(path.join(outputDir, manifest), 'utf8'))
      const worst = (matrix) => {
        const rgb = spawnSync('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-i', media, '-frames:v', '1',
          '-vf', `scale=in_color_matrix=${matrix}:in_range=tv`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
        ], { maxBuffer: 1 << 26 })
        assert.equal(rgb.status, 0, `ffmpeg failed:\n${rgb.stderr}`)
        assert.equal(rgb.stdout.length, width * height * 3)
        let max = 0
        for (const patch of patches) {
          const x = patch.x + Math.floor(patch.w / 2)
          const y = patch.y + Math.floor(patch.h / 2)
          const at = (y * width + x) * 3
          for (let c = 0; c < 3; c += 1) max = Math.max(max, Math.abs(rgb.stdout[at + c] - patch.rgb[c]))
        }
        return max
      }
      const statedErr = worst(stated)
      const otherErr = worst(other)
      assert.ok(
        statedErr < otherErr,
        `${name}: decoding as ${stated} is off by ${statedErr}, as ${other} by ${otherErr}`,
      )
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('the RGB colour charts hold RGB samples, tagged as their encoder tags them, and decode to the chart', async (t) => {
  if (!ffmpegOnPath()) {
    t.skip('no ffmpeg on PATH, so the fixture cannot be produced either')
    return
  }
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture rgb '))
  const outputDir = path.join(parent, 'media with spaces')
  const shapes = [
    // libx264rgb declares its RGB matrix itself; QuickTime Animation declares nothing.
    { entry: { colorRgb: 'h264' }, pixFmt: 'gbrp', colorSpace: 'gbr' },
    { entry: { colorRgb: 'qtrle' }, pixFmt: 'rgb24', colorSpace: undefined },
  ]

  try {
    await withCapturedLogs(() => ensureFixtures(outputDir, { matrix: shapes.map(({ entry }) => entry) }))
    const { width, height, patches } = JSON.parse(readFileSync(path.join(outputDir, 'color_manifest.json'), 'utf8'))

    for (const { entry, pixFmt, colorSpace } of shapes) {
      const name = outputName(entry)
      const media = path.join(outputDir, name)
      const probe = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=pix_fmt,color_space', '-of', 'json', media,
      ], { encoding: 'utf8' })
      assert.equal(probe.status, 0, `ffprobe failed:\n${probe.stderr}`)
      const stream = JSON.parse(probe.stdout).streams[0]
      assert.equal(stream.pix_fmt, pixFmt, `${name}: pixel format`)
      assert.equal(stream.color_space === 'unknown' ? undefined : stream.color_space, colorSpace, `${name}: matrix tag`)

      // RGB samples need no matrix to read: the authored patches come back.
      const rgb = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-i', media, '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { maxBuffer: 1 << 26 })
      assert.equal(rgb.status, 0, `ffmpeg failed:\n${rgb.stderr}`)
      assert.equal(rgb.stdout.length, width * height * 3)
      for (const patch of patches) {
        const at = ((patch.y + Math.floor(patch.h / 2)) * width + patch.x + Math.floor(patch.w / 2)) * 3
        for (let c = 0; c < 3; c += 1) {
          assert.ok(
            Math.abs(rgb.stdout[at + c] - patch.rgb[c]) <= 2,
            `${name}: ${patch.id} reads ${[...rgb.stdout.subarray(at, at + 3)]}, authored ${patch.rgb}`,
          )
        }
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
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

test('the denoise fixture measures the levels its manifest records', async (t) => {
  if (!ffmpegOnPath()) {
    t.skip('no ffmpeg on PATH, so the fixture cannot be produced either')
    return
  }
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture denoise '))
  const outputDir = path.join(parent, 'media with spaces')
  const entry = { noisySpeech: true }
  const name = outputName(entry)

  try {
    // Real encode, then re-measure. The levels are what the denoise gate's
    // before/after comparison rests on, and they are produced by ffmpeg's own
    // generators — so only ffmpeg can say whether a release has moved them, and
    // that has to redden the fixture suite rather than the gate downstream.
    await withCapturedLogs(() => ensureFixtures(outputDir, { matrix: [entry] }))

    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    const levels = manifest.entries[name].audioLevels
    assert.ok(levels, `${name} records no expected levels`)
    const samples = monoPcm48k(path.join(outputDir, name))

    assert.equal(
      Math.round((samples.length / 48_000) * 1_000_000),
      levels.durationUs,
      `${name} duration`,
    )
    const profile = rmsDbfs(samples, levels.profile.inUs, levels.profile.outUs)
    const tone = rmsDbfs(samples, levels.tone.inUs, levels.tone.outUs)
    assert.ok(
      Math.abs(profile - levels.profile.rmsDbfs) <= AUDIO_LEVEL_TOL_DB,
      `noise-only head: recorded ${levels.profile.rmsDbfs} dBFS, measured ${profile.toFixed(2)}`,
    )
    assert.ok(
      Math.abs(tone - levels.tone.rmsDbfs) <= AUDIO_LEVEL_TOL_DB,
      `tone window: recorded ${levels.tone.rmsDbfs} dBFS, measured ${tone.toFixed(2)}`,
    )
    assert.ok(
      tone - profile >= NOISY_SPEECH_MIN_SNR_DB,
      `tone must sit >=${NOISY_SPEECH_MIN_SNR_DB} dB over the head, measured ${(tone - profile).toFixed(2)}`,
    )

    // The head really is noise-ONLY: the tone starts after it, so the span just
    // past the tone's start is louder than the span just before it.
    const beforeTone = rmsDbfs(samples, levels.toneStartUs - 500_000, levels.toneStartUs)
    const afterTone = rmsDbfs(samples, levels.toneStartUs, levels.toneStartUs + 500_000)
    assert.ok(
      afterTone - beforeTone >= NOISY_SPEECH_MIN_SNR_DB,
      `the tone must begin at ${levels.toneStartUs}us: measured ${beforeTone.toFixed(2)} dBFS `
        + `before and ${afterTone.toFixed(2)} dBFS after`,
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
