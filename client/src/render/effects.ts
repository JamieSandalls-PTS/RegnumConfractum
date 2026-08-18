import * as THREE from 'three';

/**
 * Combat effects (stakeholder, 2026-08-18): projectiles that leave a weapon
 * and land on a target, with light and particles around magical ones.
 *
 * Purely cosmetic and purely client-side. Every effect is triggered by an
 * authoritative server event, and none of them decide anything — a bolt
 * that visually misses still did exactly the damage the server said
 * (D-102). Effects sit on render layer 1 with the characters so the split
 * pass quantises them the same way (D-404).
 */

const LAYER_CHARACTER = 1;

interface Spark {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
}

interface Bolt {
  group: THREE.Group;
  light: THREE.PointLight | null;
  from: THREE.Vector3;
  to: THREE.Vector3;
  elapsed: number;
  duration: number;
  magic: boolean;
  /** Fires when the bolt lands — the impact burst. */
  onArrive: (at: THREE.Vector3) => void;
}

export class CombatEffects {
  private group = new THREE.Group();
  private bolts: Bolt[] = [];
  private sparks: Spark[] = [];
  /** One geometry and a handful of materials, shared by every mote. */
  private sparkGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  private boltGeo = new THREE.SphereGeometry(0.085, 8, 6);
  private haloGeo = new THREE.SphereGeometry(0.17, 8, 6);
  private matArcaneCore = new THREE.MeshBasicMaterial({ color: 0xdcf0ff });
  private matArcane = new THREE.MeshBasicMaterial({
    color: 0x74b8f0, transparent: true, opacity: 0.55,
  });
  private matEmber = new THREE.MeshBasicMaterial({ color: 0xffc46b });
  private matBlood = new THREE.MeshBasicMaterial({ color: 0x8e2b22 });
  private tmp = new THREE.Vector3();

  constructor(private scene: THREE.Scene) {
    scene.add(this.group);
  }

  /**
   * A magical bolt: bright core, soft halo, its own light, and a tail of
   * motes. Lands after a flight proportional to the distance.
   */
  castBolt(from: THREE.Vector3, to: THREE.Vector3): void {
    const group = new THREE.Group();
    const core = new THREE.Mesh(this.boltGeo, this.matArcaneCore);
    const halo = new THREE.Mesh(this.haloGeo, this.matArcane);
    group.add(core, halo);
    group.position.copy(from);
    // A travelling light is what sells magic in a dark room; it is cheap
    // because exactly one bolt is usually in the air.
    const light = new THREE.PointLight(0x8ecbff, 9, 6, 1.8);
    group.add(light);
    this.group.add(group);
    for (const o of [group, core, halo, light]) o.layers.set(LAYER_CHARACTER);
    const distance = from.distanceTo(to);
    this.bolts.push({
      group,
      light,
      from: from.clone(),
      to: to.clone(),
      elapsed: 0,
      duration: Math.min(0.5, 0.09 + distance * 0.045),
      magic: true,
      onArrive: (at) => this.burst(at, 'arcane'),
    });
  }

  /** The wind-up glow: motes gathering at the weapon before release. */
  gather(at: THREE.Vector3): void {
    for (let i = 0; i < 7; i++) {
      const mesh = new THREE.Mesh(this.sparkGeo, this.matArcaneCore);
      mesh.layers.set(LAYER_CHARACTER);
      // Spawn on a small shell and drift INWARD — gathering, not spraying.
      const dir = new THREE.Vector3(
        Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5,
      ).normalize();
      mesh.position.copy(at).addScaledVector(dir, 0.34);
      this.group.add(mesh);
      this.sparks.push({
        mesh,
        vel: dir.multiplyScalar(-0.85),
        life: 0.4,
        maxLife: 0.4,
        gravity: 0,
      });
    }
  }

  /** Impact: a spray of motes at the point of contact. */
  burst(at: THREE.Vector3, kind: 'arcane' | 'physical'): void {
    const magic = kind === 'arcane';
    const count = magic ? 16 : 10;
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(
        this.sparkGeo,
        magic ? (i % 3 === 0 ? this.matArcaneCore : this.matEmber) : this.matBlood,
      );
      mesh.layers.set(LAYER_CHARACTER);
      mesh.position.copy(at);
      this.group.add(mesh);
      const speed = magic ? 1.6 + Math.random() * 1.9 : 0.9 + Math.random() * 1.2;
      this.sparks.push({
        mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * speed,
          Math.random() * speed * 0.85 + 0.3,
          (Math.random() - 0.5) * speed,
        ),
        life: magic ? 0.5 + Math.random() * 0.3 : 0.34 + Math.random() * 0.22,
        maxLife: magic ? 0.8 : 0.56,
        gravity: magic ? 2.4 : 5.2,
      });
    }
    if (magic) {
      // A brief flash at the point of impact.
      const flash = new THREE.PointLight(0xa8dcff, 16, 5, 2);
      flash.position.copy(at);
      flash.layers.set(LAYER_CHARACTER);
      this.group.add(flash);
      this.bolts.push({
        group: flash as unknown as THREE.Group,
        light: flash,
        from: at.clone(),
        to: at.clone(),
        elapsed: 0,
        duration: 0.22,
        magic: true,
        onArrive: () => { /* the flash simply expires */ },
      });
    }
  }

  update(dt: number): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]!;
      b.elapsed += dt;
      const f = Math.min(1, b.elapsed / b.duration);
      b.group.position.copy(b.from).lerp(b.to, f);
      // Bolts fly a shallow arc rather than a dead-straight line.
      if (b.magic && b.from.distanceToSquared(b.to) > 0.01) {
        b.group.position.y += Math.sin(f * Math.PI) * 0.22;
        if (Math.random() < 0.55) {
          this.tmp.copy(b.group.position);
          this.trailMote(this.tmp);
        }
      }
      if (b.light) b.light.intensity *= 1 - dt * (b.duration < 0.3 ? 6 : 0.6);
      if (f >= 1) {
        b.onArrive(b.group.position.clone());
        this.group.remove(b.group);
        if (b.light) b.light.parent?.remove(b.light);
        this.bolts.splice(i, 1);
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]!;
      s.life -= dt;
      if (s.life <= 0) {
        this.group.remove(s.mesh);
        this.sparks.splice(i, 1);
        continue;
      }
      s.vel.y -= s.gravity * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      // Shrink as they die: cheaper and cleaner than fading a material.
      const k = Math.max(0.05, s.life / s.maxLife);
      s.mesh.scale.setScalar(k);
    }
  }

  private trailMote(at: THREE.Vector3): void {
    const mesh = new THREE.Mesh(this.sparkGeo, this.matArcane);
    mesh.layers.set(LAYER_CHARACTER);
    mesh.position.copy(at);
    this.group.add(mesh);
    this.sparks.push({
      mesh,
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.15, (Math.random() - 0.5) * 0.3),
      life: 0.3,
      maxLife: 0.3,
      gravity: 0,
    });
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.bolts.length = 0;
    this.sparks.length = 0;
    this.sparkGeo.dispose();
    this.boltGeo.dispose();
    this.haloGeo.dispose();
    for (const m of [this.matArcaneCore, this.matArcane, this.matEmber, this.matBlood]) {
      m.dispose();
    }
  }
}
