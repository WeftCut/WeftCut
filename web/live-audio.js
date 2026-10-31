import {AudioBufferQueue} from './audio-buffer.js';
export class LiveAudio {
 constructor(url,onState){this.url=url;this.onState=onState;this.state='stopped';this.diagnostics={buffered_ms:0,dropped_frames:0,transport:'pcm'};}
 async start(){this.abort=new AbortController();this.state='connecting';this.onState(this.state);this.context=new AudioContext({sampleRate:48000,latencyHint:'interactive'});await this.context.resume();
  if(this.context.audioWorklet){await this.context.audioWorklet.addModule('/audio-worklet.js');this.node=new AudioWorkletNode(this.context,'h3-live-audio',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});this.node.port.onmessage=e=>Object.assign(this.diagnostics,e.data);this.deliver=samples=>this.node.port.postMessage(samples.buffer,[samples.buffer]);}
  else {this.queue=new AudioBufferQueue(this.context.sampleRate);this.node=this.context.createScriptProcessor(1024,0,2);this.node.onaudioprocess=e=>{this.queue.render(e.outputBuffer.getChannelData(0),e.outputBuffer.getChannelData(1));this.diagnostics.buffered_ms=this.queue.bufferedMs;this.diagnostics.dropped_frames=this.queue.dropped;};this.deliver=samples=>this.queue.push(samples);}
  this.node.connect(this.context.destination);
  const response=await fetch(this.url,{signal:this.abort.signal,cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);const reader=response.body.getReader();let remainder=new Uint8Array(0);
  while(!this.abort.signal.aborted){const {value,done}=await reader.read();if(done)break;const merged=new Uint8Array(remainder.length+value.length);merged.set(remainder);merged.set(value,remainder.length);const bytes=merged.length-merged.length%8;
   if(bytes){this.deliver(new Float32Array(merged.buffer.slice(0,bytes)));if(this.state==='connecting'){this.state='playing';this.onState(this.state);}}remainder=merged.slice(bytes);
  }
  if(!this.abort.signal.aborted)throw Error('Аудиопоток закрыт. Включите звук снова.');
 }
 async stop(){this.abort?.abort();this.node?.disconnect();if(this.context&&this.context.state!=='closed')await this.context.close();this.state='stopped';this.onState(this.state);}
}
