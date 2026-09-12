import {
  BODY_HEIGHT,
  BODY_RADIUS,
  MAX_DROP,
  STEP_UP,
  distanceToShape,
  polygonContains,
  shapeContains,
  surfaceHeight,
  type CollisionLayer,
  type Volume,
} from './collision';
import type { Vec2 } from './types';

/**
 * Finding a way through, in metres (D-567).
 *
 * ⚠ **The grid in this file is an INDEX, not a return of tiles.** Saying so
 * loudly because it would otherwise look exactly like the thing D-567 removed.
 * The distinction is real and load-bearing: nothing in content, the wire
 * protocol, the rules or the editor sees it; no distance is measured in it; it
 * is rebuilt from the collision layer at load and never authored. A path comes
 * out of it as a list of POINTS in metres, pulled straight, and the cells are
 * thrown away. Swapping it for a true navmesh later would touch nothing
 * outside this file.
 *
 * ⚠ It is also 2.5D, not 3D. Each cell holds the height a body standing there
 * would have, and an edge between two cells is passable only if the climb is
 * within `STEP_UP` and the fall within `MAX_DROP` — which is the same rule
 * `stepTo` applies, so a path is never found through something a body would
 * then refuse to walk. Two floors of a building genuinely stacked over each
 * other are NOT expressible and are not attempted; a bridge over a road is,
 * because only one of them is walkable at any given point.
 */

/**
 * How fine the index is.
 *
 * ⚠ Chosen against the BODY, not against the old tile. A body is 0.6m across,
 * so a gap has to be sampled at least twice to be found at all — at 0.5m a
 * doorway lands between samples and the pathfinder reports no way through a
 * door that is plainly open. 0.25m samples every doorway three times.
 */
export const NAV_RESOLUTION = 0.25;

/**
 * Metres per second on the flat.
 *
 * ⚠ The first number in D-567 set by PLAY rather than by arithmetic. It was
 * 3.33 — one tile every three ticks, inherited wholesale from the grid so that
 * converting movement to metres did not silently re-pace the game in the same
 * change. The stakeholder walked it and called it "a bit fast", which it was:
 * 3.33 m/s is a jog, and a real walk is nearer 1.4.
 *
 * 2.9 after a second pass: 3.33 was "a bit fast", 2.6 was "maybe a little
 * slow". It is a deliberate compromise rather than realism — a real walk is
 * nearer 1.4, and a character moving at human pace crosses a 50m town in
 * thirty-five seconds, which is longer than D-530's travel band was measured
 * against.
 */
export const WALK_SPEED = 2.9;

/**
 * A uniform spatial hash over the volumes.
 *
 * ⚠ Without this, baking is quadratic and unusable. A 100×100 area is 160,000
 * cells and its collision layer holds a few hundred volumes; testing every
 * volume at every cell is tens of millions of shape tests per area load. The
 * buckets cut it to the handful of volumes actually near each cell.
 */
const BUCKET = 4;

class VolumeIndex {
  private readonly buckets = new Map<number, Volume[]>();

  constructor(private readonly volumes: readonly Volume[]) {
    for (const v of volumes) {
      const b = this.extentOf(v);
      for (let j = Math.floor(b.y0 / BUCKET); j <= Math.floor(b.y1 / BUCKET); j++) {
        for (let i = Math.floor(b.x0 / BUCKET); i <= Math.floor(b.x1 / BUCKET); i++) {
          const key = i * 100003 + j;
          const list = this.buckets.get(key);
          if (list) list.push(v);
          else this.buckets.set(key, [v]);
        }
      }
    }
  }

  private extentOf(v: Volume): { x0: number; y0: number; x1: number; y1: number } {
    if (v.shape.kind === 'circle') {
      return {
        x0: v.shape.x - v.shape.r,
        y0: v.shape.y - v.shape.r,
        x1: v.shape.x + v.shape.r,
        y1: v.shape.y + v.shape.r,
      };
    }
    if (v.shape.kind === 'rect') {
      // ⚠ The HALF-DIAGONAL in both axes, not the half-width in x and the
      // half-height in y. A 0.4m × 10m wall turned a quarter reaches five
      // metres along x, and bucketing it by its unrotated width would file it
      // in the wrong buckets — a rotated wall the pathfinder cannot see, which
      // is a path straight through it and no error anywhere.
      const r = Math.hypot(v.shape.w, v.shape.h) / 2;
      return {
        x0: v.shape.x - r,
        y0: v.shape.y - r,
        x1: v.shape.x + r,
        y1: v.shape.y + r,
      };
    }
    const pts = v.shape.points;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  }

  /** Every volume that could be within `pad` of this point. */
  near(p: Vec2, pad: number): Volume[] {
    const out: Volume[] = [];
    const seen = new Set<Volume>();
    for (let j = Math.floor((p.y - pad) / BUCKET); j <= Math.floor((p.y + pad) / BUCKET); j++) {
      for (let i = Math.floor((p.x - pad) / BUCKET); i <= Math.floor((p.x + pad) / BUCKET); i++) {
        for (const v of this.buckets.get(i * 100003 + j) ?? []) {
          if (seen.has(v)) continue;
          seen.add(v);
          out.push(v);
        }
      }
    }
    return out;
  }

