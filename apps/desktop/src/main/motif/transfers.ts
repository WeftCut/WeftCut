import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync, rmSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const MAX_FILE = 256 * 1024 * 1024, MAX_TOTAL = 512 * 1024 * 1024, TTL = 24 * 60 * 60 * 1000;
export const FILE_CHUNK_BYTES = 256 * 1024;
interface Transfer {
    size: number;
    sha256: string;
    expires: number;
}
function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function range(file: string, offset: number, length: number) { const fd = openSync(file, 'r'); try {
    const bytes = Buffer.alloc(length);
    return bytes.subarray(0, readSync(fd, bytes, 0, length, offset));
}
finally {
    closeSync(fd);
} }
/** Bounded app-owned temporary files shared by upload, read and export. IDs are
 * capabilities within the authenticated local API; paths are never accepted. */
export class FileTransfers {
    constructor(private root: string) { }
    private file(id: string, suffix: string) { if (!/^[0-9a-f-]{36}$/.test(id))
        throw new Error('Invalid file_id'); return path.join(this.root, id + suffix); }
    private metadata(id: string): Transfer {
        const meta = JSON.parse(readFileSync(this.file(id, '.json'), 'utf8')) as Transfer;
        if (meta.expires < Date.now()) {
            this.delete(id);
            throw new Error('File transfer expired; upload again');
        }
        return meta;
    }
    begin(size: number, sha256: string) {
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
            throw new Error('Upload requires size <= 256 MiB and lowercase SHA-256');
        mkdirSync(this.root, { recursive: true });
        let reserved = 0, count = 0;
        for (const name of readdirSync(this.root).filter(n => n.endsWith('.json'))) {
            const id = name.slice(0, -5);
            try {
                reserved += this.metadata(id).size;
                count++;
            }
            catch {
                this.delete(id);
            }
        }
        if (reserved + size > MAX_TOTAL || count >= 64)
            throw new Error('File transfer quota exceeded; delete unused transfers');
        const file_id = randomUUID(), meta: Transfer = { size, sha256, expires: Date.now() + TTL };
        if (size === 0 && sha256 !== digest(Buffer.alloc(0)))
            throw new Error('SHA-256 mismatch');
        writeFileSync(this.file(file_id, '.bin'), Buffer.alloc(0), { flag: 'wx' });
        writeFileSync(this.file(file_id, '.json'), JSON.stringify(meta), { flag: 'wx' });
        return { file_id, size, sha256, chunk_bytes: FILE_CHUNK_BYTES, complete: size === 0 };
    }
    write(id: string, offset: number, base64: string) {
        const meta = this.metadata(id), file = this.file(id, '.bin'), size = statSync(file).size;
        if (typeof base64 !== 'string' || base64.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4 || !Number.isSafeInteger(offset) || offset < 0)
            throw new Error('Invalid upload chunk');
        const bytes = Buffer.from(base64, 'base64');
        if (!bytes.length || bytes.length > FILE_CHUNK_BYTES || bytes.toString('base64') !== base64 || offset + bytes.length > meta.size)
            throw new Error('Invalid base64 chunk or declared size');
        if (offset < size) {
            if (offset + bytes.length > size || !range(file, offset, bytes.length).equals(bytes))
                throw new Error('Upload chunk conflict');
        }
        else if (offset === size)
            appendFileSync(file, bytes);
        else
            throw new Error('Upload offset gap; resume from received_bytes');
        const received = statSync(file).size, complete = received === meta.size;
        if (complete && digest(readFileSync(file)) !== meta.sha256) {
            this.delete(id);
            throw new Error('SHA-256 mismatch; upload again');
        }
        return { file_id: id, received_bytes: received, complete };
    }
    bytes(id: string) {
        const meta = this.metadata(id), bytes = readFileSync(this.file(id, '.bin'));
        if (bytes.length !== meta.size)
            throw new Error('File upload is incomplete');
        if (digest(bytes) !== meta.sha256)
            throw new Error('File transfer integrity failure');
        return bytes;
    }
    read(id: string, offset = 0, length = FILE_CHUNK_BYTES) {
        const meta = this.metadata(id), received = statSync(this.file(id, '.bin')).size;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > received || !Number.isSafeInteger(length) || length < 1 || length > FILE_CHUNK_BYTES)
            throw new Error('Invalid download range');
        const bytes = range(this.file(id, '.bin'), offset, length);
        return { file_id: id, size: meta.size, sha256: meta.sha256, received_bytes: received, complete: received === meta.size, offset, base64: bytes.toString('base64'), next_offset: offset + bytes.length, eof: offset + bytes.length === meta.size };
    }
    put(bytes: Buffer) {
        const result = this.begin(bytes.length, digest(bytes));
        const dest = this.file(result.file_id, '.bin'), temp = dest + '.tmp';
        try {
            writeFileSync(temp, bytes);
            renameSync(temp, dest);
        }
        finally {
            rmSync(temp, { force: true });
        }
        return { ...result, complete: true };
    }
    delete(id: string) { rmSync(this.file(id, '.json'), { force: true }); rmSync(this.file(id, '.bin'), { force: true }); }
}
