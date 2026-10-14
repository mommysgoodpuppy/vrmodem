// One machine's way to the internet: a passt process (userspace NAT, no root)
// that sees the machine as a guest behind a virtual Ethernet. Bare IPv4
// packets go in and come out; this side adds and strips the Ethernet header
// and answers passt's ARP for the guest.
//
// passt speaks qemu's stream protocol on a UNIX socket: each frame after a
// 32-bit big-endian length.

const GUEST_MAC = [0x02, 0x76, 0x72, 0x6d, 0x00, 0x01]; // locally administered
const PASST_MAC = [0x9a, 0x55, 0x9a, 0x55, 0x9a, 0x55]; // passt's default

export type PasstOptions = {
  address: string; // the guest's, e.g. 10.0.0.1
  gateway?: string; // in the guest's /16; mapped to this host (and its DNS)
  tcp?: string[]; // inbound TCP forwards, passt's -t specs, e.g. "8080:80"
  udp?: string[];
  dir?: string; // where the socket goes
};

export class Passt {
  private proc!: Deno.ChildProcess;
  private conn!: Deno.UnixConn;
  private closed = false;
  readonly ready: Promise<void>;
  sent = 0;
  received = 0;

  constructor(private o: PasstOptions, private onPacket: (ip: Uint8Array) => void, private onExit?: (code: number) => void) {
    this.ready = this.start();
  }

  private async start() {
    const dir = this.o.dir ?? await Deno.makeTempDir({ prefix: "vrmodem-passt-" });
    const socket = `${dir}/passt-${this.o.address}.sock`;
    await Deno.remove(socket).catch(() => {});
    const gateway = this.o.gateway ?? "10.0.255.254";
    const args = [
      "--foreground", "--quiet", "--one-off", "--ipv4-only", "--socket", socket,
      "--address", this.o.address, "--netmask", "16", "--gateway", gateway, "--dns-forward", gateway,
      "--no-dhcp", "--no-ndp", "--no-ra", "--no-dhcpv6", "--mtu", "576",
      ...(this.o.tcp?.length ? ["-t", this.o.tcp.join(",")] : ["-t", "none"]),
      ...(this.o.udp?.length ? ["-u", this.o.udp.join(",")] : ["-u", "none"]),
    ];
    this.proc = new Deno.Command("passt", { args, stdout: "null", stderr: "piped" }).spawn();
    this.proc.status.then((s) => {
      this.closed = true;
      this.onExit?.(s.code);
    });
    // passt makes the socket once it is set up.
    for (let i = 0; ; i++) {
      try {
        this.conn = await Deno.connect({ transport: "unix", path: socket });
        break;
      } catch (e) {
        if (i > 100 || this.closed) throw new Error(`passt did not start: ${e}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    this.read();
    // passt learns the guest's MAC from what it sends: say something now so
    // that packets for the guest can come before the guest speaks.
    this.arp(1, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff], [0, 0, 0, 0, 0, 0], gateway);
  }

  private async read() {
    let pending = new Uint8Array(0);
    const buf = new Uint8Array(65536 + 4);
    try {
      while (true) {
        const n = await this.conn.read(buf);
        if (n === null) break;
        const data = new Uint8Array(pending.length + n);
        data.set(pending);
        data.set(buf.subarray(0, n), pending.length);
        let at = 0;
        while (at + 4 <= data.length) {
          const len = new DataView(data.buffer, at).getUint32(0);
          if (at + 4 + len > data.length) break;
          this.ethernet(data.subarray(at + 4, at + 4 + len));
          at += 4 + len;
        }
        pending = data.slice(at);
      }
    } catch {
      // Closed.
    }
  }

  private ethernet(frame: Uint8Array) {
    if (frame.length < 14) return;
    const type = (frame[12] << 8) | frame[13];
    if (type === 0x0800 && frame.length >= 34) {
      // Short frames are padded to Ethernet's 60 bytes: the IP length counts.
      const length = (frame[16] << 8) | frame[17];
      if (length < 20 || 14 + length > frame.length) return;
      this.received++;
      this.onPacket(frame.slice(14, 14 + length));
    } else if (type === 0x0806 && frame.length >= 42 && frame[21] === 1) {
      // A request: is the guest's address ours? Answer for the guest.
      const target = [...frame.subarray(38, 42)].join(".");
      const mac = [...frame.subarray(22, 28)];
      if (target === this.o.address) this.arp(2, mac, mac, [...frame.subarray(28, 32)].join("."));
    }
  }

  // An ARP request (op 1) or reply (op 2) from the guest's address.
  private arp(op: number, dstMac: number[], targetMac: number[], targetIp: string) {
    const ip = (s: string) => s.split(".").map(Number);
    const f = new Uint8Array(42);
    f.set(dstMac, 0);
    f.set(GUEST_MAC, 6);
    f.set([0x08, 0x06, 0, 1, 0x08, 0, 6, 4, 0, op], 12);
    f.set(GUEST_MAC, 22);
    f.set(ip(this.o.address), 28);
    f.set(targetMac, 32);
    f.set(ip(targetIp), 38);
    this.write(f);
  }

  private write(frame: Uint8Array) {
    if (this.closed || !this.conn) return;
    const msg = new Uint8Array(4 + frame.length);
    new DataView(msg.buffer).setUint32(0, frame.length);
    msg.set(frame, 4);
    // Unix stream writes of this size go whole; an error means passt is gone.
    this.conn.write(msg).catch(() => {});
  }

  // An IPv4 packet from the guest.
  send(ip: Uint8Array) {
    if (ip.length < 20 || ip[0] >> 4 !== 4) return;
    const f = new Uint8Array(14 + ip.length);
    f.set(PASST_MAC, 0);
    f.set(GUEST_MAC, 6);
    f.set([0x08, 0x00], 12);
    f.set(ip, 14);
    this.sent++;
    this.write(f);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.conn?.close();
    } catch {
      // Already closed.
    }
    try {
      this.proc.kill();
    } catch {
      // Already gone.
    }
  }
}
