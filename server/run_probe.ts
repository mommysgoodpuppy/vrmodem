// One-shot probe run, no GUI steps:
//   1. export the world headless (Unity batch mode, WorldExport.Build)
//   2. start the probe server
//   3. launch VRChat on the local test build via Steam (desktop, --watch-worlds),
//      or, if VRChat is already running, let --watch-worlds reload the rebuild
//   4. follow the VRChat output log until every probe reports done (or timeout)
// Everything lands in logs/run-<time>/.
//
//   deno task probe [--no-build] [--url URL] [--matrix "URL URL ..."] [--rtt MS] [--lanes N] [--listen HOST:PORT]
//                   [--intervals 0.1,0,-2] [--seeks 400] [--timeout 300] [--vr]
//                   [--down [NAME,NAME...]] [--down-player unity|avpro]
//                   [--live "QUERY;QUERY..."] [--modem [LANES]]
//
// --world PROJECT launches the world another Unity project last exported (its
// Logs/vrmodem-last-build.txt) without building; --until TEXT ends the run at
// the first log line with TEXT. With --modem and --world, only the gateway runs
// (e.g. ShaderEmu: --world ~/ALCOM/Projects/shaderemu --modem --until "[ModemTest] done").
// --forward SESSION:tcp:HOSTPORT:GUESTPORT is passed to the gateway (repeatable), and
// --hold SECONDS keeps the gateway and VRChat running that long after the end, e.g. for a
// shell into the world's machine (shell_check.ts).
//
// --modem builds the modem world (MODEM.md) and runs the gateway on
// 127.0.0.1:8789 beside the probe server: ModemPing pings 1.1.1.1 and resolves
// a name through it.
//
// --live decodes live downlink streams instead (main.ts /l/), one per query,
// e.g. --live "block=8&qp=36;block=4&qp=36&w=1920&h=1080". All must share a size.
//
// --down builds the downlink scene instead: every video of
// media/down/configs.json (or the named ones) played and decoded in turn.
//
// --rtt routes the baked URLs through delay_proxy.ts on port 8788, emulating
// that round-trip time (and a TCP handshake) without root. --lanes builds N
// AVPro players (Probe AVPro0..) instead of one AVPro and one Unity player.
// --listen binds the probe server elsewhere (default 127.0.0.1:8787), e.g.
// 0.0.0.0:8080 with --url on the public address for a port-forwarded test.

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { join } from "jsr:@std/path@1";

const args = parseArgs(Deno.args, {
  boolean: ["no-build", "vr"],
  string: ["url", "matrix", "rtt", "lanes", "intervals", "seeks", "listen", "timeout", "down", "down-player", "live", "modem", "world", "until", "forward", "hold"],
  collect: ["forward"],
});
const HOME = Deno.env.get("HOME")!;
const REPO = new URL("../", import.meta.url).pathname;
const PROJECT = `${HOME}/ALCOM/Projects/vrcmodem`;
const UNITY = `${HOME}/Unity/Hub/Editor/2022.3.22f1/Editor/Unity`;
const VRC_LOGS =
  `${HOME}/.local/share/Steam/steamapps/compatdata/438100/pfx/drive_c/users/steamuser/AppData/LocalLow/VRChat/VRChat`;
