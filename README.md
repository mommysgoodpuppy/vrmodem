# vrmodem

An internet connection for a VRChat world, made out of nothing but video players.

VRChat worlds can't open network connections. They can play videos from a URL, though, and
seek in them. vrmodem turns that into a two-way link: the world sends data by seeking video
players, a server outside VRChat reads the seeks, and that server sends data back as a live
video whose frames are bytes. On top of that link runs plain IP, so a computer emulated
inside the world ([ShaderEmu](https://github.com/MichaelMoroz/ShaderEmu)'s Linux machine,
running in a pixel shader) can ping, resolve names, browse websites and take SSH logins.

It's an experiment, and it works: a Linux machine in a VRChat world has been online through
it, pinging 1.1.1.1, fetching web pages, and taking SSH and telnet logins.

## 1. The link: how the world gets online

**Up (world to server).** VRChat lets a world seek a video freely, but not make up new URLs
on the fly. Every seek makes the player send a new HTTP request whose byte range points at a
frame, so the server can see which frame was asked for. The videos are 4,194,240 frames long
(22 bits), and the frame number *is* the data: 7 bits of sequence number and 15 bits of
payload. Eight players ("lanes") seek in parallel, each about 60 times a second. Lost seeks
are resent, and a packet is split across the least busy lanes.

**Down (server to world).** One player plays a live video that the server generates as it
goes: 1280×720 at 60 frames a second, each frame carrying 3,520 bytes as gray blocks. A
shader decodes the blocks, and the world reads the bytes back. The server repeats what isn't
acknowledged.

**The gateway** (`server/gateway.ts`, run with `deno task gateway`) is the server half. It
gives each machine its own [passt](https://passt.top), a small userspace NAT that needs no
root, so the machine's packets go out to the real internet as if from a normal program. It
also forwards ports in (that's how SSH into the world's machine works), hands the machine
random bytes for its encryption keys, and runs an HTTPS proxy for it.

How fast it is, measured with the gateway on the same computer:

| | |
| --- | --- |
| Upload | about 790 bytes a second with all 8 lanes busy |
| Download | 3,520 bytes a frame, about 210 KB a second: more than the machine can take in |
| Ping to 1.1.1.1 | about 0.8 s (half of it is the video player's own buffering) |
| A command over SSH | 0.9 to 1.4 s; a login takes 25 to 32 s of the emulated CPU's time |

Where to read more:
- [MODEM.md](MODEM.md): the modem protocol, the gateway, measurements.
- [PROTOCOL.md](PROTOCOL.md): exactly how bytes are packed into seeks and frames.
- [DOWNLINK.md](DOWNLINK.md): the downlink video format and its decoder.
- [README_old.md](README_old.md): the original research log, with every probe and finding
  (what seeks do, player limits, rates over a real network, what didn't work).
- [WORKFLOW.md](WORKFLOW.md): machine setup and the automated test loop.

## 2. In the world: what works, what's untested, caveats

The world side lives in ShaderEmu's VRChat world, in
[a fork of ShaderEmu](https://github.com/mommysgoodpuppy/ShaderEmu) (branch `modem`; its
`docs/modem.md` is the world's half of this README). There the machine on the wall has a modem, a chart recorder of the seeks,
a speed meter, and a sound you can switch on to hear the data.

**Works (tested by one player, gateway on the same PC):**
- The machine boots, connects, pings, resolves names, and fetches pages over HTTP and HTTPS.
- The in-world web browser loads any site through the modem.
- SSH and telnet into the machine through a port forward on the gateway.
- Built and published as a real (non-local) world, joined, and brought online
  (15 October 2026).

**Built but not tested yet:**
- **Friends using the owner's internet.** Only the instance owner's modem runs. Everyone
  else's machine is meant to reach the internet through the owner's machine: their packets
  travel over the world's existing LAN to the owner's machine, whose Linux forwards and
  NATs them out through the modem. It works when one client feeds the owner's machine
  packets from a made-up friend, but **it hasn't been tried with a second real player
  yet**. That's the next test: a friend joins, turns on their PC, and loads a site.
- **A gateway on a real network.** Every run so far had the gateway on the same computer as
  VRChat. Over a real network each seek is a new TCP connection, so each lane gets roughly
  one seek per round trip (about 10 a second at 50 ms, from the research runs). That's much
  slower than loopback.

**How it's run today, and the caveats:**
- **The instance owner runs the gateway on their own PC** (`deno task gateway`, port 8788),
  and the world's video URLs point at `127.0.0.1`. Nobody else needs to install anything.
  Someone (you, or anyone) could host the gateway on a VPS instead, so the owner doesn't have
  to run anything locally. That isn't built: the world would need the VPS's address baked
  in, and the gateway would need some access control, since anyone with the URLs could use it
  as a proxy.
- **The owner needs "Allow untrusted URLs"** on in VRChat. Friends need no settings.
- **The instance needs an owner:** Invite+ or Friends+. Group and public instances have no
  owner, so nobody's modem starts.
- **Start the gateway before joining.** A lane that can't load gives up after five tries,
  and only a rejoin restarts it.
- **HTTPS is a shortcut.** The machine's own TLS fails, so it asks the gateway's proxy in
  plain HTTP, and the encryption ends on the gateway's computer. Whoever runs the gateway can
  see that traffic, and since they also hand the machine its random bytes, they could
  predict its SSH host keys.
- **It's slow and shared:** about 800 bytes a second up, shared by everyone in the instance.
- **PC only.** Quest hasn't been tried. It would need HTTPS URLs and a different player for
  the downlink.

## 3. Linux

All of this was built and tested on Linux, with VRChat running under Proton. That took some
work of its own.

- **Building the world on Linux needs fxc2.** VRChat runs worlds on Direct3D 11, and Unity's
  normal shader compiler (Microsoft's FXC) can't build ShaderEmu's CPU shader: it takes longer
  than Unity's 10-minute limit, and it rejects part of the shader anyway.
  [fxc2](https://github.com/MichaelMoroz/FXC2) is a replacement compiler that builds it in
  about 11 seconds. **[My fork of FXC2](https://github.com/mommysgoodpuppy/FXC2)**
  (branch `linux-unity-loader`) adds support for loading it into the native Linux Unity
  editor.
- **But the fxc2 editor can't be opened with a window:** on Linux the editor draws with
  OpenGL, and the OpenGL shaders it makes from fxc2's output are broken. Because Unity's
  shader cache doesn't record which compiler made an entry, they then broke the normal editor
  too. The working recipe: export headless with the fxc2 editor, then Build and Publish from
  the normal editor, which reuses fxc2's shaders from the cache. Step by step in ShaderEmu's
  `docs/linux-build.md`, with the build script and a watchdog in `unity/linux-build/`.
- **An unlit room for builds made on Linux.** Baking the room's lighting runs on the CPU on
  Linux and took two hours, so there's a build switch (`SHADEREMU_LIGHTING=unlit`) that draws
  the room without baked light. Without it (and without a bake) the room uploads black.
- **Running the world under Proton.** One instruction the CPU shader used (a one-step
  multiply-high that only fxc2 can emit) turned into invalid code in Proton's Direct3D
  translation, so the shader no longer uses it (ShaderEmu's `docs/linux.md`).
- **Testing from Linux.** `deno task probe` exports a world headless, starts the servers,
  launches VRChat through Steam, and collects the logs ([WORKFLOW.md](WORKFLOW.md)).

## Layout

| Path | What |
| --- | --- |
| `server/gateway.ts` | The gateway: uplink lanes, the live downlink, a passt per machine, port forwards, `/random`, the HTTPS proxy |
| `server/modem/` | The link protocol (`link.ts`), its client and gateway halves, the passt wrapper, simulation tests |
| `server/https_proxy.ts` | HTTPS for the machine, whose own TLS doesn't work (the gateway runs it) |
| `server/shell_check.ts`, `server/ssh_check.ts` | Log in to the world's machine through a port forward and time commands |
| `server/sim_client.ts` | A stand-in world against a running gateway: ping and DNS (`deno task sim`) |
| `server/run_probe.ts`, `server/analyze.ts` | Automated test runs in VRChat, and their analysis |
| `server/main.ts` | The old probe server from the research phase (`deno task serve`, port 8787). Not what the modem uses |
| `unity/` | The research probes and the modem's original world half (`Modem.cs`, `Downlink.shader`) |

```sh
cd server
deno task gateway        # the modem's server, 127.0.0.1:8788
deno task test           # protocol and media tests
```
