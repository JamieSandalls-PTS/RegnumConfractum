import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Screenshot receiver for the viewer's automation hook (D-503 technique).
 * The browser pane can't write files, so `window.__viewer.shoot()`/`sheet()`
 * POST png data-urls here; this saves them for review.
 *
 *   npx tsx tools/src/shot-receiver.ts [outDir]
 */

const outDir = process.argv[2] ?? path.join('docs', 'media', 'review');
// Configurable, because 8123 collided with a dev game server once and the
// two processes fought over the port in a way that looked like a dead client.
const port = Number(process.env.SHOT_PORT ?? process.argv[3] ?? 8123);
fs.mkdirSync(outDir, { recursive: true });

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const name = (req.url ?? '/shot').slice(1).replace(/[^a-z0-9_.-]/gi, '_') || 'shot';
      const m = body.match(/^data:image\/png;base64,(.+)$/);
      if (m) {
        const file = path.join(outDir, name.endsWith('.png') ? name : `${name}.png`);
        fs.writeFileSync(file, Buffer.from(m[1]!, 'base64'));
        console.log(`saved ${file}`);
      } else {
        console.log(`ignored ${name}: body is not a png data-url (${body.length} bytes)`);
      }
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    });
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`shot receiver on http://127.0.0.1:${port} -> ${outDir}`);
  });
