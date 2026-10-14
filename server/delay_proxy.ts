// TCP proxy that emulates WAN round-trip time on localhost without root.
// The kernel completes the client's handshake at once, so the proxy models
// it instead: it connects upstream only one rtt after accepting, and drops
// the connection unsent if the client closes first, as a real connection
// abandoned mid-handshake would never send its request. After that every
// chunk is delayed by rtt/2 in each direction, order preserved.
//
//   deno task delay [--rtt 40] [--listen [HOST:]8788] [--target [HOST:]8787]
//
// With --rtt 0 it is a plain relay, e.g. on another machine:
//   deno run --allow-net delay_proxy.ts --rtt 0 --listen 0.0.0.0:5178 --target <server>:5177

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["rtt", "listen", "target"] });
const rtt = Number(args.rtt ?? 40);
if (!(rtt >= 0)) throw new Error("--rtt must be a nonnegative number of milliseconds");
// "[host:]port"; the host defaults to loopback.
const endpoint = (v: string) => {
  const m = v.match(/^(?:(.*):)?(\d+)$/);
  if (!m) throw new Error(`bad endpoint ${v}`);
  return { hostname: m[1] ?? "127.0.0.1", port: Number(m[2]) };
};
const listen = endpoint(args.listen ?? "8788");
const target = endpoint(args.target ?? "8787");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const close = (c: Deno.Conn) => {
  try {
    c.close();
  } catch {
    // Already closed.
  }
};

// Writes queued chunks to a destination once it exists, each at its due time.
// A null destination discards everything.
class DelayedWriter {
  private queue: { due: number; data: Uint8Array }[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  readonly done: Promise<void>;

  constructor(dst: Promise<Deno.Conn | null>) {
    this.done = this.run(dst);
  }

  push(due: number, data: Uint8Array) {
    this.queue.push({ due, data });
    this.notify();
  }

  end() {
    this.ended = true;
    this.notify();
  }

  private notify() {
    this.wake?.();
    this.wake = null;
  }

  private async run(dstPromise: Promise<Deno.Conn | null>) {
    const dst = await dstPromise.catch(() => null);
    if (!dst) return;
    while (!this.ended || this.queue.length) {
      const next = this.queue.shift();
      if (!next) {
        await new Promise<void>((r) => this.wake = r);
        continue;
      }
      const wait = next.due - performance.now();
      if (wait > 0) await sleep(wait);
      try {
        for (let at = 0; at < next.data.length;) at += await dst.write(next.data.subarray(at));
      } catch {
        return;
      }
    }
    try {
      await dst.closeWrite();
    } catch {
      // Already closed.
    }
  }
}

// Reads src into writer; each chunk is due `delay` ms after it was read, but
// never before `earliest`.
async function pipe(src: Deno.Conn, writer: DelayedWriter, delay: number, earliest: number) {
  const buf = new Uint8Array(64 * 1024);
  try {
    for (;;) {
      const n = await src.read(buf);
      if (n === null) break;
      writer.push(Math.max(performance.now() + delay, earliest), buf.slice(0, n));
    }
  } catch {
    // Reset or closed.
  }
  writer.end();
}

async function handle(client: Deno.Conn) {
  const opened = performance.now();
  let clientEnded = false;
  // The handshake takes one rtt; a client that gives up before then never
  // reaches the server.
  const upstreamPromise = (async () => {
    await sleep(rtt);
    return clientEnded ? null : await Deno.connect(target);
  })().catch(() => null);
  const toServer = new DelayedWriter(upstreamPromise);
  const readClient = pipe(client, toServer, rtt / 2, opened + rtt * 1.5).then(() => clientEnded = true);
  const upstream = await upstreamPromise;
  if (!upstream) {
    close(client);
    return;
  }
  const toClient = new DelayedWriter(Promise.resolve(client));
  const readServer = pipe(upstream, toClient, rtt / 2, 0);
  // WMF abandons connections on every seek; when either side ends, drop both
  // so the server sees the abort (after the delayed tail is delivered).
  await Promise.race([readClient.then(() => toServer.done), readServer.then(() => toClient.done)]);
  close(client);
  close(upstream);
}

console.log(`delay proxy ${listen.hostname}:${listen.port} -> ${target.hostname}:${target.port}, rtt ${rtt} ms`);
for await (const conn of Deno.listen(listen)) handle(conn);
