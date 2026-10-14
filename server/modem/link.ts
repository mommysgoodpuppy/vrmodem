// The modem's link layer (MODEM.md): IP packets between a VRChat world and the
// gateway, up over video seeks and down in video frames. Pure state machines,
// shared by the gateway, the simulated client and the tests; unity/Modem.cs
// must agree with the client half bit for bit.
//
// Uplink. Each lane is a video player whose seeks the gateway sees as frame
// numbers: one 22-bit symbol per seek, frame = symbol + 1. A symbol is a lane
// sequence number (mod SEQ_MOD) and CHUNK_BITS of data. Lanes are independent
// selective-repeat ARQ links (window WINDOW), each a stream of link frames that
// start on chunk boundaries: a 16-bit header (type << 12 | length) and the
// payload, then zero bits up to the next chunk.
//
// Downlink. Each video frame carries bytes (downFrame below): the gateway's
// acks for every lane, and numbered IP packets, sent until the client acks
// them in an uplink DACK frame.

export const CHUNK_BITS = 15;
export const SEQ_MOD = 126; // 126 << 15 frames fit the lane video (4,194,240 frames)
export const WINDOW = 63;
export const MTU = 576;

export const enum Type {
  Ip = 1, // an IP packet
  Dack = 2, // u24: every downlink packet before this number arrived
  Hello = 3, // u32 nonce, u32 machine address: a new client
  Frag = 4, // u8 packet id, u8 index << 4 | (count - 1), then that part of the packet
}

// A packet is split over this many lanes: about 16 bytes a part.
export const parts = (length: number, lanes: number) => Math.max(1, Math.min(lanes, 16, Math.ceil(length / 16)));

// Part i of n of a packet: bytes [floor(i * len / n), floor((i + 1) * len / n)).
export const partStart = (i: number, n: number, length: number) => Math.floor(i * length / n);

export const symbolOf = (seq: number, chunk: number) => seq * (1 << CHUNK_BITS) + chunk;
export const frameOf = (symbol: number) => symbol + 1;
export const symbolAt = (frame: number) => frame - 1;

// ---- link frames as chunks ----

export function frameBytes(type: Type, payload: Uint8Array): Uint8Array {
  if (payload.length >= 4096) throw new RangeError("link frame too long");
  const out = new Uint8Array(2 + payload.length);
  out[0] = (type << 4) | (payload.length >> 8);
  out[1] = payload.length & 255;
  out.set(payload, 2);
  return out;
}

// A frame's bytes as 15-bit chunks, MSB first, the last padded with zeros.
export function toChunks(bytes: Uint8Array): number[] {
  const chunks: number[] = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    if (bits >= CHUNK_BITS) {
      bits -= CHUNK_BITS;
      chunks.push((acc >> bits) & 0x7fff);
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) chunks.push((acc << (CHUNK_BITS - bits)) & 0x7fff);
  return chunks;
}

// Chunks in order back into link frames.
export class Deframer {
  private acc = 0;
  private bits = 0;
  private header = -1;
  private body: number[] = [];
  bad = 0;

  constructor(private onFrame: (type: number, payload: Uint8Array) => void) {}

  push(chunk: number) {
    this.acc = (this.acc << CHUNK_BITS) | chunk;
    this.bits += CHUNK_BITS;
    while (this.bits >= 8) {
      this.bits -= 8;
      this.byte((this.acc >> this.bits) & 255);
      this.acc &= (1 << this.bits) - 1;
      if (this.header === -2) {
        // A frame ended: the rest of this chunk is padding.
        this.header = -1;
        this.acc = 0;
        this.bits = 0;
      }
    }
  }

  private first = -1;

  private byte(b: number) {
    if (this.header === -1) {
      if (this.first === -1) {
        this.first = b;
        return;
      }
      this.header = (this.first << 8) | b;
      this.first = -1;
      this.body = [];
      if ((this.header & 0xfff) === 0) this.end();
      return;
    }
    this.body.push(b);
    if (this.body.length === (this.header & 0xfff)) this.end();
  }

  private end() {
    const type = this.header >> 12;
    if (type === 0) this.bad++;
    else this.onFrame(type, new Uint8Array(this.body));
    this.header = -2;
  }
}

// ---- uplink ARQ ----

export type LaneAck = { expected: number; bitmap: bigint }; // bit i: expected + 1 + i received

// Client side of a lane.
export class LaneTx {
  private queue: number[] = []; // chunks not yet sent
  private base = 0; // oldest unacked, absolute
  private next = 0; // next new, absolute
  private chunks = new Map<number, { chunk: number; order: number; at: number }>();
  private order = 0; // send counter
  private resend: number[] = [];
  private lastProgress = 0;
  sends = 0;
  resends = 0;

