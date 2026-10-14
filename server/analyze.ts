// Merges one probe run into a single timeline: probe actions from the VRChat
// log, plus server requests, ranges, completions, and pull throughput in
// 250 ms buckets.
//
//   deno task analyze logs/run-<time>     (writes timeline.txt there too)

import { join } from "jsr:@std/path@1";

const dir = Deno.args[0];
if (!dir) throw new Error("usage: analyze.ts <run dir>");
const BUCKET = 250;

type Ev = { t: number; text: string };
const events: Ev[] = [];

// --- server ---
const server = (await Deno.readTextFile(join(dir, "server.jsonl"))).trim().split("\n").filter(Boolean)
  .map((l) => JSON.parse(l));
if (!server.length) throw new Error("empty server log");
const day = new Date(server[0].t).toISOString().slice(0, 10);

const reqs = new Map<number, { t: number; remote: string; path: string; method: string; headers: Record<string, string> }>();
const buckets = new Map<string, number>(); // `${bucketStart}:${id}` -> bytes
for (const e of server) {
  if (e.ev === "req") {
    reqs.set(e.id, e);
    const ua = e.headers["user-agent"] ?? "-";
    events.push({ t: e.t, text: `srv #${e.id} ${e.remote} ${e.method} ${e.path} range=${e.headers.range ?? "-"} ua=${ua}` });
  } else if (e.ev === "res") {
    events.push({ t: e.t, text: `srv #${e.id} ${e.status} ${e.start ?? ""}-${e.end ?? ""}/${e.size ?? ""}${"frame" in e ? ` session=${e.session} frame=${e.frame ?? "header"}` : ""}` });
  } else if (e.ev === "done" || e.ev === "abort") {
    events.push({ t: e.t, text: `srv #${e.id} ${e.ev} sent=${e.sent} in ${(e.ms / 1000).toFixed(2)} s` });
  } else if (e.ev === "pull") {
    const k = `${Math.floor(e.t / BUCKET) * BUCKET}:${e.id}`;
    buckets.set(k, (buckets.get(k) ?? 0) + e.n);
  }
}
for (const [k, bytes] of buckets) {
  const [t, id] = k.split(":").map(Number);
  events.push({ t, text: `srv #${id} pulled ${(bytes / 1024).toFixed(0)} KiB` });
}

