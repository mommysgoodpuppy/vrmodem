// The world's half of the modem, as unity/Modem.cs does it: IP packets in,
// one symbol per lane per frame out, and downlink frames in.

import { decodeDown, DownRx, LaneTx, MTU, parts, partStart, Type, u24 } from "./link.ts";

export class ModemClient {
  lanes: LaneTx[];
  readonly ready: boolean[];
  readonly down = new DownRx();
  private acked = -1;
  private ackAt = -Infinity;
  bad = 0;
  private id = 0;

  constructor(lanes: number, readonly nonce: number, readonly address: number, readonly ackEvery = 100) {
    this.lanes = Array.from({ length: lanes }, () => new LaneTx());
    this.ready = this.lanes.map(() => false);
  }

  // Lane i's player is ready: its sequence starts again, with a hello.
  laneReady(i: number) {
    this.lanes[i] = new LaneTx();
    this.ready[i] = true;
    const hello = new Uint8Array(8);
    new DataView(hello.buffer).setUint32(0, this.nonce >>> 0, true);
    new DataView(hello.buffer).setUint32(4, this.address >>> 0, true);
    this.lanes[i].write(Type.Hello, hello);
  }

  // An IP packet to send: whole on the least loaded ready lane, or in parts
  // on the least loaded few, so that it arrives sooner.
  send(ip: Uint8Array) {
    if (ip.length < 20 || ip.length > MTU) return false;
    const ready = this.lanes.filter((_, i) => this.ready[i]).sort((a, b) => a.load - b.load);
    if (!ready.length) return false;
    const n = parts(ip.length, ready.length);
    if (n === 1) {
      ready[0].write(Type.Ip, ip);
      return true;
    }
    const id = this.id;
    this.id = (this.id + 1) & 255;
    for (let i = 0; i < n; i++) {
      const from = partStart(i, n, ip.length), to = partStart(i + 1, n, ip.length);
      const payload = new Uint8Array(2 + to - from);
      payload[0] = id;
      payload[1] = (i << 4) | (n - 1);
      payload.set(ip.subarray(from, to), 2);
      ready[i].write(Type.Frag, payload);
    }
    return true;
  }

  private least() {
    return this.lanes.filter((_, i) => this.ready[i]).reduce<LaneTx | undefined>((a, b) => (!a || b.load < a.load ? b : a), undefined);
  }

  // Each lane's seek for this frame (null: none).
  poll(now: number): (number | null)[] {
    const lane = this.least();
    if (lane && this.down.ack !== this.acked && now - this.ackAt >= this.ackEvery) {
      this.acked = this.down.ack;
      this.ackAt = now;
      lane.write(Type.Dack, u24(this.acked));
    }
    return this.lanes.map((l, i) => (this.ready[i] ? l.poll(now) : null));
  }

  // A downlink frame's bytes: the packets it brought that are new.
  frame(bytes: Uint8Array, now: number): Uint8Array[] {
    const f = decodeDown(bytes);
    if (!f || f.acks.length !== this.lanes.length) {
      this.bad++;
      return [];
    }
    if (f.nonce !== (this.nonce >>> 0)) return []; // the gateway has not heard our hello yet
    f.acks.forEach((a, i) => this.ready[i] && this.lanes[i].ack(a, now));
    return this.down.frame(f);
  }
}
