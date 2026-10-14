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

const reqs = new Map<number, { remote: string; path: string }>();
const buckets = new Map<string, number>(); // `${bucketStart}:${id}` -> bytes
for (const e of server) {
  if (e.ev === "req") {
    reqs.set(e.id, { remote: e.remote, path: e.path });
    const ua = e.headers["user-agent"] ?? "-";
    events.push({ t: e.t, text: `srv #${e.id} ${e.remote} ${e.method} ${e.path} range=${e.headers.range ?? "-"} ua=${ua}` });
  } else if (e.ev === "res") {
    events.push({ t: e.t, text: `srv #${e.id} ${e.status} ${e.start ?? ""}-${e.end ?? ""}/${e.size ?? ""}` });
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
const probeRe = /\[ModemProbe\] (\d\d:\d\d:\d\d\.\d{3}) (Probe \w+) (.*)$/;
for (const line of (await Deno.readTextFile(join(dir, "vrchat-probe.log"))).split("\n")) {
  const m = line.match(probeRe);
  if (!m) continue;
  events.push({ t: Date.parse(`${day}T${m[1]}Z`), text: `${m[2].padEnd(11)} ${m[3]}` });
}

events.sort((a, b) => a.t - b.t);
const t0 = events[0].t;
const out = events.map((e) => `${((e.t - t0) / 1000).toFixed(3).padStart(8)}  ${e.text}`).join("\n") + "\n";
await Deno.writeTextFile(join(dir, "timeline.txt"), out);
console.log(out);
