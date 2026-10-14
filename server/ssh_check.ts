// SSH to the world's machine through the modem: the gateway's port forwarded to the machine's
// dropbear (run_probe --forward s1:tcp:2223:22), with ssh(1) and a key the machine was given
// (ShaderEmu's SHADEREMU_MODEM_SSH_KEY). Times the login, then a few commands' round trips in
// one session (a shell on ssh's standard input: no terminal, so no echo, a reply each).
//
//   deno run --allow-run=ssh --allow-read ssh_check.ts [--port 2223] [--host 127.0.0.1] [--key ../logs/ssh/id] [--user root] [--wait 300]

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["host", "port", "key", "wait", "user"] });
const host = args.host ?? "127.0.0.1", port = args.port ?? "2223", user = args.user ?? "root";
const key = args.key ?? new URL("../logs/ssh/id", import.meta.url).pathname;
const enc = new TextEncoder(), dec = new TextDecoder();
const now = () => performance.now();
const secs = (ms: number) => (ms / 1000).toFixed(2);

// The host key is made at the first connection and is new at every boot: not kept.
const ssh = (...rest: string[]) =>
  new Deno.Command("ssh", {
    args: ["-p", port, "-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=120", `${user}@${host}`, ...rest],
    stdin: "piped", stdout: "piped", stderr: "piped",
  });

// Until dropbear runs the connection is refused or closed: try again.
const t0 = now(), deadline = t0 + Number(args.wait ?? 300) * 1000;
let login = 0;
while (true) {
  const t = now();
  const p = ssh("echo", "SSH-OK").spawn();
  p.stdin.close();
  const out = await p.output();
  if (dec.decode(out.stdout).includes("SSH-OK")) {
    login = now() - t;
    break;
  }
  if (now() > deadline) {
    console.log(`no ssh at ${host}:${port} after ${secs(now() - t0)} s: ${dec.decode(out.stderr).trim()}`);
    Deno.exit(1);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(`ssh after ${secs(now() - t0)} s, a login and a command took ${secs(login)} s`);

const p = ssh("sh").spawn();
const writer = p.stdin.getWriter();
const reader = p.stdout.getReader();
let text = "";
let closed = false;
(async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  closed = true;
})();

async function until(pattern: RegExp, ms: number) {
  const end = now() + ms;
  while (now() < end && !closed && !pattern.test(text)) await new Promise((r) => setTimeout(r, 10));
  return pattern.test(text);
}

// The session is up when its first command answers.
const opened = now();
await writer.write(enc.encode("echo READY\n"));
if (!await until(/READY/, 120000)) {
  console.log("the session did not answer");
  Deno.exit(1);
}
console.log(`a session opened in ${secs(now() - opened)} s`);

let failed = false;
for (const [cmd, expect] of [
  ["echo SHADER-$((6*7))", /SHADER-42/],
  ["uname -sm", /Linux riscv/],
  [":", null],
  ["ifconfig lan0 | grep 'inet addr'", /inet addr:10\.0\./],
] as [string, RegExp | null][]) {
  text = "";
  const sent = now();
  // Each command ends with a marker: a command with no output is timed too.
  await writer.write(enc.encode(`${cmd}; echo END\n`));
  const ok = await until(/END\n/, 30000) && (!expect || expect.test(text));
  console.log(`${ok ? "ok" : "FAILED"} ${secs(now() - sent)} s  ${cmd}  ->  ${text.replace(/END\n$/, "").trim().replace(/\n/g, " | ")}`);
  if (!ok) failed = true;
}
await writer.close();
await p.status;
Deno.exit(failed ? 1 : 0);
