// The editor's answers to side-panel views: an answer that names no address
// but 127.0.0.1, channels that get the picture as pages do, in pieces a
// channel takes, and connections that count only while their channel is open.
import { beforeEach, describe, expect, it } from "vitest";
import { MIRROR_FRAME_CONFIG, MIRROR_FRAME_KEY, MIRROR_HEADER_BYTES, PICTURE_MESSAGE_MAX_BYTES } from "../../shared/companion";
import { PEERS_MAX, PicturePeers, loopbackOnly } from "./picturePeers";
import { FakePeer, GATHERED_ANSWER } from "./testing/fakePeers";

const OFFER = "v=0\r\no=- 9 2 IN IP4 127.0.0.1\r\ns=-\r\n";

function peers() {
  const counts: number[] = [];
  let joins = 0;
  const p = new PicturePeers(
    (open) => { counts.push(open); },
    () => { joins++; },
    {
      createPeer: (config) => new FakePeer(config) as unknown as RTCPeerConnection,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
    },
  );
  return { p, counts, joins: () => joins };
}

/** Every address an SDP names, in its candidates and connection lines. */
const addresses = (sdp: string) => [
  ...[...sdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) /gm)].map((m) => m[1]),
  ...[...sdp.matchAll(/^c=IN IP[46] (\S+)/gm)].map((m) => m[1]),
  ...[...sdp.matchAll(/ raddr (\S+)/g)].map((m) => m[1]),
];

beforeEach(() => { FakePeer.reset(); });

describe("loopbackOnly", () => {
  it("names no address but 127.0.0.1, and keeps every loopback host candidate", () => {
    const sdp = loopbackOnly(GATHERED_ANSWER)!;
    expect(new Set(addresses(sdp))).toEqual(new Set(["127.0.0.1"]));
    expect(sdp.match(/^a=candidate:/gm)).toHaveLength(2);
    // The rest of the answer is untouched.
    expect(sdp).toContain("a=sctp-port:5000");
    expect(sdp.endsWith("\r\n")).toBe(true);
  });

  it("has no answer without a loopback candidate: one could never connect", () => {
    const lan = GATHERED_ANSWER.split("\r\n").filter((l) => !l.includes(" 127.0.0.1 ")).join("\r\n");
    expect(loopbackOnly(lan)).toBeNull();
  });
});

describe("PicturePeers", () => {
  it("answers an offer with the loopback candidate only", async () => {
    const { p } = peers();
    const answer = await p.answer(OFFER);
    expect(new Set(addresses(answer))).toEqual(new Set(["127.0.0.1"]));
    expect(FakePeer.made[0]!.remoteDescription).toEqual({ type: "offer", sdp: OFFER });
    // No STUN or TURN server: no address is asked of the network either.
    expect(FakePeer.made[0]!.config).toEqual({ iceServers: [] });
  });

  it("refuses to answer when it gathered no loopback candidate, and closes the connection", async () => {
    const { p } = peers();
    FakePeer.answerSdp = GATHERED_ANSWER.replaceAll(" 127.0.0.1 ", " 192.168.1.30 ");
    await expect(p.answer(OFFER)).rejects.toThrow(/127\.0\.0\.1/);
    expect(FakePeer.made[0]!.closed).toBe(true);
  });

  it("counts a connection once its channel opens, and gives it the config and the last keyframe at once", async () => {
    const { p, counts, joins } = peers();
    p.stream.configure({ codec: "vp8", coded_width: 640, coded_height: 360 });
    p.stream.chunk(true, 1, new Uint8Array([1, 2, 3]));
    await p.answer(OFFER);
    const channel = FakePeer.made[0]!.channel();
    expect(counts).toEqual([]);
    channel.open();
    expect(counts).toEqual([1]);
    expect(joins()).toBe(1);
    expect(channel.sent.map((m) => m[0])).toEqual([MIRROR_FRAME_CONFIG, MIRROR_FRAME_KEY]);
    expect(channel.binaryType).toBe("arraybuffer");
  });

  it("splits a frame larger than a channel message into pieces that join back into it", async () => {
    const { p } = peers();
    await p.answer(OFFER);
    const channel = FakePeer.made[0]!.channel();
    channel.open();
    p.stream.configure({ codec: "vp8", coded_width: 640, coded_height: 360 });
    const big = new Uint8Array(PICTURE_MESSAGE_MAX_BYTES * 2 + 10).map((_, i) => i % 251);
    channel.sent.length = 0;
    p.stream.chunk(true, 2, big);
    expect(channel.sent.every((m) => m.length <= PICTURE_MESSAGE_MAX_BYTES)).toBe(true);
    expect(channel.sent.length).toBeGreaterThan(1);
    const joined = new Uint8Array(channel.sent.reduce((n, m) => n + m.length, 0));
    let at = 0;
    for (const m of channel.sent) { joined.set(m, at); at += m.length; }
    expect(joined[0]).toBe(MIRROR_FRAME_KEY);
    expect(joined.subarray(MIRROR_HEADER_BYTES)).toEqual(big);
  });

  it("stops counting a connection whose channel closed or that failed, and closes it", async () => {
    const { p, counts } = peers();
    await p.answer(OFFER);
    await p.answer(OFFER);
    const [first, second] = FakePeer.made as [FakePeer, FakePeer];
    const a = first.channel();
    const b = second.channel();
    a.open();
    b.open();
    a.close();
    second.fail();
    expect(counts).toEqual([1, 2, 1, 0]);
    expect(first.closed && second.closed).toBe(true);
    // A closed channel is written nothing more.
    const sentBefore = b.sent.length;
    p.stream.configure({ codec: "vp8", coded_width: 640, coded_height: 360 });
    expect(b.sent).toHaveLength(sentBefore);
  });

  it("keeps at most PEERS_MAX connections, closing the oldest", async () => {
    const { p } = peers();
    for (let i = 0; i <= PEERS_MAX; i++) await p.answer(OFFER);
    expect(FakePeer.made.filter((pc) => pc.closed)).toEqual([FakePeer.made[0]]);
  });
});
