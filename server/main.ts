// Probe server: serves test media and logs every request plus the timing of
// every chunk the client pulls. The log is the measurement; see ../README.md.
//
//   deno task serve            # 127.0.0.1:8787
//   HOST=0.0.0.0 PORT=9000 deno task serve
//   LOG_PATH=/some/file.jsonl overrides the per-run log file
//
// URLs: /s/<session>/<media path>[?kbps=N]
//   <session> is free-form and only used to group log lines.
//   kbps caps the send rate for that response so the player can't buffer far
//   ahead (needed for the pause / consumption-rate channel).

import { extname, join, normalize } from "jsr:@std/path@1";
import { VirtualMp4 } from "./virtual_mp4.ts";

const HOST = Deno.env.get("HOST") ?? "127.0.0.1";
const PORT = Number(Deno.env.get("PORT") ?? 8787);
const MEDIA_DIR = new URL("../media/", import.meta.url).pathname;
const LOG_DIR = new URL("../logs/", import.meta.url).pathname;
const CHUNK = 16 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
};

await Deno.mkdir(LOG_DIR, { recursive: true });
const logPath = Deno.env.get("LOG_PATH") ??
  join(LOG_DIR, `${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
const logFile = await Deno.open(logPath, { create: true, append: true });
const enc = new TextEncoder();

const now = () => performance.timeOrigin + performance.now(); // epoch ms, sub-ms
let nextId = 1;

function log(ev: Record<string, unknown>) {
  logFile.writeSync(enc.encode(JSON.stringify({ t: now(), ...ev }) + "\n"));
}

function stamp(t = now()) {
  return new Date(t).toISOString().slice(11, 23);
}

type Range = { start: number; end: number } | "unsatisfiable" | null;

// Single ranges only; anything else is served whole.
function parseRange(header: string | null, size: number): Range {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number, end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function index(): Response {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of Deno.readDirSync(dir)) {
      if (e.isDirectory) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (/\.(mp4|m3u8)$/.test(e.name)) files.push(prefix + e.name);
    }
  };
  try {
    walk(MEDIA_DIR, "");
  } catch {
    // no media generated yet
  }
  const base = `http://${HOST === "0.0.0.0" ? "<this-host>" : HOST}:${PORT}/s/<session>/`;
  const body = files.length
    ? files.sort().map((f) => base + f).join("\n")
    : "no media yet: run `deno task gen`";
  return new Response(body + "\n" + base.replace("/s/", "/v/") + "probe.mp4?fps=60&seconds=3600&lead=30&pace=1\n", { headers: { "content-type": "text/plain" } });
}

let sourceFrame: Uint8Array | undefined;

