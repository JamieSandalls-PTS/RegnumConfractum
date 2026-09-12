import * as THREE from 'three';
import { fnv1a, mulberry32 } from '@rc/shared';

/**
 * Roofs (D-545), painted as a footprint and shaped automatically.
 *
 * **The "dynamic" part is that you never draw a roof, you draw where one is.**
 * Contiguous painted tiles are flooded into a REGION, the region's bounding
 * box decides which way the ridge runs (along the longer side), and the
 * surface is a HEIGHTFIELD evaluated at tile corners.
 *
 * That last word is the whole difference between this and the first attempt,
 * which built one tilted slab per tile and looked like a woodpile: adjacent
 * slabs each had their own rotation, so every seam opened and the silhouette
 * stepped. Sampling a continuous height function at shared corners means
 * neighbouring quads agree exactly, and the roof is one unbroken plane per
 * pitch — with the ridge, the eaves and the gable ends falling out of the
 * same function rather than being drawn on afterwards.
 *
 * **And it gets out of the way.** A roof over an isometric camera is an opaque
 * lid, so a region whose footprint contains the player fades out — the whole
 * region, not a dithered hole. A hole punched in a roof reads as damage; a
 * roof that lifts away reads as a cutaway, which is what isometric games have
 * done since Ultima. Walls keep the dither (D-542) because they are only ever
 * partly in the way.
 *
 * Roofs are presentation only: they do not block movement and they do not
 * block line of sight. Sight is the server's business (D-217), and a
 * rendering choice must never quietly edit who counts as a witness.
 */

interface RoofStyle {
  /** Deck colour, and the darker/lighter pair used to break up the surface. */
  shades: number[];
  ridge: number;
  fascia: number;
}

const ROOF_STYLES: Record<string, RoofStyle> = {
  // Muted, all of them: a decayed empire has weathered roofs, and a bright
  // deck is the single largest thing on screen for a whole building.
  thatch: { shades: [0x6e6144, 0x776a4b, 0x655939], ridge: 0x574c33, fascia: 0x5f5138 },
  tile: { shades: [0x7a4d3e, 0x855647, 0x6e4436], ridge: 0x5d3a2e, fascia: 0x6b4033 },
  slate: { shades: [0x4f545c, 0x585e67, 0x474c53], ridge: 0x3c4046, fascia: 0x444951 },
  plank: { shades: [0x6b5740, 0x756048, 0x604e39], ridge: 0x51422f, fascia: 0x5b4a35 },
};

/** Where the eaves sit — just above a full-height wall (D-542). */
const EAVE_HEIGHT = 2.55;
/** Rise per tile of half-span... */
const PITCH = 0.7;
/**
 * ...capped, or a wide hall becomes a cathedral. Raised once already: at 2.6
 * a roof over a wide building barely rose at all and read as a slightly domed
 * field rather than a roof. Pitch is most of what makes a roof legible from
 * an isometric camera.
 */
const MAX_RISE = 4.6;
/** How far the roof oversails its walls. */
const OVERHANG = 0.62;
const FADE_SECONDS = 0.22;

interface Region {
  tiles: Set<string>;
  group: THREE.Group;
  materials: THREE.Material[];
  shown: number;
}

export interface RoofTile {
  x: number;
  y: number;
  style: string;
}

export class Roofs {
  private regions: Region[] = [];
  readonly group = new THREE.Group();

  constructor(tiles: readonly RoofTile[], parent: THREE.Object3D) {
    for (const region of this.split(tiles)) this.build(region);
    parent.add(this.group);
  }

