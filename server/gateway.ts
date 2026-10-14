// The modem's gateway (MODEM.md): a VRChat world's machine on the internet
// through video players. Each client session has uplink lanes, whose seeks
// carry symbols, and a live downlink video, whose frames carry packets; its
// packets go through a passt (userspace NAT) of its own.
//
//   deno task gateway [--listen 127.0.0.1:8788] [--lanes 8]
//                     [--forward SESSION:tcp:HOSTPORT:GUESTPORT ...]
//
// URLs, per session (any name, baked into the world per machine):
//   /m/<session>/u<lane>.mp4            uplink lane <lane>, 0 .. lanes - 1
//   /m/<session>/down.mp4?w=&h=&block=&qp=&lead=   the downlink (4 levels)
// LOG_PATH sets the JSONL log (default logs/gateway-<time>.jsonl).

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { join } from "jsr:@std/path@1";
import { VirtualMp4 } from "./virtual_mp4.ts";
import { blocks, render } from "./downlink.ts";
import { liveMp4, LiveParams, liveStream, prepare } from "./live_mp4.ts";
import { frameOf, symbolAt } from "./modem/link.ts";
import { ModemSession } from "./modem/session.ts";
import { Passt } from "./modem/passt.ts";
import { serveHttpsProxy } from "./https_proxy.ts";
import { SynFix } from "./modem/synfix.ts";
import { describe, dotted } from "./modem/ip.ts";

const args = parseArgs(Deno.args, { string: ["listen", "lanes", "forward"], collect: ["forward"] });
const [HOST, PORT] = (args.listen ?? "127.0.0.1:8788").split(":");
const LANES = Number(args.lanes ?? 8);
const MEDIA_DIR = new URL("../media/", import.meta.url).pathname;
const LOG_DIR = new URL("../logs/", import.meta.url).pathname;
// Lane videos: 60 fps, 4,194,240 frames (README: about 2^22 is the limit).
const LANE_FPS = 60, LANE_SECONDS = 69904, LANE_LEAD = 30;
const PASST_DIR = join(LOG_DIR, "passt");
// Packets logged one by one per session and direction; GATEWAY_TRACE=1: all of them, with
// each downlink packet's first frame and ack (down-first, down-again, down-acked: ms since it came).
const TRACE = Deno.env.get("GATEWAY_TRACE") === "1";
const DETAIL = TRACE ? Infinity : 40;

const forwards = new Map<string, { tcp: string[]; udp: string[] }>();
for (const f of (args.forward ?? []) as string[]) {
  const m = f.match(/^([^:]+):(tcp|udp):(\d+):(\d+)$/);
  if (!m) throw new Error(`bad --forward ${f}: SESSION:tcp|udp:HOSTPORT:GUESTPORT`);
  const fw = forwards.get(m[1]) ?? { tcp: [], udp: [] };
  fw[m[2] as "tcp" | "udp"].push(`${m[3]}:${m[4]}`);
  forwards.set(m[1], fw);
}

