# Workflow

How to set up this machine for vrmodem, and how a probe run works end to end.
For what the project is and what has been measured, see [README.md](README.md).

## Components

| Piece | Where | Role |
| --- | --- | --- |
| Probe server | `server/main.ts` (Deno) | Serves test and virtual media on `127.0.0.1:8787`; logs every request, range, and chunk pull as JSONL |
| Media | `server/gen_media.ts` → `media/` | ffmpeg test MP4s, HLS, and the tiny source frame for virtual MP4s |
| Virtual MP4 | `server/virtual_mp4.ts` | Synthesizes MP4 byte ranges in memory (Ellie's implementation) |
| Udon probe | `unity/ModemProbe.cs` | Runs inside the world: load, play, sample, seek pattern, pause pattern, stop; logs `[ModemProbe]` lines |
| Scene builder | `unity/Editor/ProbeSceneBuilder.cs` | Generates the UI-free probe scene and bakes per-player URLs |
| World export | `unity/Editor/WorldExport.cs` | Builds the scene and exports a local-test `.vrcw` through the SDK's `VRCWorldBuilder`, headless |
| Orchestrator | `server/run_probe.ts` | Export → server → launch VRChat → collect logs |
| Analyzer | `server/analyze.ts` | Merges client and server logs into `timeline.txt`; grades virtual seeks and reports throughput |
| Delay proxy | `server/delay_proxy.ts` | Emulates WAN RTT on localhost without root (`--rtt`) |
| Unity project | `~/ALCOM/Projects/vrcmodem` | Worlds SDK 3.10.5 (bundles UdonSharp and ClientSim); this repo's `unity/` is symlinked in as `Assets/vrmodem` |

## One-time setup

Already done on this machine (2026-10-14):

1. **Unity Hub and ALCOM** installed from `~/git/pak`, with Unity `2022.3.22f1`.
2. **Hub module:** Windows Build Support (Mono). VRChat PC worlds build for
   Windows; the Linux editor only had Linux support. Install it from the Hub GUI.
   Hub's `--headless` CLI hands off to a running Hub window and hangs.
3. **`libxml2-legacy`** (pacman, run by Ellie). The editor needs
   `libxml2.so.2`, and current Arch only ships `.so.16`.
4. **Unity license** activated through Hub (`~/.config/unity3d/Unity/licenses`).
5. **World project** created in ALCOM as `~/ALCOM/Projects/vrcmodem`, then
   `ln -s ~/git/vrmodem/unity ~/ALCOM/Projects/vrcmodem/Assets/vrmodem`.
6. **VRChat** runs from Steam with the `proton-rtsp-11.0` compatibility tool
   (see `~/git/vrlinux/LAUNCHING.md`). Video players don't work reliably under
   stock Proton.

To repeat this on a fresh machine, do steps 1–6. Then run `cd server && deno task gen`
once for the media, and do one headless build so Unity imports the project
(the first import takes a few minutes).

## The loop

```sh
cd ~/git/vrmodem/server
deno task test                              # virtual MP4 and server tests
deno task probe                             # full automated run
deno task analyze ../logs/run-<time>        # timeline + seek grades
```

`deno task probe` does, without GUI steps:

1. **Export.** Runs Unity headless (`-executeMethod WorldExport.Build`) with
   `VRMODEM_URL` baked into the scene. The `.vrcw` lands in
   `~/.local/share/VRChat/VRChat/Worlds/`, and its path is written to
   `<project>/Logs/vrmodem-last-build.txt`.
2. **Serve.** Starts the probe server, logging to `logs/run-<time>/server.jsonl`.
3. **Launch.** `steam -applaunch 438100` with the SDK's Build & Test arguments:
   `--url=create?roomId=…&hidden=true&name=BuildAndRun&url=file:///Z:<vrcw>`,
   the debug-logging flags, `--watch-worlds`, and `--no-vr` (`--vr` keeps VR).
   Wine sees the Linux filesystem as `Z:`.
4. **Collect.** Follows the newest `output_log_*.txt` in the Proton prefix
   (`compatdata/438100/.../LocalLow/VRChat/VRChat`) until each probe logs
   `probe done` or an error, then stops the server.

Outputs in `logs/run-<time>/`: `unity-export.log`, `server.jsonl`, `server.txt`,
`launch-args.txt`, `vrchat-probe.log` (filtered), and `vrchat-output.log` (full
client log). `analyze` adds `timeline.txt`.

Options: `--url URL` (`{session}` becomes the player's session), `--lanes N`
(N AVPro players instead of AVPro + Unity), `--intervals` and `--seeks` (seek
schedule), `--matrix "URL …"` (load-acceptance matrix), `--rtt MS` (through
the delay proxy), `--timeout SECONDS`, `--no-build` (reuse the last export),
`--vr`.

Runs take minutes. Start them in the background rather than blocking on them.

This is a real client logged in as Ellie, in a hidden local test instance of a
locally built world. Nothing is uploaded.

## Editing

- **Udon or editor scripts:** edit under `unity/`. The next headless export
  recompiles UdonSharp; `ModemProbe.asset` and `.meta` files change with it and
  belong in Git.
- **Scene layout or probe parameters:** change `ProbeSceneBuilder.cs`. The
  scene is regenerated from scratch on every build, so don't hand-edit
  `Assets/Scenes/ModemProbe.unity`.
- **Server or media:** edit under `server/`, then run `deno task test`.
- **Interactive editor use:** open the project in Unity and use
  **vrmodem → Build Probe Scene**. Close the editor before `deno task probe`;
  batch mode refuses a project that is open.

## Gotchas

- **The `.vrcw` filename changes on every export.** `--watch-worlds` therefore
  won't pick up a rebuild in an already-running client. Close VRChat between
  builds (`pkill -x VRChat.exe`). `run_probe` only launches a client when none
  is running.
- **Use exact process names.** `pgrep -f VRChat.exe` / `pkill -f` match any
  shell whose command line contains the pattern, including the agent's own.
- **Unity batch mode exits 0 after exceptions** in `-executeMethod` unless the
  method calls `EditorApplication.Exit(1)`. Both entry points do.
- **UdonSharp compile must be synchronous** in batch mode
  (`UdonSharpCompilerV1.CompileSync`). Otherwise proxy serialization fails with
  "outdated script version".
- **Shell environment:** the agent's shell has no display variables. Headless
  Unity runs fine. Anything GUI-adjacent needs `DISPLAY=:0`, and `XAUTHORITY`
  from `systemctl --user show-environment`.
- **Loop default:** video player components added from code default to looping;
  the builder turns it off.
- The `[ModemProbe]` lines carry UTC `HH:mm:ss.fff`. The analyzer takes the
  date from the server log, so a run spanning UTC midnight would misplace them.

## Commits

Commits are authored as Ellie, with no co-author trailer. Agent-made commits
end with `Generated-by: <model id> (Claude Code <version>)`.
