import * as THREE from 'three';

/**
 * A way-marker as a player sees it (D-641).
 *
 * D-638 deleted the tile renderer, and the transition tile kinds it drew
 * went with it — so from then on a door was an invisible spot on the floor
 * that happened to work, which the stakeholder reported as transitions not
 * rendering. This is the marker's own presentation: a soft ring on the ground
 * that breathes, a faint column of light above it, and the marker's NAME on
 * a label, because a way-marker is a named place and not an edge on a graph.
 *
 * ⚠ Presentation only. The wire says where a door is and what it is called
 * (`snapshot.area.transitions`), never where it leads: a client that knew the
 * other end of every door would know the map before walking it.
 */

const LAYER_CHARACTER = 1;
const RING_COLOUR = 0x9fd0ff;

function labelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const scale = 2;
  const font = `${14 * scale}px system-ui, sans-serif`;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 24 * scale;
  const h = 28 * scale;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = 'rgba(10, 12, 20, 0.72)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 8 * scale);
  ctx.fill();
  ctx.fillStyle = '#dce9ff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false });
  const sprite = new THREE.Sprite(material);
  // Sized in metres off the canvas's aspect: a label is readable at the
  // camera's scale, not at a pixel size that grows with zoom.
  const metres = 0.42;
  sprite.scale.set((w / h) * metres, metres, 1);
  return sprite;
}

export class TransitionVisual {
  private readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly column: THREE.Mesh;
  private readonly phase = Math.random() * Math.PI * 2;

  constructor(
    private readonly scene: THREE.Scene,
    readonly at: { x: number; y: number; name?: string | undefined },
  ) {
    this.group.position.set(at.x, 0.03, at.y);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.5, 32),
      new THREE.MeshBasicMaterial({
        color: RING_COLOUR, transparent: true, opacity: 0.55, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.4, 1.6, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: RING_COLOUR, transparent: true, opacity: 0.08, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      }),
    );
    this.column.position.y = 0.8;
    this.group.add(this.ring, this.column);
    if (at.name) {
      const label = labelSprite(at.name);
      label.position.y = 1.85;
      this.group.add(label);
    }
    this.group.traverse((o) => o.layers.set(LAYER_CHARACTER));
    scene.add(this.group);
  }

  update(t: number): void {
    const breath = 0.5 + 0.5 * Math.sin(t * 1.8 + this.phase);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.35 * breath;
    this.ring.scale.setScalar(1 + 0.06 * breath);
    (this.column.material as THREE.MeshBasicMaterial).opacity = 0.05 + 0.06 * breath;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mat) {
        const map = (mat as THREE.SpriteMaterial).map;
        if (map) map.dispose();
        mat.dispose();
      }
    });
  }
}
