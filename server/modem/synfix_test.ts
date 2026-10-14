import { assertEquals } from "jsr:@std/assert@1";
import { checksum, ipv4 } from "./ip.ts";
import { SynFix } from "./synfix.ts";

const GW = "10.0.255.254", MACHINE = "10.0.0.1";

function tcp(src: string, dst: string, sport: number, dport: number, seq: number, ack: number, flags: number, data = new Uint8Array()) {
  const t = new Uint8Array(20 + data.length);
  const v = new DataView(t.buffer);
  v.setUint16(0, sport);
  v.setUint16(2, dport);
  v.setUint32(4, seq);
  v.setUint32(8, ack);
  t[12] = 5 << 4;
  t[13] = flags;
  v.setUint16(14, 65535);
  t.set(data, 20);
  const a = [...src.split(".").map(Number), ...dst.split(".").map(Number)];
  const pseudo = new Uint8Array([...a, 0, 6, t.length >> 8, t.length & 255]);
  v.setUint16(16, checksum(t, 0, t.length, ~checksum(pseudo) & 0xffff));
  return ipv4(6, src, dst, t);
}

const field = (p: Uint8Array, at: number) => new DataView(p.buffer, p.byteOffset).getUint32(20 + at);
// a TCP checksum over the pseudo-header comes out 0 when it is right
function tcpOk(p: Uint8Array) {
  const pseudo = new Uint8Array([...p.subarray(12, 20), 0, 6, (p.length - 20) >> 8, (p.length - 20) & 255]);
  return checksum(p, 20, p.length, ~checksum(pseudo) & 0xffff) === 0;
}

Deno.test("a SYN sent again is dropped, and the connection's numbers are put back", () => {
  const f = new SynFix();
  // passt: SYN 1000, then again 1001 a second later
  assertEquals(f.down(tcp(GW, MACHINE, 40000, 22, 1000, 0, 2), 0) !== null, true);
  assertEquals(f.down(tcp(GW, MACHINE, 40000, 22, 1001, 0, 2), 1000), null);
  // the machine answers the first: SYN ACK acknowledging 1001; passt expects 1002
  const synack = f.up(tcp(MACHINE, GW, 22, 40000, 5000, 1001, 18), 1100)!;
  assertEquals(field(synack, 8), 1002);
  assertEquals(tcpOk(synack), true);
  // passt's data starts at 1002; the machine expects 1001
  const data = f.down(tcp(GW, MACHINE, 40000, 22, 1002, 5001, 24, new TextEncoder().encode("SSH-2.0-x\r\n")), 1200)!;
  assertEquals(field(data, 4), 1001);
  assertEquals(tcpOk(data), true);
  const ack = f.up(tcp(MACHINE, GW, 22, 40000, 5001, 1012, 16), 1300);
  assertEquals(field(ack, 8), 1013);
  assertEquals(f.dropped, 1);
});

Deno.test("a connection whose SYN went once is left alone", () => {
  const f = new SynFix();
  const syn = tcp(GW, MACHINE, 40001, 23, 7, 0, 2);
  assertEquals(f.down(syn, 0), syn);
  const data = tcp(GW, MACHINE, 40001, 23, 8, 99, 24, new Uint8Array([1, 2, 3]));
  assertEquals(f.down(data, 10), data);
  const out = tcp(MACHINE, "1.1.1.1", 5000, 80, 1, 2, 16);
  assertEquals(f.up(out, 20), out);
});

Deno.test("a reset forgets the connection; a new SYN on its ports is a new one", () => {
  const f = new SynFix();
  f.down(tcp(GW, MACHINE, 40002, 22, 100, 0, 2), 0);
  f.down(tcp(GW, MACHINE, 40002, 22, 101, 0, 2), 1000);
  f.up(tcp(MACHINE, GW, 22, 40002, 0, 101, 4 | 16), 1100);
  assertEquals(f.size, 0);
  const syn = tcp(GW, MACHINE, 40002, 22, 102, 0, 2);
  assertEquals(f.down(syn, 2000), syn);
});