  constructor(readonly rto = 2000) {}

  // Chunks waiting or in flight.
  get load() {
    return this.queue.length + (this.next - this.base);
  }

  write(type: Type, payload: Uint8Array) {
    for (const c of toChunks(frameBytes(type, payload))) this.queue.push(c);
  }

  // The symbol to seek to now, or null.
  poll(now: number): number | null {
    if (this.base < this.next && now - this.lastProgress > this.rto && !this.resend.length) {
      // Nothing acked for a while: the oldest again, and wait once more.
      this.resend.push(this.base);
      this.lastProgress = now;
    }
    let abs = this.resend.shift();
    while (abs !== undefined && !this.chunks.has(abs)) abs = this.resend.shift();
    if (abs === undefined) {
      if (!this.queue.length || this.next - this.base >= WINDOW) return null;
      abs = this.next++;
      if (this.base === abs) this.lastProgress = now;
      this.chunks.set(abs, { chunk: this.queue.shift()!, order: 0, at: now });
    } else this.resends++;
    const c = this.chunks.get(abs)!;
    c.order = ++this.order;
    c.at = now;
    this.sends++;
    return symbolOf(abs % SEQ_MOD, c.chunk);
  }

  ack(a: LaneAck, now: number) {
    // The gateway's expected lies in [base, next]: within WINDOW of base.
    const expected = this.base + ((a.expected - (this.base % SEQ_MOD) + SEQ_MOD) % SEQ_MOD);
    if (expected > this.next) return; // not this run's
    let newest = 0;
    for (let abs = this.base; abs < expected; abs++) {
      newest = Math.max(newest, this.chunks.get(abs)?.order ?? 0);
      this.chunks.delete(abs);
    }
    if (expected > this.base) this.lastProgress = now;
    this.base = expected;
    for (let i = 0; i < WINDOW; i++) {
      if ((a.bitmap >> BigInt(i)) & 1n) {
        const c = this.chunks.get(expected + 1 + i);
        if (c) {
          newest = Math.max(newest, c.order);
          this.chunks.delete(expected + 1 + i);
        }
      }
    }
    // Lanes keep order: a chunk sent before one that arrived is lost.
    for (const [abs, c] of [...this.chunks].sort((x, y) => x[0] - y[0])) {
      if (c.order < newest && !this.resend.includes(abs)) this.resend.push(abs);
    }
  }
}

// Gateway side of a lane.
export class LaneRx {
  private expected = 0;
  private held = new Map<number, number>();
  readonly deframer: Deframer;
  duplicates = 0;

  constructor(onFrame: (type: number, payload: Uint8Array) => void) {
    this.deframer = new Deframer(onFrame);
  }

  symbol(symbol: number) {
    const seq = Math.floor(symbol / (1 << CHUNK_BITS)), chunk = symbol & 0x7fff;
    if (seq >= SEQ_MOD) return;
    const d = (seq - (this.expected % SEQ_MOD) + SEQ_MOD) % SEQ_MOD;
    if (d >= WINDOW || this.held.has(this.expected + d)) {
      this.duplicates++;
      return;
    }
    this.held.set(this.expected + d, chunk);
    while (this.held.has(this.expected)) {
      this.deframer.push(this.held.get(this.expected)!);
      this.held.delete(this.expected++);
    }
  }

  ack(): LaneAck {
    let bitmap = 0n;
    for (const abs of this.held.keys()) bitmap |= 1n << BigInt(abs - this.expected - 1);
    return { expected: this.expected % SEQ_MOD, bitmap };
  }
}

// ---- downlink ----
//
// Frame bytes: 'M', lane count L, nonce u32 (the client's, from its HELLO),
// low u24 (packets before it are gone: acked or dropped), then per lane
// expected u8 and bitmap u64 (LE), then packets: number u24, length u16, the
// packet; a length of 0 ends them.

export const MAGIC = 0x4d;
export const downHeader = (lanes: number) => 10 + lanes * 9;
const U24 = 1 << 24;
const after = (a: number, b: number) => ((a - b + U24) % U24) < U24 / 2 && a !== b; // a after b, mod 2^24

export type DownFrame = { nonce: number; low: number; acks: LaneAck[]; packets: { n: number; data: Uint8Array }[] };

