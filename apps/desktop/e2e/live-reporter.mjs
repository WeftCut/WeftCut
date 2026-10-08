import fs from 'node:fs'
import path from 'node:path'

/** JSON's final report is absent after cancellation. Flush each lifecycle
 * event separately so the last started test and earlier results survive. */
export default class LiveReporter {
  constructor() {
    const report = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? path.resolve('e2e-report/e2e.json')
    this.file = report.replace(/\.json$/, '') + '.live.jsonl'
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
  }
  onBegin() {
    fs.writeFileSync(this.file, JSON.stringify({ at: Date.now(), event: 'begin' }) + '\n')
  }
  write(record) { fs.appendFileSync(this.file, JSON.stringify({ at: Date.now(), ...record }) + '\n') }
  onTestBegin(test, result) { this.write({ event: 'test-begin', title: test.titlePath(), file: test.location.file, retry: result.retry, worker: result.workerIndex }) }
  onTestEnd(test, result) { this.write({ event: 'test-end', title: test.titlePath(), status: result.status, duration: result.duration, retry: result.retry, errors: result.errors, attachments: result.attachments.map(({ name, path, contentType }) => ({ name, path, contentType })) }) }
  onError(error) { this.write({ event: 'error', error }) }
  onEnd(result) { this.write({ event: 'end', status: result.status }) }
}
