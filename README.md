# vrmodem

A cursed experiment: a bidirectional data channel between a VRChat world and
an external server, built only from what Udon video players already do.

- **Downlink:** data encoded in video frames, read via RenderTexture in a shader
  or through `VRCAsyncGPUReadback`.
- **Uplink:** Udon can't construct URLs at runtime, and URL loads are limited to
  about one per 5 s. Players can still seek and pause freely, and both change
  what the player requests from the server, and when:
  - **Seek leak:** seek target → HTTP `Range` offset (all-intra MP4), HLS segment
    index, or possibly an RTSP `PLAY Range`.
  - **Pause / consumption-rate modulation:** a paused player stops reading, so
    TCP backpressure stalls the server's sends. Symbol time ≥ the player's buffer
    fill time, so the server paces sends (`?kbps=`) to keep that buffer small.
  - **Baseline:** a baked table of N `VRCUrl`s = log2(N) bits per ~5 s.
  - Several players in parallel multiply any of these.
- **Session identity:** paste one session URL into a `VRCUrlInputField` (allowed
  at runtime). Fall back to IP matching.

See [Findings](#findings) for what has been measured so far, and
[WORKFLOW.md](WORKFLOW.md) for machine setup, the automated run loop, and gotchas.

## Layout

| Path | What |
| --- | --- |
| `server/main.ts` | Deno probe server: serves media, logs requests, ranges, and per-chunk pull timing as JSONL |
| `server/gen_media.ts` | ffmpeg test media: frame number as text plus a 16-bit binary strip, and the tiny source frame |
| `server/virtual_mp4.ts` | In-memory MP4 header and repeated 128-byte intra sample; synthesizes byte ranges |
| `server/virtual_mp4_test.ts` | Tests for virtual MP4s, HTTP ranges and pacing, and analyzer grading (`deno task test`) |
| `server/run_probe.ts` | Orchestrator: headless export, server, VRChat launch, log collection (`deno task probe`) |
| `server/analyze.ts` | Merged client/server timeline, seek grading, per-rate and aggregate throughput (`deno task analyze`) |
| `server/delay_proxy.ts` | Userspace TCP proxy that emulates WAN RTT, handshake included (`deno task delay`) |
| `unity/ModemProbe.cs` | UdonSharp probe: automatic load, seek and pause patterns, position sampling |
| `unity/Editor/ProbeSceneBuilder.cs` | Generates the probe scene, headless or from the editor menu |
| `unity/Editor/WorldExport.cs` | Headless local-test world export through the SDK's `VRCWorldBuilder` |
| `WORKFLOW.md` | Setup, run loop, editing, and gotchas |
| `media/`, `logs/` | Generated; not tracked |

## Server

```sh
cd server
deno task gen                 # probe MP4s, HLS, and media/frame-64.mp4
deno task serve               # 127.0.0.1:8787; HOST/PORT env to change
```

`GET /` lists URLs. Media URLs are `/s/<session>/<file>[?kbps=N]`. Each run
writes `logs/<start time>.jsonl` with `req`, `res`, `pull` (offset and size of
every 16 KiB chunk sent), and `done`/`abort` events, timestamped in epoch ms.

Virtual MP4 URLs are `/v/<session>/<name>.mp4?fps=60&seconds=3600&lead=30&pace=1`.
Any name ending in `.mp4` uses the same gray source frame; no full file is
created. Defaults are 60 fps, one hour (216,000 frames, about 17.7 bits per
seek), 30 frames of immediate lead, then real-time pacing. `pace=0` disables
pacing and relies on TCP backpressure. The header is always sent immediately;
the lead starts at the requested media offset. `fps` must be an integer from
1 to 240, and `fps × seconds` an integer from 1 to 4,294,967,295. `lead` is a
nonnegative integer and `pace` a finite nonnegative number.

HEAD and single byte ranges are supported. Virtual `res` log events include
`session`, `frame` (null inside the header), `fps`, `frames`, `lead`, and `pace`.
Each frame is an identical AVC intra sample with valid filler to reach 128 B
(7.5 KiB/s at 60 fps). There is no audio track. ffmpeg decoding and duration
are tested, and both players accept the file under WMF (run 08-54).

`deno task test` checks the generated MP4 with ffprobe/ffmpeg and tests HTTP
ranges, pacing, and cancellation. It requires those tools on PATH.

## Unity world

Project: `~/ALCOM/Projects/vrcmodem` (Worlds SDK 3.10.5, which bundles
UdonSharp and ClientSim). This repo's `unity/` is symlinked into it as
`Assets/vrmodem`, so scripts and their `.meta` files live here.

The scene is generated, with no UI. There's a VRCWorld, a floor, and two bare
unsynced players: AVPro, and Unity rendering into `ProbeVideo.renderTexture`.
With `VRMODEM_LANES=N` there are instead N AVPro players, `Probe AVPro0`…,
as parallel uplink lanes. Each has a `ModemProbe` that runs automatically:
load (staggered for the URL rate limit), play, sampling, seek pattern, pause
pattern, stop. The URL is baked at build time. The default virtual URL
substitutes `{session}` with the player's session (`avpro`, `unity`,
`avpro0`…); explicit `/s/` and `/v/` URLs also get per-player sessions.
Looping is disabled.

