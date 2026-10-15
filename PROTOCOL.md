# How the modem packs data

The companion to [MODEM.md](MODEM.md), for the question "but *how* is the data
in the seek?". Reference code: `server/modem/link.ts` (shared state machines)
and `unity/Modem.cs` (the world half, which must match bit for bit).

## The short answer

It is **index-based, and the data lives inside the index**. No packet fragment
is smuggled into the mantissa of the timestamp float, and there is no
handshake table of pre-agreed meanings. A seek names a virtual MP4 frame
number; the frame number is a 22-bit symbol; the symbol is

```
symbol = seq × 2^15 + chunk        frame = symbol + 1
```

- `chunk` — the low 15 bits — **carries payload data directly**. The whole
  uplink is a stream of these 15-bit words.
- `seq` — the high 7 bits, mod 126 — carries **ordering**, so the gateway can
  tell a fresh chunk from a resent one.

The client seeks the lane player to frame `symbol + 1`, i.e.
`SetTime((symbol + 0.5) / 60)`. Windows Media Foundation turns that into
`Range: bytes=<header + (symbol + 1) × 128>` on a fresh TCP connection, and
the gateway divides the offset back out to get the symbol. Nothing about the
float encodes anything: it is just the inverse of `ceil(t × fps)`.

`seq × 2^15` fits the video exactly: 126 × 32,768 = 4,128,768 frames, inside
WMF's ~2^22-sample limit (4,194,240 = 69904 s at 60 fps, per MODEM.md). `seq`
wraps mod 126, which is why the link needs an ARQ (below) rather than bare
sequence numbers.

## Why the seek names a frame at all

`SetTime` takes seconds; WMF picks the first sample starting at or after
`ceil(t × fps)`. Aiming frame N at its middle, `(N − 0.5) / 60`, computed in
double before the float32 conversion, matched every seek at sub-frame phases
0.05–0.95 (README_old.md, Findings) — so the mapping time → frame → byte offset is
exact, not approximate. Float32 jitter is irrelevant because the target is
never near a frame boundary.

Per seek the client pays one TCP connection (WMF aborts the previous one), so
the practical rate is one seek per Udon frame per lane, limited over a real
network by the handshake (~1/RTT to the first hop). That economics is why the
symbol is packed to 22 bits: every bit costs the same seek.

## From bytes to seeks, end to end (uplink)

1. **Link frame.** Each packet becomes a link frame on a chunk boundary:
   a 16-bit header `type << 12 | length` (`type` 1 IP, 2 DACK, 3 HELLO,
   4 FRAG), then `length` payload bytes, MSB first.

   Example: a 20-byte IPv4 packet → `10 14 <20 bytes>` (2 + 20 = 22 bytes,
   176 bits).

2. **Chunks.** The frame's bits are re-grouped into 15-bit words, MSB first;
   the last word is zero-padded to the chunk boundary. 176 bits → 12 chunks
   (11 full + one carrying the final 11 bits). That padding is what lets the
   gateway's `Deframer` resync at every link frame: it never carries bit
   offset across frames.

   ```ts
   acc = (acc << 8) | b;  bits += 8;
   if (bits >= 15) emit((acc >> (bits - 15)) & 0x7fff);
   ```

3. **Symbol.** When the lane has a chunk to send, `Modem.Poll` pairs it with
   the lane's absolute chunk counter: `symbol = (abs % 126) × 32768 + chunk`,
   then `ModemLane.Seek(symbol + 1)` → `SetTime((symbol + 0.5) / 60)`.

4. **HTTP.** WMF opens `Range: bytes=<offset>`, `offset = header + (symbol +
   1) × 128` (one 128-byte sample per frame in the virtual MP4). The gateway
   computes `frame = (offset − header) / 128`, `symbol = frame − 1`,
   `seq = symbol >> 15`, `chunk = symbol & 0x7fff`.

5. **Deframing.** Chunks arrive in lane order (WMF never reorders; lost seeks
   are erasures, not corruptions — see below). The gateway concatenates
   chunks MSB first, splits off bytes, reads the 16-bit header, consumes
   `length` bytes, and drops the zero padding to the next chunk boundary.

So a single 20-byte IP packet rides up in 12 seeks ≈ 200 ms at 60 seeks/s;
larger payloads stream continuously (22 bits per seek, 60 seeks/s per lane,
≈1.3 kbit/s raw, ×8 lanes).

## Are packet fragments "in the timestamp float"?

No — the float is only a transport encoding of an integer, the inverse of
`ceil(t × fps)`. Fragments *are* encoded directly into the seek, just as bits
of the frame index: a FRAG link frame (`u8 packet id`, `u8 index << 4 |
(count - 1)`, the part's bytes) is chunked and sent exactly like an IP frame.
`parts()` splits a packet over `n = clamp(ceil(len/16), 1, min(ready lanes,
16))` lanes at `floor(i×len/n)` boundaries so one ping (33 chunks) no longer
takes 0.55 s on one lane; the gateway waits for every part because lanes are
independent reliable links, then reassembles by id and index.

## Not a handshake

The 22 bits are self-describing each time; nothing is agreed per-session
except the URL. Two state machines keep it a *channel* rather than a lookup:

- **Client → gateway:** each lane is selective-repeat ARQ with a 63-chunk
  window. The gateway acks every lane in every downlink frame (`expected`
  u8 + u64 bitmap); the client resends a chunk when a later chunk arrived
  (that hole is lost — a seek can be eaten by a hitch or a cancelled TCP
  connect, never delivered wrong), and resends the oldest after 2 s of no
  progress. `seq` (mod 126) exists so both sides can tell resend from new
  within one window.
- **Gateway → client:** the downlink video *is* the reliable channel. Every
  frame restates the header (nonce, per-lane acks, `low` water mark) and
  repeats unacked packets every 1.5 s until the client's DACK (uplink type 2)
  says they arrived; the client drops frames whose nonce isn't its HELLO's.
  The u32 nonce, sent on every lane at startup, is the only handshake: it
  resets the gateway's state and its passt instance.

## Downlink packing (for contrast)

The downlink doesn't use frame numbers as data; the **pixels** are the data.
`Downlink.shader` decodes gray blocks: four blocks per byte, MSB first, rows
from the top left — 3,520 bytes per 720p frame at 8 px blocks — laid out per
MODEM.md's table (`0x4d`, lane count, nonce, `low`, per-lane acks, packets).
`unity/ModemPack.shader` reads the decoded texels back as bytes. Reliability
comes from repetition (two frames running, then every 1.5 s), not from an
ARQ over the video: video frames are numbered in-band (frame index is in the
test format; the modem's byte stream is what the numbers carry).

## Precision limits

| Limit | Value | Why |
| --- | --- | --- |
| Samples per video | ~2^22 = 4,194,240 | WMF fails loading 8,388,480 |
| Symbol space | 126 × 2^15 = 4,128,768 | fits under that with headroom |
| `SetTime` precision | sub-frame exact at (N − 0.5)/fps | measured, phases 0.05–0.95 |
| Chunk size | 15 bits | what's left of 22 after a 7-bit seq |
| Per-seek cost | 1 TCP connect | WMF reopens per seek |
