// Lanes f/g of the fair comparison: the renderer half. Requests and pixels
// travel on this worker's own port, so only the finished bitmap reaches the page.
let port;
const asked = new Map();

onmessage = ({ data }) => {
  if (data.port) {
    port = data.port;
    port.onmessage = reply;
    postMessage({ id: data.id });
    return;
  }
  asked.set(data.id, performance.now());
  port.postMessage(data);
};

async function reply({ data }) {
  const arrived = performance.now(), requested = asked.get(data.id);
  asked.delete(data.id);
  if (data.error) { postMessage({ id: data.id, error: data.error }); return; }
  try {
    const { rgba } = data;
    const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const bitmap = await createImageBitmap(new ImageData(pixels, data.width, data.height));
    postMessage({ id: data.id, bitmap, native: data.native, stages: { roundTripMs: arrived - requested, bitmapMs: performance.now() - arrived } }, [bitmap]);
  } catch (error) { postMessage({ id: data.id, error: String(error?.message ?? error) }); }
}
