// Frame-accurate OSR conformance against the production CDP screenshot path.
// Synthetic HTML/CSS/Canvas, forward/reverse/repeated seeks, size changes, alpha.
const {app,BrowserWindow,ipcMain,protocol,sharedTexture}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),esbuild=require('esbuild');
const native=require('../../apps/desktop/native');
const root=path.resolve(__dirname,'../..'),work=path.join(root,'.scratch/motif-osr-bench');
app.setPath('userData',path.join(work,'profile'));
protocol.registerSchemesAsPrivileged([{scheme:'motif',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const html=`<!doctype html><style>html,body{margin:0;background:transparent}#box{position:absolute;width:81px;height:47px;background:rgba(40,170,220,.47);border-radius:9px}#text{position:absolute;top:56px;color:rgba(240,90,40,.71);font:19px Arial}canvas{position:absolute;top:83px}</style><div id="box"></div><div id="text">Synthetic frame</div><canvas width="256" height="40"></canvas><script>
motif.define({frame(t){const i=Math.round(t*30);document.querySelector('#box').style.transform='translateX('+(i%130)+'px)';document.querySelector('#text').textContent='Frame '+i;const c=document.querySelector('canvas').getContext('2d');c.clearRect(0,0,256,40);c.fillStyle='rgba('+i%255+',66,150,.31)';c.fillRect(i%150,1,100,30)}});
</script>`;
app.whenReady().then(async()=>{
 await fs.mkdir(work,{recursive:true});
 for(const [name,entry] of [['capture','apps/desktop/src/main/motif/capture.ts'],['runtime','apps/desktop/src/renderer/render/motifs/runtime.ts']]){
   await esbuild.build({entryPoints:[path.join(root,entry)],outfile:path.join(work,name+'.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
 }
 const capture=require(path.join(work,'capture.cjs'));
 capture.setRuntimeSource(require(path.join(work,'runtime.cjs')).MOTIF_RUNTIME_SOURCE);
 capture.setTextureCaptureEnabled(true);
 protocol.handle('motif',()=>new Response(html,{headers:{'Content-Type':'text/html'}}));
 const win=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false}});
 await win.loadURL('about:blank');
 let pool,imp,size='',current=0,settle=2,navigation=0;
 const args=()=>({motifId:process.env.MOTIF_OSR_NAVIGATE?'synthetic-probe-'+navigation:'synthetic-probe',tSec:current/30,propsJson:'{}',width:process.env.MOTIF_OSR_FIXED_SIZE?'256'|0:current%2?320:256,height:144,settleRafs:settle,contentHash:'fixture-v1',fpsNum:30,fpsDen:1});
 ipcMain.handle('frame',async(_e,request)=>{
   if(request.kind==='set'){current=request.frame;settle=request.settle;navigation++;return null}
   return {png:Buffer.from(await capture.captureMotifFrameB64(args()),'base64')};
 });
 ipcMain.handle('gpu',()=>capture.captureMotifTexture(args(),async texture=>{
   const info=texture.textureInfo, sig=JSON.stringify([info.codedSize,info.pixelFormat]);
   if(sig!==size){
     // Old imports remain alive until the test receiver replaces its reference.
     const oldPool=pool,oldImp=imp;
     pool=new native.MotifGpuPool(info.codedSize.width,info.codedSize.height,1,info.pixelFormat==='bgra');
     const thisPool=pool;
     imp=sharedTexture.importSharedTexture({textureInfo:{codedSize:info.codedSize,pixelFormat:info.pixelFormat,colorSpace:info.colorSpace,handle:{ntHandle:pool.handles()[0]}},allReferencesReleased:()=>thisPool.close()});
     await sharedTexture.sendSharedTexture({frame:win.webContents.mainFrame,importedSharedTexture:imp});
     oldImp?.release();if(!oldImp)oldPool?.close();size=sig;
   }
   await pool.copyTexture(info.handle.ntHandle,0);
   return null;
 }));
 const result=await win.webContents.executeJavaScript(`(async()=>{
   const gpu=()=>new Promise((resolve,reject)=>{const listener=e=>{if(e.source!==window||e.data?.type!=='gpu-result')return;window.removeEventListener('message',listener);e.data.error?reject(new Error(e.data.error)):resolve(e.data.bitmap)};window.addEventListener('message',listener);window.postMessage({type:'gpu-request'},'*')});
   const times=[],pngTimes=[],failures=[];
   const c=new OffscreenCanvas(320,144),ctx=c.getContext('2d',{willReadFrequently:true});
   const pixels=b=>{c.width=b.width;c.height=b.height;ctx.clearRect(0,0,b.width,b.height);ctx.drawImage(b,0,0);return ctx.getImageData(0,0,b.width,b.height).data};
   for(const settle of [0,1,2])for(const frame of [0,1,60,3,90,0,0,4,4,121,14,80,7,7,2,99,2,1,0,30]){
     await window.bench.frame({kind:'set',frame,settle});
     let t=performance.now();const bitmap=await gpu();times.push(performance.now()-t);const actual=pixels(bitmap);bitmap.close();
     t=performance.now();const png=await window.bench.frame({kind:'png'});const reference=await createImageBitmap(new Blob([png.png],{type:'image/png'}));pngTimes.push(performance.now()-t);const expected=pixels(reference);reference.close();
     let mismatch=0,max=0;for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-expected[i]);if(d)mismatch++;max=Math.max(max,d)}
     if(mismatch){let first=0;while(actual[first]===expected[first])first++;failures.push({frame,settle,mismatch,max,first,actual:[...actual.slice(first-first%4,first-first%4+4)],expected:[...expected.slice(first-first%4,first-first%4+4)]})};
   }
   const stat=a=>({n:a.length,mean:a.reduce((x,y)=>x+y,0)/a.length,max:Math.max(...a)});
   return {gpu:stat(times),png:stat(pngTimes),failures};
 })()`);
 console.log(JSON.stringify(result,null,2));await fs.writeFile(path.join(work,'result.json'),JSON.stringify(result,null,2));
 capture.shutdownCaptureHost();win.destroy();imp?.release();app.exit(result.failures.length?1:0);
}).catch(error=>{console.error(error);app.exit(1)});
