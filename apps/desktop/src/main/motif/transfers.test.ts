import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileTransfers } from './transfers';
it('accepts retryable chunks, verifies bytes before use, and supports bounded download after restart', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'file-transfers-'));
    try {
        const transfers = new FileTransfers(root), bytes = Buffer.from([0, 1, 255, 42]);
        const { file_id } = transfers.begin(bytes.length, createHash('sha256').update(bytes).digest('hex'));
        expect(() => transfers.bytes(file_id)).toThrow(/incomplete/);
        expect(transfers.write(file_id, 0, bytes.subarray(0, 2).toString('base64')).complete).toBe(false);
        transfers.write(file_id, 0, bytes.subarray(0, 2).toString('base64'));
        expect(() => transfers.write(file_id, 0, '/w==')).toThrow(/conflict/);
        expect(transfers.write(file_id, 2, bytes.subarray(2).toString('base64')).complete).toBe(true);
        expect(new FileTransfers(root).bytes(file_id)).toEqual(bytes);
        expect(transfers.read(file_id, 2, 2).base64).toBe(bytes.subarray(2).toString('base64'));
        transfers.delete(file_id);
        expect(() => transfers.bytes(file_id)).toThrow();
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
