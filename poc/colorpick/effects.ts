// Real project EffectChain and shaders, isolated from project persistence.
import { Application, Container, Sprite, Texture, Rectangle } from 'pixi.js';
import { EffectChain } from '../../apps/desktop/src/renderer/render/effects/EffectChain';
import { setEffectDisabled, resetEffectOverrides } from '../../apps/desktop/src/renderer/render/effects/effectOverrides';
import { containMap } from '../../apps/desktop/src/renderer/colorpick/pixel';

(window as any).runEffectsProbe = async () => {
 const app = new Application();
 await app.init({ width:64,height:64,preference:'webgl',backgroundAlpha:0,autoStart:false });
 const layer=new Container(); const fill=new Sprite(Texture.WHITE);
 fill.width=64;fill.height=64;fill.tint=0x408020;layer.addChild(fill);app.stage.addChild(layer);
 const chain=new EffectChain();
 const key={id:'key',kind:'chromakey',enabled:true,params:{}};
 const grade={id:'grade',kind:'brightness',enabled:true,params:{amount:{mode:'Static' as const,value:25}}};
 const read=()=>{
   app.renderer.render(app.stage);
   const out=app.renderer.extract.pixels({target:app.stage,frame:new Rectangle(0,0,64,64),resolution:1});
   return Array.from(out.pixels.slice((32*64+32)*4,(32*64+32)*4+4));
 };
 const input=read();
 setEffectDisabled('key',true);
 layer.filters=chain.sync([key],0);const bypassOnly=read();
 layer.filters=chain.sync([key,grade],0);const bypassWithDownstreamGrade=read();
 layer.filters=chain.sync([key],0);
 const cover=new Sprite(Texture.WHITE);cover.width=64;cover.height=64;cover.tint=0x2040e0;cover.alpha=0.5;
 app.stage.addChild(cover);const bypassWithUpperLayer=read();
 const map=containMap(150,100,{left:0,top:0,width:320,height:180},1920,1080);
 layer.filters=[];chain.dispose();resetEffectOverrides();app.destroy(true,{children:true});
 const equal=(a:number[],b:number[])=>a.every((v,i)=>v===b[i]);
 return { backend:'real WebGL + production EffectChain, isolated stage (not full editor)',
   input,bypassOnly,bypassWithDownstreamGrade,bypassWithUpperLayer,
   cssToComposition: {css:[150,100],display:[320,180],composition:[1920,1080],pixel:map},
   confirmed:equal(input,bypassOnly)&&!equal(input,bypassWithDownstreamGrade)&&!equal(input,bypassWithUpperLayer) };
};
