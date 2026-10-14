// TCP proxy that emulates WAN round-trip time on localhost without root.
// Every chunk is delayed by rtt/2 in each direction, order preserved, and a
// connection's first upstream chunk waits one extra rtt, standing in for the
// handshake the client would otherwise pay before sending its request.
//
//   deno task delay [--rtt 40] [--listen 8788] [--target 8787]

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["rtt", "listen", "target"] });
const rtt = Number(args.rtt ?? 40);
const listen = Number(args.listen ?? 8788);
const target = Number(args.target ?? 8787);
if (!(rtt >= 0)) throw new Error("--rtt must be a nonnegative number of milliseconds");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Copies src to dst, delivering each chunk `delay` ms after it was read.
async function pipe(src: Deno.Conn, dst: Deno.Conn, delay: number, firstExtra: number) {
  const queue: { due: number; data: Uint8Array }[] = [];
  let reading = true;
  let wake = null as (() => void) | null;
  const writer = (async () => {
    while (reading || queue.length) {
      const next = queue.shift();
      if (!next) {
        await new Promise<void>((r) => wake = r);
        continue;
      }
      const wait = next.due - performance.now();
      if (wait > 0) await sleep(wait);
      try {
        for (let at = 0; at < next.data.length;) at += await dst.write(next.data.subarray(at));
      } catch {
        // The receiver is gone; stop reading so the queue cannot grow.
        try {
          src.close();
        } catch {
          // Already closed.
        }
        return;
      }
    }
  })();
  const buf = new Uint8Array(64 * 1024);
  let first = true;
  try {
    for (;;) {
      const n = await src.read(buf);
      if (n === null) break;
      queue.push({ due: performance.now() + delay + (first ? firstExtra : 0), data: buf.slice(0, n) });
      first = false;
      wake?.();
      wake = null;
    }
  } catch {
    // Reset by the peer; the other direction closes below.
  }
  reading = false;
  wake?.();
  await writer;
  try {
    await dst.closeWrite();
  } catch {
    // Already closed.
  }
}

async function handle(client: Deno.Conn) {
  let upstream: Deno.Conn;
  try {
    upstream = await Deno.connect({ hostname: "127.0.0.1", port: target });
  } catch {
    client.close();
    return;
  }
  // WMF abandons connections on every seek; when either side ends, drop both
  // so the server sees the abort (after the delayed tail is delivered).
  const pipes = [pipe(client, upstream, rtt / 2, rtt), pipe(upstream, client, rtt / 2, 0)];
  await Promise.race(pipes);
  for (const c of [client, upstream]) {
    try {
      c.close();
    } catch {
      // Already closed.
    }
  }
}

console.log(`delay proxy 127.0.0.1:${listen} -> 127.0.0.1:${target}, rtt ${rtt} ms`);
for await (const conn of Deno.listen({ hostname: "127.0.0.1", port: listen })) handle(conn);
