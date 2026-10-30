import {Container,type Application} from 'pixi.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Compositor} from './Compositor';
import {ExportDecoderPool} from './decoder/ExportDecoderPool';
import {ImageOverlaySprite} from './sprite/ImageOverlaySprite';
import {summaryFixture} from '../testing/summaryFixture';
import type {LayerSummary} from '../ipc';

const stat=(value:number)=>({mode:'Static' as const,value});
const transform={x:stat(0),y:stat(0),scale_x:stat(1),scale_y:stat(1),scale_linked:true,
 rotation_deg:stat(0),anchor_x:stat(.5),anchor_y:stat(.5),opacity:stat(1),fade_in_us:0,fade_out_us:0};
const layer={t_start_us:0,t_end_us:1_000_000,color_hint:'#000000',enabled:true,locked:false,effects:[]};
const video:LayerSummary={...layer,id:'clip',label:'Clip',kind:'VideoClip',params:{...transform,
 kind:'VideoClip',media_id:'video',media_label:'Clip',src_in_us:0,src_out_us:1_000_000,speed:1,flip_h:false,flip_v:false,crop:null}};
const image:LayerSummary={...layer,id:'still',label:'Still',kind:'ImageOverlay',params:{...transform,
 kind:'ImageOverlay',media_id:'image',media_label:'Still',graphic_role:null}};
const summary=summaryFixture({root:{tracks:[{id:'visual',label:null,kind:'Video',enabled:true,locked:false,
 muted:false,solo:false,role:'a-roll',transient:false,layers:[video,image]}]}});

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('export repaint ownership',()=>{
 it.each(['export','preview'] as const)('image preload respects the %s frame driver',async mode=>{
  const callbacks:FrameRequestCallback[]=[];
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>callbacks.push(callback));
  vi.spyOn(ImageOverlaySprite.prototype,'loadFromAsset').mockResolvedValue();
  const pool=new ExportDecoderPool();
  const compositor=new Compositor({app:{stage:new Container()} as unknown as Application,
   width:1920,height:1080,mode,pool,originalAssetUrl:()=>'/still.png',proxyAssetUrl:()=>'/clip.mp4',
   sourceColor:()=>undefined,mediaById:()=>undefined});
  try{
   compositor.setProject(summary);
   const composite=vi.spyOn(compositor,'compositeFrame');
   await compositor.preloadImages();
   expect(pool.handles.size).toBe(0);
   // Image completion used to queue an export repaint before the worker had
   // opened the admitted native decoder. Its implicit WebCodecs acquire then
   // poisoned the shared pool identity and exceeded the native memory plan.
   expect(callbacks).toHaveLength(mode==='export'?0:1);
   if(mode==='export'){
    compositor.scheduleRepaint();
    expect(callbacks).toHaveLength(0);
    expect(composite).not.toHaveBeenCalled();
    const sweep=vi.spyOn(compositor.rootNode(),'compositeVisual').mockImplementation(()=>{});
    compositor.compositeFrame(0);
    expect(sweep).toHaveBeenCalledOnce();
   }else{
    compositor.scheduleRepaint();
    expect(callbacks).toHaveLength(1); // preview still coalesces async arrivals
   }
  }finally{compositor.dispose();}
 });
});
