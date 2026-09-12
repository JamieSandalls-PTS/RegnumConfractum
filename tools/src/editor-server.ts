import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AreaSchema, GROUND_MASKS, GroundMaterialSchema, type AreaDef } from '@rc/shared';
import { validateContent } from './validate-content';
import { checkAreaForSave } from './editor-check';

/**
 * The map editor's file server (D-543).
 *
 * The browser cannot read or write the repository, so the editor page talks
 * to this. It is deliberately small and deliberately strict:
 *
 *   GET  /api/areas          the list, for the picker
 *   GET  /api/areas/:id      one area, exactly as it sits on disk
 *   PUT  /api/areas/:id      validate, back up, write
 *
 * **Nothing invalid is ever written.** A save is parsed against the real
 * `AreaSchema`, flood-filled for reachability with solid props blocking
 * (D-542), and checked for the obvious own-foot shots — a prop inside a wall,
 * a spawn nobody can stand on, a transition sealed off — before the file is
 * touched. This is the whole reason the editor writes through a server rather
 * than downloading a file for the user to drop in: the validator that guards
 * CI is the same code guarding the save button, so the editor cannot produce
 * content that fails the build.
 *
 * After a successful write it runs the FULL content validation and returns
 * anything it finds. That catches what a single area cannot know about
 * itself — a transition pointing at a tile another area just stopped having.
 *
 *   npx tsx tools/src/editor-server.ts [contentDir] [port]
 */

const contentDir = path.resolve(process.argv[2] ?? 'content');
const port = Number(process.env.EDITOR_PORT ?? process.argv[3] ?? 8140);
const areasDir = path.join(contentDir, 'areas');
/** Where the pre-save copy goes. Git is the real safety net; this is the belt. */
const backupDir = path.join(contentDir, '.editor-backups');

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

function areaFile(id: string): string | null {
  // Ids come off the wire, so they are treated as hostile: kebab-case only,
  // and the resolved path must still sit inside the areas directory.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return null;
  const file = path.join(areasDir, `${id}.json`);
  if (path.dirname(path.resolve(file)) !== path.resolve(areasDir)) return null;
  return file;
}

