import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PreviewConnection} from '../web/preview-connection.mjs';

function setup(profile, getCredentials) {
  const sessions=[],hosts=[],states=[];
  class RFB extends EventTarget {
    constructor(host,url){super();this.host=host;this.url=url;this.closes=0;sessions.push(this);}
    disconnect(){this.closes++;this.dispatchEvent(new Event('disconnect'));}
    sendCredentials(value){this.credentials=value;}
  }
  const screen={ownerDocument:{createElement:()=>({remove(){this.removed=true;}})},append:host=>hosts.push(host)};
  const preview=new PreviewConnection({RFB,screen,url:'ws://editor.invalid/websockify',profile,getCredentials,onState:s=>states.push(s)});
  return {preview,sessions,hosts,states};
}

test('smooth transport uses the public RFB settings without restarting the editor',()=>{
  const {preview,sessions,states}=setup();preview.connect();preview.connect();
  assert.equal(sessions.length,1);
  assert.equal(sessions[0].scaleViewport,true);
  assert.equal(sessions[0].resizeSession,false);
  assert.equal(sessions[0].qualityLevel,5);assert.equal(sessions[0].compressionLevel,0);
  sessions[0].dispatchEvent(new Event('connect'));assert.equal(states.at(-1),'connected');
  preview.setProfile('sharp');assert.equal(sessions[0].qualityLevel,8);assert.equal(sessions[0].compressionLevel,2);
  preview.setProfile('unknown');assert.equal(sessions[0].qualityLevel,8);
});

test('desktop credentials are fetched on demand without a second password prompt',async()=>{
  const credentials={username:'desktop',password:'synthetic-password-long'};
  const {preview,sessions}=setup('smooth',async()=>credentials);preview.connect();
  assert.equal(sessions[0].credentials,undefined);
  sessions[0].dispatchEvent(new Event('credentialsrequired'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(sessions[0].credentials,credentials);
});

test('late credentials cannot authenticate a replaced connection',async()=>{
  let release;const {preview,sessions}=setup('smooth',()=>new Promise(r=>release=r));preview.connect();
  sessions[0].dispatchEvent(new Event('credentialsrequired'));preview.reconnect();
  release({username:'desktop',password:'synthetic-password-long'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sessions[0].credentials,undefined);assert.equal(sessions[1].credentials,undefined);
});

test('authentication failure is visible and does not leave a stuck connection',async()=>{
  const {preview,sessions,states}=setup('smooth',async()=>{throw Error('unavailable')});preview.connect();
  sessions[0].dispatchEvent(new Event('credentialsrequired'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(states.at(-1),'authentication_failed');assert.equal(sessions[0].closes,1);
});

test('reconnect releases the old canvas and ignores stale connection events',()=>{
  const {preview,sessions,hosts,states}=setup('sharp');preview.connect();preview.reconnect();
  assert.equal(sessions[0].closes,1);assert.equal(hosts[0].removed,true);assert.equal(sessions.length,2);
  assert.equal(sessions[1].qualityLevel,8);
  assert.equal(sessions[1].resizeSession,false);
  sessions[0].dispatchEvent(new Event('disconnect'));sessions[0].dispatchEvent(new Event('connect'));
  assert.equal(states.at(-1),'connecting');assert.equal(sessions[1].closes,0);
  sessions[1].dispatchEvent(new Event('connect'));assert.equal(states.at(-1),'connected');
});

test('hidden browser tabs cannot accumulate remote framebuffer work',()=>{
  const {preview,sessions,states}=setup();preview.connect();preview.setVisible(false);preview.setVisible(false);
  assert.equal(sessions[0].closes,1);assert.equal(states.at(-1),'suspended');
  preview.reconnect();assert.equal(sessions.length,1);
  preview.setVisible(true);preview.setVisible(true);assert.equal(sessions.length,2);
  preview.dispose();preview.dispose();preview.setVisible(true);preview.reconnect();
  assert.equal(sessions[1].closes,1);assert.equal(sessions.length,2);
});

test('unexpected disconnect cleans up and permits a manual reconnect',()=>{
  const {preview,sessions,states}=setup('invalid');preview.connect();
  assert.equal(sessions[0].qualityLevel,5);
  sessions[0].dispatchEvent(new Event('disconnect'));assert.equal(states.at(-1),'disconnected');
  assert.equal(sessions[0].closes,0);
  preview.reconnect();assert.equal(sessions.length,2);
});
