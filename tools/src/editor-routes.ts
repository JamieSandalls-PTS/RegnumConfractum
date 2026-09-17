import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AreaSchema, GROUND_MASKS, GroundMaterialSchema, type AreaDef } from '@rc/shared';
import { validateContent } from './validate-content';
import { checkAreaForSave } from './editor-check';

/**
 * The map editor's routes (D-543), mounted on the ONE authoring server (D-629).
 *
 * These lived in `editor-server.ts` on port 8140 while everything else the
 * tools save went through `studio-server.ts` on 8150. Two ports was a real
 * cost, not untidiness: a session was lost to a stale editor server answering
 * with a schema it had never heard of, which presents as a broken route, and
 * the map builder was dead without a second process nobody remembered to
 * start. There is one server now; this file is the part of it that owns
 * areas, ground materials and the painted masks.
 *
 *   PUT    /api/paint/:areaId   write 1..N ground-mask PNGs
 *   GET    /api/ground          materials + texture files on disk
 *   PUT    /api/ground/:id      validate texture exists, back up, write
 *   DELETE /api/ground/:id      refused while an area paints with it
 *   GET    /api/palette         what a map may place: station/node/npc ids, cues, scripts
 *   GET    /api/areas           the list, for the picker
 *   GET    /api/areas/:id       one area, schema-parsed (defaults applied)
 *   PUT    /api/areas/:id       validate, back up, write, then full validation
 *
 * **Nothing invalid is ever written.** A save is parsed against the real
 * `AreaSchema`, flood-filled for reachability with solid props blocking
 * (D-542), and checked for the obvious own-foot shots — a prop inside a wall,
 * a spawn nobody can stand on, a transition sealed off — before the file is
 * touched. The validator that guards CI is the same code guarding the save
 * button, so the editor cannot produce content that fails the build.
 */

export interface EditorRouteOptions {
  contentDir: string;
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
}

function areaFile(areasDir: string, id: string): string | null {
  // Ids come off the wire, so they are treated as hostile: kebab-case only,
  // and the resolved path must still sit inside the areas directory.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return null;
  const file = path.join(areasDir, `${id}.json`);
  if (path.dirname(path.resolve(file)) !== path.resolve(areasDir)) return null;
  return file;
}

