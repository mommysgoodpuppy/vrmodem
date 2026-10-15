# Shared internet through the instance owner's shader PC

Implementation plan, 14 October 2026. This is a plan, not an implemented feature.

## Demo target

Ellie creates an Invite+ or Friends+ instance of the ShaderEmu world. Each visitor
has their own local Linux machine and can use the existing lobby LAN. Only the
instance owner's client loads the modem videos. That owner's guest Linux routes
and translates friends' internet traffic; Udon carries the packets between Linux,
the LAN, and the existing video modem.

The external Deno gateway stays on Ellie's real computer, listening on localhost.
Friends reach it through the lobby LAN and Ellie's VRChat client, not by opening
connections to Ellie's computer. Start with the already working PC-client setup.

```text
Friend's guest Linux
  -> friend's LAN packet batch (VRChat synchronization)
  -> owner's guest Linux: IPv4 forwarding and source NAT
  -> owner's video modem
  -> localhost Deno gateway and passt
  -> internet

Reply
  -> passt and video downlink
  -> owner's guest Linux: connection tracking reverses the NAT
  -> owner's LAN packet batch
  -> friend's guest Linux
```

Linux performs forwarding, TTL/checksum updates, connection tracking, and NAT.
Udon selects the transport and delivers packets; it does not implement a second
TCP/IP stack. Ordinary friend-to-friend LAN traffic remains direct.

## What the code currently does

Paths below are relative to `../ShaderEmu` unless prefixed `vrmodem/`.

| Component | Existing behavior | Change needed |
| --- | --- | --- |
| `Scripts/EmuMachine.cs` under `unity/ShaderEmu/` | A local machine receives a player-derived `10.0.H.L/16` address on power-on. `NetWindow` sends outside destinations directly to its attached modem. `NetIn` accepts only its own address and broadcasts. | Restrict modem transmission to the owner/provider. Permit validated transit packets into the provider's Linux. Send non-provider internet packets over the LAN. |
| `Scripts/EmuShareHub.cs` | `MoveNet` sends length-prefixed IP packets in the sender's player object. `TakeNet` knows the sender's player ID but currently calls `NetIn` without that provenance. | Preserve sender identity during reception; deliver outside packets only to the selected provider. |
| `Scripts/EmuShare.cs` | Per-player manually synced state, including `net`, `netSeq`, and power flags. | Advertise the provider's role, readiness, and run generation using the owner's existing player object. |
| `Scripts/EmuModem.cs` and `EmuModemLane.cs` | Every powered visitor currently starts their modem, selecting baked URLs by player ID modulo 32. | Explicit owner-only start/stop, fresh state on a new provider run, and guards on delayed loads/retries. |
| `linux/kernel/shaderemu_net.c` | One bare-IPv4, no-ARP interface `lan0`, MTU 576, backed by a transmit window and receive ring. | Expose routing-role information to the guest and guest configuration status back to Udon. Prove forwarding on this existing interface. |
| `linux/kernel/config.extra` | Enables the custom NIC, but does not request netfilter/NAT. The upstream minimal config reviewed enables INET without requesting netfilter. | Add and verify the resolved conntrack/NAT/filter configuration. Audit the actual tested image rather than assuming its configuration from these inputs. |
| `vrmodem/server/gateway.ts` | Rejects outbound packets whose source differs from the address registered by HELLO. | Preserve this check: guest source NAT should make friends' traffic use the provider's registered address. |
| `vrmodem/server/modem/passt.ts` | One guest address behind userspace NAT, with optional port forwarding. | Reuse it. The provider's Linux must translate friends' addresses before packets reach passt. |

The current guest does not automatically install its default route or DNS settings.
The modem test script types them into the shell. Production setup needs a guest
configuration path, not automated terminal typing.

## Initial design: one guest interface

Use the existing `lan0` first. Linux can receive and forward a packet through the
same interface. Here Udon multiplexes that interface onto two transports according
to destination and provider role. A second guest NIC is not required by this design,
but the target kernel/driver combination needs a working proof before adoption.

Use these addresses in the first controlled test; production derives the provider
address from its current player ID:

| Address | Meaning |
| --- | --- |
| `10.0.0.1` | Provider guest, example only; never hardcode player 1 as the provider |
| `10.0.0.2`, `10.0.0.3` | Friend guests |
| `10.0.255.254` | Existing passt gateway/DNS address, reserved from normal guests |
| `10.0.255.255`, `255.255.255.255` | Existing LAN broadcasts |