function listAreas(): {
  id: string; name: string; width: number; height: number;
  generated: boolean; live: boolean;
}[] {
  return fs
    .readdirSync(areasDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const doc = JSON.parse(fs.readFileSync(path.join(areasDir, f), 'utf8')) as AreaDef;
      return {
        id: doc.id,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        // The cross is written by build-round-map.py, which rewrites these
        // files wholesale — the editor warns rather than pretending otherwise.
        generated: /^round-/.test(doc.id),
        // Part of a real game loop, or somewhere to test things. Stated by
        // the file rather than guessed from the name.
        live: doc.live === true,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every area except `exceptId`, parsed. Used for the inbound-door check. */
function otherAreas(exceptId: string): AreaDef[] {
  const out: AreaDef[] = [];
  for (const f of fs.readdirSync(areasDir).filter((n) => n.endsWith('.json'))) {
    const parsed = AreaSchema.safeParse(JSON.parse(fs.readFileSync(path.join(areasDir, f), 'utf8')));
    if (parsed.success && parsed.data.id !== exceptId) out.push(parsed.data);
  }
  return out;
}

function backup(id: string, file: string): void {
  if (!fs.existsSync(file)) return;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, path.join(backupDir, `${id}.${stamp}.json`));
}

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    // What this map may PLACE — read from content, not from a list in the
    // editor's own source.
    //
    // ⚠ The palettes were hard-coded, so a node or a facility added to content
    // simply never appeared: a content file the tool could not see, and no
    // error anywhere to say so.
    /**
   * The painted ground for an area (D-585): a PNG the brush produced.
   *
   * ⚠ Written next to the game's other textures rather than into `content/`,
   * because it IS art — the same place a ground texture or a character atlas
   * goes. What lives in content is the area's reference to it, which is the
   * decision; the pixels are the output.
   */
  if (req.method === 'PUT' && parts[1] === 'paint' && parts.length === 3) {
    const areaId = decodeURIComponent(parts[2]!);
    if (!/^[a-z0-9-]+$/.test(areaId)) return send(res, 400, { error: 'bad area id' });
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      let body: { pngs?: unknown };
      try {
        body = JSON.parse(raw) as { pngs?: unknown };
      } catch (err) {
        return send(res, 400, { error: `invalid JSON: ${String(err)}` });
      }
      const prefix = 'data:image/png;base64,';
      const pngs = body.pngs;
      // ⚠ A LIST of masks since D-588, one per three materials. Six materials
      // need two images and they are written together: an area naming a mask
      // that was never written fails the build, and writing one of the two is
      // exactly that state.
      if (!Array.isArray(pngs) || pngs.length === 0 || pngs.length > GROUND_MASKS
        || !pngs.every((p) => typeof p === 'string' && p.startsWith(prefix))) {
        return send(res, 400, {
          error: `expected 1-${GROUND_MASKS} png data urls in 'pngs'`,
        });
      }
      const dir = path.join(contentDir, '..', 'client', 'public', 'textures', 'painted');
      fs.mkdirSync(dir, { recursive: true });
      const saved = (pngs as string[]).map((png, i) => {
        // ⚠ Suffixed by INDEX, and the index is the mask number. The name is
        // how the area pairs an image with its three materials, so the second
        // mask must never be written where the first one lives.
        const file = `${areaId}-${i}.png`;
        fs.writeFileSync(path.join(dir, file), Buffer.from(png.slice(prefix.length), 'base64'));
        return file;
      });
      return send(res, 200, { saved });
    });
    return;
  }

  // The ground materials a person can paint with (D-585). Served from the
  // editor's own API rather than the studio's: painting ground is map work,
  // and the map editor already owns areas.
  if (req.method === 'GET' && url.pathname === '/api/ground') {
    const dir = path.join(contentDir, 'ground');
    const mats = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) =>
        GroundMaterialSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
      : [];
    return send(res, 200, { ground: mats });
  }

  if (req.method === 'GET' && url.pathname === '/api/palette') {
      const ids = (sub: string): string[] => {
        try {
          return fs
            .readdirSync(path.join(contentDir, sub))
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
            .sort();
        } catch {
          return [];
        }
      };
      return send(res, 200, { stations: ids('stations'), nodes: ids('nodes') });
    }

    if (req.method === 'GET' && url.pathname === '/api/areas') {
      try {
        return send(res, 200, { areas: listAreas() });
      } catch (err) {
        return send(res, 500, { error: String(err) });
      }
    }

    if (parts[0] === 'api' && parts[1] === 'areas' && parts[2]) {
      const file = areaFile(parts[2]);
      if (!file) return send(res, 400, { error: 'bad area id' });

      if (req.method === 'GET') {
        if (!fs.existsSync(file)) return send(res, 404, { error: 'no such area' });
        // PARSED, not raw. Half the schema has defaults — `lighting`, `props`,
        // `stations`, `zone` — and a hand-authored file may omit any of them.
        // Handing the editor the raw bytes gave it an area with no lighting
        // profile, which the renderer met as `undefined`. The editor works on
        // the same resolved document the server loads.
        const parsed = AreaSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (!parsed.success) {
          return send(res, 500, {
            error: 'the file on disk does not validate',
            errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          });
        }
        return send(res, 200, parsed.data);
      }

      if (req.method === 'PUT') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          let doc: unknown;
          try {
            doc = JSON.parse(body);
          } catch (err) {
            return send(res, 400, { ok: false, errors: [`invalid JSON: ${String(err)}`] });
          }
          const id = typeof (doc as { id?: unknown }).id === 'string'
            ? (doc as { id: string }).id
            : parts[2]!;
          const { errors, area } = checkAreaForSave(doc, otherAreas(id));
          if (errors.length > 0 || !area) {
            // Refused BEFORE writing: the editor cannot produce content that
            // would fail the build.
            return send(res, 200, { ok: false, errors });
          }
          try {
            backup(area.id, file);
            fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
          } catch (err) {
            return send(res, 500, { ok: false, errors: [`could not write: ${String(err)}`] });
          }
          // Written. Now the questions one area cannot answer about itself.
          let crossArea: string[] = [];
          try {
            crossArea = validateContent(contentDir).errors;
          } catch (err) {
            crossArea = [`full validation could not run: ${String(err)}`];
          }
          console.log(
            `saved ${area.id} (${area.assets.length} assets, ${area.stations.length} stations)`
            + (crossArea.length ? ` — ${crossArea.length} content warning(s)` : ''),
          );
          return send(res, 200, { ok: true, crossArea });
        });
        return;
      }
    }

    send(res, 404, { error: 'not found' });
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`map editor server on http://127.0.0.1:${port}`);
    console.log(`  content: ${contentDir}`);
    console.log(`  backups: ${backupDir}`);
    console.log('  open the editor at http://localhost:5173/editor.html');
  });
