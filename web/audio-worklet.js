import {AudioBufferQueue} from './audio-buffer.js';
class H3LiveAudio extends AudioWorkletProcessor {
 constructor(){super();this.queue=new AudioBufferQueue(sampleRate);this.frames=0;this.port.onmessage=event=>this.queue.push(new Float32Array(event.data));}
 process(_inputs,outputs){const channels=outputs[0];if(channels.length<2)return true;this.queue.render(channels[0],channels[1]);this.frames+=channels[0].length;if(this.frames>=sampleRate/4){this.frames=0;this.port.postMessage({buffered_ms:this.queue.bufferedMs,dropped_frames:this.queue.dropped});}return true;}
}
registerProcessor('h3-live-audio',H3LiveAudio);