const lanes = Number(args.lanes ?? 0);
const viaProxy = (u: string) => args.rtt === undefined ? u : u.replaceAll("127.0.0.1:8787", "127.0.0.1:8788");
const url = viaProxy(args.url ?? "http://127.0.0.1:8787/v/{session}/probe.mp4?fps=60&seconds=69904&lead=30&pace=1");
const matrixUrls = viaProxy(args.matrix ?? "");
// --down with no names is the empty string: every config.
let downSpec = "";
if (args.down !== undefined) {
  const { configs } = JSON.parse(await Deno.readTextFile(join(REPO, "media/down/configs.json")));
  const names = args.down ? new Set(String(args.down).split(",")) : null;
  const base = args.listen ? `http://${args.listen.replace(/^0\.0\.0\.0:/, "127.0.0.1:")}` : "http://127.0.0.1:8787";
  downSpec = configs.filter((c: { name: string }) => !names || names.has(c.name))
    .map((c: { name: string; w: number; h: number; block: number; levels: number; seed: number }) =>
      [viaProxy(`${base}/s/down/down/${c.name}.mp4`), c.w, c.h, c.block, c.levels, c.seed].join("|"))
    .join(";");
  if (!downSpec) throw new Error(`no downlink configs match ${args.down}`);
} else if (args.live) {
  const base = args.listen ? `http://${args.listen.replace(/^0\.0\.0\.0:/, "127.0.0.1:")}` : "http://127.0.0.1:8787";
  downSpec = String(args.live).split(";").map((query, i) => {
    const q = new URLSearchParams(query);
    const get = (k: string, d: number) => Number(q.get(k) ?? d);
    if (!q.has("seed")) q.set("seed", String(i + 1));
    return [viaProxy(`${base}/l/down/live${i}.mp4?${q}`), get("w", 1280), get("h", 720), get("block", 8), get("levels", 4), get("seed", i + 1)].join("|");
  }).join(";");
}
const GATEWAY = "127.0.0.1:8789";
const modemLanes = args.modem === undefined ? 0 : Number(args.modem || 8);
const modemSpec = modemLanes ? `http://${GATEWAY}|world|${modemLanes}` : "";
const PROBES = args.until ? [String(args.until)] : modemSpec ? ["Modem Ping"] : downSpec ? ["Probe Down"]
  : lanes > 0 ? Array.from({ length: lanes }, (_, i) => `Probe AVPro${i}`) : ["Probe AVPro", "Probe Unity"];
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
const resultFile = join(args.world ?? PROJECT, "Logs/vrmodem-last-build.txt");
if (args["no-build"] || args.world) {
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
    VRMODEM_INTERVALS: args.intervals ?? "", VRMODEM_SEEKS: args.seeks ?? "",
    VRMODEM_DOWN: downSpec, VRMODEM_DOWN_PLAYER: args["down-player"] ?? "unity", VRMODEM_MODEM: modemSpec });
  if (code !== 0) throw new Error(`export failed (exit ${code}), see ${runDir}/unity-export.log`);
  vrcw = (await Deno.readTextFile(resultFile)).trim();
}
say(`world: ${vrcw}`);

// --- 2. server ---

const server = new Deno.Command("deno", {
  args: ["task", "serve"],
  cwd: join(REPO, "server"),
  env: {
    LOG_PATH: join(runDir, "server.jsonl"),
    ...(args.listen ? { HOST: args.listen.replace(/:\d+$/, ""), PORT: args.listen.match(/:(\d+)$/)?.[1] ?? "8787" } : {}),
  },
  stdout: "piped",
  stderr: "inherit",
}).spawn();
const serverOut = await Deno.open(join(runDir, "server.txt"), { write: true, create: true, truncate: true });
server.stdout.pipeTo(serverOut.writable);
const gateway = !modemSpec ? null : new Deno.Command("deno", {
  args: ["task", "gateway", "--listen", GATEWAY, "--lanes", String(modemLanes), ...((args.forward ?? []) as string[]).flatMap((f) => ["--forward", f])],
  cwd: join(REPO, "server"),
  env: { LOG_PATH: join(runDir, "gateway.jsonl") },
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
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
    if (/\[ModemProbe\]|\[Modem\]|\[ModemTest\]|\[Lan\]|Video Playback|AVPro|untrusted|URL/i.test(line)) {
      probeLines.push(line.trimEnd());
      if (/\[ModemProbe\]|\[Modem\]|\[ModemTest\]/.test(line)) console.log(line.trim());
    }
    for (const p of PROBES) {
      if (args.until ? line.includes(p) : line.includes(`${p} probe done`) || line.includes(`${p} event error`)) done.add(p);
    }
  }
}

if (args.hold) {
  say(`holding ${args.hold} s for the gateway`);
  await new Promise((r) => setTimeout(r, Number(args.hold) * 1000));
}
await Deno.writeTextFile(join(runDir, "vrchat-probe.log"), probeLines.join("\n") + "\n");
if (logPath) await Deno.copyFile(logPath, join(runDir, "vrchat-output.log"));
server.kill("SIGTERM");
await server.status;
proxy?.kill("SIGTERM");
await proxy?.status;
gateway?.kill("SIGTERM");
await gateway?.status;

say(done.size === PROBES.length ? "all probes finished" : `timed out; finished: ${[...done].join(", ") || "none"}`);
say(`results in ${runDir}`);
