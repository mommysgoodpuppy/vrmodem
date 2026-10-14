// One-shot probe run, no GUI steps:
//   1. export the world headless (Unity batch mode, WorldExport.Build)
//   2. start the probe server
//   3. launch VRChat on the local test build via Steam (desktop, --watch-worlds),
//      or, if VRChat is already running, let --watch-worlds reload the rebuild
//   4. follow the VRChat output log until every probe reports done (or timeout)
// Everything lands in logs/run-<time>/.
//
//   deno task probe [--no-build] [--url URL] [--matrix "URL URL ..."] [--rtt MS] [--lanes N]
//                   [--intervals 0.1,0,-2] [--seeks 400] [--timeout 300] [--vr]
//
// --rtt routes the baked URLs through delay_proxy.ts on port 8788, emulating
// that round-trip time (and a TCP handshake) without root. --lanes builds N
// AVPro players (Probe AVPro0..) instead of one AVPro and one Unity player.

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { join } from "jsr:@std/path@1";

const args = parseArgs(Deno.args, {
  boolean: ["no-build", "vr"],
  string: ["url", "matrix", "rtt", "lanes", "intervals", "seeks", "timeout"],
});
const HOME = Deno.env.get("HOME")!;
const REPO = new URL("../", import.meta.url).pathname;
const PROJECT = `${HOME}/ALCOM/Projects/vrcmodem`;
const UNITY = `${HOME}/Unity/Hub/Editor/2022.3.22f1/Editor/Unity`;
const VRC_LOGS =
  `${HOME}/.local/share/Steam/steamapps/compatdata/438100/pfx/drive_c/users/steamuser/AppData/LocalLow/VRChat/VRChat`;
const lanes = Number(args.lanes ?? 0);
const PROBES = lanes > 0 ? Array.from({ length: lanes }, (_, i) => `Probe AVPro${i}`) : ["Probe AVPro", "Probe Unity"];
const viaProxy = (u: string) => args.rtt === undefined ? u : u.replaceAll("127.0.0.1:8787", "127.0.0.1:8788");
const url = viaProxy(args.url ?? "http://127.0.0.1:8787/v/{session}/probe.mp4?fps=60&seconds=69904&lead=30&pace=1");
const matrixUrls = viaProxy(args.matrix ?? "");
const timeoutMs = Number(args.timeout ?? 300) * 1000;

const runDir = join(REPO, "logs", `run-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}`);
await Deno.mkdir(runDir, { recursive: true });
const say = (msg: string) => console.log(`[probe] ${msg}`);

async function run(cmd: string, cmdArgs: string[], env: Record<string, string> = {}) {
  const { code, stdout } = await new Deno.Command(cmd, { args: cmdArgs, env, stdout: "piped", stderr: "inherit" }).output();
  return { code, out: new TextDecoder().decode(stdout) };
}

async function isRunning(pattern: string) {
  return (await run("pgrep", ["-x", pattern])).code === 0;
}

// --- 1. export ---

