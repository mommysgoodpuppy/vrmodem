// HTTPS for a guest that has no working TLS of its own: a proxy on this computer, which the
// guest reaches as 10.0.255.254 (passt's gateway), like the gateway's /random. The guest asks
// for the address after a prefix, in plain HTTP:
//   wget http://10.0.255.254:3128/https://example.com/
// and this fetches it with TLS here, follows its redirections, and answers with the page and
// the address it ended at (x-final-url). So the encryption ends on this computer, not in the
// guest: a cheat, until the guest's own TLS works (busybox's is reset by the servers, and
// busybox's wget speaks TLS even to an http proxy for an https address). Plain http is not
// proxied: the guest fetches that itself, but a site with no https is fetched in http here.
// Listens on loopback only: nobody else's proxy.
//
//   deno run --allow-net https_proxy.ts [--port 3128]

const KEEP = ["content-type", "last-modified", "cache-control", "content-language", "set-cookie"];
const ASK = ["accept", "accept-language", "user-agent", "range", "cookie"];
const MOST = 16 << 20; // bytes of an answer

const https = new Map<string, boolean>(); // site (host:port) -> whether it finishes a TLS handshake

async function hasHttps(url: URL): Promise<boolean> {
  const site = url.hostname + ":" + (url.port || "443");
  const known = https.get(site);
  if (known !== undefined) return known;
  let timer = 0;
  const late = new Promise<null>((done) => timer = setTimeout(() => done(null), 3000));
  // (a handshake, not a connection: bettermotherfuckingwebsite.com takes the connection and says nothing)
  const tried = (async () => {
    const c = await Deno.connectTls({ hostname: url.hostname, port: Number(url.port || 443) });
    await c.handshake();
    return c;
  })().catch(() => null);
  const conn = await Promise.race([tried, late]);
  clearTimeout(timer);
  if (conn) conn.close();
  else tried.then((c) => c?.close());   // (one that comes after all)
  https.set(site, conn !== null);
  return conn !== null;
}

export function serveHttpsProxy(port = 3128, log: (o: Record<string, unknown>) => void = (o) => console.log(JSON.stringify(o))) {
  return Deno.serve({ hostname: "127.0.0.1", port, onListen: () => log({ ev: "https-proxy", port }) }, async (req) => {
    let url: URL;
    try {
      const asked = new URL(req.url);
      url = new URL(asked.pathname.slice(1) + asked.search);   // (the prefix's path: "/https://...")
    } catch {
      return new Response("bad address", { status: 400 });
    }
    if (url.protocol !== "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return new Response("this proxy fetches https addresses only", { status: 400 });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    const headers = new Headers();
    for (const h of ASK) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    const t0 = performance.now();
    try {
      // A site with no https at all (a bare name the browser made https of): http, as a browser
      // falls back; its address from then on is the http one (x-final-url), which the guest
      // fetches itself. Whether it has https is a TLS handshake with it in a few seconds (one
      // that has it answers in a fraction of one), remembered for the site.
      const plain = !(await hasHttps(url));
      if (plain) {
        url = new URL(url.href);
        url.protocol = "http:";
        log({ ev: "https-proxy-plain", url: url.href });
      }
      const res = await fetch(url, { method: req.method, headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
      const out = new Headers({ "x-final-url": res.url || url.href });
      for (const h of KEEP) {
        const v = res.headers.get(h);
        if (v) out.set(h, v);
      }
      // the body as fetch decoded it (no content-encoding), whole, so that its length is known
      const body = req.method === "HEAD" ? null : new Uint8Array(await res.arrayBuffer()).slice(0, MOST);
      if (body) out.set("content-length", String(body.length));
      log({ ev: "https-proxy-get", url: url.href, status: res.status, bytes: body?.length ?? 0, ms: Math.round(performance.now() - t0) });
      return new Response(body, { status: res.status, headers: out });
    } catch (e) {
      log({ ev: "https-proxy-failed", url: url.href, error: String(e) });
      return new Response("could not fetch: " + String(e), { status: 502 });
    }
  });
}

if (import.meta.main) {
  const i = Deno.args.indexOf("--port");
  serveHttpsProxy(i >= 0 ? Number(Deno.args[i + 1]) : 3128);
}
