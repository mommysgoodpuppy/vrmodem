import { assert, assertEquals } from "jsr:@std/assert@1";
import { Passt } from "./passt.ts";
import { describe, dotted, udp } from "./ip.ts";

const wait = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, j) => setTimeout(() => j(new Error("timed out")), ms))]);

Deno.test("passt: UDP out to a host service and back, and an inbound TCP forward", async () => {
  // A UDP echo on this host, reached through the gateway address.
  const echo = Deno.listenDatagram({ transport: "udp", hostname: "127.0.0.1", port: 0 });
  const port = (echo.addr as Deno.NetAddr).port;
  (async () => {
    for await (const [data, from] of echo) await echo.send(data, from);
  })().catch(() => {});
  const forward = 20000 + Math.floor(Math.random() * 20000);
  const got: Uint8Array[] = [];
  let arrived = () => {};
  const passt = new Passt({ address: "10.0.0.7", tcp: [`${forward}:80`] }, (ip) => {
    got.push(ip);
    arrived();
  });
  try {
    await passt.ready;
    const next = () => new Promise<void>((r) => (arrived = r));
    let p = next();
    passt.send(udp("10.0.0.7", "10.0.255.254", 4000, port, new TextEncoder().encode("hello")));
    await wait(p, 3000);
    const reply = got.shift()!;
    assertEquals(describe(reply), `UDP 10.0.255.254:${port} > 10.0.0.7:4000 5 bytes`);
    assertEquals(new TextDecoder().decode(reply.subarray(28)), "hello");
    // Someone connects to the forwarded port: the guest gets a SYN for port 80.
    p = next();
    const c = Deno.connect({ hostname: "127.0.0.1", port: forward }).catch(() => null);
    await wait(p, 3000);
    const syn = got.shift()!;
    assert(describe(syn).includes("> 10.0.0.7:80 SYN"), describe(syn));
    assertEquals(dotted(syn, 16), "10.0.0.7");
    (await c)?.close();
  } finally {
    passt.close();
    echo.close();
  }
});
