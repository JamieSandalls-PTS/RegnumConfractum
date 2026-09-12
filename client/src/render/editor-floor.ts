import * as THREE from 'three';

/**
 * The editor's ground: an empty, highlighted floor to build on (D-567).
 *
 * ⚠ This replaces `Terrain` in the editor, and the replacement is the point.
 * Terrain drew painted tiles — grass, dirt, stone, seven wall families — which
 * is the art the tile system supplied and D-567 retired. A map is now BUILT
 * from pack assets standing on open ground, so the ground has to get out of
 * the way and still be visible enough to aim at.
 *
 * So it is deliberately not a surface with a material opinion: a flat neutral
 * plane, a metre grid to judge size against, and a bright boundary. Anything
 * more (a texture, a colour per region) would be scenery competing with the
 * assets you are placing, and would read as the floor being finished.
 */

/** Every fifth line is drawn heavier — you cannot count sixty identical ones. */
const MAJOR = 5;

export class EditorFloor {
  private readonly group = new THREE.Group();

  constructor(
    scene: THREE.Scene,
    private readonly width: number,
    private readonly height: number,
  ) {
    // The plane itself. Dark and matte so a placed asset of any colour reads
    // against it, and just light enough that the grid sits on something.
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshStandardMaterial({
        color: 0x22262b,
        roughness: 1,
        metalness: 0,
      }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(width / 2, 0, height / 2);
    plane.receiveShadow = true;
    this.group.add(plane);

    this.group.add(this.grid());
    this.group.add(this.edge());
    scene.add(this.group);
  }

  /**
   * A metre grid, as line segments rather than three-and-a-half thousand
   * quads. ⚠ Lifted 1cm clear of the plane: coplanar geometry z-fights, and
   * the symptom is a grid that flickers as the camera turns rather than one
   * that is obviously wrong.
   */
  private grid(): THREE.LineSegments {
    const minor: number[] = [];
    const major: number[] = [];
    const y = 0.01;
    for (let x = 0; x <= this.width; x++) {
      (x % MAJOR === 0 ? major : minor).push(x, y, 0, x, y, this.height);
    }
    for (let z = 0; z <= this.height; z++) {
      (z % MAJOR === 0 ? major : minor).push(0, y, z, this.width, y, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...minor, ...major], 3));
    // One draw call, two colours: the groups split the same buffer.
    geo.addGroup(0, minor.length / 3, 0);
    geo.addGroup(minor.length / 3, major.length / 3, 1);
    return new THREE.LineSegments(geo, [
      new THREE.LineBasicMaterial({ color: 0x424b55 }),
      new THREE.LineBasicMaterial({ color: 0x6f7d8c }),
    ]);
  }

  /**
   * The edge of the map.
   *
   * ⚠ Drawn from `width`/`height` for now. D-567 makes the boundary an
   * authored POLYGON — which is what lets an area stop being a rectangle —
   * and this becomes that polygon's outline when the schema carries it. Said
   * here so the rectangle is not mistaken for the decision.
   */
  private edge(): THREE.LineSegments {
    const y = 0.02;
    const c: [number, number][] = [
      [0, 0],
      [this.width, 0],
      [this.width, this.height],
      [0, this.height],
    ];
    const pts: number[] = [];
    for (let i = 0; i < c.length; i++) {
      const a = c[i]!;
      const b = c[(i + 1) % c.length]!;
      pts.push(a[0], y, a[1], b[0], y, b[1]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xc8a34a }));
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh | THREE.LineSegments;
      if (!m.geometry) return;
      m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat.dispose();
    });
    this.group.clear();
  }
}
