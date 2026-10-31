import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFileBytes } from '../web/export-files.mjs';
test('file sizes are finite and human readable without implying decimal gigabytes', () => {
  assert.equal(formatFileBytes(0), '0 Б');
  assert.equal(formatFileBytes(1048576), '1 МиБ');
  assert.equal(formatFileBytes(1073741824), '1 ГиБ');
  assert.equal(formatFileBytes(NaN), '—');
  assert.equal(formatFileBytes(-1), '—');
});
