// IPv4 helpers for tests and logs: checksums, a few packets, a one-line summary.

export function checksum(b: Uint8Array, start = 0, end = b.length, initial = 0): number {
  let x = initial;
  for (let i = start; i < end; i += 2) x += (b[i] << 8) | (i + 1 < end ? b[i + 1] : 0);
  while (x >> 16) x = (x & 0xffff) + (x >> 16);
  return ~x & 0xffff;
}

const addr = (s: string) => s.split(".").map(Number);
export const dotted = (b: Uint8Array, at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

export function ipv4(proto: number, src: string, dst: string, payload: Uint8Array, id = 1): Uint8Array {
  const p = new Uint8Array(20 + payload.length);
  p.set([0x45, 0, p.length >> 8, p.length & 255, id >> 8, id & 255, 0x40, 0, 64, proto, 0, 0, ...addr(src), ...addr(dst)]);
  const c = checksum(p, 0, 20);
  p[10] = c >> 8;
  p[11] = c & 255;
  p.set(payload, 20);
  return p;
}

export function icmpEcho(src: string, dst: string, id: number, seq: number, data = new Uint8Array(8)): Uint8Array {
  const m = new Uint8Array(8 + data.length);
  m.set([8, 0, 0, 0, id >> 8, id & 255, seq >> 8, seq & 255]);
  m.set(data, 8);
  const c = checksum(m);
  m[2] = c >> 8;
  m[3] = c & 255;
  return ipv4(1, src, dst, m, seq);
}

// UDP with its checksum over the pseudo-header.
export function udp(src: string, dst: string, sport: number, dport: number, data: Uint8Array): Uint8Array {
  const u = new Uint8Array(8 + data.length);
  u.set([sport >> 8, sport & 255, dport >> 8, dport & 255, u.length >> 8, u.length & 255, 0, 0]);
  u.set(data, 8);
  const pseudo = new Uint8Array([...addr(src), ...addr(dst), 0, 17, u.length >> 8, u.length & 255]);
  const c = checksum(u, 0, u.length, (~checksum(pseudo) & 0xffff)) || 0xffff;
  u[6] = c >> 8;
  u[7] = c & 255;
  return ipv4(17, src, dst, u);
}

// "ICMP 10.0.0.1 > 1.1.1.1 echo", "TCP 1.2.3.4:80 > 10.0.0.1:5000 SYN ACK", ...
export function describe(p: Uint8Array): string {
  if (p.length < 20 || p[0] >> 4 !== 4) return `${p.length} bytes, not IPv4`;
  const hl = (p[0] & 15) * 4, proto = p[9], src = dotted(p, 12), dst = dotted(p, 16);
  const port = (at: number) => (p[hl + at] << 8) | p[hl + at + 1];
  if (proto === 1) return `ICMP ${src} > ${dst} ${({ 0: "echo reply", 8: "echo", 3: "unreachable", 11: "time exceeded" } as Record<number, string>)[p[hl]] ?? `type ${p[hl]}`}`;
  if (proto === 17) return `UDP ${src}:${port(0)} > ${dst}:${port(2)} ${p.length - hl - 8} bytes`;
  if (proto === 6) {
    const f = p[hl + 13];
    const flags = ["FIN", "SYN", "RST", "PSH", "ACK"].filter((_, i) => f & (1 << i)).join(" ");
    return `TCP ${src}:${port(0)} > ${dst}:${port(2)} ${flags} ${p.length - hl - (p[hl + 12] >> 4) * 4} bytes`;
  }
  return `proto ${proto} ${src} > ${dst}`;
}
