/** Resumeable, non-destructive import of an editorial recipe through public MCP. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {connect,records} from './client.mjs';
import {upload} from './upload.mjs';

const recipePath=process.argv[2], statePath=process.argv[3];
if(!recipePath||!statePath)throw Error('Usage: import-project.mjs recipe.json private-progress.json');
const recipe=JSON.parse(await fs.readFile(recipePath,'utf8'));
let state={name:recipe.name,uploads:{},media:{},tracks:{},layers:{},motifs:{},steps:{}};
try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(state.name!==recipe.name)throw Error('Progress file belongs to a different project');
const save=()=>fs.writeFile(statePath,JSON.stringify(state,null,2),{mode:0o600});
const {client,transport,connection}=await connect();
const call=async(name,args)=>{
  const result=records(await client.callTool({name,arguments:args},undefined,{timeout:180000}));
  console.log(name,args.label||args.name||args.layer_id||args.path||'');
  return result;
};
const step=async(id,fn)=>{if(!state.steps[id]){await fn();state.steps[id]=true;await save();}};
const us=value=>Math.round(value*1e6);
let locked=false,session=false;
try {
  let current;
  try{current=await call('read_project',{view:'current'});}catch{}
  if(!current){await call('create_project',{name:recipe.name,parent_folder:'/data/projects',width:1920,height:1080,fps:{num:30,den:1}});}
  current=await call('read_project',{view:'current'});
  if(current.metadata?.name!==recipe.name)throw Error(`The open project is ${current.metadata?.name}; refusing to modify another project`);
  if(state.projectId&&state.projectId!==current.project_id)throw Error('Progress IDs belong to another project instance');
  state.projectId=current.project_id;
  const tracks=await call('read_project',{view:'tracks'});
  await call('create_checkpoint',{label:'До переноса таймлайна без озвучки'});
  await call('begin_agent_session',{reason:recipe.reason||'Перенос согласованного монтажа без озвучки'});session=true;
  await call('set_history_lock',{locked:true,reason:'Импорт медиа, монтажных слоёв и анимаций'});locked=true;
  await step('settings',async()=>{
    await call('set_project_settings',{patch:{auto_pair_audio_on_import:false,correction_script:recipe.scriptText||''}});
    await call('update_composition',{patch:{duration_us:us(recipe.duration),background:{r:8,g:14,b:25,a:255}}});
  });
  const existingFiles=await (await fetch(new URL('/api/media',connection.url),{headers:{Authorization:'Bearer '+connection.key}})).json();
  const media=Object.values(await call('read_project',{view:'media'}));
  for(const asset of recipe.assets){
    let uploaded=state.uploads[asset.id];
    const existing=existingFiles.files.find(f=>f.name===asset.name);
    const pooled=media.find(m=>m.label===asset.name);
    if(!uploaded&&existing&&pooled)uploaded=state.uploads[asset.id]={path:existing.path,bytes:existing.bytes};
    if(!uploaded){uploaded=await upload(connection,asset.path,asset.name);state.uploads[asset.id]=uploaded;await save();console.log('uploaded',asset.name,uploaded.bytes);}
    if(!state.media[asset.id]){
      state.media[asset.id]=pooled ? {media_id:pooled.id,kind:pooled.kind,
        width:pooled.metadata.video?.width,height:pooled.metadata.video?.height} : await call('import_media',{path:uploaded.path});await save();
    }
  }
  for(const track of recipe.tracks){
    if(state.tracks[track.key]&&tracks.some(t=>t.id===state.tracks[track.key]))continue;
    let record=track.role?tracks.find(t=>t.role===track.role):tracks.find(t=>t.label===track.label);
    if(!record)record=await call('add_track',{label:track.label});
    state.tracks[track.key]=record.id||record.track_id;
    if(!state.tracks[track.key])throw Error('Track response has no identity');
    await save();
  }
  for(const clip of recipe.clips){
    const item=state.media[clip.source];
    if(!item)throw Error('Unknown source '+clip.source);
    let layer=state.layers[clip.id];
    // A pre-existing placed clip is adopted by its explicit label, never by position alone.
    if(!layer){
      const found=tracks.flatMap(t=>t.layers).find(l=>l.label===clip.label);
      layer=found?{layer_id:found.id}:await call('add_video_layer',{
        media_id:item.media_id||item.id,track_id:state.tracks[clip.track],
        t_start_us:us(clip.start),t_end_us:us(clip.end),
        ...(item.kind==='Video'?{src_in_us:us(clip.in||0),src_out_us:us(clip.out??((clip.in||0)+clip.end-clip.start))}:{}),
        ...(item.kind==='Image'?{graphic_role:'illustration'}:{}),
      });
      state.layers[clip.id]=layer;await save();
    }
    await step('fit:'+clip.id,async()=>{
      const scale=Math.min(1920/item.width,1080/item.height)*(clip.zoom||1);
      await call('update_layer',{layer_id:layer.layer_id,patch:{label:clip.label}});
      await call('update_layer_params',{layer_id:layer.layer_id,patch:{kind:item.kind==='Image'?'ImageOverlay':'VideoClip',
        x:960,y:540,scale_x:scale,scale_y:scale,...(clip.rotation?{rotation_deg:clip.rotation}:{}),
        fade_in_us:us(clip.fadeIn||0),fade_out_us:us(clip.fadeOut||0)}});
      if(clip.panZoom){for(const axis of ['scale_x','scale_y'])await call('set_param_track',{layer_id:layer.layer_id,param_key:axis,
        track:{mode:'Keyframed',value:[{t_us:us(clip.start),value:scale},{t_us:us(clip.end),value:scale*1.045}]}});}
    });
  }
  for(const transition of recipe.transitions||[])await step('transition:'+transition.to,async()=>{
    const to=state.layers[transition.to],from=state.layers[transition.from];
    await call('add_transition',{from_layer_id:from.layer_id,to_layer_id:to.layer_id,duration_us:us(transition.duration),kind:transition.kind||'Crossfade'});
    // Still-image tail is extended back to the agreed cue; main footage never shifts.
    const clip=recipe.clips.find(c=>c.id===transition.to);
    if(state.media[clip.source].kind!=='Image')throw Error('Cue-preserving extension is restricted to still images');
    await call('update_layer',{layer_id:to.layer_id,patch:{t_end_us:us(clip.end)}});
  });
  for(const title of recipe.texts||[])await step('text:'+title.id,async()=>{
    const l=await call('add_text_layer',{track_id:state.tracks[title.track||'titles'],content:title.content,
      t_start_us:us(title.start),t_end_us:us(title.end),x:title.x??150,y:title.y??160,graphic_role:title.role||'callout'});
    state.layers[title.id]=l;
    await call('update_layer',{layer_id:l.layer_id,patch:{label:title.label||title.content.replaceAll('\n',' · ')}});
    await call('update_layer_params',{layer_id:l.layer_id,patch:{kind:'Text',font_family:'DejaVu Sans',font_size_px:title.size||64,
      font_weight:700,color:title.color||{r:237,g:245,b:255,a:255},align:'Left',anchor_x:0,anchor_y:0,box_w:title.width||1600,
      outline_width:3,outline_color:{r:5,g:10,b:20,a:230},intro:'SlideUp',outro:'FadeOut'}});
  });
  for(const motif of recipe.motifs||[]){
    if(!state.motifs[motif.id]){
      const draft=await call('open_motif_draft',{source:{kind:'empty',name:motif.manifest.name}});
      const updated=await call('update_motif_files',{draft_id:draft.draft_id,expected_revision:draft.revision,
        files:[{path:'manifest.json',text:JSON.stringify(motif.manifest)},{path:'index.html',text:motif.html}]});
      state.motifs[motif.id]={...draft,...updated};await save();
    }
  }
  const resolve=value=>typeof value==='string'?value.replace(/\$media\(([^)]+)\)/g,(_,id)=>state.media[id].media_id||state.media[id].id):value;
  for(const clip of recipe.motifClips||[])await step('motif:'+clip.id,async()=>{
    const draft=state.motifs[clip.motif];
    const layer=await call('add_motif_layer',{motif_id:draft.draft_id,track_id:state.tracks[clip.track||'motion'],
      t_start_us:us(clip.start),t_end_us:us(clip.end),props:Object.fromEntries(Object.entries(clip.props||{}).map(([k,v])=>[k,resolve(v)])),graphic_role:clip.role||'illustration'});
    state.layers[clip.id]=layer;
    await call('update_layer',{layer_id:layer.layer_id,patch:{label:clip.label||clip.id}});
    if(clip.x!==undefined)await call('update_layer_params',{layer_id:layer.layer_id,patch:{kind:'Motif',x:clip.x,y:clip.y}});
  });
  for(const marker of recipe.markers||[])await step('marker:'+marker.id,async()=>{
    await call('add_marker',{t_us:us(marker.start),end_t_us:us(marker.end),label:marker.label,color:{r:65,g:187,b:255,a:255}});
  });
  const audit=await call('check_composition',{});await fs.writeFile(path.join(path.dirname(statePath),'audit.json'),JSON.stringify(audit,null,2));
  await save();
} finally {
  if(locked)await call('set_history_lock',{locked:false}).catch(error=>console.error('Unlock:',error.message));
  if(session)await call('end_agent_session',{}).catch(error=>console.error('Session audit:',error.message));
  await transport.terminateSession().catch(()=>{});
  await client.close();
}
