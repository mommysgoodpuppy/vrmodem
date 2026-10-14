// The world's half of the modem, as unity/Modem.cs does it: IP packets in,
// one symbol per lane per frame out, and downlink frames in.

import { decodeDown, DownRx, LaneTx, MTU, Type, u24 } from "./link.ts";

export class ModemClient {
  readonly lanes: LaneTx[];
  readonly down = new DownRx();
  private acked = -1;
  private ackAt = -Infinity;
  bad = 0;

  constructor(lanes: number, readonly nonce: number, readonly address: number, readonly ackEvery = 100) {
    this.lanes = Array.from({ length: lanes }, () => new LaneTx());
    const hello = new Uint8Array(8);
    new DataView(hello.buffer).setUint32(0, nonce >>> 0, true);
    new DataView(hello.buffer).setUint32(4, address >>> 0, true);
    for (const lane of this.lanes) lane.write(Type.Hello, hello);
  }

  // An IP packet to send: on the least loaded lane.
  send(ip: Uint8Array) {
    if (ip.length < 20 || ip.length > MTU) return;
    this.least().write(Type.Ip, ip);
  }

  private least() {
    return this.lanes.reduce((a, b) => (b.load < a.load ? b : a));
  }

  // Each lane's seek for this frame (null: none).
  poll(now: number): (number | null)[] {
    if (this.down.ack !== this.acked && now - this.ackAt >= this.ackEvery) {
      this.acked = this.down.ack;
      this.ackAt = now;
      this.least().write(Type.Dack, u24(this.acked));
    }
    return this.lanes.map((l) => l.poll(now));
  }

  // A downlink frame's bytes: the packets it brought that are new.
  frame(bytes: Uint8Array, now: number): Uint8Array[] {
    const f = decodeDown(bytes);
    if (!f || f.acks.length !== this.lanes.length) {
      this.bad++;
      return [];
    }
    if (f.nonce !== (this.nonce >>> 0)) return []; // the gateway has not heard our hello yet
    f.acks.forEach((a, i) => this.lanes[i].ack(a, now));
    return this.down.frame(f);
  }
}
