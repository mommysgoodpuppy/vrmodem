// Offline check of the live downlink: frames through LiveEncoder, a VirtualMp4
// header around them, then ffmpeg decodes the file and downlink.ts checks it.
//
//   deno task live-check [--size 1280x720] [--block 8] [--levels 4] [--fps 60] [--qp 24,30,36] [--frames 120]

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { blocks, decode } from "./downlink.ts";
import { LiveEncoder, liveMp4, LiveParams, prepare } from "./live_mp4.ts";
import { render } from "./downlink.ts";

const args = parseArgs(Deno.args, { string: ["size", "block", "levels", "fps", "qp", "frames"] });
const [w, h] = String(args.size ?? "1280x720").split("x").map(Number);
const fps = Number(args.fps ?? 60);
const count = Number(args.frames ?? 120);

for (const qp of String(args.qp ?? "24,30,36").split(",").map(Number)) {
  const p: LiveParams = { w, h, block: Number(args.block ?? 8), levels: Number(args.levels ?? 4), seed: 7, fps, qp };
  const prepared = await prepare(p);
  const mp4 = liveMp4(prepared, fps, 3600);
  const enc = new LiveEncoder(p, prepared.sampleSize);
  const samples: (Uint8Array | null)[] = [];
  const t0 = performance.now();
  // Keep the encoder one frame ahead: each frame's sample appears at the next AUD.
  await enc.write(render(p, 0));
  for (let n = 0; n < count; n++) {
    await enc.write(render(p, n + 1));
    samples.push(await enc.take());
  }
  const ms = (performance.now() - t0) / count;
  enc.close();
  const file = await Deno.makeTempFile({ suffix: ".mp4" });
  const f = await Deno.open(file, { write: true });
  await f.write(mp4.header);
  for (const s of samples) await f.write(s ?? mp4.sample);
  f.close();
  // The file declares an hour; decode just what was written.
  const ff = new Deno.Command("ffmpeg", {
    args: ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", String(count), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    stdout: "piped",
  }).spawn();
  const raw = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
  await ff.status;
  await Deno.remove(file);
  const size = w * h;
  let frames = 0, errors = 0, bad = 0;
  for (let at = 0; at + size <= raw.length; at += size, frames++) {
    const r = decode(p, raw.subarray(at, at + size));
    if (!r || r.frame !== frames) bad++;
    else errors += r.errors;
  }
  const b = blocks(p);
  console.log(`qp ${qp}: sample ${(prepared.sampleSize / 1024).toFixed(1)} KiB (${(prepared.sampleSize * 8 * fps / 1e6).toFixed(1)} Mbit/s), ` +
    `${ms.toFixed(1)} ms/frame, ${enc.overflows} overflows, ${frames} decoded, ${bad} wrong, ` +
    `symbol errors ${(errors / (b.count * Math.max(1, frames - bad)) * 100).toFixed(4)}%, ${(b.bits * fps / 1e6).toFixed(2)} Mbit/s data`);
}