export function listAreas(areasDir: string): {
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
function otherAreas(areasDir: string, exceptId: string): AreaDef[] {
  const out: AreaDef[] = [];
  for (const f of fs.readdirSync(areasDir).filter((n) => n.endsWith('.json'))) {
    const parsed = AreaSchema.safeParse(JSON.parse(fs.readFileSync(path.join(areasDir, f), 'utf8')));
    if (parsed.success && parsed.data.id !== exceptId) out.push(parsed.data);
  }
  return out;
}

/** The ground images actually on disk, which is what a material may name. */
export function groundTextures(contentDir: string): string[] {
  const dir = path.join(contentDir, '..', 'client', 'public', 'textures', 'ground');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

/** Where the pre-save copy goes. Git is the real safety net; this is the belt. */
function backup(contentDir: string, id: string, file: string): void {
  if (!fs.existsSync(file)) return;
  const backupDir = path.join(contentDir, '.editor-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, path.join(backupDir, `${id}.${stamp}.json`));
}

/**
 * Answer the request if it is one of the editor's; return false otherwise so
 * the caller falls through to its own routes.
 */
export function editorRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  parts: string[],
  { contentDir, send }: EditorRouteOptions,
): boolean {
  const areasDir = path.join(contentDir, 'areas');
  if (parts[0] !== 'api') return false;

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
    if (!/^[a-z0-9-]+$/.test(areaId)) {
      send(res, 400, { error: 'bad area id' });
      return true;
    }
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
    return true;
  }

  // The ground materials a person can paint with (D-585), and the texture
  // FILES as well as the materials. A material naming an image that is not
  // there renders as its tint and looks like a material somebody has not
  // finished, so what the editor offers is what is on disk — the same rule
  // the ambience list follows, and the reason neither is a text box.
  if (req.method === 'GET' && url.pathname === '/api/ground') {
    const dir = path.join(contentDir, 'ground');
    const mats = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) =>
        GroundMaterialSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
      : [];
    send(res, 200, { ground: mats, textures: groundTextures(contentDir) });
    return true;
  }

  // PUT /api/ground/:id — write one material.
  //
  // ⚠ Ground materials were the last thing in `content/` that could be
  // PAINTED WITH and never authored: thirteen shipped, a fourteenth meant
  // hand-writing JSON beside a file nothing listed.
  if (req.method === 'PUT' && parts[1] === 'ground' && parts.length === 3) {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      let doc: unknown;
      try {
        doc = JSON.parse(body || '{}');
      } catch (err) {
        return send(res, 400, { ok: false, errors: [`invalid JSON: ${String(err)}`] });
      }
      const parsed = GroundMaterialSchema.safeParse(doc);
      if (!parsed.success) {
        return send(res, 200, {
          ok: false,
          errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }
      const mat = parsed.data;
      if (mat.id !== parts[2]) {
        return send(res, 200, { ok: false, errors: ['id does not match the url'] });
      }
      // ⚠ The texture has to BE there. CI cannot check this — it is an image
      // under `client/public/`, not content — so the one place that can see
      // both is here, which is exactly why the check lives in the server
      // and not in the schema.
      if (mat.texture && !groundTextures(contentDir).includes(mat.texture)) {
        return send(res, 200, {
          ok: false,
          errors: [`no such texture '${mat.texture}' under client/public/textures/ground`],
        });
      }
      const dir = path.join(contentDir, 'ground');
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${mat.id}.json`);
        if (fs.existsSync(file)) backup(contentDir, `ground-${mat.id}`, file);
        fs.writeFileSync(file, `${JSON.stringify(mat, null, 2)}\n`, 'utf8');
      } catch (err) {
        return send(res, 500, { ok: false, errors: [`could not write: ${String(err)}`] });
      }
      return send(res, 200, { ok: true });
    });
    return true;
  }

  // DELETE /api/ground/:id — refused while a map is painted with it.
  //
  // ⚠ Refused BY NAME rather than left to the build. `groundMaterials` is the
  // channel order for the masks (D-588): remove a material an area lists and
  // every surface painted after it shifts one channel along, which is not an
  // error anywhere — the map simply comes back wearing the wrong ground.
  if (req.method === 'DELETE' && parts[1] === 'ground' && parts.length === 3) {
    const id = parts[2]!;
    if (!/^[a-z0-9-]+$/.test(id)) {
      send(res, 400, { ok: false, errors: ['bad id'] });
      return true;
    }
    const used: string[] = [];
    try {
      for (const f of fs.readdirSync(areasDir).filter((n) => n.endsWith('.json'))) {
        const doc = JSON.parse(fs.readFileSync(path.join(areasDir, f), 'utf8')) as
          { id?: string; groundMaterials?: string[] };
        if ((doc.groundMaterials ?? []).includes(id)) used.push(doc.id ?? f);
      }
    } catch {
      // No areas directory is not a reason to refuse a delete.
    }
    if (used.length > 0) {
      send(res, 200, {
        ok: false,
        errors: [`${id} is painted into ${used.join(', ')} — repaint those first`],
      });
      return true;
    }
    const file = path.join(contentDir, 'ground', `${id}.json`);
    if (!fs.existsSync(file)) {
      send(res, 404, { ok: false, errors: ['no such material'] });
      return true;
    }
    try {
      backup(contentDir, `ground-${id}`, file);
      fs.unlinkSync(file);
    } catch (err) {
      send(res, 500, { ok: false, errors: [`could not delete: ${String(err)}`] });
      return true;
    }
    send(res, 200, { ok: true });
    return true;
  }

  // What this map may PLACE — read from content, not from a list in the
  // editor's own source.
  //
  // ⚠ The palettes were hard-coded, so a node or a facility added to content
  // simply never appeared: a content file the tool could not see, and no
  // error anywhere to say so.
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
    // ⚠ Cues and scripts too, because the map-level panel offers them and
    // a free-text box would be a way to author a dangling reference. An
    // `ambience` naming a cue that does not exist fails CI (D-541); a
    // `scripts` entry naming no file fails it too. What the editor lets a
    // person pick should be exactly what the build accepts — which is the
    // promise D-543 makes and the reason this is a list rather than a field.
    //
    // Ambience cues only: an `effect` cue is a sword hitting somebody and
    // naming one as an area's bed would loop it forever.
    let cues: string[] = [];
    try {
      const file = path.join(contentDir, 'audio', 'sounds.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as
        { id: string; kind: string }[];
      cues = parsed.filter((c) => c.kind === 'ambience').map((c) => c.id).sort();
    } catch {
      cues = [];
    }
    let scripts: string[] = [];
    try {
      scripts = fs
        .readdirSync(path.join(contentDir, 'scripts'))
        .filter((f) => f.endsWith('.lua'))
        .map((f) => f.slice(0, -4))
        .sort();
    } catch {
      scripts = [];
    }
    send(res, 200, {
      stations: ids('stations'),
      nodes: ids('nodes'),
      npcs: ids('npcs'),
      cues,
      scripts,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/areas') {
    try {
      send(res, 200, { areas: listAreas(areasDir) });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return true;
  }

  if (parts[1] === 'areas' && parts[2] && parts.length === 3) {
    const file = areaFile(areasDir, parts[2]);
    if (!file) {
      send(res, 400, { error: 'bad area id' });
      return true;
    }

    if (req.method === 'GET') {
      if (!fs.existsSync(file)) {
        send(res, 404, { error: 'no such area' });
        return true;
      }
      // PARSED, not raw. Half the schema has defaults — `lighting`, `props`,
      // `stations`, `zone` — and a hand-authored file may omit any of them.
      // Handing the editor the raw bytes gave it an area with no lighting
      // profile, which the renderer met as `undefined`. The editor works on
      // the same resolved document the server loads.
      const parsed = AreaSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!parsed.success) {
        send(res, 500, {
          error: 'the file on disk does not validate',
          errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        return true;
      }
      send(res, 200, parsed.data);
      return true;
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
        const { errors, area } = checkAreaForSave(doc, otherAreas(areasDir, id));
        if (errors.length > 0 || !area) {
          // Refused BEFORE writing: the editor cannot produce content that
          // would fail the build.
          return send(res, 200, { ok: false, errors });
        }
        try {
          backup(contentDir, area.id, file);
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
      return true;
    }
  }

  return false;
}
