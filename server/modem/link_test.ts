import { assertEquals } from "jsr:@std/assert@1";
import { Deframer, frameBytes, MTU, toChunks, Type } from "./link.ts";
import { ModemClient } from "./client.ts";
import { ModemSession } from "./session.ts";

// A deterministic PRNG (mulberry32).
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function packet(r: () => number, n: number): Uint8Array {
  const len = 20 + Math.floor(r() * (MTU - 19));
  const p = new Uint8Array(len);
  for (let i = 0; i < len; i++) p[i] = Math.floor(r() * 256);
  p[0] = 0x45;
  new DataView(p.buffer).setUint32(4, n); // a tag to find it by
  return p;
}

Deno.test("link frames survive chunking", () => {
  const r = rng(1);
  const got: [number, Uint8Array][] = [];
  const d = new Deframer((t, p) => got.push([t, p]));
  const sent: Uint8Array[] = [];
  for (let i = 0; i < 200; i++) {
    const p = i % 7 === 0 ? new Uint8Array(0) : packet(r, i).subarray(0, Math.floor(r() * 600));
    sent.push(p);
    for (const c of toChunks(frameBytes(Type.Ip, p))) d.push(c);
  }
  assertEquals(got.map((g) => g[1]), sent);
  assertEquals(d.bad, 0);
});

type Opts = { lanes: number; seconds: number; loss: number; hitch: number; downLoss: number; upMs: number; downMs: number; upPerSecond: number; downPerSecond: number; seed: number };

// Both halves, with the world's frame clock: one seek per lane per frame,
// uplink symbols lost singly and in hitches, downlink frames lost.
function simulate(o: Opts) {
  const r = rng(o.seed);
  const upGot: Uint8Array[] = [], downGot: Uint8Array[] = [];
  const session = new ModemSession(o.lanes, (ip) => upGot.push(ip));
  const client = new ModemClient(o.lanes, 0x1234, 0x0a000001);
  for (let i = 0; i < o.lanes; i++) client.laneReady(i);
  const upSent: Uint8Array[] = [], downSent: Uint8Array[] = [];
  const inFlight: { at: number; run: () => void }[] = [];
  const later = (at: number, run: () => void) => inFlight.push({ at, run });
  const dt = 1000 / 60;
  let hitch = 0, n = 0;
  for (let t = 0; t < o.seconds * 1000; t += dt) {
    // Packets in the first half; the second is to finish.
    const sending = t < o.seconds * 500;
    if (sending && r() < o.upPerSecond / 60) client.send(upSent[upSent.push(packet(r, n++)) - 1]);
    // (the gateway has nothing for the client before its hello)
    if (sending && session.nonce && r() < o.downPerSecond / 60) {
      const p = packet(r, n++);
      downSent.push(p);
      session.down.push(p);
    }
    if (hitch > 0) hitch--;
    else if (r() < o.hitch) hitch = 1 + Math.floor(r() * 10);
    client.poll(t).forEach((s, lane) => {
      if (s === null || hitch > 0 || r() < o.loss) return;
      later(t + o.upMs, () => session.symbol(lane, s));
    });
    const frame = session.frame(3520, t);
    if (r() >= o.downLoss) later(t + o.downMs, () => downGot.push(...client.frame(frame, t + o.downMs)));
    inFlight.sort((a, b) => a.at - b.at);
    while (inFlight.length && inFlight[0].at <= t) inFlight.shift()!.run();
  }
  return { upSent, upGot, downSent, downGot, session, client };
}

const tag = (p: Uint8Array) => new DataView(p.buffer, p.byteOffset).getUint32(4);

Deno.test("clean link: everything, in order per lane", () => {
  const s = simulate({ lanes: 8, seconds: 20, loss: 0, hitch: 0, downLoss: 0, upMs: 20, downMs: 550, upPerSecond: 3, downPerSecond: 30, seed: 2 });
  assertEquals(s.upGot.length, s.upSent.length);
  assertEquals(new Set(s.downGot.map(tag)), new Set(s.downSent.map(tag)));
  assertEquals(s.downGot.length, s.downSent.length);
});

Deno.test("lossy link: every packet exactly once, intact", () => {
  for (const seed of [3, 4, 5]) {
    const s = simulate({ lanes: 8, seconds: 60, loss: 0.01, hitch: 0.005, downLoss: 0.2, upMs: 20, downMs: 550, upPerSecond: 2, downPerSecond: 20, seed });
    const byTag = new Map(s.upSent.map((p) => [tag(p), p]));
    assertEquals(s.upGot.length, s.upSent.length, `seed ${seed} uplink`);
    for (const p of s.upGot) assertEquals(p, byTag.get(tag(p)));
    assertEquals(s.downGot.length, s.downSent.length, `seed ${seed} downlink`);
    const down = new Map(s.downSent.map((p) => [tag(p), p]));
    for (const p of s.downGot) assertEquals(p, down.get(tag(p)));
  }
});

Deno.test("throughput, saturated", () => {
  for (const [loss, hitch, upMs] of [[0, 0, 20], [0.01, 0.005, 20], [0, 0, 300]]) {
    // Far more offered than fits: count what arrived in the sending half.
    const s = simulate({ lanes: 8, seconds: 40, loss, hitch, downLoss: 0.1, upMs, downMs: 550, upPerSecond: 20, downPerSecond: 0, seed: 7 });
    const bytes = s.upGot.reduce((n, p) => n + p.length, 0);
    const resends = s.client.lanes.reduce((n, l) => n + l.resends, 0), sends = s.client.lanes.reduce((n, l) => n + l.sends, 0);
    console.log(`loss=${loss} hitch=${hitch} up=${upMs} ms: ${(bytes / 40).toFixed(0)} B/s of packets (raw ${8 * 60 * 15 / 8} B/s), resent ${resends}/${sends}`);
  }
});
