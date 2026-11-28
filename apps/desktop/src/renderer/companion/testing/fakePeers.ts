// A stand-in for Chromium's RTCPeerConnection as `picturePeers.ts` uses it:
// the answer it makes carries the candidates a machine with a LAN, a VPN and
// loopback gathers, and a test opens and closes its data channels by hand.

/** What `createAnswer` gives: a host candidate per interface, a reflexive one,
 *  and the loopback one `allow-loopback-in-peer-connection` adds. */
export const GATHERED_ANSWER = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 192.168.1.20",
  "a=candidate:1 1 udp 2122260223 192.168.1.20 50001 typ host generation 0",
  "a=candidate:2 1 udp 2122194687 10.8.0.2 50002 typ host generation 0",
  "a=candidate:3 1 udp 2122129151 127.0.0.1 50003 typ host generation 0",
  "a=candidate:4 1 tcp 1518280447 127.0.0.1 9 typ host tcptype active generation 0",
  "a=candidate:5 1 udp 1686052607 203.0.113.7 50004 typ srflx raddr 192.168.1.20 rport 50001 generation 0",
  "a=end-of-candidates",
  "a=sctp-port:5000",
  "",
].join("\r\n");

export class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  binaryType = "";
  readonly sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(bytes: Uint8Array): void {
    this.sent.push(new Uint8Array(bytes));
  }
  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }
  close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }
}

export class FakePeer {
  static made: FakePeer[] = [];
  /** What the next `createAnswer` gives. */
  static answerSdp = GATHERED_ANSWER;
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  closed = false;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;

  constructor(readonly config: unknown) {
    FakePeer.made.push(this);
  }

  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = d;
  }
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: "answer", sdp: FakePeer.answerSdp };
  }
  async setLocalDescription(d: { type: string; sdp: string }): Promise<void> {
    this.localDescription = d;
    // Gathering finishes on its own, after the description is set.
    queueMicrotask(() => {
      this.iceGatheringState = "complete";
      this.onicegatheringstatechange?.();
    });
  }
  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  /** The view opens its channel; the connection hands it over. */
  channel(): FakeChannel {
    const channel = new FakeChannel();
    this.ondatachannel?.({ channel });
    return channel;
  }
  /** The connection ends under the editor. */
  fail(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }

  static reset(): void {
    FakePeer.made = [];
    FakePeer.answerSdp = GATHERED_ANSWER;
  }
}