Classify an upstream destination as outside `10.0.0.0/16`, or exactly
`10.0.255.254`. Keep LAN broadcasts local. Multicast/other unusual destinations
need an explicit policy; the demo need not promise multicast internet routing.

The DNS exception matters: DNS traffic to `10.0.255.254` must both reach the
provider and undergo source NAT, although it is within the LAN prefix.

Friends can use a default route through `lan0` initially, as the current modem
test does. This is a bare-IP link: its packet batches do not carry an Ethernet
next-hop address. Udon's validated provider advertisement selects the logical
next hop. Merely setting `default via <provider-IP>` does not fix that missing
selection. A next-hop route can be tested, but no new ARP implementation is needed.

If forwarding/NAT through one NIC proves unsuitable, the fallback is a distinct
modem interface with its own mailbox/ring and address. That expands the kernel,
shader, Udon, and harness ABI. Investigate a concrete failure before taking that
larger path.

## Work packages and gates

### 0. Preserve and measure the working setup

- Record the vrmodem/ShaderEmu revisions, current image hashes, gateway command,
  and current successful direct-modem ping/DNS/HTTP/SSH behavior.
- Capture a two-client LAN baseline: address assignment, peer ping, and a small
  file transfer. The documentation's injected/play-mode LAN checks are not a
  substitute for two real clients. A local two-client test may use the explicit
  development role; real instance ownership is checked after a reviewed upload.
- Use an isolated kernel work directory and private test image. The current
  kernel build script copies its result into the shared image directory; add an
  explicit private output option or use an isolated checkout before rebuilding.
- `tools/private_image.py` rereads the current shared root. Freeze/hash the root
  used for the comparison; rebuilding a private image later is not automatically
  a preserved baseline. Follow ShaderEmu's image-build and GPU queue rules.
- Claude is currently changing SSH/image setup and `ShaderEmuModem.cs`/
  `EmuModemTest.cs`. Coordinate those overlapping files; preserve that work.

Gate: owner internet and direct peer LAN both have a repeatable baseline.

### 1. Prove Linux forwarding and NAT before changing the world

- Inspect the target 5.17.11 configuration and resolved `.config`. Enable built-in
  `NETFILTER`, `NF_CONNTRACK`, `NF_NAT`, `NETFILTER_XTABLES`, `IP_NF_IPTABLES`,
  `IP_NF_FILTER`, `IP_NF_NAT`, `NETFILTER_XT_NAT`, and the conntrack match needed
  for an established/related forwarding policy. Check all dependencies in this
  fork's Kconfig and make the build fail if required symbols resolve to disabled
  or modules. Ordinary forwarding does not require policy-routing features.
- Cross-build a pinned, static legacy iptables/iptables-restore tool using the
  existing RV32IMAF/musl toolchain. Include the required static extensions.
  BusyBox network commands do not supply the NAT management tool. Record source,
  build flags, and redistribution information with the existing prebuilt docs.
- In the provider guest, enable `ip_forward`, then configure redirect settings
  and the forwarding policy. Changing `ip_forward` resets relevant IP defaults,
  so apply the other settings afterward. Disable ICMP redirects for this shared
  interface topology and verify reverse-path filtering behavior.
- Add source NAT to the provider's current `10.0.H.L` address for friend-origin
  packets to upstream destinations, including the DNS address. Do not NAT normal
  peer LAN traffic or broadcasts. Use dedicated managed chains and idempotent
  configuration; do not repeatedly append rules.
- Permit intended outbound forwarding and established/related replies. Keep
  unsolicited inbound forwarding disabled. Owner-local traffic and its existing
  external SSH forward must still work.
- Bound conntrack memory for the small guest and measure the extra image size,
  boot time, and idle/runtime cost. Choose the bound from measurements.
- Build a controlled packet injector/collector against the existing guest network
  mailbox. Feed a friend-sourced TCP, UDP, or ICMP packet to the provider, collect
  its translated output, send that through the existing modem/passt test path,
  and inject the reply into the provider. Collect its restored friend destination.
  The current harness `NetLink` drops outside destinations; extend a test-only
  path or add explicit router/upstream modes rather than assuming it can test this.

Gate: a friend packet is forwarded by actual guest Linux, TTL changes once per
Linux routing hop, the gateway sees only the provider source address, and Linux
restores the correct friend destination on the reply. Test two friends using the
same source port/ICMP identifier toward the same peer. Udon/TypeScript must not
perform NAT to make the proof pass.