async function serveFile(req: Request, id: number, session: string, rel: string, kbps: number, url?: URL) {
  let virtual: VirtualMp4 | undefined;
  let lead = 0, pace = 0;
  if (url) {
    const fps = Number(url.searchParams.get("fps") ?? 60);
    const seconds = Number(url.searchParams.get("seconds") ?? 3600);
    lead = Number(url.searchParams.get("lead") ?? 30);
    pace = Number(url.searchParams.get("pace") ?? 1);
    if (!Number.isSafeInteger(lead) || lead < 0 || !Number.isFinite(pace) || pace < 0) {
      log({ ev: "res", id, status: 400, session });
      return new Response("lead must be a nonnegative integer; pace must be finite and nonnegative", { status: 400 });
    }
    try {
      sourceFrame ??= await Deno.readFile(join(MEDIA_DIR, "frame-64.mp4"));
      virtual = new VirtualMp4(sourceFrame, fps, seconds);
    } catch (e) {
      const status = e instanceof RangeError ? 400 : 503;
      log({ ev: "res", id, status, session });
      return new Response(status === 400 ? String(e) : "virtual source unavailable: run deno task gen", { status });
    }
  }
  const path = normalize(join(MEDIA_DIR, rel));
  if (!path.startsWith(MEDIA_DIR)) return new Response("bad path", { status: 400 });

  let size: number;
  if (virtual) size = virtual.size;
  else {
    try {
      const stat = await Deno.stat(path);
      if (!stat.isFile) throw new Error();
      size = stat.size;
    } catch {
      log({ ev: "res", id, status: 404 });
      return new Response("not found", { status: 404 });
    }
  }
  const range = parseRange(req.headers.get("range"), size);
  const headers = new Headers({
    "content-type": virtual ? "video/mp4" : CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });

  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    log({ ev: "res", id, status: 416, size });
    console.log(`${stamp()} #${id} 416`);
    return new Response(null, { status: 416, headers });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = end - start + 1;
  const status = range ? 206 : 200;
  headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${start}-${end}/${size}`);
  log({ ev: "res", id, status, session, start, end, size, kbps, ...(virtual ? { frame: virtual.frameAt(start), fps: virtual.fps, frames: virtual.frames, lead, pace } : {}) });

  if (req.method === "HEAD") return new Response(null, { status, headers });

  const file = virtual ? undefined : await Deno.open(path);
  await file?.seek(start, Deno.SeekMode.Start);
  const t0 = now();
  let sent = 0;
  let closed = false;
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
    file?.close();
    const ms = now() - t0;
    log({ ev, id, sent, ms });
    console.log(`${stamp()} #${id} ${ev} ${(sent / 1024).toFixed(0)} KiB in ${(ms / 1000).toFixed(2)} s`);
  };

  // Each pull happens when the client has drained the previous chunk far
  // enough for TCP backpressure to release, so pull timing is consumption rate.
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (sent >= length) {
        ctrl.close();
        finish("done");
        return;
      }
      if (closed) return;
      let chunk = Math.min(CHUNK, length - sent);
      if (virtual) {
        const position = start + sent;
        const mediaStart = Math.max(start, virtual.header.length);
        const leadEnd = mediaStart + Math.min(lead, virtual.frames) * virtual.sample.length;
        if (position < virtual.header.length) chunk = Math.min(chunk, virtual.header.length - position);
        else if (pace > 0) {
          // Do not let a 16 KiB chunk turn a half-second lead into seconds
          // of unintended read-ahead. After the lead, send one frame at a time.
          if (position < leadEnd) chunk = Math.min(chunk, leadEnd - position);
          else {
            const due = t0 + ((position - leadEnd) / virtual.sample.length + 1) * 1000 / (virtual.fps * pace);
            while (!closed && due > now()) await waitFor(Math.min(60_000, due - now()));
            chunk = Math.min(chunk, virtual.sample.length);
          }
        }
      } else if (kbps > 0) {
        const due = t0 + (sent * 8) / kbps;
        while (!closed && due > now()) await waitFor(Math.min(60_000, due - now()));
      }
      if (closed) return;
      const buf = virtual ? virtual.read(start + sent, chunk) : new Uint8Array(chunk);
      let n: number | null;
      try {
        n = virtual ? buf.length : await file!.read(buf);
      } catch (e) {
        if (closed) return;
        finish("abort");
        ctrl.error(e);
        return;
      }
      if (closed) return;
      if (n === null) {
        ctrl.close();
        finish("done");
        return;
      }
      log({ ev: "pull", id, off: start + sent, n });
      sent += n;
      ctrl.enqueue(n === buf.length ? buf : buf.subarray(0, n));
    },
    cancel() {
      finish("abort");
    },
  }, { highWaterMark: 0 });

  return new Response(body, { status, headers });
}

Deno.serve({ hostname: HOST, port: PORT, onListen: () => {
  console.log(`listening on http://${HOST}:${PORT}/  log: ${logPath}`);
} }, (req, info) => {
  const id = nextId++;
  const url = new URL(req.url);
  const remote = `${info.remoteAddr.hostname}:${info.remoteAddr.port}`;
  log({
    ev: "req",
    id,
    remote,
    method: req.method,
    path: url.pathname + url.search,
    headers: Object.fromEntries(req.headers),
  });
  const range = req.headers.get("range");
  console.log(
    `${stamp()} #${id} ${remote} ${req.method} ${url.pathname}${url.search}` +
      (range ? `  ${range}` : "") +
      `  ua=${req.headers.get("user-agent") ?? "-"}`,
  );

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  if (url.pathname === "/") return index();

  const v = url.pathname.match(/^\/v\/([^/]+)\/([^/]+\.mp4)$/);
  if (v) return serveFile(req, id, v[1], v[2], 0, url);
  const m = url.pathname.match(/^\/s\/([^/]+)\/(.+)$/);
  if (!m) {
    log({ ev: "res", id, status: 404 });
    return new Response("not found", { status: 404 });
  }
  const kbps = Number(url.searchParams.get("kbps") ?? 0) || 0;
  return serveFile(req, id, m[1], decodeURIComponent(m[2]), kbps);
});
