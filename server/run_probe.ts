// One-shot probe run, no GUI steps:
//   1. export the world headless (Unity batch mode, WorldExport.Build)
//   2. start the probe server
//   3. launch VRChat on the local test build via Steam (desktop, --watch-worlds),
//      or, if VRChat is already running, let --watch-worlds reload the rebuild
//   4. follow the VRChat output log until every probe reports done (or timeout)
// Everything lands in logs/run-<time>/.
//
//   deno task probe [--no-build] [--url URL] [--timeout 300] [--vr]

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { join } from "jsr:@std/path@1";

const args = parseArgs(Deno.args, {
  boolean: ["no-build", "vr"],
  string: ["url", "timeout"],
});
const HOME = Deno.env.get("HOME")!;
const REPO = new URL("../", import.meta.url).pathname;
const PROJECT = `${HOME}/ALCOM/Projects/vrcmodem`;
const UNITY = `${HOME}/Unity/Hub/Editor/2022.3.22f1/Editor/Unity`;
const VRC_LOGS =
  `${HOME}/.local/share/Steam/steamapps/compatdata/438100/pfx/drive_c/users/steamuser/AppData/LocalLow/VRChat/VRChat`;
const PROBES = ["Probe AVPro", "Probe Unity"];
const url = args.url ?? "http://127.0.0.1:8787/s/probe/probe-intra.mp4";
const timeoutMs = Number(args.timeout ?? 300) * 1000;

const runDir = join(REPO, "logs", `run-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}`);
await Deno.mkdir(runDir, { recursive: true });
const say = (msg: string) => console.log(`[probe] ${msg}`);

async function run(cmd: string, cmdArgs: string[], env: Record<string, string> = {}) {
  const { code, stdout } = await new Deno.Command(cmd, { args: cmdArgs, env, stdout: "piped", stderr: "inherit" }).output();
  return { code, out: new TextDecoder().decode(stdout) };
}

async function isRunning(pattern: string) {
  return (await run("pgrep", ["-f", pattern])).code === 0;
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
  say(`exporting world (url=${url})`);
  const { code } = await run(UNITY, [
    "-batchmode", "-quit", "-nographics", "-buildTarget", "Win64",
    "-projectPath", PROJECT, "-executeMethod", "WorldExport.Build",
    "-logFile", join(runDir, "unity-export.log"),
  ], { VRMODEM_URL: url });
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
await new Promise((r) => setTimeout(r, 1500));

// --- 3. launch ---

const launchedAt = Date.now();
if (await isRunning("VRChat.exe")) {
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
    if (!e.name.startsWith("output_log_")) continue;
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

say(done.size === PROBES.length ? "all probes finished" : `timed out; finished: ${[...done].join(", ") || "none"}`);
say(`results in ${runDir}`);
