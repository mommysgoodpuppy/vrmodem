// passt opens a connection in to the machine (--forward) with a SYN and sends it again a second
// later if no SYN ACK has come, with a sequence number one higher each time, and counts its
// data on from the last. Through the modem a SYN ACK takes about a second: the machine's
// kernel answers the second SYN with a reset (a SYN that is not its half-open connection's),
// and a connection that does open is a byte off from its start, its data never acknowledged.
//
// So, between passt and the modem: a SYN again is not sent (the way down repeats what is
// lost anyway), and for the rest of that connection passt's sequence numbers go down by what
// its SYNs added and the machine's acknowledgements up by it.

const TCP = 6, SYN = 2, RST = 4, ACK = 16;
const IDLE = 10 * 60_000; // a connection not heard of for this long is forgotten

type Conn = { isn: number; delta: number; at: number };

export class SynFix {
  private conns = new Map<string, Conn>();
  dropped = 0;

  // A packet from passt for the machine: the packet to send, or null for none.
  down(ip: Uint8Array, now = Date.now()): Uint8Array | null {
    const t = tcp(ip);
    if (!t) return ip;
    const key = `${t.src}:${t.sport}>${t.dst}:${t.dport}`;
    let c = this.conns.get(key);
    if ((t.flags & (SYN | ACK)) === SYN) {
      if (c && now - c.at < IDLE && (t.seq - c.isn) >>> 0 < 16) {
        c.delta = (t.seq - c.isn) >>> 0;
        c.at = now;
        this.dropped++;
        return null;
      }
      this.prune(now);
      this.conns.set(key, { isn: t.seq, delta: 0, at: now });
      return ip;
    }
    if (!c) return ip;
    c.at = now;
    if (t.flags & RST) this.conns.delete(key);
    if (!c.delta) return ip;
    return rewrite(ip, t.hl, 4, (t.seq - c.delta) >>> 0);
  }

  // A packet from the machine for passt.
  up(ip: Uint8Array, now = Date.now()): Uint8Array {
    const t = tcp(ip);
    if (!t) return ip;
    const c = this.conns.get(`${t.dst}:${t.dport}>${t.src}:${t.sport}`);
    if (!c) return ip;
    c.at = now;
    if (t.flags & RST) this.conns.delete(`${t.dst}:${t.dport}>${t.src}:${t.sport}`);
    if (!c.delta || !(t.flags & ACK)) return ip;
    return rewrite(ip, t.hl, 8, (t.ack + c.delta) >>> 0);
  }

  get size() {
    return this.conns.size;
  }

  private prune(now: number) {
    for (const [k, c] of this.conns) if (now - c.at > IDLE) this.conns.delete(k);
  }
}

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const ip4 = (b: Uint8Array, at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

function tcp(ip: Uint8Array) {
  if (ip.length < 40 || ip[0] >> 4 !== 4 || ip[9] !== TCP) return null;
  const hl = (ip[0] & 15) * 4;
  if (ip.length < hl + 20 || ((ip[6] & 0x1f) | ip[7])) return null; // (no fragments)
  return {
    hl, src: ip4(ip, 12), dst: ip4(ip, 16), sport: (ip[hl] << 8) | ip[hl + 1], dport: (ip[hl + 2] << 8) | ip[hl + 3],
    seq: u32(ip, hl + 4), ack: u32(ip, hl + 8), flags: ip[hl + 13],
  };
}

// A copy with the TCP word at `at` (4: sequence, 8: acknowledgement) set to v, its checksum
// mended (RFC 1624: HC' = ~(~HC + ~m + m')).
function rewrite(ip: Uint8Array, hl: number, at: number, v: number): Uint8Array {
  const p = ip.slice();
  const o = hl + at;
  let sum = ~((p[hl + 16] << 8) | p[hl + 17]) & 0xffff;
  for (const k of [0, 2]) sum += (~((p[o + k] << 8) | p[o + k + 1]) & 0xffff);
  p[o] = v >>> 24;
  p[o + 1] = (v >>> 16) & 255;
  p[o + 2] = (v >>> 8) & 255;
  p[o + 3] = v & 255;
  for (const k of [0, 2]) sum += (p[o + k] << 8) | p[o + k + 1];
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  const c = ~sum & 0xffff;
  p[hl + 16] = c >> 8;
  p[hl + 17] = c & 255;
  return p;
}