export function encodeDown(f: DownFrame, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out[0] = MAGIC;
  out[1] = f.acks.length;
  v.setUint32(2, f.nonce >>> 0, true);
  v.setUint32(6, f.low & 0xffffff, true); // the top byte stays 0
  let at = 10;
  for (const a of f.acks) {
    out[at] = a.expected;
    v.setBigUint64(at + 1, a.bitmap, true);
    at += 9;
  }
  for (const p of f.packets) {
    if (at + 5 + p.data.length + 2 > size) break;
    out[at] = p.n & 255;
    out[at + 1] = (p.n >> 8) & 255;
    out[at + 2] = (p.n >> 16) & 255;
    v.setUint16(at + 3, p.data.length, true);
    out.set(p.data, at + 5);
    at += 5 + p.data.length;
  }
  return out; // zeros after: a length of 0
}

export function decodeDown(b: Uint8Array): DownFrame | null {
  if (b.length < 10 || b[0] !== MAGIC) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const lanes = b[1];
  let at = 10;
  if (at + lanes * 9 > b.length) return null;
  const acks: LaneAck[] = [];
  for (let i = 0; i < lanes; i++, at += 9) acks.push({ expected: b[at], bitmap: v.getBigUint64(at + 1, true) });
  const packets: { n: number; data: Uint8Array }[] = [];
  while (at + 5 <= b.length) {
    const len = v.getUint16(at + 3, true);
    if (len === 0) break;
    if (len < 20 || len > MTU || at + 5 + len > b.length) return null; // damaged
    packets.push({ n: b[at] | (b[at + 1] << 8) | (b[at + 2] << 16), data: b.slice(at + 5, at + 5 + len) });
    at += 5 + len;
  }
  return { nonce: v.getUint32(2, true), low: v.getUint32(6, true) & 0xffffff, acks, packets };
}

// Gateway side: packets for the client, each sent in `copies` frames running
// and again every `rto` ms until acked.
export class DownTx {
  private packets: { n: number; data: Uint8Array; sends: number; at: number; pushed: number; rounds: number }[] = [];
  private next = 0;
  dropped = 0;
  // Each packet's first frame and its ack, with the ms since it was pushed (the gateway's trace).
  trace?: (ev: "first" | "again" | "acked", n: number, ms: number) => void;

  constructor(readonly limit = 256, readonly copies = 2, readonly rto = 1500) {}

  get waiting() {
    return this.packets.length;
  }

  push(data: Uint8Array, now = Date.now()) {
    if (data.length < 20 || data.length > MTU) return;
    if (this.packets.length >= this.limit) {
      this.packets.shift();
      this.dropped++;
    }
    this.packets.push({ n: this.next, data, sends: 0, at: 0, pushed: now, rounds: 0 });
    this.next = (this.next + 1) % U24;
    return (this.next + U24 - 1) % U24;
  }

  get low() {
    return this.packets.length ? this.packets[0].n : this.next;
  }

  // Everything before n arrived.
  ack(n: number, now = Date.now()) {
    while (this.packets.length && after(n, this.packets[0].n)) {
      const p = this.packets.shift()!;
      this.trace?.("acked", p.n, now - p.pushed);
    }
  }

  // What goes into a frame of `room` bytes for packets.
  take(room: number, now: number) {
    const out: { n: number; data: Uint8Array }[] = [];
    for (const p of this.packets) {
      if (p.sends >= this.copies && now - p.at < this.rto) continue;
      if (5 + p.data.length > room) break;
      room -= 5 + p.data.length;
      if (p.sends >= this.copies) p.sends = 0; // a new round of copies
      if (p.sends === 0) this.trace?.(p.rounds++ ? "again" : "first", p.n, now - p.pushed);
      p.sends++;
      p.at = now;
      out.push({ n: p.n, data: p.data });
    }
    return out;
  }
}

// Client side: new packets once each, and what to ack.
export class DownRx {
  private cumulative = 0; // every packet before this arrived
  private above = new Set<number>();
  duplicates = 0;

  // Packets not seen before.
  frame(f: DownFrame): Uint8Array[] {
    // Packets before the gateway's low are gone either way.
    if (after(f.low, this.cumulative)) this.cumulative = f.low;
    const fresh: Uint8Array[] = [];
    for (const p of f.packets) {
      if (after(this.cumulative, p.n) || this.above.has(p.n)) {
        this.duplicates++;
        continue;
      }
      this.above.add(p.n);
      fresh.push(p.data);
    }
    this.advance();
    return fresh;
  }

  private advance() {
    for (const n of [...this.above]) if (after(this.cumulative, n)) this.above.delete(n);
    while (this.above.delete(this.cumulative)) this.cumulative = (this.cumulative + 1) % U24;
  }

  get ack() {
    return this.cumulative;
  }
}

export const u24 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
export const readU24 = (b: Uint8Array) => b[0] | (b[1] << 8) | (b[2] << 16);
