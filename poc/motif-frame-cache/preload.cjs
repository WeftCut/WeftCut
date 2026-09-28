const {contextBridge,ipcRenderer,sharedTexture}=require('electron');
contextBridge.exposeInMainWorld('bench',{frame:codec=>ipcRenderer.invoke('frame',codec)});
let imported;
sharedTexture.setSharedTextureReceiver(async data=>{imported?.release();imported=data.importedSharedTexture});
const ctx=new OffscreenCanvas(1,1).getContext('2d',{willReadFrequently:true});
window.addEventListener('message',async e=>{
  if(e.source!==window||e.data?.type!=='gpu-request')return;
  try{
    await ipcRenderer.invoke('gpu');
    const vf=imported.getVideoFrame();
    let bitmap;
    try{bitmap=await createImageBitmap(vf)}finally{vf.close()}
    ctx.drawImage(bitmap,0,0,1,1);ctx.getImageData(0,0,1,1);
    window.postMessage({type:'gpu-result',bitmap},'*',[bitmap]);
  }catch(error){window.postMessage({type:'gpu-result',error:String(error)},'*')}
});
