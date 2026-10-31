import RFB from '/novnc/core/rfb.js';
import {LiveAudio} from './live-audio.js';
import {PreviewConnection,PREVIEW_PROFILES} from './preview-connection.mjs';
import {installExportFiles} from './export-files.mjs';
const exportFiles=installExportFiles({document,fetch:window.fetch.bind(window),EventSource:window.EventSource,storage:window.sessionStorage});
const status=document.getElementById('status');
const url=new URL('/websockify',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
const messages={connecting:'Подключение…',connected:'Подключено · проекты /data/projects · экспорт /data/exports',
 disconnected:'Соединение закрыто. Нажмите «Обновить просмотр».',suspended:'Просмотр приостановлен в скрытой вкладке. Редактор продолжает работу.'};
const profile=document.getElementById('preview-profile');
try{const saved=localStorage.getItem('weftcut-preview-profile');if(Object.hasOwn(PREVIEW_PROFILES,saved))profile.value=saved;}catch{}
const preview=new PreviewConnection({RFB,screen:document.getElementById('screen'),url:url.href,
 profile:profile.value,onState:state=>status.textContent=messages[state]});
preview.setVisible(!document.hidden);preview.connect();
profile.onchange=()=>{preview.setProfile(profile.value);try{localStorage.setItem('weftcut-preview-profile',profile.value);}catch{}};
document.getElementById('refresh-preview').onclick=()=>preview.reconnect();
const restart=document.getElementById('restart-editor');
restart.onclick=async()=>{
 if(!window.confirm('Сохранить текущий проект и перезапустить редактор? Во время экспорта, транскрибации или анализа перезапуск запрещён.'))return;
 restart.disabled=true;
 try{
  const response=await fetch('/api/editor/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});
  const result=await response.json();
  if(!response.ok){
   const message=response.status===409?'Редактор занят: дождитесь завершения экспорта или анализа. Ничего не остановлено.':'Не удалось безопасно перезапустить редактор. Проверьте сохранение проекта.';
   status.textContent=message;window.alert(message);return;
  }
  if(result.status!=='restarting')throw Error('Unexpected restart response');
  status.textContent='Перезапуск редактора… Проект сохранён.';
  for(let attempt=0;attempt<30;attempt++){
   await new Promise(resolve=>setTimeout(resolve,2000));
   if((await fetch('/health',{cache:'no-store'}).catch(()=>null))?.ok){preview.reconnect();return;}
  }
  status.textContent='Редактор ещё запускается. Нажмите «Обновить просмотр» через несколько секунд.';
 }catch{status.textContent='Не удалось выполнить перезапуск. Текущая работа не отменялась.';}
 finally{restart.disabled=false;}
};
document.addEventListener('visibilitychange',()=>preview.setVisible(!document.hidden));
let audio=null;const button=document.getElementById('audio-toggle');
button.onclick=async()=>{
 if(audio){const previous=audio;audio=null;await previous.stop();button.textContent='Включить звук';return;}
 const stream=new LiveAudio('/api/audio',state=>button.textContent=state==='playing'?'Выключить звук':state==='connecting'?'Подключение звука…':'Включить звук');audio=stream;
 try{await stream.start();}catch(error){if(error.name!=='AbortError')status.textContent='Звук: '+error.message;if(audio===stream){audio=null;await stream.stop();}}
};
document.getElementById('fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
window.addEventListener('pagehide',()=>{exportFiles.close();void audio?.stop();preview.setVisible(false);});
window.addEventListener('pageshow',()=>{exportFiles.connect();preview.setVisible(!document.hidden);});
