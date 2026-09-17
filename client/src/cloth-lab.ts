import * as THREE from 'three';
import { Cloth, defaultClothParams, type ClothParams } from './render/cloth';
import type { WorkbenchBody } from './render/workbench-body';

/**
 * The cloth workbench (stakeholder, 2026-08-18): re-pin a cape or robe to
 * any bone, resize and reshape it, retune the solver, choose what it
 * collides with — all live — then export the settings that worked.
 *
 * It runs on the SAME character the rest of the viewer is showing: the
 * built-in garment is hidden and this one takes its place, so what you
 * tune is what the game would render. The export is a plain JSON block
 * meant to be pasted back into the conversation and baked into
 * WorkbenchBody's construction.
 */

export interface GarmentConfig {
  /** Which of the game's garments this stands in for. */
  preset: 'cape' | 'robe skirt' | 'sleeve';
  /** Bone the top edge is pinned to, by WorkbenchBody.bones() name. */
  bone: string;
  /** Pin offset from that bone, in body-width units so it scales. */
  offset: { x: number; y: number; z: number };
  /** Pin rotation (radians) — tilts the whole attachment ring. */
  rotation: { x: number; y: number; z: number };
  layout: 'bar' | 'collar' | 'tube';
  /** Simulated grid. */
  cols: number;
  rows: number;
  /** Cut, in body-relative units. */
  width: number;
  height: number;
  /** collar: neck-ring radius. tube: waist radius. */
  collarRadius: number;
  /** collar: pinned shoulder-ring half-width. tube: hem radius. */
  shoulderHalfWidth: number;
  /** tube: leading rows that follow the bone rigidly. */
  rigidRows: number;
  /** Named colliders from WorkbenchBody.colliderCatalog(). */
  colliders: string[];
  /** Keep the cloth behind the wearer's coronal plane (capes). */
  backPlane: { enabled: boolean; maxZ: number; exemptAboveY: number };
  params: ClothParams;
}

/** Sensible starting points that mirror what the game builds today. */
export function presetConfig(preset: GarmentConfig['preset']): GarmentConfig {
  const base = {
    offset: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    rigidRows: 1,
    backPlane: { enabled: false, maxZ: -0.12, exemptAboveY: 0.26 },
  };
  switch (preset) {
    case 'cape':
      return {
        ...base,
        preset,
        bone: 'upper back (cape anchor)',
        layout: 'collar',
        cols: 13,
        rows: 10,
        // Body-relative, matching the baked game cape exactly (D-520):
        // width = 2.9·shoulder + 0.25·bodyW, length = 0.91·anchor height,
        // collar = 0.38·headH + 0.16·shoulder, hem ring = 1.99·shoulder.
        // The anchor offset/tilt are baked into the BONE, so zero here
        // means "where the game puts it".
        width: 2.9,
        height: 0.91,
        collarRadius: 0.38,
        shoulderHalfWidth: 1.99,
        colliders: [
          'chest', 'pelvis',
          'forearm right', 'hand right', 'forearm left', 'hand left',
          'thigh left', 'thigh right', 'shin left', 'shin right',
        ],
        backPlane: { enabled: true, maxZ: -0.04, exemptAboveY: 0.46 },
        params: {
          ...defaultClothParams('collar'),
          gravity: -24.5, damping: 0.875, windScale: 0.6, windStrength: 20,
          hug: 0, hugHemFalloff: 1, hugHemStart: 0.05, softPin: 0.02,
        },
      };
    case 'robe skirt':
      return {
        ...base,
        preset,
        bone: 'spine',
        layout: 'tube',
        cols: 22,
        rows: 18,
        width: 1,
        height: 0.99,
        collarRadius: 0.47,
        shoulderHalfWidth: 0.94,
        rigidRows: 8,
        colliders: ['hips (skirt)', 'thigh left', 'thigh right', 'shin left', 'shin right'],
        params: {
          ...defaultClothParams('tube'),
          gravity: -29, damping: 0.625, softPin: 0.2,
          hugHemFalloff: 0.25, hugHemStart: 0.2, floor: 0,
        },
      };
    default:
      return {
        ...base,
        preset,
        bone: 'elbow right',
        layout: 'tube',
        cols: 9,
        rows: 5,
        width: 0,
        height: 0.33,
        collarRadius: 0.15,
        shoulderHalfWidth: 0.22,
        rigidRows: 3,
        colliders: ['forearm right', 'hand right'],
        params: defaultClothParams('tube'),
      };
  }
}

