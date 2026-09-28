// Real Electron IPC + bitmap creation. Optional MOTIF_BENCH_PNG names an existing
// PNG (read-only); the default fixture is synthetic. Artifacts go to .scratch.
const {app, BrowserWindow, ipcMain, sharedTexture} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {PNG} = require('pngjs');
const native = require('../../apps/desktop/native');
const root = path.resolve(__dirname, '../..');
const work = path.join(root, '.scratch/motif-cache-bench');
app.setPath('userData', path.join(work, 'profile'));
app.whenReady().then(async () => {
  await fs.mkdir(work, {recursive:true});
  let png;
  if(process.env.MOTIF_BENCH_PNG) png = await fs.readFile(process.env.MOTIF_BENCH_PNG);
  else {
    const fixture = new PNG({width:1920,height:1080});
    for(let y=0;y<1080;y++)for(let x=0;x<1920;x++){
      const i=(y*1920+x)*4;
      fixture.data[i]=(x>>3)%256;fixture.data[i+1]=(y>>2)%256;
      fixture.data[i+2]=(x+y)%256;fixture.data[i+3]=(x*7+y*11)%256;
    }
    png=PNG.sync.write(fixture);
  }
  await fs.writeFile(path.join(work,'frame.png'),png);
  for(const codec of ['raw','lz4'])await fs.writeFile(path.join(work,codec),await native.motifEncodePng(png,codec==='lz4'));
  ipcMain.handle('frame', async(_e,codec)=>codec==='png'
    ? {png:await fs.readFile(path.join(work,'frame.png'))}
    : native.motifReadFrame(path.join(work,codec)));
  const win = new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false}});
  await win.loadURL('about:blank');
  let pool, imported;
  if(process.env.MOTIF_BENCH_GPU==='1'){
    const pixels=await native.motifReadFrame(path.join(work,'lz4'));
    pool=new native.MotifGpuPool(pixels.width,pixels.height,1);
    imported=sharedTexture.importSharedTexture({textureInfo:{
      codedSize:{width:pixels.width,height:pixels.height},pixelFormat:'rgba',
      colorSpace:{primaries:'bt709',transfer:'srgb',matrix:'rgb',range:'full'},
      handle:{ntHandle:pool.handles()[0]},
    },allReferencesReleased:()=>{}});
    await sharedTexture.sendSharedTexture({frame:win.webContents.mainFrame,importedSharedTexture:imported});
    ipcMain.handle('gpu',async()=>{await pool.uploadFile(path.join(work,'lz4'),0);return null});
  }
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const result={};
    const canvas=new OffscreenCanvas(1920,1080), ctx=canvas.getContext('2d',{willReadFrequently:true});
    let reference;
    const gpu=()=>new Promise((resolve,reject)=>{
      const listener=e=>{if(e.source!==window||e.data?.type!=='gpu-result')return;window.removeEventListener('message',listener);e.data.error?reject(new Error(e.data.error)):resolve(e.data.bitmap)};
      window.addEventListener('message',listener);window.postMessage({type:'gpu-request'},'*');
    });
    for(const codec of ${JSON.stringify(process.env.MOTIF_BENCH_GPU==='1'?['png','raw','lz4','gpu']:['png','raw','lz4'])}){
      const times=[],loads=[],bitmaps=[];
      for(let i=0;i<35;i++){
        const t=performance.now(),frame=codec==='gpu'?await gpu():await window.bench.frame(codec),loaded=performance.now();
        const bmp=codec==='gpu'?frame:await createImageBitmap(frame.png?new Blob([frame.png],{type:'image/png'}):new ImageData(new Uint8ClampedArray(frame.rgba.buffer,frame.rgba.byteOffset,frame.rgba.byteLength),frame.width,frame.height));
        const end=performance.now();
        if(i>=5){times.push(end-t);loads.push(loaded-t);bitmaps.push(end-loaded)}
        if(i===0){
          canvas.width=bmp.width;canvas.height=bmp.height;ctx.clearRect(0,0,bmp.width,bmp.height);ctx.drawImage(bmp,0,0);
          const pixels=ctx.getImageData(0,0,bmp.width,bmp.height).data;
          if(reference){let mismatch=0,max=0,alphaMismatch=0;for(let j=0;j<pixels.length;j++){const d=Math.abs(pixels[j]-reference[j]);if(d){mismatch++;if(j%4===3)alphaMismatch++}max=Math.max(max,d)}result[codec+'Parity']={mismatch,max,alphaMismatch,sample:[...pixels.slice(0,32)],reference:[...reference.slice(0,32)]};}
          else reference=pixels;
        }
        bmp.close();
      }
      const stat=a=>{a.sort((x,y)=>x-y);return{mean:a.reduce((x,y)=>x+y,0)/a.length,p50:a[15],p95:a[28]}};
      result[codec]={total:stat(times),load:stat(loads),bitmap:stat(bitmaps)};
    }
    return result;
  })()`);
  result.bytes={};for(const name of ['frame.png','raw','lz4'])result.bytes[name]=(await fs.stat(path.join(work,name))).size;
  await fs.writeFile(path.join(work,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if(result.rawParity.mismatch||result.lz4Parity.mismatch||result.gpuParity?.mismatch)process.exitCode=1;
  win.destroy();imported?.release();pool?.close();app.exit(process.exitCode??0);
}).catch(e=>{console.error(e);app.exit(1)});