  /** Flood-fills the painted tiles into contiguous buildings. */
  private split(tiles: readonly RoofTile[]): RoofTile[][] {
    const byKey = new Map(tiles.map((t) => [`${t.x}:${t.y}`, t]));
    const seen = new Set<string>();
    const out: RoofTile[][] = [];
    for (const tile of tiles) {
      const start = `${tile.x}:${tile.y}`;
      if (seen.has(start)) continue;
      const group: RoofTile[] = [];
      const stack = [tile];
      seen.add(start);
      while (stack.length > 0) {
        const t = stack.pop()!;
        group.push(t);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${t.x + dx!}:${t.y + dy!}`;
          const next = byKey.get(k);
          if (next && !seen.has(k)) {
            seen.add(k);
            stack.push(next);
          }
        }
      }
      out.push(group);
    }
    return out;
  }

  private build(tiles: RoofTile[]): void {
    const group = new THREE.Group();
    const materials: THREE.Material[] = [];
    const style = ROOF_STYLES[tiles[0]?.style ?? 'thatch'] ?? ROOF_STYLES.thatch!;
    const has = new Set(tiles.map((t) => `${t.x}:${t.y}`));

    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of tiles) {
      x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x);
      y0 = Math.min(y0, t.y); y1 = Math.max(y1, t.y);
    }
    // The ridge runs along the LONGER side, the way a real roof sheds water
    // over the shortest span.
    const ridgeAlongX = x1 - x0 >= y1 - y0;
    const mid = ridgeAlongX ? (y0 + y1 + 1) / 2 : (x0 + x1 + 1) / 2;
    const halfSpan = Math.max(0.5, (ridgeAlongX ? y1 - y0 + 1 : x1 - x0 + 1) / 2);
    const rise = Math.min(MAX_RISE, halfSpan * PITCH);

    /**
     * The surface, as a continuous function of world position. Sampling it at
     * shared corners is what keeps neighbouring quads watertight.
     */
    const heightAt = (wx: number, wz: number): number => {
      const across = ridgeAlongX ? wz : wx;
      const d = Math.min(1, Math.abs(across - mid) / halfSpan);
      return EAVE_HEIGHT + (1 - d) * rise;
    };

    // --- the deck ----------------------------------------------------------
    // One quad per painted tile, its corners pushed outward at the region
    // boundary so the roof oversails the walls it sits on.
    const positions: number[] = [];
    const colors: number[] = [];
    const colour = new THREE.Color();
    const outward = (v: number, lo: boolean): number => (lo ? -OVERHANG : OVERHANG);

    for (const t of tiles) {
      const rnd = mulberry32(fnv1a(`roof:${t.x}:${t.y}`));
      colour.setHex(style.shades[Math.floor(rnd() * style.shades.length)]!);
      const westEdge = !has.has(`${t.x - 1}:${t.y}`);
      const eastEdge = !has.has(`${t.x + 1}:${t.y}`);
      const northEdge = !has.has(`${t.x}:${t.y - 1}`);
      const southEdge = !has.has(`${t.x}:${t.y + 1}`);
      const xa = t.x - 0.5 + (westEdge ? outward(t.x, true) : 0);
      const xb = t.x + 0.5 + (eastEdge ? outward(t.x, false) : 0);
      const za = t.y - 0.5 + (northEdge ? outward(t.y, true) : 0);
      const zb = t.y + 0.5 + (southEdge ? outward(t.y, false) : 0);
      const corners: [number, number][] = [[xa, za], [xb, za], [xb, zb], [xa, zb]];
      const h = corners.map(([cx, cz]) => heightAt(cx, cz));
      // Two triangles, wound so the deck faces up.
      const tri = (a: number, b: number, c: number): void => {
        for (const i of [a, b, c]) {
          positions.push(corners[i]![0], h[i]!, corners[i]![1]);
          colors.push(colour.r, colour.g, colour.b);
        }
      };
      tri(0, 2, 1);
      tri(0, 3, 2);
    }

    const deckGeo = new THREE.BufferGeometry();
    deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    deckGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    deckGeo.computeVertexNormals();
    const deckMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      flatShading: true,
    });
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.castShadow = true;
    deck.receiveShadow = true;
    materials.push(deckMat);
    group.add(deck);

    // --- the ridge beam ----------------------------------------------------
    // A capping timber along the top, which is what makes the join read as a
    // ridge rather than as two planes that happen to meet.
    const ridgeMat = new THREE.MeshLambertMaterial({
      color: style.ridge, transparent: true, opacity: 1,
    });
    materials.push(ridgeMat);
    const ridgeLength = (ridgeAlongX ? x1 - x0 + 1 : y1 - y0 + 1) + OVERHANG * 2;
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(ridgeLength, 0.2, 0.34), ridgeMat);
    ridge.position.set(
      ridgeAlongX ? (x0 + x1 + 1) / 2 - 0.5 : mid - 0.5,
      EAVE_HEIGHT + rise + 0.06,
      ridgeAlongX ? mid - 0.5 : (y0 + y1 + 1) / 2 - 0.5,
    );
    if (!ridgeAlongX) ridge.rotation.y = Math.PI / 2;
    ridge.castShadow = true;
    group.add(ridge);

    // --- fascia ------------------------------------------------------------
    // A board closing the open edge of the deck at the eaves, so the roof is
    // not a sheet of paper when seen from below the eaveline.
    const fasciaMat = new THREE.MeshLambertMaterial({
      color: style.fascia, transparent: true, opacity: 1,
    });
    materials.push(fasciaMat);
    for (const t of tiles) {
      const edges: [boolean, number, number, number, number][] = [
        [!has.has(`${t.x}:${t.y - 1}`), t.x, t.y - 0.5 - OVERHANG, 1 + OVERHANG * 2, 0],
        [!has.has(`${t.x}:${t.y + 1}`), t.x, t.y + 0.5 + OVERHANG, 1 + OVERHANG * 2, 0],
        [!has.has(`${t.x - 1}:${t.y}`), t.x - 0.5 - OVERHANG, t.y, 1 + OVERHANG * 2, Math.PI / 2],
        [!has.has(`${t.x + 1}:${t.y}`), t.x + 0.5 + OVERHANG, t.y, 1 + OVERHANG * 2, Math.PI / 2],
      ];
      for (const [present, px, pz, len, rot] of edges) {
        if (!present) continue;
        const h = heightAt(px, pz);
        const board = new THREE.Mesh(new THREE.BoxGeometry(len, 0.22, 0.1), fasciaMat);
        board.position.set(px, h - 0.08, pz);
        board.rotation.y = rot;
        board.castShadow = true;
        group.add(board);
      }
    }

    this.group.add(group);
    this.regions.push({ tiles: has, group, materials, shown: 1 });
  }

  /**
   * Fades any region the player is standing under. Call once a frame with
   * their tile; pass null to keep every roof up (the editor does this, so you
   * can see what you are painting).
   */
  update(at: { x: number; y: number } | null, dt: number): void {
    for (const region of this.regions) {
      const inside = at !== null && region.tiles.has(`${Math.round(at.x)}:${Math.round(at.y)}`);
      const target = inside ? 0 : 1;
      if (region.shown === target) continue;
      const step = dt / FADE_SECONDS;
      region.shown = target > region.shown
        ? Math.min(target, region.shown + step)
        : Math.max(target, region.shown - step);
      for (const m of region.materials) {
        (m as THREE.MeshLambertMaterial).opacity = region.shown;
      }
      region.group.visible = region.shown > 0.01;
    }
  }

  /** How many buildings the painted tiles resolved into. */
  get regionCount(): number {
    return this.regions.length;
  }

  /** Test hook: how many regions are currently lifted away. */
  get hiddenCount(): number {
    return this.regions.filter((r) => r.shown < 0.5).length;
  }

  dispose(parent: THREE.Object3D): void {
    parent.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
    this.regions = [];
  }
}
