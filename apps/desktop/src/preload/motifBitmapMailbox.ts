/** One-shot GPU snapshots wait only for the matching invoke reply. Retention
 * is bounded; a lost reply or document teardown never leaks graphics memory. */
export class MotifBitmapMailbox {
  private values = new Map<string, { bitmap: ImageBitmap; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  constructor(private readonly capacity = 8, private readonly ttl = 5000) {}
  put(token: string, bitmap: ImageBitmap): void {
    if (this.closed || this.values.has(token) || this.values.size >= this.capacity) {
      throw new Error('Motif GPU snapshot mailbox unavailable');
    }
    const timer = setTimeout(() => { const value = this.values.get(token); this.values.delete(token); value?.bitmap.close(); }, this.ttl);
    this.values.set(token, { bitmap, timer });
  }
  take(token: string): ImageBitmap {
    const value = this.values.get(token);
    if (!value) throw new Error('Motif GPU snapshot missing or expired');
    clearTimeout(value.timer); this.values.delete(token); return value.bitmap;
  }
  close(): void {
    this.closed = true;
    for (const value of this.values.values()) { clearTimeout(value.timer); value.bitmap.close(); }
    this.values.clear();
  }
}
