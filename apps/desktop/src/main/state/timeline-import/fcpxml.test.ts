import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceIn, sourceOut } from '../../../renderer/layerTiming'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, rootComposition } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { PROJECT_FILE } from '../persistence'
import { AUDIO_GRID, isCanonicalOnGrid, timeUsAtGridIndex } from '../snap'
import { validate } from '../validate'
import { inspectFcpxml, listFcpxmlSequences, parseFcpxml } from './fcpxml'
import { prepareTimelineProject, type TimelineMediaProbe } from './project'
import type { TimelineMediaReplacement } from '../../../shared/timelineImport'

const fixture = (url = 'file:///fictional/Harbor%20Lights.mov') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="format" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="take" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2"
        audioRate="48000" format="format" start="3600s" duration="10s">
      <media-rep kind="original-media" src="${url}"/>
    </asset>
  </resources>
  <project name="Harbor &amp; Lights">
    <sequence format="format" duration="6006/30000s" tcStart="0s" tcFormat="NDF">
      <spine>
        <asset-clip ref="take" name="Signal" start="108002002/30000s" duration="3003/30000s">
          <marker value="Signal seen" start="108003003/30000s" duration="1001/30000s"/>
        </asset-clip>
        <gap offset="3003/30000s" duration="1001/30000s"/>
        <asset-clip ref="take" name="Dock" offset="4004/30000s" start="108006006/30000s"
          duration="2002/30000s" audioRole="music"/>
      </spine>
    </sequence>
  </project>
</fcpxml>`

const mixedVideoFixture = (url: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="sequence" frameDuration="1/30s" width="320" height="240"/>
    <format id="camera" frameDuration="1/25s" width="640" height="360"/>
    <asset id="take" format="camera" duration="1s" hasVideo="1" hasAudio="0">
      <media-rep kind="original-media" src="${url}"/>
    </asset>
  </resources>
  <project name="Fictional Cut">
    <sequence format="sequence" duration="3/30s">
      <spine><asset-clip ref="take" start="1/25s" duration="3/30s"/></spine>
    </sequence>
  </project>
</fcpxml>`

