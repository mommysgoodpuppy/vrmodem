# The modem: IP between a world and the internet

The world's machine (ShaderEmu's `lan0`, docs/lan.md there) sends and
receives bare IPv4 packets of 20 to 576 bytes. The modem carries them to a
gateway server and back with nothing but video players:

- **Up:** a few *lane* players seek; each seek's HTTP `Range` request names a
  frame, and the frame number is a 22-bit symbol.
- **Down:** one player plays a live video whose frames are bytes (gray
  blocks, `Downlink.shader`).

The gateway (`server/gateway.ts`) gives each client its own
[passt](https://passt.top), a userspace NAT that needs no root. passt also
forwards ports in: `--forward SESSION:tcp:2222:22` makes the host's port 2222
the machine's port 22.

The reference implementation is `server/modem/` (`link.ts`, `client.ts`,
`session.ts`). `unity/Modem.cs` must match its client half bit for bit.

## URLs

Each machine has one session name, baked into the world (VRCUrls can't be
built at run time):

| URL | Player |
| --- | --- |
| `/m/<session>/u<k>.mp4` | uplink lane k, 0 to lanes − 1 (8 by default) |
| `/m/<session>/down.mp4?w=1280&h=720&block=8&qp=36` | the downlink |

## Uplink

A lane's video is 60 fps and 4,194,240 frames long. Frame N is reached by
`SetTime((N - 0.5) / 60)`; the gateway takes the first frame of each request.

- Loading the lane (a request from byte 0) restarts the lane's sequence.
  Frame 0 is never a symbol.
- Symbol = `seq × 32768 + chunk`, frame = symbol + 1. `seq` counts the lane's
  chunks mod 126; `chunk` is 15 bits of data.
- A lane sends at most one seek per Udon frame. Only the last `SetTime` of a
  frame counts.
- Lanes keep order but lose seeks in hitches. Each lane is a selective-repeat
  link with a window of 63 chunks:
  - The gateway acks every lane in every downlink frame.
  - The client resends a chunk when a chunk it sent later has arrived.
  - With no progress for 2 s, it resends the oldest.

A lane's chunks are a stream of link frames. Each frame starts on a chunk
boundary: a 16-bit header (`type << 12 | length`), then `length` bytes, MSB
first, then zero bits to the end of the chunk.

| Type | Payload |
| --- | --- |
| 1 IP | an IPv4 packet, 20 to 576 bytes |
| 2 DACK | u24 LE: every downlink packet numbered before this arrived |
| 3 HELLO | u32 LE nonce (random per run), u32 LE address (10.0.H.L as 0x0a00HHLL) |

The client sends HELLO on every lane when it starts. A new nonce restarts the
gateway's downlink state and passt. A packet goes whole on the least loaded
lane.

## Downlink

A frame's blocks are bytes: four blocks a byte, MSB first, rows from the top
left; at 1280×720 with 8 px blocks, 3,520 bytes a frame.

| Bytes | |
| --- | --- |
| 0 | `0x4d` |
| 1 | lanes L |
| 2–5 | nonce (u32 LE): the HELLO the gateway acts on; 0 before one |
| 6–9 | low (u24 LE, then 0): packets before it are gone, acked or dropped |
| 10 + 9k | lane k: the next seq the gateway expects (u8), then a u64 LE bitmap whose bit i means seq + 1 + i arrived |
| then | packets: number (u24 LE), length (u16 LE), the packet; length 0 ends them |

- The client ignores a frame whose nonce isn't its own.
- It hands on each packet number it hasn't seen.
- It acks the lowest number it hasn't seen (DACK) at most every 100 ms.
- The gateway puts a packet in two frames running, then again every 1.5 s
  until acked. It keeps 256 and drops the oldest.

## Measured

`deno task test` simulates both halves with 8 lanes:
- A clean link carries 842 B/s of packets of the raw 900 B/s.
- With 1% of seeks lost singly, 0.5% hitches and 10% of downlink frames lost,
  it carries 723 B/s.
- Every packet arrives exactly once and intact under loss.

`deno task gateway` plus `deno task sim` runs the real thing over HTTP, with
ffmpeg decoding the downlink as the shader does. On loopback, a ping to
1.1.1.1 takes 430–450 ms (28 ms direct), and a DNS query through the gateway's
address resolves in 630 ms.
