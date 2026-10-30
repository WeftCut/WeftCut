import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import common from './common.cjs';

test('JSON exports remove filesystem roots and credential values, including nested URL paths', () => {
  const data = { count: 40, location: path.join(common.output, '.private', 'profile'),
    nested: [{ source: encodeURIComponent(path.join(common.repository, 'sample.mp4')),
      stack: `${path.join(os.homedir(), 'private-fixture')}:1`, authorization: 'example credential',
      api_key: 'example credential', client_secret: 'example credential', finalizationToken: 'example credential',
      error: 'Request failed: Bearer example-credential' }] };
  const result = JSON.stringify(common.sanitize(data));
  for (const root of [common.output, common.repository, os.homedir()]) {
    assert(!result.includes(root));
    assert(!result.includes(encodeURIComponent(root)));
  }
  assert(!result.includes('example credential'));
  assert(!result.includes('example-credential'));
  assert.equal(JSON.parse(result).count, 40);
  assert(result.includes('<output>'));
});
