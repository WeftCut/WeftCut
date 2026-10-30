// Lane g of the fair comparison: the native reader in a utility process. It
// answers the renderer worker on a MessagePortMain, so neither main's thread
// nor the page's main thread touches the pixels.
let native, directories, corruptFile;
const frameFile = (content, frame) => content === 'corrupt' ? corruptFile
  : require('node:path').join(directories[content], `${frame % 8}.wfrm`);

process.parentPort.on('message', ({ data, ports }) => {
  if (data.init) {
    native = require(data.init.native);
    ({ directories, corruptFile } = data.init);
    return;
  }
  const port = ports[0];
  port.on('message', async ({ data: { id, content, frame, div } }) => {
    try {
      const f = await native.motifReadFrameScaled(frameFile(content, frame), div);
      port.postMessage({ id, width: f.width, height: f.height, rgba: f.rgba, native: f.timing });
    } catch (error) { port.postMessage({ id, error: String(error?.message ?? error) }); }
  });
  port.start();
});