// --- probe (VRChat log) ---
const sessions = new Map<string, string>();
const seeks: { t: number; player: string; frame: number; interval: string; session: string }[] = [];
const probeRe = /\[ModemProbe\] (\d\d:\d\d:\d\d\.\d{3}) (Probe \w+) (.*)$/;
for (const line of (await Deno.readTextFile(join(dir, "vrchat-probe.log"))).split("\n")) {
  const m = line.match(probeRe);
  if (!m) continue;
  const t = Date.parse(`${day}T${m[1]}Z`);
  events.push({ t, text: `${m[2].padEnd(11)} ${m[3]}` });
  if (m[3].startsWith("load ")) {
    const path = new URL(m[3].slice(5)).pathname;
    const session = path.match(/^\/[sv]\/([^/]+)\//)?.[1];
    if (session) sessions.set(m[2], session);
  }
  const frame = m[3].match(/^seek .* frame=(\d+)(?:.* interval=(-?[\d.]+))?/);
  const session = sessions.get(m[2]);
  if (frame && session) {
    seeks.push({ t, player: m[2], frame: Number(frame[1]), interval: frame[2] ?? "-", session });
  }
}

// A seek passes when a player range request for its frame arrives within five
// seconds; at short intervals that request can follow the next seek. Otherwise
// the first request before the next seek is a mismatch. Chrome URL checks and
// HEADs are not seek evidence.
const seekRequests = server.filter((e) => {
  const req = reqs.get(e.id);
  return e.ev === "res" && e.status === 206 && typeof e.frame === "number" && req?.method === "GET" &&
    req.headers.range && !/Chrome/i.test(req.headers["user-agent"] ?? "");
});
const used = new Set<number>();
type Block = { player: string; interval: string; n: number; passed: number; latency: number[]; first: number; last: number; bits: number; ids: number[] };
const blocks = new Map<string, Block>();
let passed = 0;
const delivered: { t: number; bits: number }[] = [];
for (let i = 0; i < seeks.length; i++) {
  const seek = seeks[i];
  const next = seeks.slice(i + 1).find((s) => s.player === seek.player);
  const after = seekRequests.filter((e) => e.session === seek.session && reqs.get(e.id)!.t >= seek.t && reqs.get(e.id)!.t < seek.t + 5000);
  const match = after.find((e) => e.frame === seek.frame && !used.has(e.id));
  const response = match ?? after.find((e) => reqs.get(e.id)!.t < (next?.t ?? Infinity));
  const req = response && reqs.get(response.id)!;
  if (match) { passed++; used.add(match.id); }
  const key = `${seek.player} interval=${seek.interval}`;
  const block = blocks.get(key) ?? { player: seek.player, interval: seek.interval, n: 0, passed: 0, latency: [], first: seek.t, last: seek.t, bits: 0, ids: [] };
  blocks.set(key, block);
  block.n++;
  block.last = seek.t;
  if (match) {
    block.passed++;
    block.latency.push(req!.t - seek.t);
    block.bits = Math.log2(match.frames - 1);
    block.ids.push(match.id);
    delivered.push({ t: seek.t, bits: Math.log2(match.frames - 1) });
  }
  events.push({ t: seek.t, text: `${seek.player} seek grade=${match ? "PASS" : response ? "MISMATCH" : "NO REQUEST"} expected=${seek.frame}` +
    (response ? ` actual=${response.frame} latency=${(req!.t - seek.t).toFixed(1)} ms #${response.id}` : "") });
}
// Matrix mode: which URLs each player accepted.
const matrix = new Map<string, string>();
for (const e of events) {
  const m = e.text.match(/^(Probe \w+)\s+matrix (\d+) (load|ready|failed) ?(.*)$/);
  if (!m) continue;
  const key = `${m[1]} ${m[2]}`;
  if (m[3] === "load") matrix.set(key, `${m[4]} -> no event`);
  else matrix.set(key, `${matrix.get(key)?.replace(/ -> .*$/, "")} -> ${m[3]} ${m[4]}`);
}
if (matrix.size) {
  console.log("Matrix:");
  for (const [k, v] of matrix) console.log(`  ${k} ${v.replace(/^https?:\/\/[^/]+/, "")}`);
}
if (seeks.length) {
  console.log(`Virtual seeks: ${passed}/${seeks.length} matched`);
  // Requests during a block that no seek accounts for show coalescing or retries.
  for (const b of blocks.values()) {
    const session = seeks.find((s) => s.player === b.player)!.session;
    const extra = seekRequests.filter((e) => e.session === session && !used.has(e.id) &&
      reqs.get(e.id)!.t >= b.first && reqs.get(e.id)!.t <= b.last + 200).length;
    const span = (b.last - b.first) / 1000;
    const rate = span > 0 ? (b.passed - 1) / span : 0;
    // Request ids are assigned in arrival order, so a decrease is a reorder.
    const reordered = b.ids.filter((id, i) => i > 0 && id < b.ids[i - 1]).length;
    const sorted = [...b.latency].sort((x, y) => x - y);
    const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0;
    const lat = b.latency.length ? `latency mean=${(b.latency.reduce((a, x) => a + x, 0) / b.latency.length).toFixed(1)} p99=${p99.toFixed(1)} max=${Math.max(...b.latency).toFixed(1)} ms` : "";
    console.log(`  ${b.player} interval=${b.interval} ${b.passed}/${b.n} extra=${extra} reordered=${reordered} ${rate.toFixed(1)} seeks/s ${(rate * b.bits).toFixed(0)} bit/s ${lat}`);
  }
  // Aggregate across players: best 1 s and 10 s windows of matched seeks.
  delivered.sort((x, y) => x.t - y.t);
  const best = (ms: number) => {
    let top = 0;
    for (let a = 0, b = 0, sum = 0; b < delivered.length; b++) {
      sum += delivered[b].bits;
      while (delivered[b].t - delivered[a].t >= ms) sum -= delivered[a++].bits;
      top = Math.max(top, sum * 1000 / ms);
    }
    return top;
  };
  console.log(`  aggregate best 1 s ${best(1000).toFixed(0)} bit/s, best 10 s ${best(10000).toFixed(0)} bit/s`);
}

events.sort((a, b) => a.t - b.t);
const t0 = events[0].t;
const out = events.map((e) => `${((e.t - t0) / 1000).toFixed(3).padStart(8)}  ${e.text}`).join("\n") + "\n";
await Deno.writeTextFile(join(dir, "timeline.txt"), out);
console.log(out);