await Deno.mkdir(PASST_DIR, { recursive: true });
const logPath = Deno.env.get("LOG_PATH") ?? join(LOG_DIR, `gateway-${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
const logFile = await Deno.open(logPath, { create: true, append: true });
const enc = new TextEncoder();
const now = () => performance.timeOrigin + performance.now();
function log(ev: Record<string, unknown>) {
  logFile.writeSync(enc.encode(JSON.stringify({ t: now(), ...ev }) + "\n"));
}

const laneMp4 = new VirtualMp4(await Deno.readFile(join(MEDIA_DIR, "frame-64.mp4")), LANE_FPS, LANE_SECONDS);

type Client = {
  name: string;
  modem: ModemSession;
  passt?: Passt;
  up: number; // packets to the internet
  down: number;
  symbols: number;
  synfix: SynFix; // (modem/synfix.ts: passt's SYNs sent again)
};
const clients = new Map<string, Client>();

function client(name: string): Client {
  let c = clients.get(name);
  if (c) return c;
  const fresh: Client = { name, up: 0, down: 0, symbols: 0, modem: undefined!, synfix: new SynFix() };
  fresh.modem = new ModemSession(LANES, (ip) => {
    // Only the machine's own packets go out.
    if (!fresh.passt || ip.length < 20 || dotted(ip, 12) !== dotted(addressBytes(fresh.modem.address), 0)) return;
    if (fresh.up++ < DETAIL) log({ ev: "up", session: name, ip: describe(ip), bytes: ip.length });
    fresh.passt.send(fresh.synfix.up(ip));
  }, (nonce, address) => {
    fresh.passt?.close();
    const addr = dotted(addressBytes(address), 0);
    log({ ev: "hello", session: name, nonce, address: addr });
    const fw = forwards.get(name);
    fresh.synfix = new SynFix();
    const passt = new Passt({ address: addr, tcp: fw?.tcp, udp: fw?.udp, dir: PASST_DIR }, (from) => {
      const ip = fresh.synfix.down(from);
      if (!ip) {
        if (fresh.down < DETAIL) log({ ev: "down-syn-again", session: name, ip: describe(from) });
        return;
      }
      const n = fresh.modem.down.push(ip, now());
      if (fresh.down++ < DETAIL) log({ ev: "down", session: name, ip: describe(ip), bytes: ip.length, n });
    }, (code) => log({ ev: "passt-exit", session: name, code }));
    fresh.passt = passt;
    passt.ready.catch((e) => log({ ev: "passt-failed", session: name, error: String(e) }));
  });
  if (TRACE) fresh.modem.down.trace = (ev, n, ms) => log({ ev: `down-${ev}`, session: name, n, ms: Math.round(ms) });
  clients.set(name, fresh);
  return fresh;
}

const addressBytes = (a: number) => new Uint8Array([(a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255]);

// Every five seconds, each session's counts.
setInterval(() => {
  for (const c of clients.values()) {
    log({
      ev: "stats", session: c.name, symbols: c.symbols, up: c.up, down: c.down, ips: c.modem.ips,
      downWaiting: c.modem.down.waiting, downDropped: c.modem.down.dropped, synAgain: c.synfix.dropped,
      duplicates: c.modem.lanes.reduce((n, l) => n + l.duplicates, 0), bad: c.modem.lanes.reduce((n, l) => n + l.deframer.bad, 0),
    });
  }
}, 5000);

type Range = { start: number; end: number } | null;
function parseRange(header: string | null, size: number): Range | "unsatisfiable" {
  const m = header?.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return null;
  const start = Number(m[1]), end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}

function rangeHeaders(range: Range, size: number) {
  const start = range?.start ?? 0, end = range?.end ?? size - 1;
  const headers = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store", "content-length": String(end - start + 1) });
  if (range) headers.set("content-range", `bytes ${start}-${end}/${size}`);
  return { start, end, headers, status: range ? 206 : 200 };
}

// A lane: the request's first frame is a symbol; the body plays on from it,
// paced, until the next seek replaces the request.
function serveLane(req: Request, c: Client, lane: number): Response {
  const range = parseRange(req.headers.get("range"), laneMp4.size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${laneMp4.size}` } });
  const { start, end, headers, status } = rangeHeaders(range, laneMp4.size);
  const frame = laneMp4.frameAt(start);
  if (start === 0) c.modem.resetLane(lane); // a load: the lane's sequence starts again
  else if (frame !== null && frame >= frameOf(0)) {
    c.symbols++;
    c.modem.symbol(lane, symbolAt(frame));
  }
  if (req.method === "HEAD") return new Response(null, { status, headers });
  const t0 = now();
  let at = start, closed = false;
  const mediaStart = Math.max(start, laneMp4.header.length);
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (at > end || closed) {
        if (!closed) ctrl.close();
        return;
      }
      let n = Math.min(16384, end + 1 - at);
      if (at < laneMp4.header.length) n = Math.min(n, laneMp4.header.length - at);
      else {
        const k = Math.floor((at - mediaStart) / laneMp4.sample.length);
        const due = t0 + Math.max(0, k - LANE_LEAD + 1) * 1000 / LANE_FPS;
        if (due > now()) await new Promise((r) => setTimeout(r, due - now()));
        if (closed) return;
        n = Math.min(n, laneMp4.sample.length - ((at - mediaStart) % laneMp4.sample.length));
      }
      ctrl.enqueue(laneMp4.read(at, n));
      at += n;
    },
    cancel() {
      closed = true;
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status, headers });
}

