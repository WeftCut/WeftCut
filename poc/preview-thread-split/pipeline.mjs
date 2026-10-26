// Shared by the main thread and the Worker: mediabunny demux, WebCodecs decode
// paced to the stream clock, ImageBitmap creation, and the per-stream stats.
import { Input, MP4, BufferSource, EncodedPacketSink } from '../../node_modules/mediabunny/dist/bundles/mediabunny.mjs'

export function percentiles(arr) {
  if (!arr || !arr.length) return null
  const a = Float64Array.from(arr).sort()
  const q = p => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))]
  let sum = 0; for (const v of a) sum += v
  return { n: a.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +a[a.length - 1].toFixed(2), mean: +(sum / a.length).toFixed(2) }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function fetchBuffer(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`)
  return r.arrayBuffer()
}

/** Sampling window shared by every stage: [warmup, warmup + sample) seconds after start(). */
export class Window {
  constructor(warmup, sample) { this.warmup = warmup; this.sample = sample; this.t0 = performance.now() }
  sec() { return (performance.now() - this.t0) / 1000 }
  sampling() { const s = this.sec(); return s >= this.warmup && s < this.warmup + this.sample }
  done() { return this.sec() >= this.warmup + this.sample }
}

/** One 4K stream: demux → VideoDecoder → createImageBitmap → onFrame(index, bitmap, tsUs). */
export class StreamDecoder {
  constructor(index, buffer, { window, hw, onFrame, lookaheadSec = 0.15, maxQueue = 6 }) {
    Object.assign(this, { index, buffer, window, hw, onFrame, lookaheadSec, maxQueue })
    this.running = false
    this.stats = { decoded: 0, sampledOutputs: 0, cibMs: [], lateMs: [], late50: 0, decodeQueueMax: 0, errors: [] }
    this.lastTs = -1
  }

  async start() {
    const input = new Input({ formats: [MP4], source: new BufferSource(this.buffer) })
    const track = await input.getPrimaryVideoTrack()
    const config = await track.getDecoderConfig()
    config.hardwareAcceleration = this.hw
    config.optimizeForLatency = false
    const support = await VideoDecoder.isConfigSupported(config)
    this.stats.hwSupported = support.supported
    if (!support.supported) { delete config.hardwareAcceleration; this.stats.fallback = 'no-preference' }
    this.stats.codec = config.codec
    this.decoder = new VideoDecoder({
      output: frame => this.onOutput(frame),
      error: e => { this.stats.errors.push(String(e)); this.running = false },
    })
    this.decoder.configure(config)
    const sink = new EncodedPacketSink(track)
    this.running = true
    let pkt = await sink.getFirstPacket()
    while (pkt && this.running) {
      const due = pkt.timestamp - this.lookaheadSec
      const now = this.window.sec()
      if (due > now) await sleep(Math.min(50, (due - now) * 1000))
      else {
        while (this.decoder.decodeQueueSize >= this.maxQueue && this.running) await sleep(2)
        if (!this.running) break
        this.stats.decodeQueueMax = Math.max(this.stats.decodeQueueMax, this.decoder.decodeQueueSize)
        this.decoder.decode(pkt.toEncodedVideoChunk())
        pkt = await sink.getNextPacket(pkt)
      }
    }
    this.stats.eof = !pkt
  }

  async onOutput(frame) {
    this.stats.decoded++
    const ts = frame.timestamp
    const sampling = this.window.sampling()
    const t0 = performance.now()
    let bmp
    try { bmp = await createImageBitmap(frame) } catch (e) { this.stats.errors.push('createImageBitmap: ' + e); frame.close(); return }
    frame.close()
    const t1 = performance.now()
    const lateMs = (this.window.sec() - this.lookaheadSec) * 1000 - ts / 1000
    if (sampling) {
      this.stats.sampledOutputs++
      this.stats.cibMs.push(t1 - t0)
      this.stats.lateMs.push(lateMs)
      if (lateMs > 50) this.stats.late50++
    }
    if (!this.running || ts < this.lastTs) { bmp.close(); return }
    this.lastTs = ts
    this.onFrame(this.index, bmp, ts)
  }

  stop() {
    this.running = false
    try { this.decoder?.close() } catch { /* already closed */ }
  }

  summary() {
    const s = this.stats
    return { codec: s.codec, hwSupported: s.hwSupported, fallback: s.fallback, decoded: s.decoded, sampledOutputs: s.sampledOutputs, late50: s.late50, decodeQueueMax: s.decodeQueueMax, eof: s.eof, errors: s.errors,
      createImageBitmapMs: percentiles(s.cibMs), lateMs: percentiles(s.lateMs) }
  }
}