Virtual seeks pick random frames N and aim at `(N − 0.5) / fps`, computed in
double, because WMF requests `ceil(t × fps)`. The schedule is
`seeksPerInterval` seeks at each of `seekIntervals`: seconds between seeks,
0 for one per Udon frame, or −k for k seeks within each Udon frame.
`VRMODEM_INTERVALS` (comma-separated) and `VRMODEM_SEEKS` override it.
`VRMODEM_MATRIX` (whitespace-separated URLs) switches the probes to matrix
mode instead: load each URL in turn, 12 s apart, and log ready or failed.

```sh
VRMODEM_URL='http://127.0.0.1:8787/v/{session}/probe.mp4?fps=60&seconds=3600&lead=30&pace=1' \
  ~/Unity/Hub/Editor/2022.3.22f1/Editor/Unity -batchmode -quit -nographics \
  -buildTarget Win64 -projectPath ~/ALCOM/Projects/vrcmodem \
  -executeMethod ProbeSceneBuilder.Build -logFile logs/unity-build.log
```

The batch run can't use the project while it's open in the editor. Use the
**vrmodem → Build Probe Scene** menu there instead. Normal testing goes through
`deno task probe` (below), which is the scripted equivalent of Build & Test.
Local `127.0.0.1` URLs played without changing "Allow Untrusted URLs".

Linux editor prerequisites: `libxml2-legacy` (pacman) and the Windows Build
Support (Mono) Hub module.

## Automated run

```sh
cd server
deno task probe            # export world, start server, launch VRChat (desktop), collect logs
deno task analyze ../logs/run-<time>    # merged timeline -> timeline.txt
```

Options: `--lanes N`, `--intervals 0.1,0,-2`, `--seeks N`, `--matrix "URL …"`,
`--rtt MS` (routes the baked URLs through `delay_proxy.ts` on port 8788),
`--url`, `--timeout`, `--no-build`, `--vr`.

`probe` exports headless, then launches VRChat with
`steam -applaunch 438100 --url=create?...&url=file:///Z:<vrcw> --watch-worlds --no-vr`.
It follows the client's `output_log` until each `ModemProbe` reports done, then
saves everything under `logs/run-<time>/`. The analyzer grades virtual seeks
as PASS (a request for the exact frame within 5 s), MISMATCH, or NO REQUEST,
and prints per-player, per-interval match counts, unexplained extra requests,
reorders, latency (mean, p99, max), and the best 1 s and 10 s aggregate
bit rate. Chrome preflights and HEAD requests are excluded from grading. The project
must not be open in the editor at the same time.

## Findings

### Runs 2026-10-14T09-28 and 09-30 (2 AVPro lanes through `delay_proxy`)

- **RTT costs latency, not rate.** At 40 ms and 150 ms emulated RTT, two
  lanes seeking every frame matched 2400/2400 each run, at 60 seeks/s per
  lane, with no extra or reordered requests. Latency from `SetTime` to the
  server is 1.5 × RTT + about 2 ms (62 ms and 227 ms): the handshake plus the
  one-way trip. WMF opens each seek's connection without waiting for earlier
  ones, so at 150 ms about 13 are in flight per lane. Real WAN loss and
  jitter are still untested.

### Runs 2026-10-14T09-10 to 09-24 (uplink rate, depth, and lanes)

- **One seek per Udon frame is lossless.** At 60 fps (desktop), 400 random
  far-apart seeks per player per rate, at 10/s and at every frame, all matched
  on both players, with no extra or reordered requests. AVPro p99 latency is
  4.8 ms at 60/s; Unity is about 19 ms throughout.
- **Within one Udon frame, the last `SetTime` wins.** In bursts of 2, 4, or 8
  seeks per frame, the last seek matched 100% of the time on both players.
  Unity never issued a request for an earlier one. AVPro occasionally leaked
  earlier ones (5–20%, unreliable). The per-player ceiling is the Udon frame
  rate.
- **Lanes scale linearly.** Four AVPro players seeking every frame matched
  12000/12000, each at 60 seeks/s, for 5.3 kbit/s aggregate over 10 s at
  22 bits per seek.
