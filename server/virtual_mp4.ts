// A fast-start, all-intra MP4 backed by one repeated AVC sample. Only the
// header and one sample are allocated; byte ranges are synthesized on demand.
const enc = new TextEncoder();
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function words(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const v = new DataView(out.buffer);
  values.forEach((n, i) => v.setUint32(i * 4, n));
  return out;
}
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const data = concat(parts);
  return concat([words(data.length + 8), enc.encode(type), data]);
}
type Box = { type: string; data: Uint8Array };
function boxes(data: Uint8Array): Box[] {
  const out: Box[] = [];
  for (let at = 0; at < data.length;) {
    if (at + 8 > data.length) throw new Error("truncated MP4 box");
    const size = new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0);
    if (size < 8 || at + size > data.length) throw new Error("unsupported MP4 box size");
    out.push({ type: new TextDecoder().decode(data.subarray(at + 4, at + 8)), data: data.subarray(at + 8, at + size) });
    at += size;
  }
  return out;
}
function child(data: Uint8Array, type: string): Uint8Array {
  const found = boxes(data).find((b) => b.type === type);
  if (!found) throw new Error(`source MP4 missing ${type}`);
  return found.data;
}
function u32(data: Uint8Array, at: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at);
}

export class VirtualMp4 {
  readonly header: Uint8Array;
  readonly sample: Uint8Array;
  readonly size: number;
  readonly frames: number;

  // sampleSize: every sample's size in bytes (default 128). The source's own
  // sample is padded to it; a live stream sends other samples of that size.
  constructor(source: Uint8Array, readonly fps: number, seconds: number, sampleSize = 128) {
    this.frames = fps * seconds;
    if (!Number.isInteger(fps) || fps < 1 || fps > 240 ||
      !Number.isSafeInteger(this.frames) || this.frames < 1 || this.frames > 0xffffffff) {
      throw new RangeError("fps must be an integer from 1 to 240; fps × seconds must be an integer from 1 to 4294967295");
    }
    const moov = child(source, "moov");
    if (boxes(moov).filter((b) => b.type === "trak").length !== 1) throw new Error("source must have one video track");
    const stbl = child(child(child(child(moov, "trak"), "mdia"), "minf"), "stbl");
    const stsz = child(stbl, "stsz");
    if (u32(stsz, 8) !== 1) throw new Error("source must contain exactly one sample");
    const offset = u32(child(stbl, "stco"), 8);
    const length = u32(stsz, 4) || u32(stsz, 12);
    const stsd = child(stbl, "stsd");
    if (new TextDecoder().decode(stsd.subarray(12, 16)) !== "avc1") throw new Error("source must be AVC");
    const avcc = child(stsd.subarray(94), "avcC");
    if ((avcc[4] & 3) !== 3) throw new Error("source must use four-byte NAL lengths");
    // x264's encoder-information SEI dominates this tiny frame. Keep the
    // actual IDR and add a valid filler NAL to reach sampleSize bytes per frame.
    const nals: Uint8Array[] = [];
    for (let at = offset; at < offset + length;) {
      const n = u32(source, at);
      if (n < 1 || at + 4 + n > offset + length) throw new Error("invalid AVC sample");
      if ((source[at + 4] & 31) !== 6) nals.push(source.subarray(at, at + 4 + n));
      at += 4 + n;
    }
    const payload = concat(nals);
    const filler = new Uint8Array(Math.max(2, sampleSize - payload.length - 4)).fill(0xff);
    filler[0] = 12;
    filler[filler.length - 1] = 0x80;
    this.sample = concat([payload, words(filler.length), filler]);

    let dataOffset = 0;
    const rewrite = (data: Uint8Array): Uint8Array => concat(boxes(data).flatMap(({ type, data: d }) => {
      if (["edts", "stss", "ctts"].includes(type)) return [];
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(type)) return [box(type, rewrite(d))];
      if (["mvhd", "mdhd", "tkhd"].includes(type)) {
        if (d[0] !== 0) throw new Error("source requires version-zero duration boxes");
        d = d.slice();
        const v = new DataView(d.buffer);
        if (type === "tkhd") v.setUint32(20, this.frames);
        else { v.setUint32(12, fps); v.setUint32(16, this.frames); }
      } else if (type === "stts") d = words(0, 1, this.frames, 1);
      else if (type === "stsc") d = words(0, 1, 1, this.frames, 1);
      else if (type === "stsz") d = words(0, this.sample.length, this.frames);
      else if (type === "stco" || type === "co64") {
        const off = new Uint8Array(8);
        new DataView(off.buffer).setBigUint64(0, BigInt(dataOffset));
        return [box("co64", words(0, 1), off)];
      }
      return [box(type, d)];
    }));
    const ftyp = box("ftyp", child(source, "ftyp"));
    const movie = () => box("moov", rewrite(moov));
    dataOffset = ftyp.length + movie().length + 16;
    const mdat = new Uint8Array(16);
    mdat.set(words(1), 0);
    mdat.set(enc.encode("mdat"), 4);
    new DataView(mdat.buffer).setBigUint64(8, BigInt(this.frames * this.sample.length + 16));
    this.header = concat([ftyp, movie(), mdat]);
    this.size = this.header.length + this.frames * this.sample.length;
  }

  frameAt(offset: number): number | null {
    return offset < this.header.length || offset >= this.size ? null :
      Math.floor((offset - this.header.length) / this.sample.length);
  }

  read(offset: number, length: number): Uint8Array {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) throw new RangeError("invalid virtual MP4 read");
    const out = new Uint8Array(length);
    let at = 0;
    if (offset < this.header.length) {
      const n = Math.min(length, this.header.length - offset);
      out.set(this.header.subarray(offset, offset + n));
      at += n; offset += n;
    }
    while (at < length) {
      const pos = (offset - this.header.length) % this.sample.length;
      const n = Math.min(length - at, this.sample.length - pos);
      out.set(this.sample.subarray(pos, pos + n), at);
      at += n; offset += n;
    }
    return out;
  }
}