const prepared = new Map<string, ReturnType<typeof prepare>>();

async function serveDown(req: Request, c: Client, url: URL, id: number): Promise<Response> {
  const q = (k: string, d: number) => Number(url.searchParams.get(k) ?? d);
  const p: LiveParams = { w: q("w", 1280), h: q("h", 720), block: q("block", 8), levels: 4, seed: 0, fps: 60, qp: q("qp", 36) };
  const lead = q("lead", 2);
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(p.w, 544, 3840) || !int(p.h, 32, 2160) || p.w % 2 || p.h % 2 || !int(p.block, 2, 64) || p.block % 2 || !int(p.qp, 0, 51) || !int(lead, 0, 600)) {
    return new Response("bad downlink parameters", { status: 400 });
  }
  const key = JSON.stringify(p);
  if (!prepared.has(key)) prepared.set(key, prepare(p, 30, 1.25, LOG_DIR));
  let ready;
  try {
    ready = await prepared.get(key)!;
  } catch (e) {
    prepared.delete(key);
    return new Response(`encoder unavailable: ${e}`, { status: 503 });
  }
  const mp4 = liveMp4(ready, p.fps, 3600);
  const range = parseRange(req.headers.get("range"), mp4.size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${mp4.size}` } });
  const { start, end, headers, status } = rangeHeaders(range, mp4.size);
  if (req.method === "HEAD") return new Response(null, { status, headers });
  // Two bits a block, MSB first: four blocks a byte.
  const size = Math.floor(blocks(p).count / 4);
  log({ ev: "down-open", id, session: c.name, start, ...p, bytes: size });
  const body = liveStream({
    p, mp4, sampleSize: ready.sampleSize, start, end, lead,
    render: (n) => {
      const bytes = c.modem.frame(size, now());
      return render(p, n, undefined, (i) => i >> 2 < size ? (bytes[i >> 2] >> (6 - 2 * (i & 3))) & 3 : 0);
    },
    onEnd: (ev, sent, ms, overflows) => log({ ev: `down-${ev}`, id, session: c.name, sent, ms, overflows }),
  });
  return new Response(body, { status, headers });
}

// https for the guest, whose own TLS fails (https_proxy.ts): GATEWAY_HTTPS_PROXY=0 for none
const HTTPS_PROXY = Number(Deno.env.get("GATEWAY_HTTPS_PROXY") ?? "3128");
if (HTTPS_PROXY) serveHttpsProxy(HTTPS_PROXY, log);

let nextId = 1;
Deno.serve({ hostname: HOST, port: Number(PORT), onListen: () => console.log(`gateway on http://${HOST}:${PORT}/  log: ${logPath}`) }, (req, info) => {
  const id = nextId++;
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/m\/([^/]+)\/(u(\d+)|down)\.mp4$/);
  log({ ev: "req", id, remote: `${info.remoteAddr.hostname}:${info.remoteAddr.port}`, method: req.method, path: url.pathname + url.search, range: req.headers.get("range") });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  // 64 random bytes, for a machine with no randomness of its own: ShaderEmu's guest reaches
  // this computer as 10.0.255.254 and credits them to its kernel (rngseed), which dropbear waits for.
  if (url.pathname === "/random") return new Response(crypto.getRandomValues(new Uint8Array(64)), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  if (!m) return new Response("not found", { status: 404 });
  const c = client(m[1]);
  if (m[2] === "down") return serveDown(req, c, url, id);
  const lane = Number(m[3]);
  if (lane >= LANES) return new Response("no such lane", { status: 404 });
  return serveLane(req, c, lane);
});
