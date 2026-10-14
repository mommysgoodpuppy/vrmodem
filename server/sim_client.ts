// A stand-in for the world against a running gateway: the modem client's
// seeks as HTTP range requests, and the downlink video decoded by ffmpeg the
// way Downlink.shader decodes it. Then a ping and a DNS query through it.
//
//   deno task gateway &       then       deno task sim [--url http://127.0.0.1:8788] [--session sim]
//       [--lanes 8] [--ping 1.1.1.1] [--count 5] [--resolve example.com]

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { VirtualMp4 } from "./virtual_mp4.ts";
import { decodeSymbols, Layout } from "./downlink.ts";
import { ModemClient } from "./modem/client.ts";
import { frameOf } from "./modem/link.ts";
import { describe, dotted, icmpEcho, udp } from "./modem/ip.ts";

const args = parseArgs(Deno.args, { string: ["url", "session", "lanes", "ping", "count", "resolve", "address"] });
const base = args.url ?? "http://127.0.0.1:8788";
const session = args.session ?? "sim";
const lanes = Number(args.lanes ?? 8);
const address = args.address ?? "10.0.0.1";
const layout: Layout = { w: 1280, h: 720, block: 8, levels: 4, seed: 0 };
const frameBytes = Math.floor(Math.floor(layout.w / layout.block) * Math.floor((layout.h - 16) / layout.block) / 4);

// The lane video as the gateway serves it, for byte offsets of frames.
const lane = new VirtualMp4(await Deno.readFile(new URL("../media/frame-64.mp4", import.meta.url).pathname), 60, 69904);
const now = () => performance.now();
const addr = address.split(".").map(Number);
const client = new ModemClient(lanes, (Math.random() * 2 ** 32) >>> 0, (addr[0] << 24 | addr[1] << 16 | addr[2] << 8 | addr[3]) >>> 0);
const t0 = now();
const stamp = () => ((now() - t0) / 1000).toFixed(3).padStart(8);

// Each lane: a load, then one range request per seek; a new seek cancels the last.
const current: (AbortController | undefined)[] = [];
async function request(i: number, frame: number | null) {
  current[i]?.abort();
  const ac = new AbortController();
  current[i] = ac;
  const range = frame === null ? "bytes=0-" : `bytes=${lane.header.length + frame * lane.sample.length}-`;
  try {
    const r = await fetch(`${base}/m/${session}/u${i}.mp4`, { headers: { range }, signal: ac.signal });
    await r.body?.cancel();
  } catch {
    // Cancelled by the next seek.
  }
}
await Promise.all(Array.from({ length: lanes }, (_, i) => request(i, null)));
for (let i = 0; i < lanes; i++) client.laneReady(i);

// The downlink: the stream through ffmpeg into gray frames.
const down = await fetch(`${base}/m/${session}/down.mp4?w=${layout.w}&h=${layout.h}&block=${layout.block}`);
const ff = new Deno.Command("ffmpeg", {
  args: ["-hide_banner", "-loglevel", "fatal", "-fflags", "nobuffer", "-flags", "low_delay", "-i", "-", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
  stdin: "piped", stdout: "piped",
}).spawn();
down.body!.pipeTo(ff.stdin).catch(() => {});
const replies: { at: number; ip: Uint8Array }[] = [];
let frames = 0, lastFrame = -1;
(async () => {
  const size = layout.w * layout.h;
  let pending = new Uint8Array(0);
  for await (const chunk of ff.stdout) {
    const data = new Uint8Array(pending.length + chunk.length);
    data.set(pending);
    data.set(chunk, pending.length);
    let at = 0;
    for (; at + size <= data.length; at += size) {
      const d = decodeSymbols(layout, data.subarray(at, at + size));
      if (!d || d.frame === lastFrame) continue;
      lastFrame = d.frame;
      frames++;
      const bytes = new Uint8Array(frameBytes);
      for (let i = 0; i < frameBytes * 4; i++) bytes[i >> 2] |= d.symbols[i] << (6 - 2 * (i & 3));
      for (const ip of client.frame(bytes, now())) {
        console.log(`${stamp()} down ${describe(ip)}`);
        replies.push({ at: now(), ip });
      }
    }
    pending = data.slice(at);
  }
})();

// The world's frame clock: every lane's seek each 1/60 s.
let seeks = 0;
const tick = setInterval(() => {
  client.poll(now()).forEach((s, i) => {
    if (s === null) return;
    seeks++;
    request(i, frameOf(s));
  });
}, 1000 / 60);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number) {
  for (const end = now() + ms; now() < end; await wait(10)) if (cond()) return true;
  return false;
}

// The gateway answers our hello in its frames' nonce; acks follow.
await wait(2000);
console.log(`${stamp()} ${frames} downlink frames so far, ${seeks} seeks`);
let failed = false;
const count = Number(args.count ?? 5);
if (args.ping !== "none") {
  const target = args.ping ?? "1.1.1.1";
  const rtts: number[] = [];
  for (let seq = 1; seq <= count; seq++) {
    const sent = now();
    client.send(icmpEcho(address, target, 0x4242, seq));
    const ok = await until(() => replies.some((r) => r.ip[9] === 1 && r.ip[20] === 0 && ((r.ip[26] << 8) | r.ip[27]) === seq), 5000);
    if (ok) rtts.push(now() - sent);
    console.log(`${stamp()} ping ${target} seq=${seq} ${ok ? `${(now() - sent).toFixed(0)} ms` : "lost"}`);
  }
  if (rtts.length < count) failed = true;
}
if (args.resolve !== "none") {
  // A DNS query for an A record, through the gateway's address.
  const name = args.resolve ?? "example.com";
  const q = [0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const part of name.split(".")) q.push(part.length, ...new TextEncoder().encode(part));
  q.push(0, 0, 1, 0, 1);
  const sent = now();
  client.send(udp(address, "10.0.255.254", 5353, 53, new Uint8Array(q)));
  const ok = await until(() => replies.some((r) => r.ip[9] === 17 && ((r.ip[22] << 8) | r.ip[23]) === 5353), 5000);
  const r = replies.find((r) => r.ip[9] === 17 && ((r.ip[22] << 8) | r.ip[23]) === 5353);
  // The answer's last four bytes are the first record's address, for a plain reply.
  console.log(`${stamp()} resolve ${name}: ${ok ? `${dotted(r!.ip, r!.ip.length - 4)} in ${(now() - sent).toFixed(0)} ms` : "no answer"}`);
  if (!ok) failed = true;
}
const resends = client.lanes.reduce((n, l) => n + l.resends, 0);
console.log(`${stamp()} ${frames} frames, ${seeks} seeks (${resends} resent), ${client.bad} bad frames, ${client.down.duplicates} duplicates`);
clearInterval(tick);
current.forEach((c) => c?.abort());
try {
  ff.kill();
} catch {
  // Gone.
}
await down.body?.cancel().catch(() => {});
Deno.exit(failed ? 1 : 0);
