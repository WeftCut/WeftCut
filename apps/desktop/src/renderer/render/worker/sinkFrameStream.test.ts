import { describe, expect, it } from "vitest";
import { SinkFrameStream, type SinkFramePort } from "./sinkFrameStream";
import type { SinkPortReply } from "../../../shared/exportSinkPort";

function fakePort() {
  const sent: number[] = [];
  const port: SinkFramePort = {
    onmessage: null,
    postMessage: (frame) => { sent.push(frame[0]!); },
  };
  const reply = (data: SinkPortReply) => port.onmessage!({ data } as MessageEvent<SinkPortReply>);
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
});