  get all(): readonly Volume[] {
    return this.volumes;
  }
}

/** Where a body may be, and how high its feet are, sampled on a fine grid. */
export class Nav {
  readonly res: number;
  readonly cols: number;
  readonly rows: number;
  readonly x0: number;
  readonly y0: number;
  private readonly open: Uint8Array;
  private readonly z: Float32Array;
  private readonly index: VolumeIndex;

  constructor(
    private readonly layer: CollisionLayer,
    res = NAV_RESOLUTION,
    private readonly radius = BODY_RADIUS,
  ) {
    this.res = res;
    this.index = new VolumeIndex(layer.volumes);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of layer.bounds) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    this.x0 = minX;
    this.y0 = minY;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / res));
    this.rows = Math.max(1, Math.ceil((maxY - minY) / res));
    this.open = new Uint8Array(this.cols * this.rows);
    this.z = new Float32Array(this.cols * this.rows);
    this.bake();
  }

  private bake(): void {
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const p = this.centre(i, j);
        const k = j * this.cols + i;
        if (!polygonContains(this.layer.bounds, p)) continue;
        const near = this.index.near(p, this.radius);
        // The highest surface under this point, ignoring how you got here —
        // the climb rule is applied to EDGES, where it belongs.
        let floor = 0;
        for (const v of near) {
          if (!v.walkable) continue;
          if (!shapeContains(v.shape, p)) continue;
          floor = Math.max(floor, surfaceHeight(v, p));
        }
        // ⚠ The same tolerance `overlapsBody` uses, and for the same reason:
        // a body has width, so anything a step or less above the feet has to be
        // standable-beside or the last 30cm of every ramp and doorstep is a
        // wall. Duplicated deliberately rather than calling `canOccupy` — that
        // would re-test every volume in the layer at every one of 160,000
        // cells, which is the quadratic this index exists to avoid.
        let blocked = false;
        for (const v of near) {
          if (distanceToShape(v.shape, p) >= this.radius) continue;
          if (v.base < floor + BODY_HEIGHT && surfaceHeight(v, p) > floor + STEP_UP) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        this.open[k] = 1;
        this.z[k] = floor;
      }
    }
  }

  centre(i: number, j: number): Vec2 {
    return { x: this.x0 + (i + 0.5) * this.res, y: this.y0 + (j + 0.5) * this.res };
  }

  cellOf(p: Vec2): { i: number; j: number } {
    return {
      i: Math.floor((p.x - this.x0) / this.res),
      j: Math.floor((p.y - this.y0) / this.res),
    };
  }

  private inside(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.cols && j < this.rows;
  }

  passable(i: number, j: number): boolean {
    return this.inside(i, j) && this.open[j * this.cols + i] === 1;
  }

  heightAt(i: number, j: number): number {
    return this.inside(i, j) ? this.z[j * this.cols + i]! : 0;
  }

  /** How many cells a body could stand in. Diagnostics, and a smoke test. */
  get openCells(): number {
    let n = 0;
    for (const v of this.open) n += v;
    return n;
  }

  /**
   * May a body move between two neighbouring cells?
   *
   * ⚠ The climb rule lives HERE rather than on the cell, and that is what makes
   * a 2.5D grid work at all. A platform's top and the ground beside it are both
   * perfectly standable cells; what separates them is the two-metre step
   * between them. Putting the rule on cells would let a path walk up a wall.
   */
  canReach(i0: number, j0: number, i1: number, j1: number): boolean {
    return this.canCross(i0, j0, i1, j1);
  }

  private canCross(i0: number, j0: number, i1: number, j1: number): boolean {
    if (!this.passable(i1, j1)) return false;
    const dz = this.heightAt(i1, j1) - this.heightAt(i0, j0);
    if (dz > STEP_UP || dz < -MAX_DROP) return false;
    // ⚠ No corner cutting. A diagonal between two blocked orthogonals is a
    // body squeezing through the join of two walls, which the collision model
    // refuses and a path must not promise.
    if (i0 !== i1 && j0 !== j1) {
      if (!this.passable(i1, j0) || !this.passable(i0, j1)) return false;
    }
    return true;
  }

  /**
   * The nearest standable cell to a point, searched outward.
   *
   * ⚠ Needed at BOTH ends of every path. A click lands wherever the cursor was,
   * which is regularly a centimetre inside a wall; refusing to path there at
   * all makes clicking near a building feel broken, and the honest answer is
   * "as close as you can get".
   */
  nearestOpen(p: Vec2, maxRings = 40): { i: number; j: number } | null {
    const start = this.cellOf(p);
    if (this.passable(start.i, start.j)) return start;
    for (let r = 1; r <= maxRings; r++) {
      let best: { i: number; j: number } | null = null;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = start.i + di;
          const j = start.j + dj;
          if (!this.passable(i, j)) continue;
          const c = this.centre(i, j);
          const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = { i, j };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * Can a body walk the straight line between two points?
   *
   * Sampled at half the cell size, so nothing narrower than the index can slip
   * between two samples. This is what pulls a path straight.
   */
  clearLine(a: Vec2, b: Vec2): boolean {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / (this.res / 2)));
    let prev = this.cellOf(a);
    if (!this.passable(prev.i, prev.j)) return false;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const cell = this.cellOf(p);
      if (cell.i === prev.i && cell.j === prev.j) continue;
      // Stepping diagonally between cells in one sample would skip the corner
      // rule, so cross one axis at a time.
      if (cell.i !== prev.i && cell.j !== prev.j) {
        if (!this.canCross(prev.i, prev.j, cell.i, prev.j)) return false;
        if (!this.canCross(cell.i, prev.j, cell.i, cell.j)) return false;
      } else if (!this.canCross(prev.i, prev.j, cell.i, cell.j)) {
        return false;
      }
      prev = cell;
    }
    return true;
  }

  /**
   * A route from one point to another, as points in METRES.
   *
   * `null` when there is no way through at all. The last point is the closest
   * standable place to `to`, which may not be `to` — walking as near as
   * possible to a spot inside a wall is what a person expects from a click.
   */
  path(from: Vec2, to: Vec2): Vec2[] | null {
    const start = this.nearestOpen(from);
    const goal = this.nearestOpen(to);
    if (!start || !goal) return null;
    if (start.i === goal.i && start.j === goal.j) return [this.centre(goal.i, goal.j)];

    const n = this.cols * this.rows;
    const gScore = new Float64Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const startK = start.j * this.cols + start.i;
    const goalK = goal.j * this.cols + goal.i;
    gScore[startK] = 0;

    // A binary heap keyed on f. A linear scan is O(n) per pop and a 160,000
    // cell area makes that the whole frame.
    const heap: { k: number; f: number }[] = [{ k: startK, f: 0 }];
    const push = (item: { k: number; f: number }): void => {
      heap.push(item);
      let c = heap.length - 1;
      while (c > 0) {
        const parent = (c - 1) >> 1;
        if (heap[parent]!.f <= heap[c]!.f) break;
        [heap[parent], heap[c]] = [heap[c]!, heap[parent]!];
        c = parent;
      }
    };
    const pop = (): { k: number; f: number } => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let c = 0;
        for (;;) {
          const l = c * 2 + 1;
          const r = l + 1;
          let small = c;
          if (l < heap.length && heap[l]!.f < heap[small]!.f) small = l;
          if (r < heap.length && heap[r]!.f < heap[small]!.f) small = r;
          if (small === c) break;
          [heap[small], heap[c]] = [heap[c]!, heap[small]!];
          c = small;
        }
      }
      return top;
    };

    const gi = goal.i;
    const gj = goal.j;
    const heuristic = (i: number, j: number): number => {
      const dx = Math.abs(gi - i);
      const dy = Math.abs(gj - j);
      return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * this.res;
    };

    while (heap.length > 0) {
      const { k } = pop();
      if (closed[k]) continue;
      closed[k] = 1;
      if (k === goalK) break;
      const i = k % this.cols;
      const j = (k - i) / this.cols;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di;
          const nj = j + dj;
          if (!this.canCross(i, j, ni, nj)) continue;
          const nk = nj * this.cols + ni;
          if (closed[nk]) continue;
          const stepCost = (di !== 0 && dj !== 0 ? Math.SQRT2 : 1) * this.res;
          const g = gScore[k]! + stepCost;
          if (g >= gScore[nk]!) continue;
          gScore[nk] = g;
          cameFrom[nk] = k;
          push({ k: nk, f: g + heuristic(ni, nj) });
        }
      }
    }
    if (cameFrom[goalK] === -1 && goalK !== startK) return null;

    const cells: number[] = [];
    for (let k = goalK; k !== -1; k = cameFrom[k]!) {
      cells.push(k);
      if (k === startK) break;
    }
    cells.reverse();
    const points = cells.map((k) => {
      const i = k % this.cols;
      return this.centre(i, (k - i) / this.cols);
    });
    return this.pullStraight(points);
  }

  /**
   * Remove every waypoint the walker can simply see past.
   *
   * ⚠ Without this a path is a staircase of 25cm steps and a character walks
   * across open ground in visible zigzags — the tell-tale of a grid showing
   * through, which is exactly what D-567 is removing. Greedy rather than a
   * funnel: a funnel is optimal on a navmesh and this is a grid, where the
   * greedy version gives the same answer for a fraction of the code.
   */
  private pullStraight(points: Vec2[]): Vec2[] {
    if (points.length <= 2) return points;
    const out: Vec2[] = [points[0]!];
    let anchor = 0;
    while (anchor < points.length - 1) {
      let furthest = anchor + 1;
      for (let k = points.length - 1; k > anchor + 1; k--) {
        if (this.clearLine(points[anchor]!, points[k]!)) {
          furthest = k;
          break;
        }
      }
      out.push(points[furthest]!);
      anchor = furthest;
    }
    return out;
  }
}
