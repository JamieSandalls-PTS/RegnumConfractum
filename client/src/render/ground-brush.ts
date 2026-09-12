import * as THREE from 'three';
import type { GroundMaterial } from '@rc/shared';
import { paintedPlane } from './ground';
import {
  SPLAT_CHANNELS,
  SPLAT_MASKS,
  SPLAT_PIXELS_PER_METRE,
  WEIGHTS_PER_MASK,
  channelOf,
  compactChannels,
  coverageByte,
  loadLayerTexture,
  splatMaterial,
  type SplatLayer,
} from './ground-splat';

/**
 * The ground brush (D-585, re-cut by D-587, extended by D-588).
 *
 * Paints a soft-edged MASK saying how much of each material is where. The
 * renderer composites the real textures from it at full resolution.
 *
 * ⚠ SIX materials per area, across two masks of three weights each. Alpha is
 * not a fourth weight and no longer carries coverage either — it is 0 or 255
 * and nothing else, because those are the only two values a premultiplied
 * canvas round-trips without loss (see `WEIGHTS_PER_MASK`).
 *
 * ⚠ A material can be REMOVED from a map, and that used to be impossible while
 * the editor claimed otherwise: a layer was added on first use and never taken
 * away, so a material rubbed out to nothing still held its channel and the
 * advice "rub one out to free its channel" could not work. `removeMaterial`
 * clears the channel AND compacts the ones after it, moving their painted
 * weights down with them.
 */
export class GroundBrush {
  private readonly canvases: HTMLCanvasElement[] = [];
  private readonly ctxs: CanvasRenderingContext2D[] = [];
  private readonly textures: THREE.CanvasTexture[] = [];
  readonly mesh: THREE.Mesh;
  private layers: SplatLayer[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly area: { width: number; height: number },
    materials: readonly GroundMaterial[],
    existing?: readonly (HTMLImageElement | null)[],
  ) {
    const w = Math.max(1, Math.round(area.width * SPLAT_PIXELS_PER_METRE));
    const h = Math.max(1, Math.round(area.height * SPLAT_PIXELS_PER_METRE));
    for (let m = 0; m < SPLAT_MASKS; m++) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2d context for the ground brush');
      // ⚠ Starts EMPTY. An all-zero mask is unpainted ground, which the shader
      // discards — so the editor's own floor shows through and a person can
      // see where they have been.
      const img = existing?.[m];
      if (img) ctx.drawImage(img, 0, 0, w, h);
      this.canvases.push(canvas);
      this.ctxs.push(ctx);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.NoColorSpace; // it is data, not colour
      tex.magFilter = THREE.LinearFilter;
      this.textures.push(tex);
    }

    for (const mat of materials.slice(0, SPLAT_CHANNELS)) this.addLayer(mat);

