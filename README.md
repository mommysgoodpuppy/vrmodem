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

Nothing below is verified in VRChat yet. The current phase is the probe.

## Layout

| Path | What |
| --- | --- |
| `server/main.ts` | Deno probe server: serves media, logs requests, ranges, and per-chunk pull timing as JSONL |
| `server/gen_media.ts` | ffmpeg test media: frame number as text plus a 16-bit binary strip |
| `unity/ModemProbe.cs` | UdonSharp probe driver: load, play/pause, seek and pause patterns, position sampling |
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

## Unity scene (world project, Unity 2022.3.22f1)

1. Create a **Worlds** project in ALCOM. UdonSharp ships with the worlds SDK.
2. Copy `unity/ModemProbe.cs` into `Assets/` and create its UdonSharp program asset.
3. Add a `VRCAVProVideoPlayer` with a `VRCAVProVideoScreen` on a quad. Also add a
   second object with `VRCUnityVideoPlayer` to compare the two backends.
4. Add a world-space Canvas with a `VRCUrlInputField` and buttons calling
   `LoadFromInput`, `Play`, `Pause`, `SeekBack`, `SeekForward`,
   `StartSeekPattern`, `StartPausePattern`, `StopPatterns`, `ToggleSampling`.
5. Test with **Build & Test** only. Turn on "Allow Untrusted URLs" in the client.

Exact component and prefab names should be checked against the installed SDK.

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
