import { expect, it } from 'vitest'
import { importDiagnosticDetails } from './importDiagnosticExport'
it('exports useful timings and codec context without expanding project-data export', () => {
  const details = { schema: 1, import_id: 'request-1', media_label: 'Private shoot', path: 'C:/private/video.mp4',
    stage: 'background_settled', elapsed_ms: 1500, error: 'failed opening C:/private/video.mp4',
    video: { codec: 'h264', width: 3840, pix_fmt: 'yuv420p', title: 'private title' },
    stages: [{ stage: 'copy', queue_ms: 800, work_ms: 600, total_ms: 1400,
      admission_at_enqueue: { playing: true, background_playback: false, reserved_mib: 512, secret: 'excluded' } }],
    milestones_ms: { editable: 1200, private_name: 'excluded' },
  }
  const result = importDiagnosticDetails({ category: { kind: 'Import' }, message: 'Import timing: background_settled', details })!
  expect(result).toMatchObject({ schema: 1, import_id: 'request-1', elapsed_ms: 1500,
    video: { codec: 'h264', width: 3840, pix_fmt: 'yuv420p' }, milestones_ms: { editable: 1200 },
    stages: [{ queue_ms: 800, work_ms: 600, admission_at_enqueue: { playing: true, background_playback: false } }] })
  const json = JSON.stringify(result)
  expect(json).not.toMatch(/private|Private|secret|excluded/)
  expect(importDiagnosticDetails({ category: { kind: 'Project' }, message: 'ordinary', details })).toBeUndefined()
  expect(importDiagnosticDetails({ category: { kind: 'Import' }, message: 'ordinary', details })).toBeUndefined()
})