const illustratedStoryFixture = (audioUrl: string, imageUrl: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1/60s" width="320" height="240"/>
    <format id="still" name="FFVideoFormatRateUndefined" width="120" height="130"/>
    <asset id="narration" name="Narration" start="0s" duration="2s" hasAudio="1" audioSources="1" audioChannels="1">
      <media-rep kind="original-media" src="${audioUrl}"/>
    </asset>
    <asset id="mouth" name="Mouth A" start="0s" duration="0s" hasVideo="1" videoSources="1" format="still">
      <media-rep kind="original-media" src="${imageUrl}"/>
    </asset>
  </resources>
  <library><event name="Illustrated Story"><project name="Illustrated Story test">
    <sequence format="f" duration="120/60s" tcStart="0s" tcFormat="NDF" audioLayout="mono" audioRate="48k">
      <spine>
        <gap offset="0s" start="0s" duration="120/60s">
          <asset-clip ref="narration" lane="-1" offset="0s" start="0s" duration="120/60s" audioRole="dialogue"/>
          <video ref="mouth" lane="1" name="A" offset="30/60s" start="0s" duration="60/60s"/>
        </gap>
      </spine>
    </sequence>
  </project></event></library>
</fcpxml>`

function multicamFixture() {
  return ['<fcpxml version="1.10"><resources>',
    '<format id="f" frameDuration="1/30s" width="320" height="240"/>',
    '<asset id="v" format="f" hasVideo="1" start="3600s" duration="2s" src="file:///fictional/Camera.mov"/>',
    '<asset id="a" hasAudio="1" start="2s" duration="2s" src="file:///fictional/Sound.wav"/>',
    '<media id="m"><multicam format="f" tcStart="600s" duration="1s">',
    '<mc-angle name="Wide" angleID="v"><asset-clip ref="v" offset="600s" start="3600s" duration="10/30s"/>',
    '<asset-clip ref="v" offset="18010/30s" start="108020/30s" duration="20/30s"/></mc-angle>',
    '<mc-angle name="Recorder" angleID="a"><asset-clip ref="a" offset="600s" start="2s" duration="1s"/></mc-angle>',
    '<mc-angle name="Unused" angleID="u"><title name="Offline alternate"/></mc-angle>',
    '</multicam></media></resources>',
    '<project name="Fictional multicam"><sequence format="f"><spine>',
    '<gap duration="1/30s"/><mc-clip ref="m" offset="1/30s" start="18008/30s" duration="4/30s" name="Camera edit">',
    '<adjust-volume amount="-6dB"/><mc-source angleID="v" srcEnable="video"><adjust-conform type="fill"/></mc-source>',
    '<mc-source angleID="a" srcEnable="audio"/><mc-source angleID="u" srcEnable="none"/>',
    '</mc-clip></spine></sequence></project></fcpxml>'].join('')
}

function synchronizedFixture(storyline: (body: string) => string = body => body) {
  const body = `<asset-clip ref="camera" offset="20/30s" start="3600s" duration="1s" srcEnable="video">
    <audio ref="recorder" lane="-1" offset="172799999/48000s" start="97/48s" duration="1s"/>
    <marker start="108007/30s" value="Slate" duration="0s"/>
  </asset-clip>`
  return `<fcpxml version="1.10"><resources>
    <format id="f" frameDuration="1/30s" width="320" height="240"/>
    <asset id="camera" format="f" hasVideo="1" hasAudio="1" start="3600s" duration="2s" src="file:///fictional/Camera.mov"/>
    <asset id="recorder" hasAudio="1" start="2s" duration="2s" src="file:///fictional/Sound.wav"/>
  </resources><project name="Fictional interview"><sequence tcStart="60s" format="f"><spine>
    <sync-clip name="Slate take" offset="1801/30s" start="26/30s" duration="10/30s" tcStart="600s">
      <note>Double system sound</note>${storyline(body)}
      <metadata><md key="fictional"><array><string>Slate B</string></array></md></metadata>
    </sync-clip>
  </spine></sequence></project></fcpxml>`
}

describe('FCPXML subset', () => {
  it.each([false, true])('keeps synchronized clocks, early recorder audio and a source marker (spine: %s)', (hasSpine) => {
    const timeline = parseFcpxml(synchronizedFixture(body => hasSpine ? `<spine name="Main">${body}</spine>` : body))
    expect(timeline.groups).toHaveLength(1)
    const group = timeline.groups[0]!
    expect(group).toMatchObject({ kind: 'synchronized', firstFrame: 1, endFrame: 11, conform: 'fit',
      sourceIn: { num: 700000, den: 3 }, sourceOut: { num: 1700000, den: 3 } })
    const [picture, sound] = group.timeline.clips
    expect(picture).toMatchObject({ hasVideo: true, audioRole: null, firstFrame: 1, endFrame: 31,
      sourceIn: { num: 0, den: 1 }, markers: [{ label: 'Slate', frame: 8, source: { num: 700000, den: 3 } }] })
    expect(sound).toMatchObject({ hasVideo: false, audioRole: 'dialogue', lane: -1,
      timelineStart: { num: 66625, den: 2 }, sourceIn: { num: 62500, den: 3 } })
    expect(timeline.notices.flatMap(item => item.notes).join(' ')).toMatch(/editable Group.*display timecode is left out/)
    expect(group.timeline.notices.flatMap(item => item.notes)).toContain('Sequence keywords, notes and custom metadata are left out.')
  })

  it.each([false, true])('keeps a recorder connected directly to its synchronized clip (spine: %s)', (hasSpine) => {
    const xml = synchronizedFixture(body => {
      const recorder = body.match(/<audio[^>]+\/>/)![0]
      const picture = body.replace(recorder, '')
      const sound = recorder.replace('offset="172799999/48000s"', 'offset="31999/48000s"')
      return (hasSpine ? '<spine>' + picture + '</spine>' : picture) + sound
    })
    const [group] = parseFcpxml(xml).groups
    expect(group!.timeline.clips).toMatchObject([
      { hasVideo: true, audioRole: null, firstFrame: 1 },
      { hasVideo: false, audioRole: 'dialogue', lane: -1, timelineStart: { num: 66625, den: 2 },
        sourceIn: { num: 62500, den: 3 } },
    ])
    expect(group!.timeline.clips[1]!.notes).toContain('This clip keeps its timing on a separate track in the synchronized Group.')
  })

  it('keeps independent relinking available when a synchronized clip trim needs repair', () => {
    const result = inspectFcpxml(synchronizedFixture().replace('duration="10/30s" tcStart', 'duration="3s" tcStart'), 0, false, false)
    expect(result).toMatchObject({ issues: [{ label: 'Slate take', notes: [expect.stringMatching(/trim extends past.*source editor/)] }],
      sources: [{ asset: { ref: 'camera' } }, { asset: { ref: 'recorder' } }] })
  })

  it('explains that role routing needs a rendered or flattened edit without opening its source files', () => {
    const xml = synchronizedFixture(body => body + '<sync-source sourceID="storyline"><audio-role-source role="dialogue" active="0"/></sync-source>')
    expect(inspectFcpxml(xml, 0, false, false)).toMatchObject({ issues: [{ label: 'Slate take',
      notes: [expect.stringMatching(/cannot yet reproduce that audio routing.*source editor/)] }], sources: [] })
  })

  it('keeps an explicitly selected camera and separate audio across a source cut', () => {
    const timeline = parseFcpxml(multicamFixture())
    expect(timeline.groups).toHaveLength(1)
    const group = timeline.groups[0]!
    expect(group).toMatchObject({ kind: 'multicam', firstFrame: 1, endFrame: 5 })
    expect(group.timeline.clips).toMatchObject([
      { hasVideo: false, audioRole: 'dialogue', volumeDb: -6, asset: { ref: 'a' }, sourceIn: { num: 800000, den: 3 } },
      { hasVideo: true, audioRole: null, conform: 'fill', firstFrame: 0, endFrame: 2, sourceIn: { num: 800000, den: 3 } },
      { hasVideo: true, audioRole: null, conform: 'fill', firstFrame: 2, endFrame: 4, sourceIn: { num: 2000000, den: 3 } },
    ])
    expect(timeline.notices.flatMap(notice => notice.notes).join(' ')).toMatch(/Wide \(video\).*Recorder \(audio\).*Unused angles/)
  })

  it('keeps both streams of an explicitly selected angle and preserves an explicit gap', () => {
    const xml = multicamFixture()
      .replace('id="v" format="f" hasVideo="1"', 'id="v" format="f" hasVideo="1" hasAudio="1"')
      .replace('angleID="v" srcEnable="video"', 'angleID="v" srcEnable="all"')
      .replace('<mc-source angleID="a" srcEnable="audio"/>', '')
      .replace('<asset-clip ref="v" offset="18010/30s" start="108020/30s" duration="20/30s"/>',
        '<gap offset="18010/30s" duration="20/30s"/>')
    const timeline = parseFcpxml(xml)
    const group = timeline.groups[0]!
    expect(group.endFrame - group.firstFrame).toBe(4)
    expect(group.timeline.clips).toMatchObject([{ hasVideo: true, audioRole: 'dialogue', firstFrame: 0, endFrame: 2 }])
    expect(group.timeline.clips).toHaveLength(1)
  })

  it.each([
    ['duplicate active video', (xml: string) => xml.replace('angleID="u" srcEnable="none"', 'angleID="u" srcEnable="video"'), /More than one angle/],
    ['uncovered selected range', (xml: string) => xml.replace('offset="18010/30s"', 'offset="18011/30s"'), /no clip or explicit gap/],
    ['a selected component mute', (xml: string) => xml.replace('<mc-source angleID="a" srcEnable="audio"/>', '<mc-source angleID="a" srcEnable="audio"><audio-role-source role="dialogue"><mute start="0s" duration="1s"/></audio-role-source></mc-source>'), /audio-role-source/],
    ['split audio trim', (xml: string) => xml.replace('<mc-clip ref="m"', '<mc-clip ref="m" audioStart="1s"'), /audioStart/],
  ])('reports how to flatten multicam with %s', (_name, change, reason) => {
    expect(() => parseFcpxml(change(multicamFixture()))).toThrow(reason)
    expect(() => parseFcpxml(change(multicamFixture()))).toThrow(/flattening this multicam edit/)
  })

  it('keeps a connected title interval in the parent clock after explicitly leaving it out', () => {
    const xml = fixture().replace('<marker value="Signal seen"',
      '<title name="Lower Third" ref="motion" lane="1" offset="108003003/30000s" duration="1001/30000s"><text><text-style>Field Notes</text-style></text></title><marker value="Signal seen"')
    const inspect = parseFcpxml(xml, 0, 'inspect')
    expect(inspect.editIssues).toMatchObject([{ label: 'Lower Third', recovery: 'leave-title-gap',
      timelineFrames: { start: 1, end: 2 } }])
    const fallback = parseFcpxml(xml, 0, 'inspect', true)
    expect(fallback.clips).toEqual(parseFcpxml(fixture()).clips)
    expect(fallback.omittedTitles).toMatchObject([{ label: 'Lower Third', timelineFrames: { start: 1, end: 2 } }])
    expect(() => parseFcpxml(xml.replace('</title>', '<audio ref="take" lane="-1" offset="0s" duration="1s"/></title>'),
      0, 'inspect', true)).toThrow(/Unsupported inside/)
    expect(() => parseFcpxml(fixture().replace('<gap offset="3003/30000s" duration="1001/30000s"/>',
      '<title-gap offset="3003/30000s" duration="1001/30000s"/>'), 0, 'inspect', true)).toThrow(/Unsupported inside/)
  })

  it('keeps fractional frames, source timecode origin and marker time distinct', () => {
    const url = pathToFileURL(join(tmpdir(), 'Harbor Lights.mov')).href
    const parsed = parseFcpxml(fixture(url))
    expect(parsed).toMatchObject({ name: 'Harbor & Lights', fps: { num: 30000, den: 1001 }, durationFrames: 6 })
    expect(parsed.clips[0]).toMatchObject({
      firstFrame: 0, endFrame: 3,
      asset: { path: join(tmpdir(), 'Harbor Lights.mov') },
      sourceIn: { num: 200200, den: 3 }, sourceOut: { num: 500500, den: 3 },
      markers: [{ label: 'Signal seen', frame: 1, source: { num: 100100, den: 1 } }],
    })
    expect(parsed.clips[1]).toMatchObject({ firstFrame: 4, endFrame: 6, audioRole: 'music' })
  })

  it('reads Apple predefined format names without inventing width, height or FPS', () => {
    const named = fixture().replace(
      '<format id="format" frameDuration="1001/30000s" width="320" height="240"/>',
      '<format id="format" name="FFVideoFormat1080p2997"/>',
    )
    const parsed = parseFcpxml(named)
    expect(parsed).toMatchObject({
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30000, den: 1001 },
      namedFormatDefaults: true,
    })
    const overridden = named.replace('name="FFVideoFormat1080p2997"',
      'name="FFVideoFormat1080p2997" width="320" height="240"')
    expect(parseFcpxml(overridden).canvas).toEqual({ width: 320, height: 240 })
    expect(() => parseFcpxml(named.replace('FFVideoFormat1080p2997', 'MysteryFormat')))
      .toThrow(/Format needs width, height and frameDuration/)
    expect(() => parseFcpxml(named.replace('FFVideoFormat1080p2997', 'FFVideoFormat1080i5994')))
      .toThrow(/Format needs width, height and frameDuration/)
  })

  it('normalizes nonzero sequence timecode and accepts DF display metadata without shifting edits', () => {
    const displaced = fixture()
      .replace('tcStart="0s" tcFormat="NDF"', 'tcStart="3600s" tcFormat="DF"')
      .replace('offset="3003/30000s"', 'offset="108003003/30000s"')
      .replace('offset="4004/30000s"', 'offset="108004004/30000s"')
    const parsed = parseFcpxml(displaced)
    const original = parseFcpxml(fixture())
    expect(parsed.clips).toEqual(original.clips)
    expect(parsed.durationFrames).toBe(original.durationFrames)
    expect(parsed).toMatchObject({ normalizedTimecode: true, dropFrameTimecode: true })
    expect(() => parseFcpxml(fixture()
      .replace('frameDuration="1001/30000s"', 'frameDuration="1/25s"')
      .replace('tcFormat="NDF"', 'tcFormat="DF"')))
      .toThrow(/Drop-frame display timecode requires/)
  })

  it('ignores Final Cut import-options metadata without treating it as a second project', () => {
    const xml = fixture().replace('<resources>', `<import-options>
      <option key="library location" value="file:///fictional/Test.fcpbundle"/>
    </import-options><resources>`)
    expect(parseFcpxml(xml).clips).toHaveLength(2)
    expect(() => parseFcpxml(xml.replace('</import-options>', '<option unexpected="1"/></import-options>')))
      .toThrow(/Unsupported attribute/)
  })

  it('lists multiple projects by index and imports only the requested sequence', () => {
    const xml = fixture().replace('</project>', `</project>
    <project name="Alternate Edit">
      <sequence format="format" duration="1001/30000s">
        <spine><asset-clip ref="take" start="108002002/30000s" duration="1001/30000s"/></spine>
      </sequence>
    </project>`)
    const choices = listFcpxmlSequences(xml)
    expect(choices).toMatchObject([
      { index: 0, name: 'Harbor & Lights', event: null },
      { index: 1, name: 'Alternate Edit', event: null },
    ])
    expect(() => parseFcpxml(xml)).toThrow(/Choose which one/)
    expect(parseFcpxml(xml, 0).clips).toHaveLength(2)
    const alternate = parseFcpxml(xml, 1)
    expect(alternate).toMatchObject({ name: 'Alternate Edit', durationFrames: 1 })
    expect(alternate.clips).toHaveLength(1)
    expect(() => parseFcpxml(xml, 2)).toThrow(/not available/)
    expect(() => parseFcpxml(xml, -1)).toThrow(/not available/)
    expect(() => parseFcpxml(xml, 1.2)).toThrow(/not available/)
  })

  it('lists project sequences across multiple library events, retaining event provenance', () => {
    const xml = fixture()
      .replace('<project name=', '<library><event name="Scene One"><project name=')
      .replace('</project>', `</project></event><event name="Scene Two">
        <project name="Alternate Edit">
          <sequence format="format" duration="1001/30000s">
            <spine><asset-clip ref="take" start="108002002/30000s" duration="1001/30000s"/></spine>
          </sequence>
        </project></event></library>`)
    expect(listFcpxmlSequences(xml)).toMatchObject([
      { index: 0, name: 'Harbor & Lights', event: 'Scene One' },
      { index: 1, name: 'Alternate Edit', event: 'Scene Two' },
    ])
    expect(parseFcpxml(xml, 1).clips).toHaveLength(1)
  })

  it.each([
    ['transition', '<gap offset="3003/30000s" duration="1001/30000s"/>',
      '<transition duration="1001/30000s"/>', /Unsupported inside <spine>/],
    ['multicam clip', '<gap offset="3003/30000s" duration="1001/30000s"/>',
      '<mc-clip ref="multicam" duration="1001/30000s"/>', /no media definition.*flattening/],
    ['motion title', '<gap offset="3003/30000s" duration="1001/30000s"/>',
      '<title ref="motion-template" duration="1001/30000s"/>', /Unsupported inside <spine>/],
  ])('blocks an unsupported %s instead of silently dropping it', (_name, find, replace, issue) => {
    expect(() => parseFcpxml(fixture().replace(find, replace))).toThrow(issue)
  })

  it('reports every unsupported story element in a mixed selected sequence', () => {
    const xml = fixture()
      .replace('<gap offset=', '<title ref="caption"/><transition name="Dissolve"/><gap offset=')
      .replace('<marker ', '<adjust-transform><param name="animated"/></adjust-transform><marker ')
    expect(() => parseFcpxml(xml)).toThrow(/<param>[^]*<title>[^]*<transition>/)
  })

  it('blocks source retiming and unsupported third-party effects with specific elements', () => {
    const xml = fixture()
    expect(() => parseFcpxml(xml.replace('<marker value="Signal seen"',
      '<timeMap><timept time="0s" value="0s"/></timeMap><marker value="Signal seen"')))
      .toThrow(/Unsupported inside <asset-clip>/)
    expect(() => parseFcpxml(xml.replace('<marker value="Signal seen"',
      '<filter-video ref="custom" name="Third-party plugin"/><marker value="Signal seen"')))
      .toThrow(/Unsupported inside <asset-clip>/)
  })

  it.each(['1.6', '1.7', '1.8', '1.9', '1.10', '1.11', '1.12', '1.13', '1.14'])(
    'parses a supported interchange subset at FCPXML version %s', version => {
      expect(parseFcpxml(fixture().replace('version="1.10"', 'version="' + version + '"')).clips).toHaveLength(2)
    },
  )

  it('explains how to re-export an XML version WeftCut cannot read', () => {
    const xml = fixture().replace('version="1.10"', 'version="1.15"')
    expect(() => listFcpxmlSequences(xml)).toThrow(/FCPXML 1\.15.*1\.6 through 1\.14.*Export XML/)
  })

  it('reports an unsupported edit in a supported version without dropping it', () => {
    const xml = fixture().replace('version="1.10"', 'version="1.14"')
      .replace('<marker value="Signal seen"', '<unknown-edit/><marker value="Signal seen"')
    expect(() => parseFcpxml(xml)).toThrow(/Unsupported inside <asset-clip>/)
  })

  it('accepts legacy asset URLs and a single library/event/project wrapper', () => {
    const url = pathToFileURL(join(tmpdir(), 'Harbor Lights.mov')).href
    const xml = fixture(url).replace('version="1.10"', 'version="1.8"')
      .replace(/duration="10s">\s*<media-rep[^>]+\/>\s*<\/asset>/, `duration="10s" src="${url}"/>`)
      .replace('<project name=', '<library><event name="Fictional Event"><project name=')
      .replace('</project>', '</project></event></library>')
    expect(parseFcpxml(xml).clips).toHaveLength(2)
  })

  it('translates connected offsets from the trimmed parent clock and validates lane collisions', () => {
    const url = pathToFileURL(join(tmpdir(), 'Harbor Lights.mov')).href
    const child = '<asset-clip ref="take" name="Overlay" lane="2" offset="108003003/30000s" start="108006006/30000s" duration="2002/30000s"/>'
    const xml = fixture(url).replace('<marker ', child + '<marker ')
    const parsed = parseFcpxml(xml)
    expect(parsed.clips.map((clip) => [clip.lane, clip.firstFrame, clip.endFrame])).toEqual([[0, 0, 3], [0, 4, 6], [2, 1, 3]])
    expect(() => parseFcpxml(xml.replace(child, child + child))).toThrow(/same connected lane/)
    expect(() => parseFcpxml(xml.replace('offset="108003003/30000s"', 'offset="0s"'))).toThrow(/before the timeline origin/)
  })

  it('parses static spatial conform and audio gain and rejects unsupported adjustments', () => {
    const xml = fixture().replace(
      'duration="3003/30000s">\n          <marker',
      'duration="3003/30000s">\n          <adjust-conform type="fill"/>\n          <adjust-volume amount="-6dB"/>\n          <marker',
    )
    const parsed = parseFcpxml(xml)
    expect(parsed.clips[0]).toMatchObject({ conform: 'fill', volumeDb: -6 })
    expect(parsed.clips[1]).toMatchObject({ conform: 'fit', volumeDb: 0 })
    expect(() => parseFcpxml(xml.replace('type="fill"', 'type="stretch"')))
      .toThrow(/Spatial conform must be/)
    expect(() => parseFcpxml(xml.replace('amount="-6dB"', 'amount="-120dB"')))
      .toThrow(/between -30dB and/)
    expect(() => parseFcpxml(xml.replace('<adjust-conform type="fill"/>',
      '<adjust-conform type="fill"><param key="animated" value="1"/></adjust-conform>')))
      .toThrow(/Unsupported inside <adjust-conform>/)
    expect(() => parseFcpxml(xml.replace('<adjust-conform type="fill"/>',
      '<adjust-conform type="fill"/><adjust-conform type="fit"/>')))
      .toThrow(/Only one spatial conform/)
  })

  it('preserves static FCPXML transform and normal-mode opacity, rejecting animated or off-pivot variants', async () => {
    const xml = fixture().replace('<marker value="Signal seen"',
      '<adjust-transform position="10 10" scale="0.5 0.75" rotation="30"/>' +
      '<adjust-blend amount="0.75" mode="0"/><marker value="Signal seen"')
    expect(parseFcpxml(xml).clips[0]).toMatchObject({
      opacity: 0.75,
      staticTransform: { xPercent: 10, yPercent: 10, scaleX: 0.5, scaleY: 0.75, rotation: 30 },
    })
    expect(() => parseFcpxml(xml.replace('mode="0"', 'mode="17"')))
      .toThrow(/Only normal blend mode/)
    expect(() => parseFcpxml(xml.replace('rotation="30"', 'rotation="nan"')))
      .toThrow(/Static transform must have/)
    expect(() => parseFcpxml(xml.replace('rotation="30"', 'rotation="30" anchor="10 0"')))
      .toThrow(/Nonzero anchor/)
    expect(() => parseFcpxml(xml.replace('<adjust-blend amount="0.75" mode="0"/>',
      '<adjust-blend amount="0.75" mode="0"><param name="opacity"/></adjust-blend>')))
      .toThrow(/Unsupported inside <adjust-blend>/)

  })

  it('accepts non-square source pixels but rejects unsupported non-square sequence canvases', () => {
    const source = mixedVideoFixture('file:///fictional/Camera.mov')
      .replace('width="640" height="360"', 'width="640" height="360" paspH="8" paspV="9"')
    expect(parseFcpxml(source).clips[0]!.asset.videoFormat).toMatchObject({
      width: 640, height: 360, paspH: 8, paspV: 9,
    })
    expect(() => parseFcpxml(source.replace('width="320" height="240"',
      'width="320" height="240" paspH="8" paspV="9"')))
      .toThrow(/Non-square sequence pixel aspect ratios/)
    expect(() => parseFcpxml(source.replace('paspH="8"', 'paspH="0"')))
      .toThrow(/Pixel aspect ratio values/)
  })

  it('accepts independent source FPS/resolution and aligns trims to the source frame grid', () => {
    const parsed = parseFcpxml(mixedVideoFixture('file:///fictional/Camera.mov'))
    expect(parsed).toMatchObject({ canvas: { width: 320, height: 240 },
      fps: { num: 30, den: 1 }, durationFrames: 3 })
    expect(parsed.clips[0]).toMatchObject({
      firstFrame: 0, endFrame: 3,
      sourceIn: { num: 40000, den: 1 }, sourceOut: { num: 140000, den: 1 },
      asset: { videoFormat: { width: 640, height: 360,
        frameDuration: { num: 40000, den: 1 } } },
    })
    expect(parseFcpxml(mixedVideoFixture('file:///fictional/Camera.mov')
      .replace('start="1/25s"', 'start="1/30s"')).clips[0]!.sourceIn).toEqual({ num: 100000, den: 3 })
  })

  it('accepts Illustrated Story mono narration and still PNG visemes as connected image clips', () => {
    const xml = illustratedStoryFixture('file:///fictional/narration.wav', 'file:///fictional/mouth.png')
    const parsed = parseFcpxml(xml)
    expect(parsed).toMatchObject({
      name: 'Illustrated Story test', fps: { num: 60, den: 1 }, durationFrames: 120,
    })
    expect(parsed.clips).toHaveLength(2)
    expect(parsed.clips.map((clip) => [clip.lane, clip.firstFrame, clip.endFrame])).toEqual([
      [-1, 0, 120],
      [1, 30, 90],
    ])
    expect(parsed.clips[0]!.asset).toMatchObject({ hasAudio: true, audioChannels: 1, stillImage: false })
    expect(parsed.clips[1]!.asset).toMatchObject({ hasVideo: true, hasAudio: false, stillImage: true })
    expect(parseFcpxml(xml.replace('audioLayout="mono"', 'audioLayout="surround"')).clips).toHaveLength(2)
    expect(parseFcpxml(xml.replace('audioRate="48k"', 'audioRate="44.1k"')).clips).toHaveLength(2)
    expect(() => parseFcpxml(xml.replace('audioLayout="mono"', 'audioLayout="unknown"')))
      .toThrow(/Unsupported sequence audio layout/)
    expect(() => parseFcpxml(xml.replace('audioRate="48k"', 'audioRate="unknown"')))
      .toThrow(/Invalid audio sample rate/)
    expect(parseFcpxml(xml.replace('<video ref="mouth"', '<asset-clip ref="mouth"')).clips[1]!.asset.stillImage).toBe(true)
  })

  it('accepts explicit first-stream selection and reports omitted clip metadata', () => {
    const xml = illustratedStoryFixture('file:///fictional/narration.wav', 'file:///fictional/mouth.png')
      .replace('ref="narration" lane=', 'ref="narration" modDate="2001-01-01" lane=')
      .replace('audioRole="dialogue"/>', 'audioRole="dialogue"><note>Check this take</note><metadata>' +
        '<md key="fictional"><array><string>Source note</string></array></md></metadata></asset-clip>')
      .replace('<video ref="mouth"', '<video ref="mouth" srcID="1"')
    const parsed = parseFcpxml(xml)
    expect(parsed.clips[0]!.notes).toContain('Clip notes and source-editor metadata, when present, are left out.')
    const still = parsed.clips[1]!
    expect(still).toMatchObject({ firstFrame: 30, endFrame: 90 })
    expect(() => parseFcpxml(xml.replace('srcID="1"', 'srcID="2"')))
      .toThrow(/selects source stream 2.*Export the selected stream/)
  })

  it('uses decoded still sizes when format dimensions are omitted', () => {
    const xml = illustratedStoryFixture('file:///fictional/narration.wav', 'file:///fictional/mouth.png')
    for (const declaration of ['', ' width="120"', ' height="130"']) {
      const parsed = parseFcpxml(xml.replace(' width="120" height="130"', declaration))
      const still = parsed.clips[1]!
      expect(still).toMatchObject({ firstFrame: 30, endFrame: 90, conform: 'fit' })
      expect(still.asset.imageSize).toEqual(declaration.includes('width') ? { width: 120, height: undefined }
        : declaration.includes('height') ? { width: undefined, height: 130 } : undefined)
      expect(parsed.notices.flatMap(item => item.notes)).toContain(
        'The source asset does not give the full image size. WeftCut reads the dimensions from the image file.')
    }
    expect(() => parseFcpxml(xml.replace('width="120"', 'width="0"'))).toThrow(/dimensions must be positive/)
  })

  it('compares the picture settings of alternate still formats', () => {
    const xml = illustratedStoryFixture('file:///fictional/narration.wav', 'file:///fictional/mouth.png')
      .replace('</resources>', '<format id="alternate" name="Different label" width="120" fieldOrder="progressive" paspH="2" paspV="2" frameDuration="1/24s" colorSpace="Rec. 709"/></resources>')
      .replace('<video ref="mouth"', '<video format="alternate" ref="mouth"')
    expect(parseFcpxml(xml).clips[1]!.notes).toContain(
      'The still clip’s format frame rate does not affect when the image appears. Its duration comes from the timeline.')
    expect(() => parseFcpxml(xml.replace('name="Different label" width="120"', 'name="Different label" width="121"')))
      .toThrow(/different size or color space/)
    expect(() => parseFcpxml(xml.replace('colorSpace="Rec. 709"', 'colorSpace="9-16-9"')))
      .toThrow(/different size or color space/)
    expect(() => parseFcpxml(xml.replace('paspV="2"', 'paspV="1"'))).toThrow(/square pixels/)
    expect(parseFcpxml(xml.replace(' width="120" height="130"', ' height="130"')).clips[1]!.asset.imageSize)
      .toEqual({ width: 120, height: 130 })
  })

  it('does not invent audio for a video-only timeline, even with no sequence audio attributes', () => {
    const xml = fixture().replace(
      'hasAudio="1" audioSources="1" audioChannels="2"\n        audioRate="48000"',
      'hasAudio="0" audioSources="0" audioChannels="0"\n        audioRate="0"',
    )
    const parsed = parseFcpxml(xml)
    expect(parsed.clips).toHaveLength(2)
    expect(parsed.clips.every((clip) => clip.audioRole === null && !clip.asset.hasAudio)).toBe(true)
  })

  it('accepts a supported surround source for explicit 48 kHz stereo downmixing', async () => {
    const xml = fixture().replace('audioChannels="2"', 'audioChannels="6"')
      .replace('audioRate="48000"', 'audioRate="96000"')
      .replace('tcFormat="NDF"', 'tcFormat="NDF" audioLayout="surround" audioRate="96k"')
    const parsed = parseFcpxml(xml)
    expect(parsed.clips[0]!.asset).toMatchObject({ audioChannels: 6, audioRate: 96000 })
  })

  it.each([
    ['malformed XML', (xml: string) => xml.replace('</sequence>', '</clip>'), /Malformed FCPXML/],
    ['an external DTD', (xml: string) => xml.replace('DOCTYPE fcpxml', 'DOCTYPE fcpxml SYSTEM "file:///fictional/other.dtd"'), /plain.*DOCTYPE/],
    ['unknown timecode display mode', (xml: string) => xml.replace('tcFormat="NDF"', 'tcFormat="BAD"'), /tcFormat must be NDF or DF/],
    ['source before the nonzero timeline origin', (xml: string) => xml.replace('tcStart="0s"', 'tcStart="3600s"'), /before the timeline origin/],
    ['a connected clip', (xml: string) => xml.replace('name="Dock"', 'name="Dock" lane="1"'), /Connected clips/],
    ['a transition', (xml: string) => xml.replace('<gap ', '<transition '), /<transition>.*Unsupported/],
    ['a retime', (xml: string) => xml.replace('<marker ', '<timeMap/><marker '), /<timeMap>.*Unsupported/],
    ['multiple originals', (xml: string) => xml.replace('</asset>', '<media-rep kind="original-media" src="file:///fictional/other.mov"/></asset>'), /exactly one.*media-rep/],
    ['a remote file', (xml: string) => xml.replace(/src="file:[^"]+"/, 'src="https://example.invalid/take.mov"'), /absolute local file URL/],
    ['a gap overlapping a clip', (xml: string) => xml.replace('offset="3003/30000s"', 'offset="2002/30000s"'), /Overlaps the preceding/],
    ['a subframe cut', (xml: string) => xml.replace('offset="4004/30000s"', 'offset="4005/30000s"'), /between frames/],
    ['a trim before the source timecode', (xml: string) => xml.replace('108006006/30000s', '3599s'), /before the asset’s source timecode/],
    ['duplicate IDs', (xml: string) => xml.replace('id="take"', 'id="format"'), /Duplicate resource ID/],
  ])('refuses %s with a diagnostic', (_reason, change, error) => {
    const url = pathToFileURL(join(tmpdir(), 'Harbor Lights.mov')).href
    expect(() => parseFcpxml(change(fixture(url)))).toThrow(error)
  })
})

describe('timeline import transaction', () => {
  let parent: string
  let document: string
  let media: string
  let destination: string
  const id = '00000000-0000-0000-0000-0000000000ab'

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'weftcut-timeline-'))
    document = join(parent, 'Harbor.fcpxml')
    media = join(parent, 'Harbor Lights.mov')
    destination = join(parent, 'Imported Harbor')
    await writeFile(document, fixture(pathToFileURL(media).href))
  })
  afterEach(async () => { await rm(parent, { recursive: true, force: true }) })

  function setup(duration = 10_000_000, audio: { channels: number; sample_rate: number } | null = { channels: 2, sample_rate: 48000 }) {
    const idGen = seededGen()
    const before = blankProject(idGen, 'Existing Project')
    rootComposition(before).fps = { num: 30000, den: 1001 }
    const actor = createActor({ idGen, initial: before })
    const probeMedia = vi.fn(async (path = media) => JSON.stringify({
      ...mediaItemTemplate(id, 'Video', duration, true), path_abs: path, file_hash_blake3: `pending-${id}`,
      metadata: {
        duration_us: duration, video: { width: 320, height: 240, fps_num: 30000, fps_den: 1001 },
        audio,
      },
    }))
    const hashMediaSource = vi.fn(async () => 'a'.repeat(64))
    const assertCurrent = vi.fn()
    const inspectMedia = vi.fn(async (path = media): Promise<TimelineMediaProbe> => ({
      item: JSON.parse(await probeMedia(path)),
      streams: { video_us: null, audio_us: null },
    }))
    const deps = {
      compute: { probeMedia, hashMediaSource },
      inspectMedia,
      statPath: (file: string) => existsSync(file) && statSync(file).isFile() ? { kind: 'file' as const, readable: true } : null,
    }
    const prepareReview = (relinkDirectory?: string, replacements?: TimelineMediaReplacement[], revalidateReplacements = false) =>
      prepareTimelineProject(document, destination, idGen, deps, assertCurrent,
        relinkDirectory, undefined, undefined, replacements, undefined, false, false, revalidateReplacements)
    const prepare = async () => (await prepareReview()).project
    return { prepare, prepareReview, before, actor, probeMedia, inspectMedia, hashMediaSource }
  }

  it('keeps marker text and timing while reporting source-editor metadata left behind', async () => {
    const url = pathToFileURL(media).href
    const xml = fixture(url)
      .replace('<project name=', '<library colorProcessing="wide-hdr"><smart-collection name="Unused"/><event><project id="project" name=')
      .replace('</project>', '</project></event></library>')
      .replace('<sequence format=', '<sequence renderFormat="fictional-codec" keywords="Harbor" format=')
      .replace('<spine>', '<note>Fictional project note</note><spine>')
      .replace('</spine>', '</spine><metadata><md key="fictional" value="archive"/></metadata>')
      .replace('<media-rep kind="original-media"', '<media-rep suggestedFilename="Camera Copy.mov" kind="original-media"')
      .replace(url + '"/>', url + '"><bookmark>RmljdGlvbmFs</bookmark></media-rep>')
      .replace('<marker value=', '<marker note="Look again" completed="0" value=')
      .replace('</asset-clip>', '<chapter-marker start="108004004/30000s" duration="1001/30000s" value="Next scene" note="Chapter note" posterOffset="0s"/></asset-clip>')
    await writeFile(document, xml)
    await writeFile(media, 'Fictional video')
    const { project, report } = await setup().prepareReview()
    expect(report.outputColorChange).toBe('a library using wide color processing')
    expect(rootComposition(project).markers).toMatchObject([
      { t_us: 33367, label: 'Signal seen', note: 'Look again' },
      { t_us: 66733, label: 'Next scene', note: 'Chapter note' },
    ])
    const notes = report.compatibilityItems.flatMap(item => item.notes).join('\n')
    expect(notes).toMatch(/Library color processing is left out/)
    expect(notes).toMatch(/render codec is left out/)
    expect(notes).toMatch(/Sequence keywords, notes and custom metadata/)
    expect(notes).toMatch(/Apple file access bookmarks are left out/)
    expect(notes).toMatch(/Suggested media filenames are left out/)
    expect(notes).toMatch(/to-do status is left out/)
    expect(notes).toMatch(/Chapter and poster-frame settings are left out/)
    expect(() => validate(project)).not.toThrow()
  })

  it('loads a regular FCPXML bundle with Info.fcpxml at its root', async () => {
    const bundle = join(parent, 'Illustrated Story.fcpxmld')
    await mkdir(bundle)
    await writeFile(join(bundle, 'Info.fcpxml'), fixture(pathToFileURL(media).href))
    await writeFile(media, 'Fictional video')
    document = bundle
    const { project, report } = await setup().prepareReview()
    expect(report).toMatchObject({ bundleSource: true, videoClips: 2, audioClips: 2 })
    expect(() => validate(project)).not.toThrow()
  })

  it('refuses missing or nonregular bundle Info.fcpxml without publishing a project', async () => {
    const bundle = join(parent, 'Empty.fcpxmld')
    await mkdir(bundle)
    document = bundle
    await expect(setup().prepareReview()).rejects.toThrow(/regular Info.fcpxml/)
    expect(existsSync(destination)).toBe(false)
    await mkdir(join(bundle, 'Info.fcpxml'))
    await expect(setup().prepareReview()).rejects.toThrow(/regular Info.fcpxml/)
  })

  it('uses the original when a document also includes a proxy and custom metadata', async () => {
    const xml = fixture(pathToFileURL(media).href).replace('</asset>',
      '<media-rep kind="proxy-media" src="file:///fictional/proxy.mov"/>' +
      '<metadata><md key="fictional.rating" value="5"/><md key="fictional.tags"><array><string>Sample</string></array></md></metadata></asset>')
    await writeFile(document, xml)
    await writeFile(media, 'Fictional original')
    const run = setup()
    const { project, report } = await run.prepareReview()
    expect(run.probeMedia).toHaveBeenCalledExactlyOnceWith(await realpath(media))
    expect(Object.values(project.media_pool)).toHaveLength(1)
    expect(report.compatibilityItems.flatMap(item => item.notes)).toEqual(expect.arrayContaining([
      'WeftCut prefers the original file. A proxy must be chosen explicitly.',
      'Custom asset metadata is not copied to the project',
    ]))
  })

  it('offers a local proxy only as a reviewed replacement for an unavailable original', async () => {
    const proxy = join(parent, 'Harbor proxy.mov')
    await writeFile(proxy, 'Fictional proxy media')
    const replacement = await realpath(proxy)
    const xml = fixture(pathToFileURL(media).href).replace('</asset>',
      `<media-rep kind="proxy-media" src="${pathToFileURL(proxy).href}"/>
       <media-rep kind="proxy-media" src="file://example.invalid/Share/Remote.mov"/></asset>`)
    await writeFile(document, xml)
    const run = setup()
    await expect(run.prepareReview()).rejects.toMatchObject({ issues: [{ assetRef: 'take', proxyPaths: [proxy] }] })
    expect(run.probeMedia).not.toHaveBeenCalled()
    const probe = JSON.parse(await run.probeMedia())
    probe.path_abs = replacement
    run.probeMedia.mockResolvedValue(JSON.stringify(probe)).mockClear()
    const { project, report } = await run.prepareReview(undefined, [{ assetRef: 'take', path: proxy }])
    expect(run.probeMedia).toHaveBeenCalledExactlyOnceWith(replacement)
    expect(report.mediaChanges).toMatchObject([{ assetRef: 'take', kind: 'proxy-source', detail: expect.stringContaining('editing and export') }])
    expect(report.relinkedMedia).toMatchObject([{ from: media, to: replacement }])
    expect(rootComposition(project).tracks[0]!.layers[0]).toMatchObject({ t_start_us: 0, t_end_us: 100100 })
    expect(run.actor.snapshot()).toBe(run.before)
  })

  it('selects projects alongside event collections and preserves disabled clips with equivalent format IDs', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('</resources>', '<format id="same" frameDuration="1001/30000s" width="320" height="240"/></resources>')
      .replace('<project name=', '<event name="Organization"><keyword-collection name="Favorites"/><project name=')
      .replace('</project>', '</project></event>')
      .replace('<asset-clip ref="take" name="Signal"', '<asset-clip ref="take" format="same" enabled="0" name="Signal"')
    expect(listFcpxmlSequences(xml)).toMatchObject([{ name: 'Harbor & Lights', event: 'Organization' }])
    await writeFile(media, 'Fictional video')
    await writeFile(document, xml)
    const { project, report } = await setup().prepareReview()
    const layers = rootComposition(project).tracks.flatMap(track => track.layers)
    expect(layers.filter(layer => layer.label === 'Signal').map(layer => layer.enabled)).toEqual([false, false])
    expect(report.compatibilityItems.flatMap(item => item.notes)).toContain(
      'Only the selected edit is imported. Library and event organization, standalone clips, collections and source metadata are not copied')
  })

  it('imports only the requested components of a shared audiovisual asset', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('<asset-clip ref="take" name="Signal"', '<asset-clip ref="take" srcEnable="video" name="Signal"')
      .replace('<asset-clip ref="take" name="Dock"', '<audio ref="take" name="Dock"')
      .replace('audioRole="music"', 'role="music.background"')
    await writeFile(media, 'Fictional audiovisual source')
    await writeFile(document, xml)
    const { project, report } = await setup().prepareReview()
    const clips = rootComposition(project).tracks.flatMap(track => track.layers)
    expect(clips.map(layer => [layer.label, layer.params.kind])).toEqual([['Signal', 'VideoClip'], ['Dock', 'Audio']])
    expect(rootComposition(project).links).toEqual([])
    expect(report.compatibilityItems.flatMap(item => item.notes)).toContain('Audio subrole “music.background” is grouped under “music”')
    expect(() => validate(project)).not.toThrow()
  })

  it('keeps playable picture and sound when a clip uses custom role labels', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('name="Signal"', 'name="Signal" audioRole="interview.field" videoRole="B-roll.observatory"')
      .replace('audioRole="music"', 'audioRole="voiceover"')
    await writeFile(media, 'Fictional audiovisual source')
    await writeFile(document, xml)
    const { project, report } = await setup().prepareReview()
    const layers = rootComposition(project).tracks.flatMap(track => track.layers)
    expect(layers.filter(layer => layer.label === 'Signal')).toMatchObject([
      { params: { kind: 'VideoClip' } },
      { params: { kind: 'Audio', role: 'dialogue' } },
    ])
    expect(layers.find(layer => layer.label === 'Dock' && layer.params.kind === 'Audio'))
      .toMatchObject({ params: { role: 'voiceover' } })
    expect(rootComposition(project).links).toHaveLength(2)
    expect(report.compatibilityItems.find(item => item.label === 'Signal')).toMatchObject({
      status: 'approximated',
      notes: expect.arrayContaining([
        'The video role label “B-roll.observatory” is left out.',
        expect.stringContaining('audio role named “interview.field”. This clip will use Dialogue'),
      ]),
    })
    expect(() => validate(project)).not.toThrow()
  })

  it('preserves a trimmed constant-speed edit and its audio pitch policy', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('<marker value="Signal seen" start="108003003/30000s" duration="1001/30000s"/>',
        '<timeMap preservesPitch="0"><timept time="3600s" value="3600s" interp="linear"/>' +
        '<timept time="3601s" value="3602s" interp="linear"/></timeMap>')
    await writeFile(media, 'Fictional audiovisual source')
    await writeFile(document, xml)
    const { project, report } = await setup().prepareReview()
    const clips = rootComposition(project).tracks.flatMap(track => track.layers).filter(layer => layer.label === 'Signal')
    expect(clips.map(layer => layer.params.kind)).toEqual(['VideoClip', 'Audio'])
    for (const layer of clips) {
      if (layer.params.kind !== 'VideoClip' && layer.params.kind !== 'Audio') throw new Error('Expected timed clip')
      expect(layer).toMatchObject({ t_start_us: 0, t_end_us: layer.params.kind === 'Audio' ? timeUsAtGridIndex(4805, AUDIO_GRID) : 100100, params: { time_map: { kind: 'Affine', rate: { num: 2, den: 1 } } } })
      expect(sourceIn(layer.params)).toEqual({ num: 400400, den: 3 })
      expect(sourceOut({ ...layer, params: layer.params })).toEqual({ num: 1001000, den: 3 })
      if (layer.params.kind === 'Audio') expect(layer.params.preserve_pitch).toBe(false)
    }
    expect(report.compatibilityItems.flatMap(item => item.notes).join(' ')).toContain('Constant playback speed')
    expect(() => parseFcpxml(xml.replace('value="3602s"', 'value="3599s"')))
      .toThrow(/forward constant speed.*Render the speed change/)
    expect(() => parseFcpxml(xml.replace('preservesPitch="0"', 'frameSampling="optical-flow"')))
      .toThrow(/frame interpolation.*Render the speed change/)
  })

  it('keeps an on-grid marker range on the timeline', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('start="108003003/30000s" duration="1001/30000s"', 'start="108003003/30000s" duration="2002/30000s"')
    await writeFile(media, 'Fictional video')
    await writeFile(document, xml)
    const { project } = await setup().prepareReview()
    expect(rootComposition(project).markers[0]).toMatchObject({ t_us: 33367, end_t_us: 100100, label: 'Signal seen' })
  })

  it('keeps near-cut markers visible and discloses when they become independent', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('</asset-clip>', '<marker start="108004900/30000s" value="Before the cut" duration="0s"/></asset-clip>')
    await writeFile(media, 'Fictional video')
    await writeFile(document, xml)
    const run = setup()
    const { project, report } = await run.prepareReview()
    const notes = report.compatibilityItems.flatMap(item => item.notes).join(' ')
    expect(notes).toMatch(/Before the cut.*last frame of its clip.*Before the cut.*independent marker/)
    const markers = rootComposition(project).markers
    expect(markers).toMatchObject([
      { label: 'Signal seen', t_us: 33367, anchor: { src_us: 100100 } },
      { label: 'Before the cut', t_us: 66733, end_t_us: null, anchor: null },
    ])
    expect(run.actor.dispatch('import_timeline_group', { imported: project, expectedProjectId: run.before.project_id, canvas: 'fit' }).ok).toBe(true)
    expect(run.actor.snapshot().compositions[project.root_id]!.markers).toEqual(markers)
  })

  it('publishes imported static transform and opacity as editable visual params', async () => {
    const xml = fixture(pathToFileURL(media).href).replace('<marker value="Signal seen"',
      '<adjust-transform position="10 10" scale="0.5 0.75" rotation="30"/>' +
      '<adjust-blend amount="0.75" mode="0"/><marker value="Signal seen"')
    await writeFile(media, 'Fictional video')
    await writeFile(document, xml)
    const project = await setup().prepare()
    const video = rootComposition(project).tracks[0]!.layers.find(l => l.params.kind === 'VideoClip')!
    expect(video.params).toMatchObject({
      opacity: { mode: 'Static', value: 0.75 },
      transform: {
        position: { x: { mode: 'Static', value: 184 }, y: { mode: 'Static', value: 96 } },
        scale_x: { mode: 'Static', value: 0.5 },
        scale_y: { mode: 'Static', value: 0.75 },
        rotation_deg: { mode: 'Static', value: -30 },
        scale_linked: false,
      },
    })
    expect(() => validate(project)).not.toThrow()
  })

  it('inserts a validated editable composition with exact trims, sample-aligned audio and clip markers', async () => {
    await writeFile(media, 'Fictional video')
    const run = setup()
    const project = await run.prepare()
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
    expect(run.probeMedia).toHaveBeenCalledOnce()
    expect(run.hashMediaSource).toHaveBeenCalledOnce()
    expect(() => validate(project)).not.toThrow()
    const root = rootComposition(project)
    const video = root.tracks[0]!.layers.filter((l) => l.params.kind === 'VideoClip')
    const audio = root.tracks[0]!.layers.filter((l) => l.params.kind === 'Audio')
    expect(root.duration_us).toBe(200200)
    expect(video.map((l) => [l.t_start_us, l.t_end_us])).toEqual([[0, 100100], [133467, 200200]])
    expect(sourceIn(video[0]!.params)).toEqual({ num: 200200, den: 3 })
    expect(sourceOut(video[0]!)).toEqual({ num: 500500, den: 3 })
    expect(audio.every((l) => isCanonicalOnGrid(l.t_start_us, AUDIO_GRID) && isCanonicalOnGrid(l.t_end_us, AUDIO_GRID))).toBe(true)
    expect(audio[1]!.t_end_us).toBeLessThanOrEqual(root.duration_us)
    expect(root.links.map((link) => link.members)).toEqual(video.map((layer, i) => [layer.id, audio[i]!.id].sort()))
    expect(root.markers[0]).toMatchObject({ t_us: 33367, label: 'Signal seen', anchor: { layer: video[0]!.id, src_us: 100100 } })
    const result = run.actor.dispatch('import_timeline_group', {
      imported: project, expectedProjectId: run.before.project_id, canvas: 'fit',
    })
    expect(result.ok).toBe(true)
    expect(run.actor.snapshot().compositions[project.root_id]).toBeDefined()
    expect(existsSync(destination)).toBe(false)
    expect(run.actor.dispatch('undo', {}).ok).toBe(true)
    expect(run.actor.snapshot()).toEqual(run.before)
    expect(run.actor.dispatch('redo', {}).ok).toBe(true)
    expect(run.actor.command('update_layer', { layerId: video[0]!.id, patch: { label: 'Signal edited' } }).ok).toBe(true)
  })

  it('keeps the last frame when the exact source out rounds down to the probed file end', async () => {
    await writeFile(media, 'Fictional video')
    const run = setup(166833)
    const url = pathToFileURL(media).href
    const xml = fixture(url).replace(/        <gap[^\n]+\n        <asset-clip[^]*?audioRole="music"\/>\n/, '')
    await writeFile(document, xml)
    const { project, report } = await run.prepareReview()
    expect(report.roundedEnds).toBe(1)
    const video = rootComposition(project).tracks[0]!.layers.find((layer) => layer.params.kind === 'VideoClip')!
    expect(sourceOut(video)).toEqual({ num: 166833, den: 1 })
    expect(video.t_end_us).toBe(100100)
    expect(() => validate(project)).not.toThrow()
  })

  it('maps 25 fps 640×360 media into 30 fps 320×240 with exact trims and centred fit', async () => {
    const file = join(parent, 'Mixed Camera.mov')
    await writeFile(file, 'Fictional mixed video')
    await writeFile(document, mixedVideoFixture(pathToFileURL(file).href))
    const itemId = '00000000-0000-0000-0000-0000000000bc'
    const { project, report } = await prepareTimelineProject(
      document, destination, seededGen(),
      {
        compute: {
          probeMedia: async () => JSON.stringify({
            ...mediaItemTemplate(itemId, 'Video', 1_000_000, false),
            path_abs: file, file_hash_blake3: `pending-${itemId}`,
            metadata: { duration_us: 1_000_000,
              video: { width: 640, height: 360, fps_num: 25, fps_den: 1 },
              audio: null },
          }),
          hashMediaSource: async () => 'a'.repeat(64),
        },
        statPath: path => existsSync(path) && statSync(path).isFile() ? { kind: 'file', readable: true } : null,
      }, () => {},
    )
    expect(report).toMatchObject({
      rateConformedVideoClips: 1, resizedVideoClips: 1,
      videoConversions: [{ source: file, sourceWidth: 640, sourceHeight: 360,
        sourceFps: { num: 25, den: 1 }, rateConformed: true, scaledToFit: true }],
    })
    const layer = rootComposition(project).tracks[0]!.layers[0]!
    expect(layer).toMatchObject({ t_start_us: 0, t_end_us: 100000,
      params: { kind: 'VideoClip', transform: {
        position: { x: { mode: 'Static', value: 160 }, y: { mode: 'Static', value: 120 } },
        scale_x: { mode: 'Static', value: 0.5 },
        scale_y: { mode: 'Static', value: 0.5 },
      } },
    })
    expect(sourceIn(layer.params)).toEqual({ num: 40000, den: 1 })
    expect(sourceOut(layer)).toEqual({ num: 140000, den: 1 })
    expect(() => validate(project)).not.toThrow()
  })

  it('uses probed source FPS when FCPXML omits an asset format', async () => {
    const file = join(parent, 'Unspecified Camera.mov')
    await writeFile(file, 'Fictional camera source')
    const xml = mixedVideoFixture(pathToFileURL(file).href)
      .replace('format="camera" duration=', 'duration=')
    await writeFile(document, xml)
    const itemId = '00000000-0000-0000-0000-0000000000bd'
    const deps = {
      compute: {
        probeMedia: async () => JSON.stringify({
          ...mediaItemTemplate(itemId, 'Video', 1_000_000, false),
          path_abs: file, file_hash_blake3: `pending-${itemId}`,
          metadata: { duration_us: 1_000_000,
            video: { width: 640, height: 360, fps_num: 25, fps_den: 1 }, audio: null },
        }),
        hashMediaSource: async () => 'a'.repeat(64),
      },
      statPath: (path: string) => existsSync(path) && statSync(path).isFile()
        ? { kind: 'file' as const, readable: true } : null,
    }
    const parsed = parseFcpxml(xml)
    expect(parsed.clips[0]!.sourceIn).toEqual({ num: 40000, den: 1 })
    expect(parsed.clips[0]!.asset.videoFormat).toBeUndefined()
    const { project, report } = await prepareTimelineProject(document, destination,
      seededGen(), deps, () => {})
    expect(report.rateConformedVideoClips).toBe(1)
    expect(() => validate(project)).not.toThrow()

    await writeFile(document, xml.replace('start="1/25s"', 'start="1/30s"'))
    await expect(prepareTimelineProject(document, destination, seededGen(), deps, () => {}))
      .rejects.toThrow(/source in-point falls between frames/)
  })

  it('applies a non-square pixel-aspect correction before fitting to the canvas', async () => {
    const file = join(parent, 'NonSquare.mov')
    await writeFile(file, 'Fictional non-square source')
    await writeFile(document, mixedVideoFixture(pathToFileURL(file).href)
      .replace('width="640" height="360"', 'width="640" height="360" paspH="8" paspV="9"'))
    const mediaId = '00000000-0000-0000-0000-0000000000bd'
    const { project, report } = await prepareTimelineProject(document, destination, seededGen(), {
      compute: {
        probeMedia: async () => JSON.stringify({
          ...mediaItemTemplate(mediaId, 'Video', 1_000_000, false),
          path_abs: file, file_hash_blake3: 'a'.repeat(64),
          metadata: { duration_us: 1_000_000,
            video: { width: 640, height: 360, fps_num: 25, fps_den: 1 }, audio: null },
        }),
        hashMediaSource: async () => 'a'.repeat(64),
      },
      statPath: path => existsSync(path) && statSync(path).isFile() ? { kind: 'file', readable: true } : null,
    }, () => {})
    expect(report.videoConversions[0]).toMatchObject({ pixelAspect: { h: 8, v: 9 }, scaledToFit: true })
    const layer = rootComposition(project).tracks[0]!.layers[0]!
    expect(layer.params).toMatchObject({ kind: 'VideoClip', transform: {
      scale_x: { mode: 'Static', value: 0.5 },
      scale_y: { mode: 'Static', value: 0.5625 },
    } })
    expect(() => validate(project)).not.toThrow()
  })

  it.each([
    ['6-1-6 (Rec. 601 NTSC)', 'smpte170m', 'smpte170m', 'smpte170m', 'Rec. 601 NTSC'],
    ['Rec. 601 (PAL)', 'bt470bg', 'bt470bg', 'bt709', 'Rec. 601 PAL'],
    ['6-1-6', null, null, null, 'Rec. 601 NTSC'],
  ])('reviews usable SDR with declaration %s and keeps the cut', async (declared, matrix, primaries, transfer, name) => {
    await writeFile(media, 'Fictional SDR video')
    await writeFile(document, fixture(pathToFileURL(media).href).replace('height="240"', `height="240" colorSpace="${declared}"`))
    const run = setup()
    const probe = JSON.parse(await run.probeMedia())
    Object.assign(probe.metadata.video, { color_matrix: matrix, color_primaries: primaries, color_transfer: transfer })
    run.probeMedia.mockResolvedValue(JSON.stringify(probe))
    const { project, report } = await run.prepareReview()
    expect(report.outputColorChange).toBe(name)
    expect(report.mediaChanges).toMatchObject([{ kind: 'color-format', detail: expect.stringContaining('render in SDR Rec. 709') }])
    expect(report.mediaChanges[0]!.detail.includes('missing color tags')).toBe(matrix === null)
    const video = rootComposition(project).tracks[0]!.layers[0]!
    expect(video).toMatchObject({ t_start_us: 0, t_end_us: 100100, params: { kind: 'VideoClip', src_in_us: 66733 } })
    expect(Object.values(project.media_pool)[0]!.metadata.video).toMatchObject({ color_matrix: matrix, color_primaries: primaries, color_transfer: transfer })
  })

  it('requires a tagged SDR file before setting aside an HDR format declaration', async () => {
    await writeFile(media, 'Fictional SDR media')
    await writeFile(document, fixture(pathToFileURL(media).href).replace('height="240"', 'height="240" colorSpace="9-18-9"'))
    const run = setup()
    await expect(run.prepareReview()).rejects.toThrow(/HDR \(Rec. 2020 HLG\).*color tags/)
    const probe = JSON.parse(await run.probeMedia())
    Object.assign(probe.metadata.video, { color_transfer: 'bt709', color_primaries: 'bt709' })
    run.probeMedia.mockResolvedValue(JSON.stringify(probe))
    const { project, report } = await run.prepareReview()
    expect(report.outputColorChange).toBe('HDR (Rec. 2020 HLG)')
    expect(report.mediaChanges).toMatchObject([{ kind: 'color-format', detail: expect.stringContaining('tagged SDR Rec. 709') }])
    expect(rootComposition(project).tracks[0]!.layers[0]).toMatchObject({ t_start_us: 0, t_end_us: 100100 })
  })

  it('refuses HDR detected in the original when the XML has no color declaration', async () => {
    await writeFile(media, 'Fictional HDR video')
    const run = setup()
    const probe = JSON.parse(await run.probeMedia())
    probe.metadata.video.color_transfer = 'smpte2084'
    probe.metadata.video.color_primaries = 'bt2020'
    run.probeMedia.mockResolvedValue(JSON.stringify(probe))
    await expect(run.prepareReview()).rejects.toThrow(/HDR or wide-gamut color.*smpte2084.*bt2020.*SDR Rec. 709 copy.*tone mapping/)
    expect(run.actor.snapshot()).toBe(run.before)
  })

  it('refuses a different video frame rate when the source format is declared', async () => {
    const file = join(parent, 'Camera.mov')
    await writeFile(file, 'Wrong camera video')
    await writeFile(document, mixedVideoFixture(pathToFileURL(file).href))
    const id = '00000000-0000-0000-0000-0000000000be'
    await expect(prepareTimelineProject(document, destination, seededGen(), {
      compute: {
        probeMedia: async () => JSON.stringify({
          ...mediaItemTemplate(id, 'Video', 1_000_000), path_abs: file,
          file_hash_blake3: `pending-${id}`,
          metadata: { duration_us: 1_000_000,
            video: { width: 640, height: 360, fps_num: 24, fps_den: 1 },
            audio: null },
        }),
        hashMediaSource: async () => 'a'.repeat(64),
      },
      statPath: path => existsSync(path) && statSync(path).isFile() ? { kind: 'file', readable: true } : null,
    }, () => {})).rejects.toThrow(/frame rate differs from its FCPXML asset format/)
    expect(existsSync(destination)).toBe(false)
  })

  it('discloses a different source rate when the cut still starts on a source frame', async () => {
    const file = join(parent, 'Replacement.mov')
    await writeFile(file, 'Fictional transcoded camera video')
    await writeFile(document, mixedVideoFixture(pathToFileURL(file).href).replace('start="1/25s"', 'start="0s"'))
    const { report, project } = await prepareTimelineProject(document, destination, seededGen(), {
      compute: {
        probeMedia: async () => JSON.stringify({
          ...mediaItemTemplate(id, 'Video', 1_000_000), path_abs: file,
          metadata: { duration_us: 1_000_000, video: { width: 640, height: 360, fps_num: 24, fps_den: 1 }, audio: null },
        }),
        hashMediaSource: async () => 'a'.repeat(64),
      },
      statPath: path => existsSync(path) && statSync(path).isFile() ? { kind: 'file', readable: true } : null,
    }, () => {})
    expect(report.mediaChanges).toMatchObject([{ kind: 'video-rate', detail: expect.stringContaining('24/1 fps') }])
    expect(rootComposition(project).tracks[0]!.layers[0]).toMatchObject({ t_start_us: 0, t_end_us: 100000 })
  })

  it('reports usable video and audio format differences without changing placement or trims', async () => {
    await writeFile(media, 'Fictional video with transcoded audio')
    const run = setup()
    const probe = JSON.parse(await run.probeMedia())
    probe.metadata.video.width = 640
    probe.metadata.video.height = 360
    probe.metadata.audio.channels = 1
    probe.metadata.audio.sample_rate = 44100
    run.probeMedia.mockResolvedValue(JSON.stringify(probe))
    const { project, report } = await run.prepareReview()
    expect(report.mediaChanges).toMatchObject([
      { kind: 'video-size', assetRef: 'take', placements: 2, detail: expect.stringContaining('640 × 360') },
      { kind: 'audio-format', assetRef: 'take', placements: 2, detail: expect.stringContaining('44100 Hz') },
    ])
    const clips = rootComposition(project).tracks.flatMap(track => track.layers)
    const video = clips.filter(layer => layer.params.kind === 'VideoClip')
    expect(video.map(layer => [layer.t_start_us, layer.t_end_us])).toEqual([[0, 100100], [133467, 200200]])
    expect(sourceIn(video[0]!.params as Extract<typeof video[0]['params'], { kind: 'VideoClip' }>)).toEqual({ num: 200200, den: 3 })
    expect(report.resampledAudioClips).toBe(2)
    expect(() => validate(project)).not.toThrow()
  })

  it('preserves independent linked source trims and puts overlapping split audio on different tracks', async () => {
    await writeFile(media, 'Fictional camera source')
    const xml = fixture(pathToFileURL(media).href)
      .replace('start="108002002/30000s" duration="3003/30000s"', 'start="108002002/30000s" duration="3003/30000s" audioDuration="5/30s"')
      .replace('start="108006006/30000s"', 'start="108006006/30000s" audioStart="108004004/30000s"')
    await writeFile(document, xml)
    const { project, report } = await setup().prepareReview()
    const composition = rootComposition(project)
    const layers = composition.tracks.flatMap(track => track.layers)
    const video = layers.filter(layer => layer.params.kind === 'VideoClip')
    const signal = layers.find(layer => layer.label === 'Signal' && layer.params.kind === 'Audio')!
    const dock = layers.find(layer => layer.label === 'Dock' && layer.params.kind === 'Audio')!
    expect(video.map(layer => [layer.t_start_us, layer.t_end_us])).toEqual([[0, 100100], [133467, 200200]])
    expect(sourceOut(signal)).toEqual({ num: 233400, den: 1 })
    expect(sourceIn(dock.params)).toEqual({ num: 400400, den: 3 })
    expect(dock.t_start_us).toBe(timeUsAtGridIndex(3203, AUDIO_GRID))
    expect(signal.t_end_us).toBeGreaterThan(dock.t_start_us)
    expect(composition.tracks.find(track => track.layers.includes(signal))?.id)
      .not.toBe(composition.tracks.find(track => track.layers.includes(dock))?.id)
    for (const layer of video) {
      const linkedAudio = layer.label === 'Signal' ? signal : dock
      expect(composition.links.map(link => link.members)).toContainEqual([layer.id, linkedAudio.id].sort())
    }
    expect(report.compatibilityItems.flatMap(item => item.notes).join(' ')).toContain('Separate picture and sound trims')
    expect(() => validate(project)).not.toThrow()
  })

  it('discloses pre-roll before zero and preserves an audio tail after the last picture', async () => {
    await writeFile(media, 'Fictional camera source')
    const xml = fixture(pathToFileURL(media).href)
      .replace('start="108002002/30000s" duration="3003/30000s"', 'start="108002002/30000s" duration="3003/30000s" audioStart="3600s"')
      .replace('duration="2002/30000s" audioRole=', 'duration="2002/30000s" audioDuration="4004/30000s" audioRole=')
    await writeFile(document, xml)
    const { project, report } = await setup().prepareReview()
    const composition = rootComposition(project)
    const layers = composition.tracks.flatMap(track => track.layers)
    const signal = layers.find(layer => layer.label === 'Signal' && layer.params.kind === 'Audio')!
    const dock = layers.find(layer => layer.label === 'Dock' && layer.params.kind === 'Audio')!
    expect(signal.t_start_us).toBe(0)
    expect(sourceIn(signal.params)).toEqual({ num: 200200, den: 3 })
    expect(sourceOut(signal)).toEqual({ num: 100100, den: 1 })
    expect(dock.t_end_us).toBeGreaterThan(200200)
    expect(composition.duration_us).toBe(266933)
    const notes = report.compatibilityItems.flatMap(item => item.notes).join(' ')
    expect(notes).toMatch(/Audio before the timeline begins is left out/)
    expect(notes).toMatch(/extended to keep split audio/)
  })

  it('checks each split trim against its own stream length', async () => {
    await writeFile(media, 'Fictional camera source')
    const xml = fixture(pathToFileURL(media).href)
      .replace('duration="2002/30000s" audioRole=', 'duration="2002/30000s" audioStart="108004004/30000s" audioDuration="2002/30000s" audioRole=')
      .replace('name="Signal" start=', 'name="Signal" srcEnable="video" start=')
    await writeFile(document, xml)
    const run = setup()
    const { item } = await run.inspectMedia()
    run.inspectMedia.mockResolvedValue({ item, streams: { video_us: 267_000, audio_us: 220_000 } })
    await expect(run.prepare()).resolves.toBeDefined()
    run.inspectMedia.mockResolvedValue({ item, streams: { video_us: 267_000, audio_us: 190_000 } })
    await expect(run.prepare()).rejects.toThrow(/audio stream ends before this trim/)
    expect(run.actor.snapshot()).toBe(run.before)
  })

  it('keeps cuts past a stale XML duration only when every requested stream covers the trim', async () => {
    await writeFile(media, 'Fictional source')
    await writeFile(document, fixture(pathToFileURL(media).href).replace('duration="10s"', 'duration="1/30s"'))
    const run = setup()
    const { item } = await run.inspectMedia()
    run.inspectMedia.mockResolvedValue({ item, streams: { video_us: 10_000_000, audio_us: 10_000_000 } })
    const { project, report } = await run.prepareReview()
    const importedMedia = Object.values(project.media_pool)[0]!
    expect(importedMedia.metadata.video).not.toHaveProperty('duration_us')
    expect(importedMedia.metadata.audio).not.toHaveProperty('duration_us')
    expect(report.mediaChanges).toMatchObject([
      { kind: 'source-duration', assetRef: 'take', placements: 2, detail: expect.stringContaining('keep the original cut times') },
    ])
    const layers = rootComposition(project).tracks[0]!.layers
    expect(layers.filter(layer => layer.params.kind === 'VideoClip')).toMatchObject([
      { t_start_us: 0, t_end_us: 100100, params: { src_in_us: 66733, src_out_us: 166833 } },
      { t_start_us: 133467, t_end_us: 200200, params: { src_in_us: 200200, src_out_us: 266933 } },
    ])
    expect(() => validate(project)).not.toThrow()
    run.inspectMedia.mockResolvedValue({ item, streams: { video_us: 10_000_000, audio_us: null } })
    await expect(run.prepareReview()).rejects.toThrow(/cannot verify that every requested stream covers it/)
    run.inspectMedia.mockResolvedValue({ item, streams: { video_us: 10_000_000, audio_us: 90_000 } })
    await expect(run.prepareReview()).rejects.toThrow(/audio stream ends before this trim/)
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
  })

  it('uses a source in-point that aligns with the actual file when the XML source rate is wrong', async () => {
    await writeFile(media, 'Fictional camera file')
    const xml = mixedVideoFixture(pathToFileURL(media).href).replace('start="1/25s"', 'start="1/30s"')
    await writeFile(document, xml)
    const run = setup()
    const probe = JSON.parse(await run.probeMedia())
    Object.assign(probe.metadata.video, { fps_num: 30, fps_den: 1 })
    run.probeMedia.mockResolvedValue(JSON.stringify(probe))
    const { project, report } = await run.prepareReview()
    expect(report.mediaChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'video-rate', detail: expect.stringContaining('keep the cut times') }),
    ]))
    const layer = rootComposition(project).tracks[0]!.layers[0]!
    if (layer.params.kind !== 'VideoClip') throw new Error('Expected video')
    expect(sourceIn(layer.params)).toEqual({ num: 100000, den: 3 })
    expect(layer).toMatchObject({ t_start_us: 0, t_end_us: 100000 })
  })

  it('reports independent timing and clip errors without reporting a cascade from a failed dissolve', () => {
    const xml = fixture()
      .replace('</resources>', '<effect id="cross" uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265"/></resources>')
      .replace('name="Signal" start=', 'name="Signal" unsupportedSetting="1" start=')
      .replace('<gap offset="3003/30000s" duration="1001/30000s"/>',
        '<transition offset="2002/30000s" duration="1001/30000s"><filter-video ref="cross"/></transition>')
      .replace('name="Dock" offset="4004/30000s"', 'name="Dock" offset="2002/30000s"')
      .replace('</spine>', '<video ref="take" name="Off-grid cut" offset="1/3s" duration="1001/30000s"/></spine>')
    const result = inspectFcpxml(xml, 0, false, false)
    expect(result).toMatchObject({ issues: [
      { label: 'Signal', notes: [expect.stringContaining('Unsupported attribute')] },
      { label: 'Off-grid cut', notes: [expect.stringContaining('between frames')] },
    ] })
  })

  it('reports an unsupported transition alongside missing media without making a partial project', async () => {
    const xml = fixture(pathToFileURL(media).href).replace('<gap offset="3003/30000s" duration="1001/30000s"/>',
      '<transition name="Ripple" offset="3003/30000s" duration="1001/30000s"/>')
    await writeFile(document, xml)
    const run = setup()
    await expect(run.prepareReview()).rejects.toMatchObject({
      issues: [{ assetRef: 'take', placements: 2, detail: expect.stringContaining('Missing or unreadable original media') }],
      editIssues: [{ label: 'Ripple', status: 'unsupported', timelineFrames: { start: 3, end: 4 } }],
    })
    await writeFile(media, 'Fictional original video')
    await expect(run.prepareReview()).rejects.toMatchObject({
      issues: [{ label: 'Ripple', status: 'unsupported' }], canOmitEffects: false,
    })
    expect(run.probeMedia).not.toHaveBeenCalled()
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
  })

  it('reports a clip mapping failure and missing originals even when asset metadata cannot be imported', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('name="Signal" start=', 'name="Signal" offset="0s" start=')
      .replace('name="Signal" offset=', 'name="Signal" unknownSetting="true" offset=')
      .replace('audioSources="1"', 'audioSources="2"')
    await writeFile(document, xml)
    const run = setup()
    await expect(run.prepareReview()).rejects.toMatchObject({
      issues: [{ assetRef: 'take', placements: 2 }],
      editIssues: [
        { label: 'Signal', status: 'unsupported', timelineFrames: { start: 0, end: 3 },
          notes: [expect.stringContaining('Unsupported attribute "unknownSetting"')] },
        { label: 'take', notes: [expect.stringContaining('Only one embedded audio stream')] },
      ],
    })
    await writeFile(media, 'Fictional original video')
    await expect(run.prepareReview()).rejects.toMatchObject({ issues: [{ label: 'Signal' }, { label: 'take' }] })
    expect(run.probeMedia).not.toHaveBeenCalled()
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
  })

  it('shows the other source when one asset has an unsafe URL and reports the blocked edit', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('</resources>', '<asset id="remote" duration="1s" hasVideo="1" src="file://example.invalid/share/Remote.mov"/></resources>')
      .replace('<gap offset="3003/30000s" duration="1001/30000s"/>',
        '<video ref="remote" name="Remote cut" offset="3003/30000s" duration="1001/30000s"/>')
      .replace('name="Signal" start=', 'name="Signal" unknownSetting="true" start=')
    await writeFile(document, xml)
    const run = setup()
    await expect(run.prepareReview()).rejects.toMatchObject({
      issues: [{ assetRef: 'take', placements: 2 }],
      editIssues: [
        { label: 'Signal', notes: [expect.stringContaining('Unsupported attribute')] },
        { label: 'remote', notes: [expect.stringContaining('Network shares, devices and traversal are unsupported')] },
      ],
    })
    expect(run.probeMedia).not.toHaveBeenCalled()
    expect(run.hashMediaSource).not.toHaveBeenCalled()
    expect(existsSync(destination)).toBe(false)
  })

  it('keeps recoverable story diagnostics when a later field blocks the mapping', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('<gap offset="3003/30000s" duration="1001/30000s"/>',
        '<title name="End Credit" offset="3003/30000s" duration="1001/30000s"/>')
      .replace('name="Dock"', 'name="Dock" unknownSetting="true"')
    await writeFile(document, xml)
    const run = setup()
    await expect(run.prepareReview()).rejects.toMatchObject({
      issues: [{ assetRef: 'take', placements: 2 }],
      editIssues: [
        { label: 'Dock', notes: [expect.stringContaining('Unsupported attribute')] },
        { label: 'End Credit', recovery: 'leave-title-gap', timelineFrames: { start: 3, end: 4 } },
      ],
    })
    expect(run.probeMedia).not.toHaveBeenCalled()
  })

  it('never inventories assets from inside an unsupported edit', async () => {
    const extra = join(parent, 'Unknown Angle.mov')
    const xml = fixture(pathToFileURL(media).href)
      .replace('</resources>', `<asset id="hidden" hasVideo="1" duration="1s" src="${pathToFileURL(extra).href}"/></resources>`)
      .replace('<gap offset="3003/30000s" duration="1001/30000s"/>',
        '<sync-clip name="Hidden Take" offset="3003/30000s" duration="1001/30000s"><video ref="hidden" duration="1s"/><sync-source sourceID="storyline"/></sync-clip>')
    await writeFile(document, xml)
    const run = setup()
    await expect(run.prepareReview()).rejects.toMatchObject({ issues: [{ assetRef: 'take' }], editIssues: [{ label: 'Hidden Take' }] })
    expect(run.probeMedia).not.toHaveBeenCalled()
  })

  it('preflights missing media before probing or creating any project folder', async () => {
    const run = setup()
    await expect(run.prepare()).rejects.toThrow(/Missing or unreadable original media.*Harbor Lights/)
    expect(run.probeMedia).not.toHaveBeenCalled()
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
  })

  it('reuses a manual replacement after the asset ID changes and asks for renewed approval', async () => {
    await writeFile(media, 'Fictional replacement video')
    const file = await realpath(media)
    const originalPath = join(parent, 'Offline', 'Harbor Lights.mov')
    const xml = fixture(pathToFileURL(originalPath).href)
    await writeFile(document, xml)
    const run = setup()
    const prior = await run.prepareReview(undefined, [{ assetRef: 'take', path: file }])
    expect(prior.report.replacements).toMatchObject([{ assetRef: 'take', path: file, sourceIdentity: expect.any(String) }])
    await writeFile(document, xml.replace('id="take"', 'id="new-take"').replaceAll('ref="take"', 'ref="new-take"'))
    const fresh = await run.prepareReview(undefined, prior.report.replacements, true)
    expect(fresh.report.replacements).toMatchObject([{ assetRef: 'new-take', path: file, reused: true }])
    expect(fresh.report.relinkedMedia).toMatchObject([{ assetRef: 'new-take', to: file }])
    expect(fresh.report.mediaChanges).toContainEqual(expect.objectContaining({ kind: 'reused-replacement' }))
    expect(fresh.report.unmatchedReplacements).toEqual([])
  })

  it.each(['source changed', 'asset duplicated', 'asset deduplicated'])('leaves a prior choice unapplied if the %s after re-export', async (reason) => {
    await writeFile(media, 'Fictional replacement video')
    const originalPath = join(parent, 'Offline', 'Harbor Lights.mov')
    const xml = fixture(pathToFileURL(originalPath).href)
    const asset = /<asset id="take"[\s\S]*?<\/asset>/.exec(xml)![0]
    const doubled = xml.replace('</resources>', asset.replace('id="take"', 'id="alternate"') + '</resources>')
      .replace('ref="take" name="Dock"', 'ref="alternate" name="Dock"')
    await writeFile(document, reason === 'asset deduplicated' ? doubled : xml)
    const run = setup()
    const replacements = [{ assetRef: 'take', path: media }]
    if (reason === 'asset deduplicated') replacements.push({ assetRef: 'alternate', path: media })
    const prior = await run.prepareReview(undefined, replacements)
    const revised = reason === 'source changed'
      ? xml.replace(pathToFileURL(originalPath).href, pathToFileURL(join(parent, 'Other', 'Harbor Lights.mov')).href)
      : reason === 'asset duplicated' ? doubled : xml
    await writeFile(document, revised)
    run.probeMedia.mockClear()
    await expect(run.prepareReview(undefined, prior.report.replacements, true)).rejects.toMatchObject({
      mediaReview: { replacements: [], unmatchedReplacements: expect.arrayContaining(['Harbor Lights.mov']) },
      issues: expect.arrayContaining([expect.objectContaining({ assetRef: 'take', detail: expect.stringContaining('Missing or unreadable') })]),
    })
    expect(run.probeMedia).not.toHaveBeenCalled()
  })

  it('relinks an explicitly selected folder by exact filename and reports the original mapping', async () => {
    const folder = join(parent, 'Moved Originals')
    await mkdir(folder)
    const candidate = join(folder, 'Harbor Lights.mov')
    await writeFile(candidate, 'Fictional replacement video')
    const replacement = await realpath(candidate)
    const run = setup()
    run.probeMedia.mockImplementation(async () => JSON.stringify({
      ...mediaItemTemplate(id, 'Video', 10_000_000, true),
      path_abs: replacement, file_hash_blake3: `pending-${id}`,
      metadata: { duration_us: 10_000_000,
        video: { width: 320, height: 240, fps_num: 30000, fps_den: 1001 },
        audio: { channels: 2, sample_rate: 48000 } },
    }))
    const { project, report } = await run.prepareReview(folder)
    expect(report.relinkedMedia).toMatchObject([{ assetRef: 'take', from: media, to: replacement }])
    expect(run.probeMedia).toHaveBeenCalledWith(replacement)
    expect(Object.values(project.media_pool)[0]?.path_abs).toBe(replacement)
    expect(() => validate(project)).not.toThrow()
    expect(run.actor.snapshot()).toBe(run.before)
  })

  it('reports sample quantization, point marker conversion, and discarded source metadata before commit', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('<resources>', '<import-options><option key="copy assets" value="false"/></import-options><resources>')
      .replace('<project name=', '<project uid="source-project" name=')
      .replace('<asset id="take"', '<asset id="take" uid="fictional-asset"')
      .replace('<media-rep kind=', '<media-rep sig="fictional-signature" kind=')
      .replace('<gap offset=', '<gap name="Hold" offset=')
      .replace('<marker value=', '<adjust-transform enabled="0" position="10 10"/><marker value=')
    await writeFile(media, 'Fictional video')
    await writeFile(document, xml)
    const { report } = await setup().prepareReview()
    const notes = report.compatibilityItems.flatMap(item => item.notes).join('\n')
    expect(notes).toMatch(/source metadata are not copied/)
    expect(notes).toContain('Source asset UID is not retained')
    expect(notes).toContain('Source media signature is not retained')
    expect(notes).toMatch(/copy assets = false/)
    expect(notes).toMatch(/Named gap/)
    expect(notes).toMatch(/Disabled transform/)
    expect(notes).toMatch(/becomes a point marker/)
    expect(notes).toMatch(/Audio start moved \d+\.\d+ µs (earlier|later) to fit the 48 kHz sample grid/)
  })

  it('reports an actual sample movement and leaves an already aligned edge out of the report', async () => {
    const xml = fixture(pathToFileURL(media).href)
      .replace('<asset-clip ref="take" name="Signal"', '<asset-clip ref="take" name="Signal" srcEnable="audio" offset="1/48000s"')
      .replace('<gap offset="3003/30000s" duration="1001/30000s"/>', '')
    await writeFile(media, 'Fictional video')
    await writeFile(document, xml)
    const { report, project } = await setup().prepareReview()
    const signal = report.compatibilityItems.find(item => item.label === 'Signal')!
    expect(signal.notes).not.toEqual(expect.arrayContaining([expect.stringContaining('Audio start moved')]))
    expect(signal.notes).toContain('Audio end moved 4.166667 µs later to fit the 48 kHz sample grid.')
    const audio = rootComposition(project).tracks[0]!.layers.find(layer => layer.label === 'Signal')!
    expect(audio).toMatchObject({ t_start_us: timeUsAtGridIndex(1, AUDIO_GRID), t_end_us: timeUsAtGridIndex(4806, AUDIO_GRID) })
  })

  it('suggests a different case spelling for a foreign path and waits for the user to choose it', async () => {
    const folder = join(parent, 'Found')
    await mkdir(folder)
    const source = process.platform === 'win32' ? 'file:///home/u/Harbor%20Lights.mov' : 'file:///C:/Media/Harbor%20Lights.mov'
    await writeFile(document, fixture(source))
    const candidate = join(folder, 'harbor lights.mov')
    await writeFile(candidate, 'Fictional replacement')
    const replacement = await realpath(candidate)
    const run = setup()
    await expect(run.prepareReview(folder)).rejects.toMatchObject({ issues: [{ assetRef: 'take',
      detail: expect.stringContaining('path is from another platform'), suggestedPaths: [replacement] }] })
    expect(run.probeMedia).not.toHaveBeenCalled()
    run.probeMedia.mockImplementation(async () => JSON.stringify({
      ...mediaItemTemplate(id, 'Video', 10_000_000, true), path_abs: replacement,
      metadata: { duration_us: 10_000_000,
        video: { width: 320, height: 240, fps_num: 30000, fps_den: 1001 },
        audio: { channels: 2, sample_rate: 48000 } },
    }))
    const { report } = await run.prepareReview(folder, [{ assetRef: 'take', path: replacement }])
    expect(run.probeMedia).toHaveBeenCalledExactlyOnceWith(replacement)
    expect(report.relinkedMedia).toMatchObject([{ assetRef: 'take', from: expect.stringContaining('Harbor Lights.mov'), to: replacement }])
  })

  it('rejects ambiguous replacement filenames without touching disk or project state', async () => {
    const folder = join(parent, 'Moved Originals')
    await mkdir(folder)
    await writeFile(join(folder, 'Harbor Lights.mov'), 'Fictional video')
    const secondSource = join(parent, 'Other Location', 'Harbor Lights.mov')
    const xml = fixture(pathToFileURL(media).href)
      .replace('</resources>', `<asset id="take2" hasVideo="1" hasAudio="1"
        audioSources="1" audioChannels="2" audioRate="48000" format="format"
        start="3600s" duration="10s">
        <media-rep kind="original-media" src="${pathToFileURL(secondSource).href}"/>
      </asset></resources>`)
      .replace('ref="take" name="Dock"', 'ref="take2" name="Dock"')
    await writeFile(document, xml)
    const run = setup()
    const candidate = await realpath(join(folder, 'Harbor Lights.mov'))
    await expect(run.prepareReview(folder)).rejects.toMatchObject({ issues: [
      { assetRef: 'take', label: 'Signal', suggestedPaths: [candidate], detail: expect.stringContaining('Ambiguous media relink') },
      { assetRef: 'take2', label: 'Dock', suggestedPaths: [candidate], detail: expect.stringContaining('Ambiguous media relink') },
    ] })
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
    expect(run.probeMedia).not.toHaveBeenCalled()
  })

  it('can keep or replace each asset independently when their original path is shared', async () => {
    const url = pathToFileURL(media).href
    const xml = fixture(url)
      .replace('</resources>', `<asset id="take2" name="Alternate Camera" hasVideo="1" hasAudio="1"
        format="format" start="3600s" duration="10s" src="${url}"/></resources>`)
      .replace('ref="take" name="Dock"', 'ref="take2" name="Dock"')
    await writeFile(document, xml)
    await writeFile(media, 'Fictional original video')
    const alternate = join(parent, 'Alternate.mov')
    await writeFile(alternate, 'Fictional alternate video')
    const original = await realpath(media)
    const replacement = await realpath(alternate)
    const replacementId = '00000000-0000-0000-0000-0000000000ac'
    const run = setup()
    run.probeMedia.mockImplementation(async (path?: string) => JSON.stringify({
      ...mediaItemTemplate(path === replacement ? replacementId : id, 'Video', 10_000_000, true),
      path_abs: path, metadata: { duration_us: 10_000_000,
        video: { width: 320, height: 240, fps_num: 30000, fps_den: 1001 },
        audio: { channels: 2, sample_rate: 48000 } },
    }))
    run.hashMediaSource.mockImplementation(async (path?: string) => (path === replacement ? 'b' : 'a').repeat(64))
    const importedVideos = (project: Awaited<ReturnType<typeof run.prepare>>) => rootComposition(project).tracks
      .flatMap(track => track.layers).filter(layer => layer.params.kind === 'VideoClip')
    const unchanged = await run.prepareReview()
    expect(run.probeMedia).toHaveBeenCalledExactlyOnceWith(original)
    expect(importedVideos(unchanged.project)).toMatchObject([
      { label: 'Signal', params: { media: id } }, { label: 'Dock', params: { media: id } },
    ])
    run.probeMedia.mockClear()
    const changed = await run.prepareReview(undefined, [{ assetRef: 'take2', path: replacement }])
    expect(run.probeMedia.mock.calls).toEqual([[original], [replacement]])
    expect(changed.report.relinkedMedia).toEqual([{ assetRef: 'take2', label: 'Alternate Camera', from: media, to: replacement }])
    expect(importedVideos(changed.project)).toMatchObject([
      { label: 'Signal', params: { media: id } }, { label: 'Dock', params: { media: replacementId } },
    ])
    expect(run.actor.snapshot()).toBe(run.before)
  })

  it('leaves the current project and disk untouched on a hash or source-range failure', async () => {
    await writeFile(media, 'Fictional video')
    const run = setup(90_000)
    await expect(run.prepare()).rejects.toThrow(/trim exceeds the probed duration/)
    run.hashMediaSource.mockRejectedValueOnce(new Error('source read failed'))
    await expect(run.prepare()).rejects.toThrow(/source read failed/)
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
  })

  it('imports a video-only edit without inventing an audio track', async () => {
    await writeFile(document, fixture(pathToFileURL(media).href)
      .replace('hasAudio="1" audioSources="1" audioChannels="2"\n        audioRate="48000"',
        'hasAudio="0" audioSources="0" audioChannels="0"\n        audioRate="0"'))
    await writeFile(media, 'Fictional silent video')
    const { prepareReview } = setup(10_000_000, null)
    const { project, report } = await prepareReview()
    expect(report).toMatchObject({ videoClips: 2, audioClips: 0, downmixedAudioClips: 0, resampledAudioClips: 0 })
    expect(rootComposition(project).tracks.flatMap((track) => track.layers).every((layer) => layer.params.kind === 'VideoClip')).toBe(true)
  })

  it('warns before resampling 96 kHz and downmixing six-channel audio', async () => {
    await writeFile(document, fixture(pathToFileURL(media).href)
      .replace('audioChannels="2"', 'audioChannels="6"')
      .replace('audioRate="48000"', 'audioRate="96000"')
      .replace('tcFormat="NDF"', 'tcFormat="NDF" audioLayout="surround" audioRate="96k"'))
    await writeFile(media, 'Fictional six-channel video')
    const { prepareReview } = setup(10_000_000, { channels: 6, sample_rate: 96000 })
    const { project, report } = await prepareReview()
    expect(report).toMatchObject({ videoClips: 2, audioClips: 2, resampledAudioClips: 2, downmixedAudioClips: 2 })
    expect(() => validate(project)).not.toThrow()
  })

  it('preserves a folder created during preparation', async () => {
    await writeFile(media, 'Fictional video')
    const run = setup()
    const project = await run.prepare()
    await mkdir(destination)
    await writeFile(join(destination, PROJECT_FILE), 'other project')
    expect(() => validate(project)).not.toThrow()
    expect(readFileSync(join(destination, PROJECT_FILE), 'utf8')).toBe('other project')
    expect(run.actor.snapshot()).toBe(run.before)
  })

})

describe('Illustrated Story still-image import transaction', () => {
  it('places a mono audio clip and an image overlay on independent editable lanes', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'weftcut-illustrated-story-'))
    try {
      const document = join(folder, 'Illustrated Story.fcpxml')
      const narration = join(folder, 'Narration.wav')
      const image = join(folder, 'Mouth A.png')
      const xml = illustratedStoryFixture(pathToFileURL(narration).href, pathToFileURL(image).href)
        .replace('lane="-1" offset="0s" start="0s" duration="120/60s"',
          'lane="-1" offset="1/48000s" start="0s" duration="95998/48000s"')
        .replace('duration="60/60s"/>', 'duration="60/60s"><marker start="1/60s" value="Expression"/></video>')
      await writeFile(document, xml)
      await writeFile(narration, 'synthetic mono-audio file')
      await writeFile(image, 'synthetic still-image file')
      const imagePath = await realpath(image)
      const probeMedia = vi.fn(async (filepath: string) => {
        const isImage = filepath === imagePath
        const id = isImage ? '00000000-0000-0000-0000-0000000000a1' : '00000000-0000-0000-0000-0000000000a2'
        return JSON.stringify({
          ...mediaItemTemplate(id, isImage ? 'Image' : 'Audio', isImage ? null : 2_000_000),
          path_abs: filepath, file_hash_blake3: `pending-${id}`,
          metadata: {
            duration_us: isImage ? null : 2_000_000,
            video: isImage ? { width: 120, height: 130, fps_num: 0, fps_den: 0 } : null,
            audio: isImage ? null : { sample_rate: 48000, channels: 1, codec: 'pcm_s16le' },
          },
        })
      })
      const inspectImage = vi.fn(async () => ({ width: 130, height: 120 }))
      const { project, report } = await prepareTimelineProject(
        document, join(folder, 'Imported project'), seededGen(),
        {
          inspectImage,
          compute: { probeMedia, hashMediaSource: async (filepath: string) => filepath === imagePath ? 'a'.repeat(64) : 'b'.repeat(64) },
          statPath: (filepath) => existsSync(filepath) && statSync(filepath).isFile() ? { kind: 'file', readable: true } : null,
        },
        () => {},
      )
      expect(report).toMatchObject({ videoClips: 1, audioClips: 1, connectedClips: 2, durationFrames: 120 })
      expect(inspectImage).toHaveBeenCalledExactlyOnceWith(imagePath)
      expect(report.mediaChanges).toContainEqual(expect.objectContaining({ kind: 'still-size',
        detail: expect.stringContaining('The editor displays this image at 130 × 120 pixels') }))
      const root = rootComposition(project)
      const images = root.tracks.flatMap((track) => track.layers.filter((layer) => layer.params.kind === 'ImageOverlay'))
      const audio = root.tracks.flatMap((track) => track.layers.filter((layer) => layer.params.kind === 'Audio'))
      expect(images).toHaveLength(1)
      expect(audio).toHaveLength(1)
      expect(images[0]).toMatchObject({ t_start_us: 500000, t_end_us: 1500000, params: { transform: {
        scale_x: { mode: 'Static', value: 240 / 120 }, scale_y: { mode: 'Static', value: 240 / 120 },
      } } })
      expect(report.compatibilityItems.some(item => item.notes.some(note => note.includes('Still image uses fit')))).toBe(true)
      expect(audio[0]).toMatchObject({ t_start_us: 21, t_end_us: 1999979 })
      expect(root.markers).toMatchObject([{ t_us: 516667, label: 'Expression', anchor: null }])
      expect(() => validate(project)).not.toThrow()
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
