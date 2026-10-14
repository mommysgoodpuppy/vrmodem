// The gateway's half of the modem for one client: symbols in from each lane,
// IP packets out to onIp, and the bytes of each downlink frame.

import { DownTx, downHeader, encodeDown, LaneRx, readU24, Type } from "./link.ts";

export class ModemSession {
  readonly lanes: LaneRx[];
  down = new DownTx();
  nonce = 0;
  address = 0;
  ips = 0;
  // Packets in parts, by id: the parts so far.
  private partial = new Map<number, { n: number; parts: (Uint8Array | undefined)[]; at: number }>();

  constructor(
    lanes: number,
    private onIp: (ip: Uint8Array) => void,
    private onHello: (nonce: number, address: number) => void = () => {},
  ) {
    this.lanes = Array.from({ length: lanes }, (_, i) => this.lane(i));
  }

  private lane(i: number) {
    return new LaneRx((type, payload) => this.linkFrame(i, type, payload));
  }

  // The lane's player loaded its video again: a new run of its sequence.
  resetLane(i: number) {
    this.lanes[i] = this.lane(i);
  }

  private linkFrame(_lane: number, type: number, payload: Uint8Array) {
    if (type === Type.Ip) {
      this.ips++;
      this.onIp(payload);
    } else if (type === Type.Dack && payload.length === 3) this.down.ack(readU24(payload));
    else if (type === Type.Frag && payload.length > 2) this.part(payload);
    else if (type === Type.Hello && payload.length === 8) {
      const v = new DataView(payload.buffer, payload.byteOffset);
      const nonce = v.getUint32(0, true), address = v.getUint32(4, true);
      if (nonce === this.nonce) return; // every lane says hello
      this.nonce = nonce;
      this.address = address;
      this.down = new DownTx();
      this.partial.clear();
      this.onHello(nonce, address);
    }
  }

  private part(payload: Uint8Array) {
    const id = payload[0], i = payload[1] >> 4, n = (payload[1] & 15) + 1;
    let p = this.partial.get(id);
    // A part of another count is a new packet with a reused id.
    if (!p || p.n !== n || p.parts[i]) p = { n, parts: [], at: Date.now() };
    this.partial.set(id, p);
    p.parts[i] = payload.slice(2);
    for (let k = 0; k < n; k++) if (!p.parts[k]) return;
    this.partial.delete(id);
    const ip = new Uint8Array(p.parts.reduce((s, x) => s + x!.length, 0));
    let at = 0;
    for (const x of p.parts) {
      ip.set(x!, at);
      at += x!.length;
    }
    this.ips++;
    this.onIp(ip);
  }

  symbol(lane: number, symbol: number) {
    this.lanes[lane]?.symbol(symbol);
  }

  // The next downlink frame, `size` bytes.
  frame(size: number, now: number): Uint8Array {
    const room = size - downHeader(this.lanes.length) - 2;
    return encodeDown({ nonce: this.nonce, low: this.down.low, acks: this.lanes.map((l) => l.ack()), packets: this.down.take(room, now) }, size);
  }
}
