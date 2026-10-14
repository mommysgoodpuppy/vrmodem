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

Status: the seek leak works, with exact 22-bit symbols and parallel lanes.
Pause modulation is a dead end. The downlink has test videos and a GPU-tested
decode shader; live in-world readback is still to be wired. See
[Findings](#findings) for what has been measured so far, and
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
| `server/downlink.ts` | Downlink test frame layout: header, calibration, gray blocks, reference decoder |
| `server/gen_downlink.ts` | Downlink test videos and an offline ffmpeg check (`deno task gen-down [--check]`) |
| `unity/Downlink.shader`, `unity/Downlink.cginc` | Downlink decoder and reusable HLSL; output format and ShaderEmu use in [DOWNLINK.md](DOWNLINK.md) |
| `server/check_downlink_shader.ts` | GPU verification against the TypeScript reference (`deno task check-down-shader`) |
| `server/delay_proxy.ts` | Userspace TCP proxy that emulates WAN RTT, handshake cancellation included (`deno task delay`); with `--rtt 0`, a plain relay |
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
This client has "Allow Untrusted URLs" enabled, and every run so far depends
on it: VRChat treats `127.0.0.1` and LAN IPs as untrusted (see Findings).

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

Current state as of 2026-10-14. Desktop VRChat under `proton-rtsp-11.0`,
60 fps, "Allow untrusted URLs" on. Run directories are under `logs/`.

### Uplink: seeks as an address bus

| Result | Value |
| --- | --- |
| Bits per seek | 22 (2^22 virtual frames at 60 fps × 69904 s) |
| Per lane, loopback/LAN | 60 seeks/s (one per Udon frame), ≈1.3 kbit/s, lossless |
| 4 lanes, loopback | 12000/12000 matched, 5.3 kbit/s |
| 8 lanes, loopback, 5 min | 143823/144000 (99.88%), 9.1 kbit/s sustained, ≈51 seeks/s per lane |
| Per lane, real internet | ≈1 / TCP connect time to the first hop (≈10/s at 50 ms) |
| Latency, `SetTime` → server | AVPro ≈2–3 ms, Unity ≈19 ms (loopback); +1.5 RTT over a network |

- **Every seek is a new request.** Both players use Windows Media Foundation
  (`NSPlayer/12.00.19041.4894 WMFSDK/…`). `SetTime` opens a new TCP
  connection with `Range: bytes=<offset>`, then aborts the previous one. This
  happens even when the target is already buffered.
- **The offset names the frame exactly.** WMF requests the first sample that
  starts at or after the seek time, `ceil(t × fps)`. Aiming frame N at
  `(N − 0.5) / fps` matched every seek at sub-frame phases 0.05–0.95, so
  float32 jitter isn't a concern. The server decodes `N = (offset − header) / 128`.
- **The last `SetTime` in an Udon frame wins.** In bursts of 2–8 per frame,
  the last seek always got through. Unity never sent the earlier ones, and
  AVPro leaked some unreliably. So the per-lane ceiling is the Udon frame rate.
- **Lanes are independent.** Four AVPro players at one seek per frame each
  kept their full rate, with no shared limit. Eight held for 5 minutes. The
  client's frame rate fell to about 51 fps, which sets the per-lane rate. The
  0.12% of seeks that failed came in bursts across lanes in the same second
  (client hitches): WMF merged a seek with the next one, so they're erasures,
  never wrong symbols. `TIME_WAIT` on the server port leveled off at about
  11k sockets. AVPro is the better sender:
  about 8× lower latency than Unity.
- **Over a real path, the TCP handshake sets the rate.** A seek that comes
  before the previous seek's connection is established cancels it unsent.
  Through a relay on a phone on mobile data (about 50 ms to connect): 98.6%
  at 10/s, 32% at 20/s, and only each lane's last seek at one per frame.
  Nothing arrived late or reordered. `delay_proxy.ts` now models this, and
  `--rtt 50` reproduces the pattern locally. Per-lane rate ≈
  1 / (client → first TCP endpoint RTT), so the levers are more lanes and a
  nearby TCP endpoint, not frame rate.

### Media limits

- **The virtual MP4 works in both players**: 64×64 repeated IDR frames, 128 B
  each, no audio, served from memory with byte ranges.
- **WMF accepts at most about 2^22 samples.** 4,194,240 samples loaded at 30,
  60, and 240 fps (up to 38.8 h). 8,388,480 samples fail with `PlayerError`
  after WMF reads past the end of the file. That file is just under 1 GiB, so
  the limit may be on size instead. Either way, float32 `SetTime` precision
  runs out around there too.
- **Read-ahead is about 4.5 MiB, then TCP backpressure.** The server paces
  virtual media (`lead=30&pace=1`: 30 frames at once, then real time) so each
  seek costs about 4 KB.

### URLs and hosting

- **Every run so far relied on "Allow untrusted URLs".** VRChat logs
  `You are playing an untrusted URL (Domain: …) in a local world` for
  `127.0.0.1` and LAN IPs alike, and points to "the world's Video Player
  Allowed Domains list on the website". According to VRChat's
  [allowlist docs](https://creators.vrchat.com/worlds/udon/video-players/www-whitelist/),
  that list doesn't remove the viewer setting. In Public and Group Public
  instances an untrusted domain needs both the world's list and the viewer's
  "Allow untrusted URLs". In other instances the viewer setting alone is
  enough. Playback with no settings changes would require one of VRChat's
  globally trusted hosts.
- **Each load is preceded by a Chrome-UA request** (VRChat's URL check), which
  is aborted after a few KiB. The analyzer ignores it.
- **The LAN IP behaves like loopback.** The public IP can't be reached from
  this machine because the router has no NAT loopback. Real-internet tests go
  through a relay on another host instead (see below).
- **Don't use SSH port forwarding as a relay.** It ends TCP locally and
  multiplexes every connection over one stream, so seeks arrived up to 3.6 s
  late, reordered, and lost in bursts.

### Downlink (offline only so far)

`deno task gen-down --check` encodes 1280×720, 60 fps test videos with x264
(keyframe every second, CBR) and decodes them again with ffmpeg. Each frame
carries data in gray blocks: a 16 px header with a sync pair, calibration
levels, and a 24-bit frame number (`server/downlink.ts`).

| Blocks, levels | Raw rate | 8 Mbit/s | 20 Mbit/s |
| --- | --- | --- | --- |
| 16 px, 2 or 4 | 0.21 / 0.42 Mbit/s | 0 errors | 0 errors |
| 8 px, 2 | 0.84 Mbit/s | 0 errors | 0 errors |
| 8 px, 4 | 1.69 Mbit/s | 0 errors | 0 errors |
| 4 px, 2 | 3.38 Mbit/s | 7.3% | 0 errors |
| 4 px, 4 | 6.76 Mbit/s | 41% | 0.0007% |

This is luma only, decoded by ffmpeg. The in-world path (WMF, Unity's color
conversion, a linear-space project) and live-stream latency are untested.

### Dead ends

- **Pause and rate modulation.** With paced media the buffer never fills, so
  pausing changes nothing the server can see, and pause/play opens no
  connection. Seeks make this channel unnecessary.
- **Several seeks per Udon frame.** Only the last one counts (see above).

### Run log

| Run | What | Result |
| --- | --- | --- |
| 08-30 | Real intra MP4, both players | WMF user agent; every seek is a deterministic `Range` request |
| 08-54 | First virtual MP4 | Loads in both; frame-center seeks all land on N+1 |
| 09-01, 09-05 | Sub-frame phase sweep | `ceil(t × fps)`; aiming at N − 0.5 matched 80/80 |
| 09-10 | Rate sweep 1/s → per frame | 240/240 including 60/s |
| 09-13, 09-16 | 240 fps × 34952 s; load matrix | `PlayerError` above about 2^22 samples |
| 09-20 | 400 seeks per rate, bursts | Per frame lossless; last `SetTime` per frame wins |
| 09-24 | 4 AVPro lanes | 12000/12000, 5.3 kbit/s |
| 09-28, 09-30 | Old `delay_proxy`, 40/150 ms | Lossless, but too optimistic (no handshake modelled) |
| 09-35 | LAN IP on 0.0.0.0:8080 | Same as loopback; revealed the untrusted-URL dependency |
| 09-48, 09-52 | `ssh -L` through phone | Late, reordered, bursty: SSH artifacts |
| 09-56 | Plain relay on phone, mobile data | Handshake-limited: 98.6% / 32% / last-only |
| 10-00 | Handshake-aware proxy, 50 ms | Reproduces 09-56 locally |
| 10-49 | 8 AVPro lanes, 5 min, per frame | 99.88%, 9.1 kbit/s; losses are clustered hitches |

## Open questions

- Where lanes stop paying: 8 cost about 15% of the frame rate (16 untested).
- Whether a nearby HTTP edge (CDN or relay) forwards `Range` requests
  uncached, restoring about 60 seeks/s per lane over the internet.
- Whether any globally trusted host can serve custom byte ranges (the only
  path that needs no viewer setting).
- Behavior on native Windows, and at VR frame rates (90/120 Hz).
- Downlink in the world: the same test videos decoded from the video player's
  RenderTexture, and a live, low-latency transport (RTSP, HLS, or fragmented MP4).
- Whether playback rate is exposed to Udon (assumed no).