    this.mesh = paintedPlane(area, this.textures[0]!);
    this.mesh.material = splatMaterial(this.textures, this.layers, area);
    scene.add(this.mesh);
  }

  private addLayer(mat: GroundMaterial): void {
    this.layers.push({
      material: mat,
      texture: mat.texture ? loadLayerTexture(`textures/ground/${mat.texture}`) : null,
    });
  }

  private refresh(): void {
    this.mesh.material = splatMaterial(this.textures, this.layers, this.area);
    for (const t of this.textures) t.needsUpdate = true;
  }

  /** The materials this area is painted with, in channel order. */
  get materials(): GroundMaterial[] {
    return this.layers.map((l) => l.material);
  }

  /** How much of the map each material actually covers, 0-1. */
  coverage(): { id: string; name: string; share: number }[] {
    const totals = new Array<number>(this.layers.length).fill(0);
    let texels = 1;
    for (let m = 0; m < SPLAT_MASKS; m++) {
      const { width, height } = this.canvases[m]!;
      const data = this.ctxs[m]!.getImageData(0, 0, width, height).data;
      texels = width * height;
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < WEIGHTS_PER_MASK; c++) {
          const layer = m * WEIGHTS_PER_MASK + c;
          if (layer < totals.length) totals[layer]! += data[i + c]! / 255;
        }
      }
    }
    return this.layers.map((l, i) => ({
      id: l.material.id,
      name: l.material.name,
      share: totals[i]! / texels,
    }));
  }

  /**
   * Take a material off this map entirely (D-588).
   *
   * ⚠ It clears the channel and then COMPACTS the ones after it: every later
   * material moves down a channel, and its painted weights move with it.
   * Clearing alone would leave a hole nothing could use — which is exactly the
   * bug that made the editor's "rub it out to free a channel" advice false.
   */
  removeMaterial(id: string): boolean {
    const index = this.layers.findIndex((l) => l.material.id === id);
    if (index < 0) return false;

    const all = this.ctxs.map((ctx, m) => {
      const { width, height } = this.canvases[m]!;
      return ctx.getImageData(0, 0, width, height);
    });
    // The arithmetic lives in `compactChannels`, headlessly tested: whether
    // the weights moved with their material is the half of this that renders
    // identically either way.
    compactChannels(all.map((i) => i.data), index);
    for (let m = 0; m < SPLAT_MASKS; m++) this.ctxs[m]!.putImageData(all[m]!, 0, 0);

    this.layers.splice(index, 1);
    this.refresh();
    return true;
  }

  /** Which channel a material owns, adding it if there is room. Null when full. */
  private channelFor(mat: GroundMaterial): number | null {
    const at = this.layers.findIndex((l) => l.material.id === mat.id);
    if (at >= 0) return at;
    if (this.layers.length >= SPLAT_CHANNELS) return null;
    this.addLayer(mat);
    this.refresh();
    return this.layers.length - 1;
  }

  /**
   * One dab, in WORLD metres.
   *
   * ⚠ Painting a material takes weight AWAY from every other channel in BOTH
   * masks at that texel, or two materials both at full strength wash out to
   * their average forever and nothing can ever be painted over.
   */
  dab(
    mat: GroundMaterial,
    x: number,
    y: number,
    radius: number,
    softness: number,
    strength: number,
  ): 'painted' | 'full' {
    const layer = this.channelFor(mat);
    if (layer === null) return 'full';
    const target = channelOf(layer);

    const px = (x + 0.5) * SPLAT_PIXELS_PER_METRE;
    const py = (y + 0.5) * SPLAT_PIXELS_PER_METRE;
    const pr = Math.max(1, radius * SPLAT_PIXELS_PER_METRE);
    const inner = pr * (1 - softness);

    for (let m = 0; m < SPLAT_MASKS; m++) {
      const canvas = this.canvases[m]!;
      const x0 = Math.max(0, Math.floor(px - pr));
      const y0 = Math.max(0, Math.floor(py - pr));
      const x1 = Math.min(canvas.width, Math.ceil(px + pr));
      const y1 = Math.min(canvas.height, Math.ceil(py + pr));
      if (x1 <= x0 || y1 <= y0) continue;
      const img = this.ctxs[m]!.getImageData(x0, y0, x1 - x0, y1 - y0);
      const data = img.data;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const d = Math.hypot(xx + 0.5 - px, yy + 0.5 - py);
          if (d > pr) continue;
          // The soft edge: full strength inside, fading to nothing at the rim.
          const fall = d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-3, pr - inner);
          const add = strength * fall;
          if (add <= 0) continue;
          const i = ((yy - y0) * (x1 - x0) + (xx - x0)) * 4;
          for (let c = 0; c < WEIGHTS_PER_MASK; c++) {
            const was = data[i + c]!;
            data[i + c] = m === target.mask && c === target.channel
              ? Math.min(255, was + add * 255)
              : Math.max(0, was * (1 - add));
          }
          data[i + 3] = coverageByte(data[i]!, data[i + 1]!, data[i + 2]!);
        }
      }
      this.ctxs[m]!.putImageData(img, x0, y0);
      this.textures[m]!.needsUpdate = true;
    }
    return 'painted';
  }

  /** Rub the painted ground back out, same brush shape. */
  erase(x: number, y: number, radius: number, softness: number, strength: number): void {
    const px = (x + 0.5) * SPLAT_PIXELS_PER_METRE;
    const py = (y + 0.5) * SPLAT_PIXELS_PER_METRE;
    const pr = Math.max(1, radius * SPLAT_PIXELS_PER_METRE);
    const inner = pr * (1 - softness);
    for (let m = 0; m < SPLAT_MASKS; m++) {
      const canvas = this.canvases[m]!;
      const x0 = Math.max(0, Math.floor(px - pr));
      const y0 = Math.max(0, Math.floor(py - pr));
      const x1 = Math.min(canvas.width, Math.ceil(px + pr));
      const y1 = Math.min(canvas.height, Math.ceil(py + pr));
      if (x1 <= x0 || y1 <= y0) continue;
      const img = this.ctxs[m]!.getImageData(x0, y0, x1 - x0, y1 - y0);
      const data = img.data;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const d = Math.hypot(xx + 0.5 - px, yy + 0.5 - py);
          if (d > pr) continue;
          const fall = d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-3, pr - inner);
          const take = 1 - strength * fall;
          const i = ((yy - y0) * (x1 - x0) + (xx - x0)) * 4;
          for (let c = 0; c < WEIGHTS_PER_MASK; c++) data[i + c] = data[i + c]! * take;
          data[i + 3] = coverageByte(data[i]!, data[i + 1]!, data[i + 2]!);
        }
      }
      this.ctxs[m]!.putImageData(img, x0, y0);
      this.textures[m]!.needsUpdate = true;
    }
  }

  /**
   * True once anything at all has been painted.
   *
   * ⚠ The WEIGHTS only. Alpha is derived from them, so reading it here would
   * be reading the same fact twice — and a map rubbed back to nothing would
   * still count as painted if alpha were ever left behind.
   */
  get painted(): boolean {
    for (let m = 0; m < SPLAT_MASKS; m++) {
      const { width, height } = this.canvases[m]!;
      const data = this.ctxs[m]!.getImageData(0, 0, width, height).data;
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < WEIGHTS_PER_MASK; c++) if (data[i + c]! > 0) return true;
      }
    }
    return false;
  }

  /**
   * What is actually in the masks — a verification hook, not a feature.
   *
   * ⚠ A splat mask cannot be judged by looking: "the ground is blank" has at
   * least three causes that are identical on screen (nothing painted, the
   * shader discarding, the channels zeroed on upload). It was the third once
   * already.
   */
  debug(): { channels: number[]; nonZero: number; materials: string[] } {
    const channels = new Array<number>(SPLAT_CHANNELS).fill(0);
    let nonZero = 0;
    for (let m = 0; m < SPLAT_MASKS; m++) {
      const { width, height } = this.canvases[m]!;
      const data = this.ctxs[m]!.getImageData(0, 0, width, height).data;
      for (let i = 0; i < data.length; i += 4) {
        let any = false;
        for (let c = 0; c < WEIGHTS_PER_MASK; c++) {
          if (data[i + c]! > 0) { channels[m * WEIGHTS_PER_MASK + c]! += 1; any = true; }
        }
        if (any) nonZero++;
      }
    }
    return { channels, nonZero, materials: this.layers.map((l) => l.material.id) };
  }

  /** The masks, for saving. One data URL per mask. */
  toDataUrls(): string[] {
    return this.canvases.map((c) => c.toDataURL('image/png'));
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    for (const t of this.textures) t.dispose();
  }
}
