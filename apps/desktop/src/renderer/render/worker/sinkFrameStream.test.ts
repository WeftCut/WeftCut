import { describe, expect, it } from "vitest";
import { SinkFrameStream, type SinkFramePort, type SinkStreamMessage } from "./sinkFrameStream";

function fakePort() {
  const sent: number[] = [];
  const port: SinkFramePort = {
    onmessage: null,
    postMessage: (frame) => { sent.push(frame[0]!); },
  };
  const reply = (data: SinkStreamMessage) => port.onmessage!({ data } as MessageEvent<SinkStreamMessage>);
  return { port, sent, reply };
}

describe("SinkFrameStream", () => {
  it("keeps at most `window` frames unanswered and sends in order", async () => {
    const { port, sent, reply } = fakePort();
    const stream = new SinkFrameStream(port, 2);
    await stream.send(new Uint8Array([0]));
    await stream.send(new Uint8Array([1]));
    let third = false;
    const pending = stream.send(new Uint8Array([2])).then(() => { third = true; });
    await Promise.resolve();
    expect(sent).toEqual([0, 1]);
    expect(third).toBe(false);
    reply({ written: 1 });
    await pending;
    expect(sent).toEqual([0, 1, 2]);
    reply({ written: 2 }); reply({ written: 3 });
    await stream.settle();
  });

  it("transfers each frame's buffer", async () => {
    const transfers: Transferable[][] = [];
    const port: SinkFramePort = { onmessage: null, postMessage: (_frame, transfer) => { transfers.push(transfer); } };
    const stream = new SinkFrameStream(port, 4);
    const frame = new Uint8Array([1, 2, 3]);
    await stream.send(frame);
    expect(transfers).toEqual([[frame.buffer]]);
  });

  it("fails the next send and settle with main's error", async () => {
    const { port, reply } = fakePort();
    const stream = new SinkFrameStream(port, 1);
    await stream.send(new Uint8Array([0]));
    reply({ error: "ffmpeg stdin: broken pipe" });
    await expect(stream.send(new Uint8Array([1]))).rejects.toThrow("broken pipe");
    await expect(stream.settle()).rejects.toThrow("broken pipe");
  });
  it("gives the next frame a sent frame's buffer once it comes back, and a new one otherwise", () => {
    const { port, reply } = fakePort();
    const stream = new SinkFrameStream(port, 2);
    const first = stream.buffer(6);
    expect(first.byteLength).toBe(6);
    reply({ recycled: first });
    expect(stream.buffer(6)).toBe(first);
    expect(stream.buffer(6)).not.toBe(first);
  });

  it("never hands out a returned buffer of another size", () => {
    const { port, reply } = fakePort();
    const stream = new SinkFrameStream(port, 2);
    reply({ recycled: new Uint8Array(4) });
    expect(stream.buffer(6).byteLength).toBe(6);
  });
});
