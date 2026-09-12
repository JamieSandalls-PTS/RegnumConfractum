import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Receives animation FBX from a browser page and writes them to disk (D-564).
 *
 *   npx tsx tools/src/animation-receiver.ts
 *
 * The browser pane cannot write files, and an authenticated download service
 * cannot be fetched from Node without carrying the session. So the page does
 * the fetching — where it already has the session — and POSTs the bytes here,
 * the same shape as the screenshot receiver (D-503).
 *
 * ⚠ It VERIFIES what it is given. An expired session or a rate limit answers
 * a download URL with JSON or an HTML login page, and 200 bytes written as
 * `Walking.fbx` fails much later, inside the FBX parser, with a message about
 * a corrupt file rather than about a login. Checking the magic bytes here
 * turns that into one line at the moment it happens.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const outDir = process.argv[2] ?? path.join(root, 'assets', 'incoming', 'animations');
const port = Number(process.env.ANIM_PORT ?? process.argv[3] ?? 8124);
fs.mkdirSync(outDir, { recursive: true });

/** Binary FBX files begin with this; anything else is not one. */
const FBX_MAGIC = 'Kaydara FBX Binary';

let written = 0;
let refused = 0;

const server = http.createServer((req, res) => {
  const done = (status: number, body: unknown): void => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Anim-Name',
      // Chrome refuses a request from an HTTPS page to loopback unless the
      // preflight is answered with this. Without it the page sees a bare
      // "Failed to fetch" that reads like the server is down, and the server
      // logs nothing at all because the request never arrives.
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end(JSON.stringify(body));
  };

  console.log(`${req.method} ${(req.url ?? '').slice(0, 60)}`);
  if (req.method === 'OPTIONS') return done(204, {});

  // The page's own Content-Security-Policy is what actually blocks this, not
  // mixed content: mixamo.com sends `connect-src` naming its own hosts, so
  // `fetch` to loopback is refused by the DOCUMENT before it leaves. An IFRAME
  // navigation is governed by frame-src, not connect-src, so a hidden iframe
  // pointed here gets through where fetch cannot — and the presigned URL rides
  // in the query string. Answering with a tiny HTML page rather than JSON keeps
  // the iframe from prompting a download.
  if (req.method === 'GET' && (req.url ?? '').startsWith('/queue')) {
    const q = new URL(req.url ?? '/', 'http://127.0.0.1');
    const name = (q.searchParams.get('name') ?? 'clip').replace(/[^a-z0-9_.-]/gi, '_');
    const url = q.searchParams.get('url') ?? '';
    void (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(r.status === 403 ? 'expired (presigned URLs last 5 minutes)' : `HTTP ${r.status}`);
        const data = Buffer.from(await r.arrayBuffer());
        if (data.subarray(0, FBX_MAGIC.length).toString('latin1') !== FBX_MAGIC) {
          throw new Error(`not an FBX (${data.byteLength} bytes)`);
        }
        fs.writeFileSync(path.join(outDir, `${name}.fbx`), data);
        written++;
        console.log(`saved ${name}.fbx  ${(data.byteLength / 1024).toFixed(0)} KB`);
      } catch (e) {
        refused++;
        console.log(`FAILED ${name}: ${(e as Error).message}`);
      }
    })();
    res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
    res.end(`<!doctype html>queued ${name}`);
    return;
  }

  if (req.method === 'GET' && req.url === '/have') {
    // Lets the page skip what is already on disk, so a re-run after an
    // interruption costs nothing rather than fetching everything again.
    const have = fs
      .readdirSync(outDir)
      .filter((f) => /\.fbx$/i.test(f))
      .map((f) => f.replace(/\.fbx$/i, ''));
    return done(200, { have, written, refused });
  }

  if (req.method === 'POST' && (req.url ?? '').startsWith('/pull')) {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        let items: { name: string; url: string }[];
        try {
          items = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof items;
        } catch {
          return done(400, { error: 'body is not JSON' });
        }
        const saved: string[] = [];
        const failed: { name: string; why: string }[] = [];
        for (const item of items) {
          const safe = item.name.replace(/[^a-z0-9_.-]/gi, '_');
          try {
            const res = await fetch(item.url);
            if (!res.ok) {
              failed.push({
                name: item.name,
                why: res.status === 403 ? 'expired (presigned URLs last 5 minutes)' : `HTTP ${res.status}`,
              });
              continue;
            }
            const data = Buffer.from(await res.arrayBuffer());
            if (data.subarray(0, FBX_MAGIC.length).toString('latin1') !== FBX_MAGIC) {
              failed.push({ name: item.name, why: `not an FBX (${data.byteLength} bytes)` });
              continue;
            }
            fs.writeFileSync(path.join(outDir, `${safe}.fbx`), data);
            written++;
            saved.push(item.name);
            console.log(`saved ${safe}.fbx  ${(data.byteLength / 1024).toFixed(0)} KB`);
          } catch (e) {
            failed.push({ name: item.name, why: (e as Error).message });
          }
        }
        done(200, { saved, failed });
      })();
    });
    return;
  }

  if (req.method !== 'POST') return done(404, { error: 'not found' });

  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = (req.headers['x-anim-name'] as string) ?? (req.url ?? '/clip').slice(1);
    const name = decodeURIComponent(raw).replace(/[^a-z0-9 _.-]/gi, '_').trim() || 'clip';
    const data = Buffer.concat(chunks);

    if (data.subarray(0, FBX_MAGIC.length).toString('latin1') !== FBX_MAGIC) {
      refused++;
      const head = data.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ');
      console.log(`REFUSED ${name}: not an FBX (${data.byteLength} bytes) — ${head}`);
      return done(400, { error: 'not an FBX', bytes: data.byteLength, head });
    }

    const file = path.join(outDir, name.endsWith('.fbx') ? name : `${name}.fbx`);
    fs.writeFileSync(file, data);
    written++;
    console.log(`saved ${path.basename(file)}  ${(data.byteLength / 1024).toFixed(0)} KB`);
    return done(200, { saved: path.basename(file), bytes: data.byteLength, written });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`animation receiver on http://127.0.0.1:${port} -> ${outDir}`);
});
