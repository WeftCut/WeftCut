// Relays the export Worker's packed frames to the native sink's port in main.
// Posting to main copies the frame (structured clone across processes); here
// that copy runs beside compositing instead of on its thread. The copy is made
// as the frame is posted, so its buffer goes straight back for the next frame.
// Replies go back unchanged, so frame order and backpressure stay the export
// Worker's (sinkFrameStream.ts).

self.onmessage = ({ data }: MessageEvent<{ frames: MessagePort; sink: MessagePort }>) => {
  const { frames, sink } = data;
  frames.onmessage = ({ data: frame }: MessageEvent<Uint8Array>) => {
    sink.postMessage(frame);
    frames.postMessage({ recycled: frame }, [frame.buffer]);
  };
  sink.onmessage = ({ data: reply }) => frames.postMessage(reply);
  self.onmessage = null;
};
