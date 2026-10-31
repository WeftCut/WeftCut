import RFB from '/novnc/core/rfb.js';
import {LiveAudio} from './live-audio.js';
import {PreviewConnection,PREVIEW_PROFILES} from './preview-connection.mjs';
import {installExportFiles} from './export-files.mjs';
const exportFiles=installExportFiles({document,fetch:window.fetch.bind(window),EventSource:window.EventSource,storage:window.sessionStorage});
const status=document.getElementById('status');
const url=new URL('/websockify',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
const messages={connecting:'Подключение…',connected:'Подключено · проекты /data/projects · экспорт /data/exports',
 disconnected:'Соединение закрыто. Нажмите «Обновить просмотр».',authentication_failed:'Не удалось авторизовать рабочий стол. Откройте HTTPS-адрес редактора и войдите повторно.',suspended:'Просмотр приостановлен в скрытой вкладке. Редактор продолжает работу.'};
const profile=document.getElementById('preview-profile');
try{const saved=localStorage.getItem('weftcut-preview-profile');if(Object.hasOwn(PREVIEW_PROFILES,saved))profile.value=saved;}catch{}
const preview=new PreviewConnection({RFB,screen:document.getElementById('screen'),url:url.href,
 profile:profile.value,onState:state=>status.textContent=messages[state],getCredentials:async()=>{
  const response=await fetch('/api/vnc-credentials',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Desktop authentication unavailable');
  return response.json();
 }});
preview.setVisible(!document.hidden);preview.connect();
profile.onchange=()=>{preview.setProfile(profile.value);try{localStorage.setItem('weftcut-preview-profile',profile.value);}catch{}};
document.getElementById('refresh-preview').onclick=()=>preview.reconnect();
const restart=document.getElementById('restart-editor');
let remoteMinimized=false;
const applyRemoteMinimized=value=>{
 remoteMinimized=value;
 document.getElementById('screen').hidden=value;
 preview.setVisible(!document.hidden&&!value);
};
const dockStyle=document.createElement('link');dockStyle.rel='stylesheet';dockStyle.href='/window-dock.css';document.head.append(dockStyle);
const windowDock=document.createElement('div');windowDock.id='editor-window-dock';windowDock.hidden=true;
const restoreWindow=document.createElement('button');restoreWindow.textContent='WeftCut свёрнут · Развернуть редактор';
windowDock.append(restoreWindow);document.body.append(windowDock);
restoreWindow.onclick=async()=>{
 restoreWindow.disabled=true;
 try{
  const response=await fetch('/api/editor/window',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'restore'})});
  if(!response.ok)throw Error('restore failed');
  windowDock.hidden=true;
  applyRemoteMinimized(false);
 }catch{status.textContent='Не удалось восстановить окно редактора. Попробуйте ещё раз.';}
 finally{restoreWindow.disabled=false;}
};
const pollWindow=async()=>{
 if(document.hidden)return;
 try{const runtime=await loadRuntime();const minimized=runtime.state==='running'&&runtime.window?.minimized===true;windowDock.hidden=!minimized;applyRemoteMinimized(minimized);}
 catch{/* Retain the restore affordance during a transient restart. */}
};
let windowTimer=setInterval(()=>void pollWindow(),3000);void pollWindow();
const desktopResolution=document.createElement('select');
desktopResolution.id='desktop-resolution';desktopResolution.setAttribute('aria-label','Разрешение рабочего стола');
desktopResolution.title='Разрешение удалённого рабочего стола. Проект и качество экспорта не меняются. Смена сохраняет проект и перезапускает редактор.';
desktopResolution.append(new Option('Рабочий стол: загрузка…',''));desktopResolution.disabled=true;
profile.after(desktopResolution);
let activeResolution='1920x1080';
async function loadRuntime(){
 const response=await fetch('/api/editor/runtime',{cache:'no-store'});
 if(!response.ok)throw Error('Runtime unavailable');
 return response.json();
}
async function loadDisplay(){
 try{
  const runtime=await loadRuntime();activeResolution=runtime.resolution;
  desktopResolution.replaceChildren(...runtime.modes.map(mode=>new Option('Рабочий стол: '+mode.replace('x',' × '),mode)));
  desktopResolution.value=activeResolution;desktopResolution.disabled=!runtime.display_supported;
 }catch{desktopResolution.replaceChildren(new Option('Разрешение недоступно',''));desktopResolution.disabled=true;}
}
void loadDisplay();
async function restartEditor(endpoint,body){
 restart.disabled=true;desktopResolution.disabled=true;
 try{
  const previous=await loadRuntime();
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok){
   const message=response.status===409?'Редактор занят: дождитесь завершения экспорта или анализа. Ничего не остановлено.':'Не удалось безопасно перезапустить редактор. Проверьте сохранение проекта.';
   status.textContent=message;window.alert(message);return;
  }
  if(result.status!=='restarting')throw Error('Unexpected restart response');
  status.textContent=result.previously_closed?'Запуск закрытого редактора…':'Перезапуск редактора… Проект сохранён.';
  for(let attempt=0;attempt<30;attempt++){
   await new Promise(resolve=>setTimeout(resolve,2000));
   const current=await loadRuntime().catch(()=>null);
   if(current?.state==='running' && current.pid!==previous.pid && (await fetch('/health',{cache:'no-store'}).catch(()=>null))?.ok){preview.reconnect();status.textContent='Редактор перезапущен. Проект восстановлен.';return;}
  }
  status.textContent='Редактор ещё запускается. Нажмите «Обновить просмотр» через несколько секунд.';
 }catch{status.textContent='Не удалось завершить перезапуск. Обновите просмотр; если редактор не появился, проверьте состояние сервиса.';}
 finally{restart.disabled=false;await loadDisplay();}
}
restart.onclick=async()=>{
 if(!window.confirm('Сохранить текущий проект и перезапустить редактор? Во время экспорта, транскрибации или анализа перезапуск запрещён.'))return;
 await restartEditor('/api/editor/restart',{confirm:true});
};
desktopResolution.onchange=async()=>{
 const resolution=desktopResolution.value;
 if(resolution===activeResolution)return;
 if(!window.confirm('Сохранить проект и изменить разрешение рабочего стола на '+resolution+'? Редактор перезапустится и восстановит проект. Во время экспорта или анализа смена недоступна.')){desktopResolution.value=activeResolution;return;}
 await restartEditor('/api/editor/display',{resolution,confirm:true});
};
document.addEventListener('visibilitychange',()=>preview.setVisible(!document.hidden&&!remoteMinimized));
let audio=null;const button=document.getElementById('audio-toggle');
button.onclick=async()=>{
 if(audio){const previous=audio;audio=null;await previous.stop();button.textContent='Включить звук';return;}
 const stream=new LiveAudio('/api/audio',state=>button.textContent=state==='playing'?'Выключить звук':state==='connecting'?'Подключение звука…':'Включить звук');audio=stream;
 try{await stream.start();}catch(error){if(error.name!=='AbortError')status.textContent='Звук: '+error.message;if(audio===stream){audio=null;await stream.stop();}}
};
document.getElementById('fullscreen').onclick=async()=>{
 try{
  if(document.fullscreenElement)await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
 }catch{status.textContent='Не удалось включить полноэкранный режим. Продолжайте просмотр в окне.';}
};
window.addEventListener('pagehide',()=>{clearInterval(windowTimer);windowTimer=null;exportFiles.close();void audio?.stop();preview.setVisible(false);});
window.addEventListener('pageshow',()=>{if(!windowTimer)windowTimer=setInterval(()=>void pollWindow(),3000);exportFiles.connect();preview.setVisible(!document.hidden&&!remoteMinimized);void pollWindow();});