- **WMF accepts at most about 2^22 samples.** A matrix of virtual MP4s loaded
  at 4,194,240 samples at 30, 60, and 240 fps (up to 38.8 h). At 8,388,480
  samples (60 or 240 fps) both players fail with `PlayerError` after WMF
  requests `bytes=<size>-` past the end of the file. That file is
  1,073,726,237 bytes, just under 2^30, so this may be a size limit instead;
  either way it's about where float32 `SetTime` precision runs out too. The
  default is now 60 fps × 69904 s = 4,194,240 frames, 22 bits per seek.

### Runs 2026-10-14T09-01 and 09-05 (virtual MP4, sub-frame phase sweep)

- **Seek quantization is `ceil(t × fps)`.** WMF requests the first sample
  whose start time is at or after the seek time. Seeking at
  `(N + phase) / fps` for phases 0.05–0.95 requested frame N+1 every time,
  on both players (80/80). In the 08-54 run, frame-center seeks were all
  +1 for the same reason.
- **Aiming at `(N − 1 + phase) / fps` is exact.** 80/80 PASS at every phase
  from 0.05 to 0.95, so at least 90% of each frame interval decodes
  correctly; float32 `SetTime` jitter isn't a concern at 60 fps × 1 h. Each
  seek therefore carries log2(216000) ≈ 17.7 bits.
- **Latency** from the Udon `SetTime` log line to the server request: AVPro
  2.3 ms mean (3.0 max), Unity 18.9 ms mean (21.5 max).
- **Pauses are invisible at `pace=1`.** A paced 7.5 KiB/s stream never fills
  the roughly 4.5 MiB read-ahead, so the client keeps pulling while paused,
  and pause/play opens no new connection. The pause channel needs a stream
  whose bitrate fills the buffer within about a second.

### Run 2026-10-14T08-54 (virtual MP4, 60 fps × 1 h, `lead=30&pace=1`)

- Both players loaded the virtual MP4, reported a 3600 s duration, and finished
  the seek and pause phases without video errors. Not yet graded with
  `deno task analyze`.

### Run 2026-10-14T08-30 (proton-rtsp-11.0, desktop, intra MP4 over 127.0.0.1)

- **Local URLs work.** `http://127.0.0.1` played in both players in a local
  test world, with no Untrusted URLs change.
- **Both players use Windows Media Foundation under Proton.** The user agent
  is `NSPlayer/12.00.19041.4894 WMFSDK/12.00.19041.4894` for AVPro and for the
  Unity player. A request with a Chrome user agent precedes each load (VRChat's
  URL check) and is aborted after a few hundred KiB.
- **Every seek is visible to the server.** `SetTime` opens a new TCP
  connection with `Range: bytes=<offset>` 2–20 ms after the Udon call, then
  aborts the previous connection. This happens even when the target is already
  buffered.
- **The offset is deterministic.** It is exactly the target frame's sample
  offset, and identical across both players (seek 10 s → `807590`). With an
  all-intra file, each seek therefore carries log2(frames) bits; this file has
  3600 frames, about 11.8 bits. A 1 Hz seek rate was clean; higher rates are
  untested.
- **Read-ahead is capped at about 4.5 MiB, then TCP backpressure.** Every
  connection pulled roughly 4.6–4.8 MB at once, then stalled. For this file
  (about 79 KB/s) that is about 58 s ahead, so pause and rate modulation can't
  be seen yet. The pause channel needs a high-bitrate stream (filler data) or
  server pacing (`?kbps=`) so the buffer drains in about a second.
- Both players looped at the end (`event loop`): `loop` defaults to on for
  components added from code.

## Probe protocol

For each backend (AVPro, Unity) × media (intra MP4, 1 s GOP MP4, HLS):

1. Load, play, and let it settle. Record initial requests and how far the
   player buffers ahead (pull timing without `kbps`).
2. Run the seek pattern. For each seek, record whether a new request appears,
   its offset or segment, latency from Udon log to server log, and whether the
   target is reached (sampling).
3. Repeat with `?kbps=` near the media bitrate, then run the pause pattern.
   Check whether the pull timing visibly follows the pause/play schedule, and
   how long it lags.
4. Repeat with seek intervals of 0.5 s and 0.2 s to find the rate limit.

Correlate the `[ModemProbe]` lines in VRChat's `output_log` (UTC) with the
server's JSONL. `deno task analyze` does this automatically.

Answered so far: localhost works in a local test world. Under Proton both
players use Media Foundation (`NSPlayer`/`WMFSDK`). Seeks inside the buffered
range still produce a new request, for sample `ceil(t × fps)`, exactly. One
seek per Udon frame per player is lossless, and players add up linearly.

Still open:

- Behavior on Windows, for comparison with Proton.
- Whether LAN or public hosts behave the same as localhost.
- Whether playback rate is exposed to Udon (assumed no).
