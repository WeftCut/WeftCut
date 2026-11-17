import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { CustomSource, EncodedPacketSink, Input, MATROSKA, MP4, QTFF, WEBM } from 'mediabunny'
import { DecodeClock } from '../../../renderer/render/decoder/decodeClock'

const MAX_METADATA_BYTES = 32 * 1024 * 1024
const MAX_READ_BYTES = 8 * 1024 * 1024
export const MAX_VIDEO_IN_POINTS = 512

/** Read presentation timing from the same container formats as the renderer. */
export async function readVideoInPoints(path: string, sourceTimesUs: readonly number[], assertCurrent: () => void): Promise<Map<number, number>> {
  const matches = new Map<number, number>()
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const file = await open(path, flags)
  try {
    const stat = await file.stat()
    assertCurrent()
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) return matches
    let remaining = MAX_METADATA_BYTES
    const source = new CustomSource({
      getSize: () => stat.size,
      maxCacheSize: MAX_READ_BYTES,
      async read(start, end) {
        assertCurrent()
        const size = end - start
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > stat.size ||
            size <= 0 || size > MAX_READ_BYTES || size > remaining) throw new Error('Video timestamp read limit reached')
        remaining -= size
        const bytes = new Uint8Array(size)
        let read = 0
        while (read < size) {
          const result = await file.read(bytes, read, size - read, start + read)
          if (!result.bytesRead) throw new Error('Video changed while reading timestamps')
          read += result.bytesRead
        }
        return bytes
      },
    })
    const input = new Input({ formats: [MP4, QTFF, MATROSKA, WEBM], source })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track) return matches
      const packets = new EncodedPacketSink(track)
      const options = { metadataOnly: true, skipLiveWait: true }
      const first = await packets.getFirstPacket(options)
      if (!first) return matches
      const clock = DecodeClock.fromFirstPacket(first)
      for (const time of sourceTimesUs) {
        assertCurrent()
        // The decoder chooses in integer microseconds. Allow the fractional
        // part of that last microsecond when looking up a container sample.
        const latest = (clock.containerUs(Math.floor(time)) + 0.9999) / 1_000_000
        const packet = await packets.getPacket(latest, options)
        if (!packet) continue
        const frameUs = clock.sourceUs(packet.microsecondTimestamp)
        const endUs = frameUs + packet.microsecondDuration
        if (frameUs <= time && time < endUs) matches.set(time, frameUs)
      }
      return matches
    } finally { input.dispose() }
  } finally { await file.close() }
}