/**
 * A live garment on a character, rebuilt whenever geometry changes and
 * re-read every frame for everything else.
 */
export class LabGarment {
  private cloth: Cloth | null = null;
  private anchor: THREE.Group | null = null;
  private anchorBone: THREE.Object3D | null = null;

  constructor(private visual: WorkbenchBody, public config: GarmentConfig) {
    this.rebuild();
  }

  /** Body-relative sizes resolved against THIS character's measurements. */
  private resolved(): { width: number; height: number; collar: number; shoulder: number } {
    const m = this.visual.measurements;
    const c = this.config;
    switch (c.preset) {
      case 'cape':
        return {
          width: m.shoulderW * c.width + m.bodyW * 0.25,
          // Length is a fraction of the ANCHOR height, not of nominal
          // body height: the anchor's own height varies with limb length,
          // so sizing off it is what keeps the hem in the same place on
          // every build (D-519).
          height: m.capeAnchorY * c.height,
          // A neck ring, sized off the head rather than off bulk.
          collar: m.headH * c.collarRadius + m.shoulderW * 0.16,
          shoulder: m.shoulderW * c.shoulderHalfWidth + m.bodyW * 0.12,
        };
      case 'robe skirt':
        return {
          width: 0,
          height: (m.height * 0.47) * c.height,
          collar: m.hipW * c.collarRadius * 1.05 + m.hipW * 0.0,
          shoulder: m.hipW * c.shoulderHalfWidth,
        };
      default:
        return {
          width: 0,
          height: m.bodyW * 2.2 * c.height,
          collar: m.bodyW * c.collarRadius,
          shoulder: m.bodyW * c.shoulderHalfWidth,
        };
    }
  }

  /** Geometry changes need a new solver; call after cols/rows/size edits. */
  rebuild(): void {
    this.dispose();
    const c = this.config;
    const r = this.resolved();
    const bones = this.visual.bones();
    this.anchorBone = bones[c.bone] ?? bones.chest!;
    // A dedicated anchor node carries the offset and rotation, so the pin
    // transform is one matrix the solver can read without special cases.
    this.anchor = new THREE.Group();
    this.anchorBone.add(this.anchor);
    this.applyAnchor();
    this.cloth = new Cloth(
      c.cols, c.rows, r.width, r.height, 0xb08a5a,
      c.layout, r.collar, r.shoulder, c.rigidRows,
    );
    Object.assign(this.cloth.params, c.params);
    this.visual.clothParent.add(this.cloth.mesh);
    this.cloth.mesh.layers.set(1); // the character/pixel layer
  }

  /** Offset and rotation are cheap — no rebuild needed. */
  applyAnchor(): void {
    if (!this.anchor) return;
    const m = this.visual.measurements;
    const c = this.config;
    this.anchor.position.set(
      c.offset.x * m.bodyW,
      c.offset.y * m.torsoH,
      c.offset.z * m.bodyW,
    );
    this.anchor.rotation.set(c.rotation.x, c.rotation.y, c.rotation.z);
  }

  step(dt: number, wind: number, t: number): void {
    if (!this.cloth || !this.anchor) return;
    Object.assign(this.cloth.params, this.config.params);
    const catalogue = this.visual.colliderCatalog();
    const colliders = this.config.colliders
      .map((name) => catalogue[name])
      .filter((x): x is NonNullable<typeof x> => x !== undefined);
    const bp = this.config.backPlane;
    this.cloth.step(
      dt, wind, t, this.anchor.matrixWorld, colliders,
      bp.enabled
        ? {
          matrix: (this.visual.bones().chest ?? this.anchorBone!).matrixWorld,
          maxZ: bp.maxZ * this.visual.measurements.bodyW,
          exemptAboveY: bp.exemptAboveY * this.visual.measurements.torsoH,
        }
        : undefined,
    );
  }

  dispose(): void {
    if (this.cloth) {
      this.visual.clothParent.remove(this.cloth.mesh);
      this.cloth.dispose();
      this.cloth = null;
    }
    if (this.anchor) {
      this.anchor.parent?.remove(this.anchor);
      this.anchor = null;
    }
  }
}
