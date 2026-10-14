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
// Live downlink: when each frame of a stream was first sent, by name, and the
// streams' encoder overflows (frames repeated because they didn't fit).
const liveSent = new Map<string, Map<number, number>>();
const liveName = new Map<number, string>();
const overflows = new Map<string, number>();
for (const e of server) {
  if (e.ev === "req") {
    reqs.set(e.id, e);
    const ua = e.headers["user-agent"] ?? "-";
    events.push({ t: e.t, text: `srv #${e.id} ${e.remote} ${e.method} ${e.path} range=${e.headers.range ?? "-"} ua=${ua}` });
  } else if (e.ev === "res") {
    events.push({ t: e.t, text: `srv #${e.id} ${e.status} ${e.start ?? ""}-${e.end ?? ""}/${e.size ?? ""}${"frame" in e ? ` session=${e.session} frame=${e.frame ?? "header"}` : ""}` });
  } else if (e.ev === "frame") {
    // A player may reconnect; the latest connection's send time counts.
    if (!liveSent.has(e.name)) liveSent.set(e.name, new Map());
    liveSent.get(e.name)!.set(e.n, e.t);
    liveName.set(e.id, e.name);
  } else if (e.ev === "done" || e.ev === "abort") {
    const name = liveName.get(e.id);
    if (name) overflows.set(name, (overflows.get(name) ?? 0) + (e.overflows ?? 0));
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
// Indexes keep grading linear-ish for long runs with hundreds of thousands of
// seeks: requests by session in arrival order, and by session and frame.
const reqT = (e: { id: number }) => reqs.get(e.id)!.t;
const bySession = new Map<string, typeof seekRequests>();
const byFrame = new Map<string, typeof seekRequests>();
for (const e of [...seekRequests].sort((a, b) => reqT(a) - reqT(b))) {
  if (!bySession.has(e.session)) bySession.set(e.session, []);
  bySession.get(e.session)!.push(e);
  const k = `${e.session}:${e.frame}`;
  if (!byFrame.has(k)) byFrame.set(k, []);
  byFrame.get(k)!.push(e);
}
// First index in a time-sorted request list at or after t.
const lowerBound = (list: typeof seekRequests, t: number) => {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (reqT(list[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
const nextSeekT: number[] = new Array(seeks.length);
{
  const later = new Map<string, number>();
  for (let i = seeks.length - 1; i >= 0; i--) {
    nextSeekT[i] = later.get(seeks[i].player) ?? Infinity;
    later.set(seeks[i].player, seeks[i].t);
  }
}
type Block = { player: string; interval: string; n: number; passed: number; latency: number[]; first: number; last: number; bits: number; ids: number[]; late: number };
const blocks = new Map<string, Block>();
let passed = 0;
const delivered: { t: number; bits: number }[] = [];
for (let i = 0; i < seeks.length; i++) {
  const seek = seeks[i];
  const sameFrame = byFrame.get(`${seek.session}:${seek.frame}`) ?? [];
  const match = sameFrame.find((e) => reqT(e) >= seek.t && reqT(e) < seek.t + 5000 && !used.has(e.id));
  const list = bySession.get(seek.session) ?? [];
  const first = list[lowerBound(list, seek.t)];
  const response = match ?? (first && reqT(first) < Math.min(nextSeekT[i], seek.t + 5000) ? first : undefined);
  const req = response && reqs.get(response.id)!;
  if (match) { passed++; used.add(match.id); }
  const key = `${seek.player} interval=${seek.interval}`;
  const block = blocks.get(key) ?? { player: seek.player, interval: seek.interval, n: 0, passed: 0, latency: [], first: seek.t, last: seek.t, bits: 0, ids: [], late: 0 };
  blocks.set(key, block);
  block.n++;
  // Requested eventually, but outside the five-second window.
  if (!match && sameFrame.some((e) => reqT(e) >= seek.t)) block.late++;
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
// Downlink probe: frames each video delivered to the world, and their errors.
type Down = { url: string; meta: Map<number, number>; uf: number[]; flips: Set<number>; samples: number; errors: number; blocks: number; status: string };
const downs = new Map<number, Down>();
for (const e of events) {
  const m = e.text.match(/^Probe Down\s+down (\d+) (.*)$/);
  if (!m) continue;
  const n = Number(m[1]);
  const d: Down = downs.get(n) ?? { url: "", meta: new Map(), uf: [], flips: new Set(), samples: 0, errors: 0, blocks: 0, status: "no event" };
  downs.set(n, d);
  let x;
  if ((x = m[2].match(/^load (\S+)/))) d.url = x[1].replaceAll("&amp;", "&"); // the VRChat log escapes it
  else if ((x = m[2].match(/^meta frame=(\d+) flip=(\d)(?: uf=(\d+))?/))) {
    if (!d.meta.has(Number(x[1]))) d.meta.set(Number(x[1]), e.t);
    d.flips.add(Number(x[2]));
    if (x[3]) d.uf.push(Number(x[3]));
  } else if ((x = m[2].match(/^frame=\d+ errors=(\d+) blocks=(\d+)/))) {
    d.samples++;
    d.errors += Number(x[1]);
    d.blocks = Number(x[2]);
  } else if (/^(ready|end|failed)/.test(m[2])) d.status = m[2].startsWith("ready") ? "ready" : m[2];
}
if (downs.size) {
  console.log("Downlink:");
  for (const [n, d] of downs) {
    const name = d.url.match(/([^/]+)\.mp4/)?.[1] ?? d.url;
    const query = new URLSearchParams(d.url.split("?")[1] ?? "");
    // Live streams take their layout from the query (main.ts defaults: 4 levels).
    const levels = Number(query.get("levels") ?? (d.url.includes("/l/") ? 4 : name.match(/l(\d+)/)?.[1] ?? 2));
    const frames = [...d.meta.keys()].sort((x, y) => x - y);
    const times = [...d.meta.values()].sort((x, y) => x - y);
    const span = frames.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
    const fps = span > 0 ? (frames.length - 1) / span : 0;
    const gaps = frames.length ? frames[frames.length - 1] - frames[0] + 1 - frames.length : 0;
    const ser = d.samples && d.blocks ? d.errors / (d.samples * d.blocks) : NaN;
    // Udon frames over the same span: a player cap and a slow client look alike otherwise.
    const ufps = d.uf.length > 1 && span > 0 ? (Math.max(...d.uf) - Math.min(...d.uf)) / span : NaN;
    const mbit = fps * d.blocks * Math.log2(levels) * (1 - (ser || 0)) / 1e6;
    console.log(`  ${n} ${name.padEnd(12)} ${d.status}: ${frames.length} frames ${frames[0] ?? "-"}..${frames[frames.length - 1] ?? "-"} ` +
      `(${gaps} missing) ${fps.toFixed(1)} fps${Number.isNaN(ufps) ? "" : ` (Udon ${ufps.toFixed(1)})`}, flip=${[...d.flips].join("/") || "-"}, ` +
      `${d.samples} sampled, symbol errors ${Number.isNaN(ser) ? "-" : (ser * 100).toFixed(4) + "%"}, ${mbit.toFixed(2)} Mbit/s`);
    const sentAt = liveSent.get(name);
    if (sentAt) {
      // Send to first sight in the world, past the lead (sent all at once).
      const lead = Number(query.get("lead") ?? 30);
      const lat = [...d.meta].filter(([f]) => f >= lead && sentAt.has(f)).map(([f, t]) => t - sentAt.get(f)!).sort((x, y) => x - y);
      const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
      if (lat.length) {
        console.log(`    live: ${sentAt.size} sent, overflows=${overflows.get(name) ?? 0}, latency min=${lat[0].toFixed(0)} ` +
          `median=${q(0.5).toFixed(0)} p99=${q(0.99).toFixed(0)} max=${lat[lat.length - 1].toFixed(0)} ms (${lat.length} frames)`);
      } else console.log(`    live: ${sentAt.size} sent, overflows=${overflows.get(name) ?? 0}, no frames past the lead seen`);
    }
  }
}
if (seeks.length) {
  console.log(`Virtual seeks: ${passed}/${seeks.length} matched`);
  // Requests during a block that no seek accounts for show coalescing or retries.
  for (const b of blocks.values()) {
    const session = seeks.find((s) => s.player === b.player)!.session;
    const list = bySession.get(session) ?? [];
    let extra = 0;
    for (let j = lowerBound(list, b.first); j < list.length && reqT(list[j]) <= b.last + 200; j++) {
      if (!used.has(list[j].id)) extra++;
    }
    const span = (b.last - b.first) / 1000;
    const rate = span > 0 ? (b.passed - 1) / span : 0;
    // Request ids are assigned in arrival order, so a decrease is a reorder.
    const reordered = b.ids.filter((id, i) => i > 0 && id < b.ids[i - 1]).length;
    const sorted = [...b.latency].sort((x, y) => x - y);
    const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0;
    const lat = b.latency.length ? `latency mean=${(b.latency.reduce((a, x) => a + x, 0) / b.latency.length).toFixed(1)} p99=${p99.toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)} ms` : "";
    console.log(`  ${b.player} interval=${b.interval} ${b.passed}/${b.n} late=${b.late} extra=${extra} reordered=${reordered} ${rate.toFixed(1)} seeks/s ${(rate * b.bits).toFixed(0)} bit/s ${lat}`);
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
