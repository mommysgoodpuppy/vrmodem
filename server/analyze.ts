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
const seeks: { t: number; player: string; frame: number; phase: number | null; session: string }[] = [];
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
  const frame = m[3].match(/^seek .* frame=(\d+)(?: phase=([\d.]+))?/);
  const session = sessions.get(m[2]);
  if (frame && session) {
    seeks.push({ t, player: m[2], frame: Number(frame[1]), phase: frame[2] ? Number(frame[2]) : null, session });
  }
}

// Match the first player range request after each seek, before the next
// seek (or five seconds). Chrome URL checks and HEADs are not seek evidence.
let passed = 0;
// player -> phase -> (actual - expected, or "none") -> count
const offsets = new Map<string, Map<string, Map<string, number>>>();
for (let i = 0; i < seeks.length; i++) {
  const seek = seeks[i];
  const next = seeks.slice(i + 1).find((s) => s.player === seek.player);
  const deadline = Math.min(next?.t ?? Infinity, seek.t + 5000);
  const response = server.find((e) => {
    const req = reqs.get(e.id);
    return e.ev === "res" && e.status === 206 && e.session === seek.session &&
      typeof e.frame === "number" && req?.method === "GET" && req.headers.range &&
      !/Chrome/i.test(req.headers["user-agent"] ?? "") && req.t >= seek.t && req.t < deadline;
  });
  const req = response && reqs.get(response.id)!;
  const ok = response?.frame === seek.frame;
  if (ok) passed++;
  const byPhase = offsets.get(seek.player) ?? new Map<string, Map<string, number>>();
  offsets.set(seek.player, byPhase);
  const phase = seek.phase === null ? "-" : seek.phase.toFixed(2);
  const counts = byPhase.get(phase) ?? new Map<string, number>();
  byPhase.set(phase, counts);
  const delta = response ? `${response.frame - seek.frame >= 0 ? "+" : ""}${response.frame - seek.frame}` : "none";
  counts.set(delta, (counts.get(delta) ?? 0) + 1);
  events.push({ t: seek.t, text: `${seek.player} seek grade=${ok ? "PASS" : response ? "MISMATCH" : "NO REQUEST"} expected=${seek.frame}` +
    (response ? ` actual=${response.frame} latency=${(req.t - seek.t).toFixed(1)} ms #${response.id}` : "") });
}
if (seeks.length) {
  console.log(`Virtual seeks: ${passed}/${seeks.length} matched`);
  // Frame offset of the requested sample by seek phase within the frame.
  for (const [player, byPhase] of offsets) {
    for (const [phase, counts] of [...byPhase].sort()) {
      console.log(`  ${player} phase=${phase} ${[...counts].map(([d, n]) => `${d}:${n}`).join(" ")}`);
    }
  }
}

events.sort((a, b) => a.t - b.t);
const t0 = events[0].t;
const out = events.map((e) => `${((e.t - t0) / 1000).toFixed(3).padStart(8)}  ${e.text}`).join("\n") + "\n";
await Deno.writeTextFile(join(dir, "timeline.txt"), out);
console.log(out);
