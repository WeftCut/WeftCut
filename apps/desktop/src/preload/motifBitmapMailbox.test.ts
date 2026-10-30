import { afterEach, expect, it, vi } from 'vitest';
import { MotifBitmapMailbox } from './motifBitmapMailbox';
const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;
afterEach(() => vi.useRealTimers());
it('transfers exact snapshots once, never closes a transferred bitmap', () => {
  const mailbox = new MotifBitmapMailbox(), frame = bitmap();
  mailbox.put('a', frame); expect(mailbox.take('a')).toBe(frame);
  expect(() => mailbox.take('a')).toThrow(); mailbox.close();
  expect(frame.close).not.toHaveBeenCalled();
});
it('bounds unclaimed snapshots and expires or closes each one', async () => {
  vi.useFakeTimers();
  const mailbox = new MotifBitmapMailbox(1, 50), a = bitmap(), b = bitmap();
  mailbox.put('a', a); expect(() => mailbox.put('b', b)).toThrow();
  expect(b.close).not.toHaveBeenCalled(); // caller still owns a rejected put
  await vi.advanceTimersByTimeAsync(50); expect(a.close).toHaveBeenCalledOnce();
  mailbox.put('b', b); mailbox.close(); expect(b.close).toHaveBeenCalledOnce();
  expect(() => mailbox.take('b')).toThrow(); expect(() => mailbox.put('c', bitmap())).toThrow();
});