let vrcw: string;
const resultFile = join(PROJECT, "Logs/vrmodem-last-build.txt");
if (args["no-build"]) {
  vrcw = (await Deno.readTextFile(resultFile)).trim();
} else {
  try {
    await Deno.stat(join(PROJECT, "Temp/UnityLockfile"));
    throw new Error("the project is open in the Unity editor; close it or use --no-build");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  say(`exporting world (url=${url}${matrixUrls ? `, matrix=${matrixUrls}` : ""})`);
  const { code } = await run(UNITY, [
    "-batchmode", "-quit", "-nographics", "-buildTarget", "Win64",
    "-projectPath", PROJECT, "-executeMethod", "WorldExport.Build",
    "-logFile", join(runDir, "unity-export.log"),
  ], { VRMODEM_URL: url, VRMODEM_MATRIX: matrixUrls, VRMODEM_LANES: String(lanes),
    VRMODEM_INTERVALS: args.intervals ?? "", VRMODEM_SEEKS: args.seeks ?? "" });
  if (code !== 0) throw new Error(`export failed (exit ${code}), see ${runDir}/unity-export.log`);
  vrcw = (await Deno.readTextFile(resultFile)).trim();
}
say(`world: ${vrcw}`);

// --- 2. server ---

const server = new Deno.Command("deno", {
  args: ["task", "serve"],
  cwd: join(REPO, "server"),
  env: { LOG_PATH: join(runDir, "server.jsonl") },
  stdout: "piped",
  stderr: "inherit",
}).spawn();
const serverOut = await Deno.open(join(runDir, "server.txt"), { write: true, create: true, truncate: true });
server.stdout.pipeTo(serverOut.writable);
const proxy = args.rtt === undefined ? null : new Deno.Command("deno", {
  args: ["task", "delay", "--rtt", args.rtt],
  cwd: join(REPO, "server"),
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
await new Promise((r) => setTimeout(r, 1500));

// --- 3. launch ---

const launchedAt = Date.now();
// A fresh client writes a new output_log; a just-killed client's log can still
// look recent, so only logs that did not exist before launch count.
const oldLogs = new Set<string>();
const reuse = await isRunning("VRChat.exe");
if (!reuse) for await (const e of Deno.readDir(VRC_LOGS)) oldLogs.add(e.name);
if (reuse) {
  // Only works if that client was started by this script (test world + --watch-worlds).
  say("VRChat already running: relying on --watch-worlds to reload the rebuild");
} else {
  // Wine sees the Linux filesystem as Z:.
  const fileUrl = "file:///Z:" + vrcw;
  const roomId = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const gameArgs = [
    `--url=create?roomId=${roomId}&hidden=true&name=BuildAndRun&url=${fileUrl}`,
    "--enable-debug-gui", "--enable-sdk-log-levels", "--enable-udon-debug-logging",
    "--watch-worlds",
    ...(args.vr ? [] : ["--no-vr"]),
  ];
  await Deno.writeTextFile(join(runDir, "launch-args.txt"), gameArgs.join("\n") + "\n");
  say("launching VRChat via Steam");
  await run("steam", ["-applaunch", "438100", ...gameArgs]);
}

// --- 4. follow the VRChat log ---

async function newestLog(): Promise<string | null> {
  let best: { name: string; mtime: number } | null = null;
  for await (const e of Deno.readDir(VRC_LOGS)) {
    if (!e.name.startsWith("output_log_") || oldLogs.has(e.name)) continue;
    const mtime = (await Deno.stat(join(VRC_LOGS, e.name))).mtime?.getTime() ?? 0;
    if (!best || mtime > best.mtime) best = { name: e.name, mtime };
  }
  return best && best.mtime >= launchedAt - 60_000 ? join(VRC_LOGS, best.name) : null;
}

const probeLines: string[] = [];
const done = new Set<string>();
let logPath: string | null = null;
let offset = 0;
const deadline = Date.now() + timeoutMs;
say(`waiting for probes (timeout ${timeoutMs / 1000} s)`);

while (Date.now() < deadline && done.size < PROBES.length) {
  await new Promise((r) => setTimeout(r, 1000));
  logPath ??= await newestLog();
  if (!logPath) continue;
  const data = await Deno.readFile(logPath);
  if (data.length <= offset) continue;
  const text = new TextDecoder().decode(data.subarray(offset));
  offset = data.length;
  for (const line of text.split("\n")) {
    if (/\[ModemProbe\]|Video Playback|AVPro|untrusted|URL/i.test(line)) {
      probeLines.push(line.trimEnd());
      if (line.includes("[ModemProbe]")) console.log(line.trim());
    }
    for (const p of PROBES) {
      if (line.includes(`${p} probe done`) || line.includes(`${p} event error`)) done.add(p);
    }
  }
}

await Deno.writeTextFile(join(runDir, "vrchat-probe.log"), probeLines.join("\n") + "\n");
if (logPath) await Deno.copyFile(logPath, join(runDir, "vrchat-output.log"));
server.kill("SIGTERM");
await server.status;
proxy?.kill("SIGTERM");
await proxy?.status;

say(done.size === PROBES.length ? "all probes finished" : `timed out; finished: ${[...done].join(", ") || "none"}`);
say(`results in ${runDir}`);
