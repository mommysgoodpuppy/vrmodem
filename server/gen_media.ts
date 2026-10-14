// Generates probe media into ../media with ffmpeg.
//
//   deno task gen [--seconds 120] [--fps 30]
//
// Every frame shows its frame number as text and as a 16-bit binary strip
// along the top (40 px per bit, MSB first, white = 1). The strip is meant for
// later in-world readback so Udon can tell which frame is actually displayed.
//
// Outputs:
//   probe-intra.mp4  every frame a keyframe: seek target maps to a unique byte range
//   probe-gop1s.mp4  keyframe every second: shows how seeks snap to keyframes
//   hls/index.m3u8   VOD HLS, 1 s segments (from the 1 s GOP encode)

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["seconds", "fps"] });
const seconds = Number(args.seconds ?? 120);
const fps = Number(args.fps ?? 30);
const media = new URL("../media/", import.meta.url).pathname;
await Deno.mkdir(`${media}hls`, { recursive: true });

const font = "/usr/share/fonts/noto/NotoSansMono-Regular.ttf";
const W = 640, H = 360, STRIP = 32;

// Bit k (MSB first) of frame number N is shown in column floor(X/40).
const bit = `mod(floor(N/pow(2,15-floor(X/40))),2)`;
const video = [
  `color=c=0x282828:s=${W}x${H}:r=${fps}:d=${seconds}`,
  "format=yuv420p",
  `geq=lum='if(lt(Y,${STRIP}),16+219*${bit},p(X,Y))':cb=128:cr=128`,
  `drawtext=fontfile=${font}:fontsize=96:fontcolor=white:x=(w-tw)/2:y=110:text='%{n}'`,
  `drawtext=fontfile=${font}:fontsize=36:fontcolor=0xbbbbbb:x=(w-tw)/2:y=240:text='%{pts\\:hms}'`,
].join(",");

async function ffmpeg(name: string, out: string[]) {
  console.log(`generating ${name}`);
  const cmd = new Deno.Command("ffmpeg", {
    args: [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", video,
      "-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono:d=${seconds}`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "32k", "-shortest",
      ...out,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`ffmpeg failed for ${name}`);
}

await ffmpeg("probe-intra.mp4", [
  "-x264-params", "keyint=1:min-keyint=1:scenecut=0",
  "-movflags", "+faststart", `${media}probe-intra.mp4`,
]);
await ffmpeg("probe-gop1s.mp4", [
  "-x264-params", `keyint=${fps}:min-keyint=${fps}:scenecut=0`,
  "-movflags", "+faststart", `${media}probe-gop1s.mp4`,
]);
await ffmpeg("hls/index.m3u8", [
  "-x264-params", `keyint=${fps}:min-keyint=${fps}:scenecut=0`,
  "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
  "-hls_segment_filename", `${media}hls/seg%05d.ts`, `${media}hls/index.m3u8`,
]);

for (const f of ["probe-intra.mp4", "probe-gop1s.mp4"]) {
  const { size } = await Deno.stat(`${media}${f}`);
  console.log(`${f}: ${(size / 1024 / 1024).toFixed(1)} MiB`);
}
