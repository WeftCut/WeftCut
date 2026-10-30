/* Stereo PCM queue. Discard stale samples so slow rendering cannot grow latency. */
export class AudioBufferQueue {
 constructor(rate=48000,maxSeconds=.12){this.rate=rate;this.capacity=Math.ceil(rate*maxSeconds);this.data=new Float32Array(this.capacity*2);this.read=0;this.length=0;this.dropped=0;this.primed=false;this.target=Math.ceil(rate*.04);}
 push(samples){const frames=Math.floor(samples.length/2),keep=Math.min(frames,this.capacity);let skip=Math.max(0,this.length+keep-this.capacity);this.read=(this.read+skip)%this.capacity;this.length-=skip;this.dropped+=skip+frames-keep;
  const start=frames-keep;for(let i=0;i<keep;i++){const pos=(this.read+this.length+i)%this.capacity;this.data[pos*2]=samples[(start+i)*2];this.data[pos*2+1]=samples[(start+i)*2+1];}this.length+=keep;
 }
 render(left,right){left.fill(0);right.fill(0);if(!this.primed){if(this.length<this.target)return;this.primed=true;}
  const count=Math.min(left.length,this.length);for(let i=0;i<count;i++){left[i]=this.data[this.read*2];right[i]=this.data[this.read*2+1];this.read=(this.read+1)%this.capacity;}this.length-=count;if(count<left.length)this.primed=false;
 }
 get bufferedMs(){return this.length/this.rate*1000;}
}
