// A shell on the world's machine through the modem: connects to a gateway
// port forwarded to the machine's telnetd (run_probe --forward s1:tcp:2222:23),
// waits for the prompt, runs a few commands and times each round trip.
//
//   deno run --allow-net shell_check.ts [--port 2222] [--host 127.0.0.1] [--wait 300]
//   deno run --allow-net shell_check.ts --interactive     (your terminal, line by line)

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["host", "port", "wait"], boolean: ["interactive"] });
const host = args.host ?? "127.0.0.1", port = Number(args.port ?? 2222);
const enc = new TextEncoder(), dec = new TextDecoder();
const now = () => performance.now();

// The forward exists as soon as the gateway does; telnetd only once the test
// has started it. Until then the connection closes at once: try again.
const deadline = now() + Number(args.wait ?? 300) * 1000;
let conn: Deno.TcpConn | undefined;
let text = "";
let reader: Promise<void> | undefined;
let closed = false;

// Telnet's option negotiation (IAC ...) is refused; everything else is text.
function strip(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 255) out.push(b[i]);
    else if (b[i + 1] === 255) out.push(255), i++;
    else if (b[i + 1] >= 251 && b[i + 1] <= 254) {
      // DO -> WONT, WILL -> DONT
      const reply = b[i + 1] === 253 ? 252 : b[i + 1] === 251 ? 254 : 0;
      if (reply) conn!.write(new Uint8Array([255, reply, b[i + 2]])).catch(() => {});
      i += 2;
    } else i += 1;
  }
  return new Uint8Array(out);
}

async function read() {
  const buf = new Uint8Array(4096);
  while (true) {
    const n = await conn!.read(buf).catch(() => null);
    if (!n) break;
    const t = dec.decode(strip(buf.subarray(0, n)));
    text += t;
    if (args.interactive) await Deno.stdout.write(enc.encode(t));
  }
  closed = true;
}

async function until(pattern: RegExp, ms: number) {
  const end = now() + ms;
  while (now() < end && !closed) {
    if (pattern.test(text)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pattern.test(text);
}

const t0 = now();
while (now() < deadline) {
  try {
    conn = await Deno.connect({ hostname: host, port });
    closed = false;
    text = "";
    reader = read();
    if (await until(/[#$] ?$/m, 30000)) break;
    conn.close();
  } catch {
    // Nothing listening yet.
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!conn || closed || !/[#$] ?$/m.test(text)) {
  console.log(`no shell at ${host}:${port} after ${((now() - t0) / 1000).toFixed(0)} s`);
  Deno.exit(1);
}
console.log(`shell after ${((now() - t0) / 1000).toFixed(1)} s`);

if (args.interactive) {
  for await (const chunk of Deno.stdin.readable) await conn.write(chunk);
  Deno.exit(0);
}

let failed = false;
for (const [cmd, expect] of [
  ["echo SHADER-$((6*7))", /SHADER-42/],
  ["uname -sm", /Linux riscv/],
  ["cat /proc/cpuinfo | grep -c processor", /^\d+\s*$/m],
  ["ifconfig lan0 | grep 'inet addr'", /inet addr:10\.0\./],
] as [string, RegExp][]) {
  text = "";
  const sent = now();
  await conn.write(enc.encode(cmd + "\r\n"));
  const ok = await until(expect, 20000) && await until(/[#$] ?$/m, 20000);
  const out = text.replace(/\r/g, "").split("\n").slice(1, -1).join(" | ");
  console.log(`${ok ? "ok" : "FAILED"} ${((now() - sent) / 1000).toFixed(2)} s  ${cmd}  ->  ${out}`);
  if (!ok) failed = true;
}
conn.close();
await reader;
Deno.exit(failed ? 1 : 0);
