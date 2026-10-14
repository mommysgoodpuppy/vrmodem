// Live downlink: frames made at send time, encoded intra-only by a persistent
// x264 (through ffmpeg), each padded with a filler NAL to one fixed size so a
// VirtualMp4 header can describe a stream that doesn't exist yet.
//
// A LiveEncoder takes luma frames and gives back MP4 samples (four-byte NAL
// lengths, no SPS, PPS, SEI or AUD: those are in the header) of exactly the
// sample size, or null when a frame came out larger than that.

import { Layout, render } from "./downlink.ts";
import { VirtualMp4 } from "./virtual_mp4.ts";

export type LiveParams = Layout & { fps: number; qp: number };

const X264 = (fps: number) => `keyint=1:min-keyint=1:scenecut=0:bframes=0:aud=1:fps=${fps}`;

function ffmpegArgs(p: LiveParams, out: string[]): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${p.w}x${p.h}`, "-r", String(p.fps), "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "main",
    "-pix_fmt", "yuv420p", "-qp", String(p.qp), "-x264-params", X264(p.fps),
    ...out,
  ];
}

async function run(args: string[], input: Uint8Array[]): Promise<Uint8Array> {
  const ff = new Deno.Command("ffmpeg", { args, stdin: "piped", stdout: "piped" }).spawn();
  const w = ff.stdin.getWriter();
  const out = new Response(ff.stdout).arrayBuffer();
  for (const frame of input) await w.write(frame);
  await w.close();
  if (!(await ff.status).success) throw new Error("ffmpeg failed");
  return new Uint8Array(await out);
}

// Splits Annex B into NAL units (without start codes).
export function annexB(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--; // a four-byte start code's leading zero
        nals.push(data.subarray(start, end));
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < data.length) nals.push(data.subarray(start));
  return nals;
}

// The slices of one access unit as an MP4 sample padded to size, or null.
export function sample(slices: Uint8Array[], size: number): Uint8Array | null {
  const used = slices.reduce((n, s) => n + 4 + s.length, 0);
  // A filler NAL is a header byte, 0xff bytes and a trailing 0x80: at least 2 + 4 length.
  if (used + 6 > size) return null;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let at = 0;
  for (const s of slices) {
    v.setUint32(at, s.length);
    out.set(s, at + 4);
    at += 4 + s.length;
  }
  const filler = size - at - 4;
  v.setUint32(at, filler);
  out.fill(0xff, at + 4, size);
  out[at + 4] = 12;
  out[size - 1] = 0x80;
  return out;
}

const isSlice = (nal: Uint8Array) => (nal[0] & 31) === 1 || (nal[0] & 31) === 5;

// One-frame MP4 with the stream's SPS and PPS, for the header, and a sample
// size with room for the largest of `probe` test frames plus a margin.
// tmpDir: where the one-frame template is written (the system's by default).
export async function prepare(p: LiveParams, probe = 30, margin = 1.25, tmpDir?: string): Promise<{ template: Uint8Array; sampleSize: number }> {
  // The MP4 muxer needs a seekable output for its header.
  const file = await Deno.makeTempFile({ suffix: ".mp4", dir: tmpDir });
  let template: Uint8Array;
  try {
    await run(ffmpegArgs(p, ["-frames:v", "1", "-movflags", "+faststart", file]), [render(p, 0)]);
    template = await Deno.readFile(file);
  } finally {
    await Deno.remove(file);
  }
  const frames = Array.from({ length: probe }, (_, n) => render(p, n));
  const nals = annexB(await run(ffmpegArgs(p, ["-f", "h264", "-"]), frames));
  let largest = 0, current = 0;
  for (const nal of nals) {
    if ((nal[0] & 31) === 9) {
      largest = Math.max(largest, current);
      current = 0;
    } else if (isSlice(nal)) current += 4 + nal.length;
  }
  largest = Math.max(largest, current);
  return { template, sampleSize: Math.ceil((largest * margin + 6) / 16) * 16 };
}

export function liveMp4(prepared: { template: Uint8Array; sampleSize: number }, fps: number, seconds: number) {
  const mp4 = new VirtualMp4(prepared.template, fps, seconds, prepared.sampleSize);
  if (mp4.sample.length !== prepared.sampleSize) throw new Error("template frame larger than the sample size");
  return mp4;
}

// Persistent encoder: write() frames in order, take() their samples in order.
export class LiveEncoder {
  private ff: Deno.ChildProcess;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private ready: (Uint8Array | null)[] = [];
  private waiting: ((s: Uint8Array | null) => void)[] = [];
  private slices: Uint8Array[] = [];
  private started = false;
  overflows = 0;

  constructor(p: LiveParams, readonly sampleSize: number) {
    this.ff = new Deno.Command("ffmpeg", { args: ffmpegArgs(p, ["-f", "h264", "-"]), stdin: "piped", stdout: "piped" }).spawn();
    this.writer = this.ff.stdin.getWriter();
    this.read();
  }

  private emit() {
    if (!this.started) return;
    const s = sample(this.slices, this.sampleSize);
    if (!s) this.overflows++;
    this.slices = [];
    const w = this.waiting.shift();
    if (w) w(s);
    else this.ready.push(s);
  }

  private async read() {
    let pending = new Uint8Array(0);
    try {
      for await (const chunk of this.ff.stdout) {
        const data = new Uint8Array(pending.length + chunk.length);
        data.set(pending);
        data.set(chunk, pending.length);
        // Keep the last NAL back: it may continue in the next chunk.
        const nals = annexB(data);
        const last = nals.pop();
        pending = last ? data.slice(last.byteOffset - data.byteOffset - 3) : new Uint8Array(0);
        for (const nal of nals) this.nal(nal);
      }
    } catch {
      // Closed.
    }
  }

  private nal(nal: Uint8Array) {
    const type = nal[0] & 31;
    if (type === 9) {
      // An access unit delimiter ends the previous frame.
      this.emit();
      this.started = true;
    } else if (isSlice(nal)) this.slices.push(nal.slice());
  }

  async write(frame: Uint8Array) {
    await this.writer.write(frame);
  }

  // The next frame's sample; frames come out one AUD late, so the caller keeps
  // the encoder at least one frame ahead of what it takes.
  take(): Promise<Uint8Array | null> {
    if (this.ready.length) return Promise.resolve(this.ready.shift()!);
    return new Promise((r) => this.waiting.push(r));
  }

  close() {
    this.writer.close().catch(() => {});
    try {
      this.ff.kill();
    } catch {
      // Already gone.
    }
  }
}

const now = () => performance.timeOrigin + performance.now();

export type LiveStream = {
  p: LiveParams;
  mp4: VirtualMp4;
  sampleSize: number;
  start: number; // the response's byte range
  end: number;
  lead: number; // frames sent at once, before real-time pacing
  render: (n: number) => Uint8Array; // frame n's luma, asked for just before it is encoded
  onFrame?: (n: number) => void; // frame n starts going out
  onEnd?: (ev: "done" | "abort", sent: number, ms: number, overflows: number) => void;
};

// A response body for bytes start..end of a live stream: the header, then each
// frame encoded when it is due.
export function liveStream(s: LiveStream): ReadableStream<Uint8Array> {
  const { p, mp4, sampleSize, start, end, lead } = s;
  const length = end - start + 1;
  const first = mp4.frameAt(Math.max(start, mp4.header.length))!;
  // The encoder runs two frames ahead of what is sent: a frame's sample only
  // appears when the next one starts.
  const encoder = new LiveEncoder(p, sampleSize);
  let written = first;
  const feed = async (upTo: number) => {
    while (written <= upTo) await encoder.write(s.render(written++));
  };
  const t0 = now();
  let sent = 0, closed = false, current = -1, last = mp4.sample;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const waitFor = (ms: number) => new Promise<void>((resolve) => {
    wake = resolve;
    timer = setTimeout(() => { timer = undefined; wake = undefined; resolve(); }, ms);
  });
  const finish = (ev: "done" | "abort") => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    wake?.();
    encoder.close();
    s.onEnd?.(ev, sent, now() - t0, encoder.overflows);
  };
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (sent >= length) {
        ctrl.close();
        finish("done");
        return;
      }
      if (closed) return;
      const position = start + sent;
      let chunk: Uint8Array;
      if (position < mp4.header.length) chunk = mp4.header.subarray(position, Math.min(mp4.header.length, end + 1));
      else {
        const n = mp4.frameAt(position)!;
        const due = t0 + Math.max(0, n - first - lead + 1) * 1000 / p.fps;
        while (!closed && due > now()) await waitFor(due - now());
        if (closed) return;
        if (n !== current) {
          try {
            await feed(n + 1);
            // A frame larger than the sample size repeats the last one: an erasure.
            last = (await encoder.take()) ?? last;
          } catch (e) {
            finish("abort");
            ctrl.error(e);
            return;
          }
          current = n;
          s.onFrame?.(n);
        }
        const off = (position - mp4.header.length) % sampleSize;
        chunk = last.subarray(off, Math.min(sampleSize, off + end + 1 - position));
      }
      sent += chunk.length;
      ctrl.enqueue(chunk);
    },
    cancel() {
      finish("abort");
    },
  }, { highWaterMark: 0 });
}