### 2. Make modem startup owner-only

- For the requested Invite+/Friends+ demo, gate provider activation with
  `Networking.IsInstanceOwner` / the instance-owner player API, after confirming
  availability and Udon exposure in the installed SDK. Do not gate on instance
  master, first arrival, display name, or player number.
- Offer an owner-only "Share internet" switch. Non-owners never call modem
  `Begin`, `LoadURL`, reload, or lane initialization, even after powering on.
- Add a development-only explicit provider override for ClientSim/Build & Test,
  where the documented instance-owner behavior differs. Keep it disabled in the
  uploaded demo world. Do not fall back to "first player" in production.
- Add stop/reset behavior for power-off, disabling sharing, and departure.
  Stop the players, disable lane sends/readback, clear pending modem state, and
  ensure already-scheduled Udon load/retry events cannot reactivate a disabled
  modem. Starting again gets a fresh HELLO nonce and generation.
- Keep current baked URL slots initially, selected only for the provider. This
  preserves the current SSH forwarding setup without requiring a wire-protocol
  redesign. Reconcile its session name/forwarded port when the owner's player ID
  changes. Use the established working localhost URL/port in the demo build.

Gate: two real clients power on with an explicitly selected development provider;
gateway logs show only that client making modem requests. The other client's
power/reset and delayed retry events produce none. Verify the production
instance-owner gate in package 5, where Build & Test's exception does not apply.

### 3. Advertise the provider and expose its role to Linux

- Add role/readiness/generation fields to the owner's existing `EmuShare` player
  object. Receivers validate its actual owner against the instance owner; a flag
  set by an arbitrary friend is not enough.
- Distinguish "sharing requested", "modem connected", "guest router configured",
  and "internet available". Advertise availability only after the modem and guest
  configuration are ready. Late joiners receive the current advertisement.
- Use the network control texel's currently reserved fourth host word
  (`0x870003fc`) for a documented, versioned routing-role/status value. Define
  its bit layout and compatibility before implementation. Add a shader uniform
  and propagate it through `EmuMachine.NetUniforms`, `Machine.shader`, and the
  canonical `experiments/rvc_opt/src/gpu.h` control pass.
- Update the interpreter/harness implementations of that ABI as well. Old hosts
  producing zero must keep ordinary LAN behavior; old images must not appear
  router-ready. The free guest control words are candidates for configuration
  acknowledgement, after verifying their ownership in every host.
- Expose status through the NIC driver's sysfs interface. A small guest helper
  reads the role and address, configures route/DNS/NAT, and acknowledges the
  matching configuration to Udon. This avoids typing shell commands or making
  the guest depend on Unity internals.
- Run the helper from guest init independently of whether the graphical desktop
  starts. Friends get route/DNS setup but forwarding stays off; only the owner
  gets NAT/forwarding. On role removal, remove managed internet configuration
  while leaving LAN addressing and peer access intact.

Gate: booting, late joining, powering on later, and owner rejoining all select the
right role without terminal commands. Owner departure does not promote a friend.

### 4. Carry transit packets through the existing LAN

- In `EmuMachine.NetWindow`, send an upstream packet to the modem only when this
  client is the active provider. A non-provider with an available router queues
  its upstream packet for `EmuShareHub.MoveNet`, like existing LAN traffic.
  Without an available router, reject/count it rather than accumulating stale
  internet packets indefinitely.
- Change `EmuShareHub.TakeNet` to pass validated sender player identity into the
  machine's reception path. Validate IPv4 header/total lengths, MTU 576, and the
  claimed source against the sender's assigned LAN address for friend traffic.
- Only the selected, powered provider may inject a friend's upstream packet
  into its Linux receive ring even though the destination is not its own IP.
  This is transit reception, not a direct call to `EmuModem.Send`.
- Preserve normal peer/broadcast delivery. Other friends ignore the internet
  packet they see in the broadcast player-state batch.
- Modem replies enter the provider's guest unchanged, addressed to its NAT IP.
  Linux reverses NAT and emits a packet addressed to the friend. The existing
  `NetWindow` LAN path and `MoveNet` transmit that packet back to the lobby.
- Permit those provider-origin replies to have an internet/DNS source address;
  applying the friend source-address check indiscriminately would reject them.
  Scope the exception to the validated active provider and intended recipient.
