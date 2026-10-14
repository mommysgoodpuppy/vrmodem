// Downlink test videos (downlink.ts layout) into ../media/down, and an offline
// check that decodes them again with ffmpeg as the world would.
//
//   deno task gen-down [--seconds 10] [--fps 60] [--check]
//
// Each config is a block size, a number of gray levels and a bitrate, 1280 x 720.
// media/down/configs.json lists them for the world builder and the analyzer.

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { blocks, decode, Layout, render } from "./downlink.ts";

const args = parseArgs(Deno.args, { boolean: ["check"], string: ["seconds", "fps"] });
const seconds = Number(args.seconds ?? 10);
const fps = Number(args.fps ?? 60);
const dir = new URL("../media/down/", import.meta.url).pathname;
await Deno.mkdir(dir, { recursive: true });

const W = 1280, H = 720;
const configs: (Layout & { name: string; kbps: number })[] = [];
for (const block of [16, 8, 4]) {
  for (const levels of [2, 4]) {
    for (const kbps of [8000, 20000]) {
      configs.push({ name: `b${block}l${levels}-${kbps / 1000}M`, w: W, h: H, block, levels, seed: configs.length + 1, kbps });
    }
  }
}

async function encode(c: (typeof configs)[number]) {
  const ff = new Deno.Command("ffmpeg", {
    args: [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${c.w}x${c.h}`, "-r", String(fps), "-i", "-",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-b:v", `${c.kbps}k`, "-maxrate", `${c.kbps}k`, "-bufsize", `${c.kbps}k`,
      "-x264-params", `keyint=${fps}:min-keyint=${fps}:scenecut=0`,
      "-movflags", "+faststart", `${dir}${c.name}.mp4`,
    ],
    stdin: "piped",
  }).spawn();
  const w = ff.stdin.getWriter();
  const frame = new Uint8Array(c.w * c.h);
  for (let n = 0; n < seconds * fps; n++) await w.write(render(c, n, frame));
  await w.close();
  if (!(await ff.status).success) throw new Error(`ffmpeg failed for ${c.name}`);
}

// Decodes the file back to luma and counts symbol errors per frame.
async function check(c: (typeof configs)[number]) {
  const ff = new Deno.Command("ffmpeg", {
    args: ["-hide_banner", "-loglevel", "error", "-i", `${dir}${c.name}.mp4`, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    stdout: "piped",
  }).spawn();
  const size = c.w * c.h;
  let buf = new Uint8Array(0), frames = 0, errors = 0, bad = 0, worst = 0;
  for await (const chunk of ff.stdout) {
    const joined = new Uint8Array(buf.length + chunk.length);
    joined.set(buf);
    joined.set(chunk, buf.length);
    buf = joined;
    while (buf.length >= size) {
      const r = decode(c, buf.subarray(0, size));
      if (!r || r.frame !== frames) bad++;
      else {
        errors += r.errors;
        worst = Math.max(worst, r.errors);
      }
      frames++;
      buf = buf.slice(size);
    }
  }
  await ff.status;
  const b = blocks(c);
  const ser = errors / (b.count * Math.max(1, frames - bad));
  console.log(`${c.name.padEnd(12)} ${frames} frames, ${bad} unreadable, symbol errors ${(ser * 100).toFixed(4)}% (worst frame ${worst}/${b.count}), ` +
    `${(b.bits * fps / 1e6).toFixed(2)} Mbit/s raw`);
}

for (const c of configs) {
  console.log(`generating ${c.name}`);
  await encode(c);
  if (args.check) await check(c);
}
await Deno.writeTextFile(`${dir}configs.json`, JSON.stringify({ fps, seconds, configs }, null, 2) + "\n");
