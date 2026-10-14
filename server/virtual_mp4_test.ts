import { VirtualMp4 } from "./virtual_mp4.ts";

function assert(ok: boolean, message = "assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}
function equal(a: Uint8Array, b: Uint8Array) {
  assert(a.length === b.length && a.every((v, i) => v === b[i]), "bytes differ");
}
async function command(cmd: string, args: string[]) {
  const result = await new Deno.Command(cmd, { args }).output();
  assert(result.code === 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

Deno.test("virtual MP4 tables, arbitrary ranges, duration and H.264 decoding", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const source = `${dir}/frame.mp4`;
    await command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x64:r=60", "-frames:v", "1", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-x264-params", "keyint=1:scenecut=0", source]);
    const bytes = await Deno.readFile(source);
    const short = new VirtualMp4(bytes, 60, 2);
    assert(short.sample.length === 128);
    assert(short.frameAt(short.header.length - 1) === null);
    assert(short.frameAt(short.header.length + 127) === 0);
    assert(short.frameAt(short.size - 1) === 119);
    const full = short.read(0, short.size);
    for (let off = 0; off < full.length; off += 37) {
      const length = Math.min(311, full.length - off);
      equal(short.read(off, length), full.subarray(off, off + length));
    }
    await Deno.writeFile(`${dir}/virtual.mp4`, full);
    const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-show_streams", "-show_packets", "-of", "json", `${dir}/virtual.mp4`]));
    assert(probe.streams.length === 1);
    assert(probe.streams[0].nb_frames === "120" && Number(probe.streams[0].duration) === 2);
    assert(probe.packets.length === 120);
    probe.packets.forEach((p: { pos: string; flags: string }, i: number) => {
      assert(Number(p.pos) === short.header.length + i * 128 && p.flags.includes("K"));
    });
    await command("ffmpeg", ["-v", "error", "-xerror", "-i", `${dir}/virtual.mp4`, "-f", "null", "-"]);
    const long = new VirtualMp4(bytes, 60, 3600);
    assert(long.frames === 216000 && long.header.length === short.header.length);
    // Sparse file validates the hour-long tables without synthesizing 27 MB.
    const file = await Deno.open(`${dir}/long.mp4`, { create: true, write: true });
    await file.write(long.header);
    await file.truncate(long.size);
    file.close();
    const info = JSON.parse(await command("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=nb_frames", "-of", "json", `${dir}/long.mp4`]));
    assert(Number(info.format.duration) === 3600 && info.streams[0].nb_frames === "216000");
    for (const [fps, seconds] of [[0, 1], [60, 0], [60, 0.001], [60, Infinity], [241, 1]]) {
      let threw = false;
      try { new VirtualMp4(bytes, fps, seconds); } catch (e) { threw = e instanceof RangeError; }
      assert(threw, `accepted invalid options ${fps}, ${seconds}`);
    }
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("HTTP ranges, pacing, cancellation and frame logs", async () => {
  const dir = await Deno.makeTempDir();
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  let process: Deno.ChildProcess | undefined;
  try {
    await Deno.mkdir(`${dir}/server`);
    await Deno.mkdir(`${dir}/media`);
    for (const name of ["main.ts", "virtual_mp4.ts", "deno.lock"]) {
      await Deno.copyFile(new URL(name, import.meta.url), `${dir}/server/${name}`);
    }
    await command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x64:r=60", "-frames:v", "1", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-x264-params", "keyint=1:scenecut=0", `${dir}/media/frame-64.mp4`]);
    process = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", `${dir}/server/main.ts`],
      env: { PORT: String(port), HOST: "127.0.0.1", LOG_PATH: `${dir}/server.jsonl` },
      stdout: "null", stderr: "inherit",
    }).spawn();
    const base = `http://127.0.0.1:${port}/v/avpro/probe.mp4`;
    for (let n = 0; ; n++) {
      try { await (await fetch(base, { method: "HEAD" })).arrayBuffer(); break; }
      catch (e) { if (n > 100) throw e; await new Promise((r) => setTimeout(r, 20)); }
    }
    const movie = new VirtualMp4(await Deno.readFile(`${dir}/media/frame-64.mp4`), 60, 3600);
    const head = await fetch(base, { method: "HEAD" });
    assert(head.status === 200 && head.headers.get("content-length") === String(movie.size));
    assert(head.headers.get("accept-ranges") === "bytes" && head.headers.get("content-type") === "video/mp4");
    assert((await head.arrayBuffer()).byteLength === 0);
    for (const [range, start, end] of [
      ["bytes=0-127", 0, 127],
      [`bytes=${movie.header.length + 123 * 128}-${movie.header.length + 125 * 128 - 1}`, movie.header.length + 123 * 128, movie.header.length + 125 * 128 - 1],
      [`bytes=${movie.size - 173}-`, movie.size - 173, movie.size - 1],
      ["bytes=-81", movie.size - 81, movie.size - 1],
    ] as [string, number, number][]) {
      const res = await fetch(base + "?pace=0", { headers: { range, "user-agent": "Chrome test preflight" } });
      assert(res.status === 206 && res.headers.get("content-range") === `bytes ${start}-${end}/${movie.size}`);
      equal(new Uint8Array(await res.arrayBuffer()), movie.read(start, end - start + 1));
    }
    const unsat = await fetch(base, { headers: { range: `bytes=${movie.size}-` } });
    assert(unsat.status === 416 && unsat.headers.get("content-range") === `bytes */${movie.size}`);
    await unsat.arrayBuffer();
    for (const query of ["fps=0", "seconds=-1", "lead=-1", "pace=NaN"]) {
      const res = await fetch(`${base}?${query}`);
      assert(res.status === 400);
      await res.arrayBuffer();
    }
    const start = movie.header.length;
    const t = performance.now();
    const paced = await fetch(`${base}?fps=10&seconds=10&lead=2&pace=1`, {
      headers: { range: `bytes=${start}-${start + 5 * 128 - 1}` },
    });
    assert((await paced.arrayBuffer()).byteLength === 640);
    assert(performance.now() - t >= 270, "remaining three frames were not paced");
    const abort = new AbortController();
    const res = await fetch(`${base}?lead=1&pace=0.00001`, {
      signal: abort.signal, headers: { range: `bytes=${start}-` },
    });
    const reader = res.body!.getReader();
    await reader.read();
    abort.abort();
    try { await reader.cancel(); } catch { /* aborted fetch */ }
    await new Promise((r) => setTimeout(r, 50));
    const healthy = await fetch(base, { method: "HEAD" });
    assert(healthy.status === 200);
    await healthy.arrayBuffer();
    const logs = (await Deno.readTextFile(`${dir}/server.jsonl`)).trim().split("\n").map((l) => JSON.parse(l));
    assert(logs.some((e) => e.ev === "res" && e.frame === 123 && e.session === "avpro"));
    assert(logs.some((e) => e.ev === "res" && e.start === 0 && e.frame === null));
    assert(logs.some((e) => e.ev === "abort") && logs.some((e) => e.ev === "done"));
  } finally {
    if (process) { process.kill("SIGTERM"); await process.status; }
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("analyzer grades by session and ignores Chrome preflights", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const t = Date.parse("2026-10-14T10:00:00Z");
    const events = [
      { ev: "req", id: 1, t: t + 10, remote: "test", method: "GET", path: "/v/avpro/probe.mp4", headers: { range: "bytes=100-", "user-agent": "Chrome" } },
      { ev: "res", id: 1, t: t + 11, status: 206, session: "avpro", frame: 999 },
      { ev: "req", id: 2, t: t + 20, remote: "test", method: "GET", path: "/v/unity/probe.mp4", headers: { range: "bytes=100-", "user-agent": "WMFSDK" } },
      { ev: "res", id: 2, t: t + 21, status: 206, session: "unity", frame: 100 },
      { ev: "req", id: 3, t: t + 30, remote: "test", method: "GET", path: "/v/avpro/probe.mp4", headers: { range: "bytes=100-", "user-agent": "WMFSDK" } },
      { ev: "res", id: 3, t: t + 31, status: 206, session: "avpro", frame: 600 },
    ];
    await Deno.writeTextFile(`${dir}/server.jsonl`, events.map((e) => JSON.stringify(e)).join("\n"));
    await Deno.writeTextFile(`${dir}/vrchat-probe.log`, [
      "[ModemProbe] 09:59:59.000 Probe AVPro load http://localhost/v/avpro/probe.mp4",
      "[ModemProbe] 09:59:59.000 Probe Unity load http://localhost/v/unity/probe.mp4",
      "[ModemProbe] 10:00:00.000 Probe AVPro seek 10.008333 frame=600 from pos=1",
      "[ModemProbe] 10:00:00.000 Probe Unity seek 2.008333 frame=120 from pos=1",
      "[ModemProbe] 10:00:01.000 Probe AVPro seek 20.008333 frame=1200 from pos=10",
    ].join("\n"));
    const out = await command(Deno.execPath(), ["run", "-A", new URL("analyze.ts", import.meta.url).pathname, dir]);
    assert(out.includes("Virtual seeks: 1/3 matched"));
    assert(out.includes("PASS expected=600 actual=600 latency=30.0 ms"));
    assert(out.includes("MISMATCH expected=120 actual=100"));
    assert(out.includes("NO REQUEST expected=1200"));
  } finally { await Deno.remove(dir, { recursive: true }); }
});
