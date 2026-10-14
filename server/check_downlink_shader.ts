// Build fixtures from the actual encoder/reference decoder, then run the
// shader in Unity's graphics context (no VRChat client or world export).
// deno task check-down-shader [--project PATH] [--unity PATH]
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { blocks, decode, Layout, render } from "./downlink.ts";

const args = parseArgs(Deno.args, { string: ["project", "unity"] });
const home = Deno.env.get("HOME")!;
const project = String(args.project ?? `${home}/ALCOM/Projects/vrcmodem`);
const unity = String(
  args.unity ?? `${home}/Unity/Hub/Editor/2022.3.22f1/Editor/Unity`,
);
try {
  await Deno.stat(`${project}/Temp/UnityLockfile`);
  throw new Error("Close the Unity editor before running this check");
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
}
const dir = await Deno.makeTempDir({ prefix: "vrmodem-downlink-" });
const cases: Record<string, unknown>[] = [];
async function fixture(
  l: Layout,
  frame: number,
  mode = "normal",
  input?: Uint8Array,
) {
  let pixels = input ?? render(l, frame);
  if (mode === "damaged") {
    // Destroy only payload, leaving sync, calibration and frame ID intact.
    pixels.fill(16, 16 * l.w);
  } else if (mode === "invalid") pixels.fill(16);
  else if (mode === "centre") {
    // Different centre pixels make averaging observable; a midpoint between
    // the first two calibration levels also exercises the strict tie rule.
    const x = l.block / 2 - 1, y = 16 + l.block / 2 - 1;
    pixels[y * l.w + x] = 16;
    pixels[y * l.w + x + 1] = 16;
    pixels[(y + 1) * l.w + x] = 89;
    pixels[(y + 1) * l.w + x + 1] = 89;
  }
  if (mode === "sync-tie") {
    // Deliberately put a white/black sync pair in the payload's bottom row.
    for (let y = l.h - 16; y < l.h; y++) {
      pixels.fill(235, y * l.w, y * l.w + 16);
      pixels.fill(16, y * l.w + 16, y * l.w + 32);
    }
  }
  const result = decode(l, pixels);
  if (mode === "flipped" || mode === "sync-tie") {
    const flipped = pixels.slice();
    for (let y = 0; y < l.h; y++) {
      flipped.set(pixels.subarray(y * l.w, (y + 1) * l.w), (l.h - 1 - y) * l.w);
    }
    pixels = flipped;
  }
  const file = `${dir}/input-${cases.length}.gray`;
  await Deno.writeFile(file, pixels);
  cases.push({
    ...l,
    file,
    frame: result?.frame ?? -1,
    errors: result?.errors ?? 0,
    flipped: mode === "flipped" || mode === "sync-tie",
    count: blocks(l).count,
    valid: result !== null,
    checkFirst: mode === "centre",
    firstSymbol: 0,
  });
}
try {
  for (const block of [16, 8, 4]) {
    for (const levels of [2, 4, 8]) {
      const l = { w: 1280, h: 720, block, levels, seed: cases.length + 1 };
      await fixture(l, 0);
      await fixture(l, 0xffffff, "flipped");
    }
  }
  const l = { w: 1280, h: 720, block: 8, levels: 4, seed: -1 };
  await fixture(l, 0x800001);
  await fixture(l, 65537, "damaged");
  await fixture(l, 1, "invalid");
  await fixture(l, 70000, "centre");
  await fixture({ ...l, block: 16, levels: 2 }, 37, "sync-tie");
  // Sample real lossy videos when gen-down has already produced them.
  const media = new URL("../media/down/", import.meta.url);
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(new URL("configs.json", media)),
    );
    for (const config of manifest.configs) {
      const result = await new Deno.Command("ffmpeg", {
        args: [
          "-v",
          "error",
          "-i",
          new URL(`${config.name}.mp4`, media).pathname,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "gray",
          "-",
        ],
        stdout: "piped",
        stderr: "inherit",
      }).output();
      if (!result.success || result.stdout.length !== config.w * config.h) {
        throw new Error(`Cannot decode ${config.name}`);
      }
      await fixture(config, 0, "normal", result.stdout);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  // Odd dimensions exercise discarded pixels at the right/bottom edges.
  await fixture({ ...l, w: 641, h: 99 }, 42, "flipped");
  await Deno.writeTextFile(`${dir}/cases.json`, JSON.stringify({ cases }));
  const log =
    new URL("../logs/downlink-shader-check.log", import.meta.url).pathname;
  await Deno.mkdir(new URL("../logs/", import.meta.url), { recursive: true });
  const env: Record<string, string> = {
    VRMODEM_DOWNLINK_CASES: `${dir}/cases.json`,
    DISPLAY: Deno.env.get("DISPLAY") ?? ":0",
  };
  if (!Deno.env.get("XAUTHORITY") && Deno.build.os === "linux") {
    const result = await new Deno.Command("systemctl", {
      args: ["--user", "show-environment"],
    }).output();
    const auth = new TextDecoder().decode(result.stdout).match(
      /^XAUTHORITY=(.*)$/m,
    )?.[1];
    if (auth) env.XAUTHORITY = auth;
  }
  console.log(`Checking ${cases.length} frames in Unity; log: ${log}`);
  const result = await new Deno.Command(unity, {
    args: [
      "-batchmode",
      "-quit",
      "-force-glcore",
      "-projectPath",
      project,
      "-executeMethod",
      "DownlinkShaderCheck.Run",
      "-logFile",
      log,
    ],
    env,
    stdout: "null",
    stderr: "inherit",
  }).output();
  const text = await Deno.readTextFile(log);
  console.log(
    text.split("\n").filter((line) => line.includes("[DownlinkShaderCheck]"))
      .join("\n"),
  );
  if (
    !result.success ||
    !text.includes(`[DownlinkShaderCheck] PASS ${cases.length} cases`)
  ) {
    throw new Error(`Shader check failed; see ${log}`);
  }
} finally {
  await Deno.remove(dir, { recursive: true });
}
