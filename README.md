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

See [Findings](#findings) for what has been measured so far.

## Layout

| Path | What |
| --- | --- |
| `server/main.ts` | Deno probe server: serves media, logs requests, ranges, and per-chunk pull timing as JSONL |
| `server/gen_media.ts` | ffmpeg test media: frame number as text plus a 16-bit binary strip |
| `unity/ModemProbe.cs` | UdonSharp probe: automatic load, seek and pause patterns, position sampling |
| `unity/Editor/ProbeSceneBuilder.cs` | Generates the probe scene, headless or from the editor menu |
| `media/`, `logs/` | Generated; not tracked |

## Server

```sh
cd server
deno task gen                 # media/probe-intra.mp4, probe-gop1s.mp4, hls/index.m3u8
deno task serve               # 127.0.0.1:8787; HOST/PORT env to change
```

`GET /` lists URLs. Media URLs are `/s/<session>/<file>[?kbps=N]`. Each run
writes `logs/<start time>.jsonl` with `req`, `res`, `pull` (offset and size of
every 16 KiB chunk sent), and `done`/`abort` events, timestamped in epoch ms.

## Unity world

Project: `~/ALCOM/Projects/vrcmodem` (Worlds SDK 3.10.5, which bundles
UdonSharp and ClientSim). This repo's `unity/` is symlinked into it as
`Assets/vrmodem`, so scripts and their `.meta` files live here.

The scene is generated, with no UI. There's a VRCWorld, a floor, and two bare
unsynced players: AVPro, and Unity rendering into `ProbeVideo.renderTexture`.
Each has a `ModemProbe` that runs automatically: load (staggered 8 s for the
URL rate limit), play, sampling, seek pattern, pause pattern, stop. The URL is
baked at build time.

```sh
VRMODEM_URL=http://127.0.0.1:8787/s/probe/probe-intra.mp4 \
  ~/Unity/Hub/Editor/2022.3.22f1/Editor/Unity -batchmode -quit -nographics \
  -buildTarget Win64 -projectPath ~/ALCOM/Projects/vrcmodem \
  -executeMethod ProbeSceneBuilder.Build -logFile logs/unity-build.log
```

The batch run can't use the project while it's open in the editor. Use the
**vrmodem → Build Probe Scene** menu there instead. Test with **Build & Test**
only, with "Allow Untrusted URLs" turned on in the client.

Linux editor prerequisites: `libxml2-legacy` (pacman) and the Windows Build
Support (Mono) Hub module.

## Automated run

```sh
cd server
deno task probe            # export world, start server, launch VRChat (desktop), collect logs
deno task analyze ../logs/run-<time>    # merged timeline -> timeline.txt
```

`probe` exports headless, then launches VRChat with
`steam -applaunch 438100 --url=create?...&url=file:///Z:<vrcw> --watch-worlds --no-vr`.
It follows the client's `output_log` until each `ModemProbe` reports done, then
saves everything under `logs/run-<time>/`. The project must not be open in the
editor at the same time.

## Findings

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
server's JSONL. Open questions to answer:

- Does localhost or a LAN address work as a video URL, or is a public host required?
- Under Proton, are AVPro's requests made by Wine's Media Foundation / GStreamer?
  What User-Agent and range behavior do they show, compared with Windows?
- Do seeks inside the buffered range produce any request at all?
- Is playback rate exposed to Udon? (Assumed no.)