- Keep all queues bounded, preserve the existing guest-window/ring handshakes,
  and expose drop counters. Distinguish modem-queue rejection from successful
  transmission; the current caller ignores `modem.Send` failure.
- Verify that no receiver puts a received transit packet directly back into its
  LAN output queue. Only actual Linux output is sent onward. This and role checks
  prevent forwarding loops; Linux handles TTL, not Udon.

Gate: friend -> owner Linux -> modem -> owner Linux -> friend works for ICMP,
DNS, and TCP, while friend-to-friend LAN packets never enter the modem.

### 5. Finish the joinable demo and test it under use

- Show provider name/address and internet state on the existing network panel:
  waiting for provider, connecting modem, configuring router, online, or offline.
- Disable the current automatic `EmuModemTest` in the production scene. Friends
  can start their own PC normally; test automation must not give everybody the
  owner's SSH/test setup or auto-start a modem.
- Only the owner needs the custom-video URL setting for this modem. Follow the
  already tested PC video setup; Quest support is a separate verification task.
- Prepare a reviewed upload after the local checks. Uploading the world is a
  separate, explicitly authorized action; choose world visibility that permits
  the intended friends to join. A private instance and a private world listing
  are separate settings. This plan does not upload anything.
- Then test with one owner and one friend in a real private instance, then with
  two friends concurrently. Verify external DNS/HTTP, small file hashes, local
  SSH/peer ping, and the owner's existing modem-side SSH access.
- Repeat with owner power-off/on, sharing off/on, gateway restart, a lost lane,
  video reload/end, late join, friend departure/rejoin, and owner departure/rejoin.
  Existing TCP connections may break after a router restart; new ones must work
  once readiness returns. Do not promise transparent session preservation.
- Measure latency at each leg and queue drops while one friend downloads and
  another issues short commands. The modem upload is shared, and the owner's
  VRChat LAN output also shares its synchronization budget with display/input.
  High raw video downlink throughput is not the friends' effective download rate.
- Keep display sharing and local games usable. If a transfer starves interactive
  traffic, add bounded per-peer scheduling at the LAN boundary based on the
  measured problem; do not claim existing queues already provide fairness.
- Document gateway startup, owner activation, friends' join/power-on steps,
  expected performance, and recovery. Verify late joins and the production
  instance-owner gate in that actual instance, without the development override.

Gate: one friend installs nothing on their real computer, joins, starts their PC,
and fetches a small external page through the owner's guest. A second friend can
do the same concurrently. Turning the provider off removes internet access but
preserves peer LAN access. Friend clients produce zero modem URL requests.

## Scope and implementation order

Execute packages 0 and 1 first: preserve the working setup and prove guest Linux
NAT. Packages 2 and 3 establish owner-only modem behavior and guest configuration;
package 4 joins the data paths; package 5 makes the result demonstrable.

The first demo shares one owner's localhost gateway in one private instance.
It does not need per-friend passt processes, a public gateway service, new NAT
logic in TypeScript/Udon, or new video encoding. CRC protection of modem control
frames, long-term gateway cleanup, broader platform support, and public-service
authorization remain independent follow-up work. Investigate any issue that blocks
the two-client gate, but do not expand this into a general hosted networking service.

## Primary references and limits of the investigation

- [VRChat network properties](https://creators.vrchat.com/worlds/udon/networking/network-components/):
  instance ownership for private instance types, absent-owner behavior, and the
  Build & Test exception. Confirm these APIs in the installed SDK before coding.
- [VRChat object ownership](https://creators.vrchat.com/worlds/udon/networking/ownership/):
  master changes and why it is unsuitable for choosing the internet provider.
- [Linux IP sysctls](https://docs.kernel.org/networking/ip-sysctl.html):
  forwarding, redirect settings, and the reset when changing `ip_forward`.
- [Netfilter NAT](https://www.netfilter.org/documentation/HOWTO/NAT-HOWTO-6.html):
  source NAT in POSTROUTING and connection-tracked reverse translation.
- Local 5.17.11 source inspected: `net/ipv4/ip_forward.c`,
  `net/netfilter/Kconfig`, and `net/ipv4/netfilter/Kconfig`; existing ShaderEmu
  driver, shader ABI, Udon LAN/modem paths, harness NetLink, and vrmodem gateway.

No new kernel/image was built and no live world was changed for this plan.
Single-interface forwarding on the exact guest, static iptables packaging, and
two-client LAN behavior remain proof tasks, not completed validations.
