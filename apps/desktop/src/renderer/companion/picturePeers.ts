// The editor's half of the side-panel views' picture connections: a view's
// offer (`cli/companion/panel/picturePeer.js`, through main's hub) is answered
// by a peer connection whose only candidate is 127.0.0.1, and every channel
// that opened on a loopback pair gets the picture as a page's
// `/companion/video` does, from the same encoder (`mirrorEncoder.ts`) in the
// same framing (`shared/companionPicture.ts`). This is the only place that
// opens a peer connection. See docs/adr/0186.
import { PICTURE_MESSAGE_MAX_BYTES } from "../../shared/companion";
import { PictureStream, type PictureSink } from "../../shared/companionPicture";

/** The longest the editor waits for its candidates before it answers with
 *  what it has. The loopback one is gathered at once. */
export const GATHER_MAX_MS = 2000;
/** Peer connections kept at once. A view that went away without closing its
 *  connection leaves it to the next view that opens one. */
export const PEERS_MAX = 4;

/** Connection states after which a channel carries nothing more. */
const ENDED = new Set<RTCPeerConnectionState>(["failed", "disconnected", "closed"]);

export interface PeerEnv {
  createPeer(config: RTCConfiguration): RTCPeerConnection;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserEnv: PeerEnv = {
  createPeer: (config) => new RTCPeerConnection(config),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/** `sdp` with every candidate but a 127.0.0.1 host one left out, and its
 *  connection lines naming 127.0.0.1: no address of this machine's networks
 *  reaches the view's host. Null when no loopback candidate was gathered: an
 *  answer without one could never connect. */
export function loopbackOnly(sdp: string): string | null {
  const lines = sdp.split(/\r?\n/).filter((line) => line !== "");
  const kept = lines.filter((line) => !line.startsWith("a=candidate:") || isLoopbackHost(line));
  if (!kept.some((line) => line.startsWith("a=candidate:"))) return null;
  return `${kept.map((line) => (/^c=IN IP[46] /.test(line) ? "c=IN IP4 127.0.0.1" : line)).join("\r\n")}\r\n`;
}

/** `sdp` with every candidate it names left out. The editor's agent then
 *  starts no check of its own, whatever an offer names: the view's checks to
 *  the answer's 127.0.0.1 candidate form the pair. A check reaching another of
 *  the editor's sockets is still answered, which `onLoopbackPair` catches. */
export function withoutCandidates(sdp: string): string {
  const lines = sdp.split(/\r?\n/).filter((line) => line !== "" && !line.startsWith("a=candidate:") && line !== "a=end-of-candidates");
  return `${lines.join("\r\n")}\r\n`;
}

/** Whether the pair a connection selected runs over the editor's 127.0.0.1
 *  socket. That end decides it: a socket bound to loopback exchanges packets
 *  with this machine only. The remote end is a candidate the view's checks
 *  revealed, since the offer names none (`withoutCandidates`), and the stats
 *  leave such an address out (webrtc-stats, `RTCIceCandidateStats.address`);
 *  one they do give must be 127.0.0.1 too. */
export function onLoopbackPair(report: RTCStatsReport): boolean {
  const stats = [...report.values()] as Array<Record<string, unknown>>;
  const selectedId = stats.find((s) => s.type === "transport" && typeof s.selectedCandidatePairId === "string")?.selectedCandidatePairId;
  const pair = selectedId !== undefined
    ? report.get(selectedId as string) as Record<string, unknown> | undefined
    : stats.find((s) => s.type === "candidate-pair" && s.nominated === true && s.state === "succeeded");
  if (pair === undefined) return false;
  const local = report.get(pair.localCandidateId as string) as Record<string, unknown> | undefined;
  const remote = report.get(pair.remoteCandidateId as string) as Record<string, unknown> | undefined;
  if (local?.candidateType !== "host" || local.address !== "127.0.0.1" || remote === undefined) return false;
  return remote.address === "127.0.0.1" || (remote.candidateType === "prflx" && (remote.address ?? "") === "");
}

/** `a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …` */
function isLoopbackHost(line: string): boolean {
  const fields = line.slice("a=candidate:".length).split(" ");
  return fields[4] === "127.0.0.1" && fields[6] === "typ" && fields[7] === "host";
}

export class PicturePeers {
  /** What each open channel is sent; the bridge feeds it the encoder's output. */
  readonly stream = new PictureStream();
  /** Every connection, oldest first. */
  private readonly peers = new Set<RTCPeerConnection>();
  /** The connections whose channel is open, and how each leaves the stream. */
  private readonly open = new Map<RTCPeerConnection, () => void>();

  /** `counted` hears the number of open channels on every change; `joined`
   *  runs when a channel opens, which then waits for a keyframe. */
  constructor(
    private readonly counted: (open: number) => void,
    private readonly joined: () => void,
    private readonly env: PeerEnv = browserEnv,
  ) {}

  /** The answer to a view's offer. Rejects when none can be made. */
  async answer(offer: string): Promise<string> {
    const pc = this.env.createPeer({ iceServers: [] });
    this.peers.add(pc);
    if (this.peers.size > PEERS_MAX) this.drop(this.peers.values().next().value!);
    pc.ondatachannel = (event) => { this.attach(pc, event.channel); };
    pc.onconnectionstatechange = () => { if (ENDED.has(pc.connectionState)) this.drop(pc); };
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: withoutCandidates(offer) });
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gathered(pc);
      const answer = loopbackOnly(pc.localDescription?.sdp ?? "");
      if (answer === null) throw new Error("no 127.0.0.1 candidate was gathered");
      return answer;
    } catch (error) {
      this.drop(pc);
      throw error;
    }
  }

  /** Every connection ends: the editor is going away. */
  closeAll(): void {
    for (const pc of [...this.peers]) this.drop(pc);
  }

  private attach(pc: RTCPeerConnection, channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    const start = async (): Promise<void> => {
      if (!this.peers.has(pc) || this.open.has(pc)) return;
      const loopback = await pc.getStats().then(onLoopbackPair, () => false);
      if (!this.peers.has(pc) || this.open.has(pc) || channel.readyState !== "open") return;
      // A pair off loopback carries nothing: the connection ends, and the
      // view, which drew nothing, says the picture cannot reach it.
      if (!loopback) {
        this.drop(pc);
        return;
      }
      const sink: PictureSink = {
        write: (bytes) => { send(channel, bytes); },
        get writableLength() { return channel.bufferedAmount; },
      };
      this.open.set(pc, this.stream.add(sink));
      this.joined();
      this.counted(this.open.size);
    };
    channel.onclose = () => { this.drop(pc); };
    if (channel.readyState === "open") void start();
    else channel.onopen = () => { void start(); };
  }

  private drop(pc: RTCPeerConnection): void {
    const leave = this.open.get(pc);
    if (leave !== undefined) {
      leave();
      this.open.delete(pc);
      this.counted(this.open.size);
    }
    if (this.peers.delete(pc)) pc.close();
  }

  private gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = this.env.setTimeout(resolve, GATHER_MAX_MS);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState !== "complete") return;
        this.env.clearTimeout(timer);
        resolve();
      };
    });
  }
}

/** `bytes` in messages a channel takes whole. A frame is written in one go,
 *  so its pieces are never interleaved with another frame's. */
function send(channel: RTCDataChannel, bytes: Uint8Array<ArrayBuffer>): void {
  if (channel.readyState !== "open") return;
  for (let at = 0; at < bytes.length; at += PICTURE_MESSAGE_MAX_BYTES) {
    channel.send(bytes.subarray(at, Math.min(bytes.length, at + PICTURE_MESSAGE_MAX_BYTES)));
  }
}
