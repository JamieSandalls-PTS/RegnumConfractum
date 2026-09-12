import * as THREE from 'three';
import {
  ACCENT_COLORS,
  APPEARANCE_LIMITS,
  ARCHETYPES,
  ARCHETYPE_NAMES,
  CLOTH_COLORS,
  HAIR_COLORS,
  HAIR_STYLES,
  SKIN_COLORS,
  describeAppearance,
  overrideFromAppearance,
  resolveAppearance,
  type Appearance,
  type AppearanceOverride,
  type ArchetypeName,
  type HairStyle,
  type CharacterLook,
} from '@rc/shared';
import { GameScene } from './render/scene';
import { CharacterVisual } from './render/character';
import { ImportedVisual } from './render/imported-visual';

/**
 * The appearance step of character creation (D-539).
 *
 * This is the in-game descendant of `creator.ts`, the standalone range-finding
 * tool the stakeholder used to ratify the model. The difference is deliberate
 * and worth stating: the tool's sliders are wider than any archetype because
 * finding where the rig breaks was the point; THIS panel is bounded by
 * `APPEARANCE_LIMITS`, which the server enforces independently (D-102). A
 * hand-rolled client that sends a two-and-a-half-metre character is rejected.
 *
 * Equipment is absent on purpose. Gear is stripped between rounds (D-522), so
 * a helm chosen at creation would be a permanent disguise that the recognition
 * system (D-219) never agreed to — silhouette is one of the few channels
 * disguise cannot fully close, and it must stay honest.
 *
 * The panel owns its own WebGL context and disposes it on close, so the login
 * overlay does not hold a renderer open behind the game.
 */

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export class AppearancePanel {
  private scene: GameScene | null = null;
  // ⚠ The union, not one cast.  holds the same pair for the same
  // reason (D-559): the code that drives a character must not know which it
  // has, and the compiler is what keeps the two interchangeable.
  private visual: CharacterVisual | ImportedVisual | null = null;
  private raf = 0;
  private clock = new THREE.Clock();
  private t = 0;
  private turntable = true;
  private azimuth = Math.PI * 0.25;
  private stage: HTMLElement | null = null;
  private descriptorEl: HTMLElement | null = null;

  /** Live state: a full override, seeded from the character's own seed. */
  private state: Required<AppearanceOverride>;

  /**
   * The heights this character may be, narrower than `APPEARANCE_LIMITS`.
   *
   * ⚠ A race bounds stature (D-560/D-572) and the SERVER enforces it, so a
   * slider that let somebody build a 2.05m elf would be offering a character
   * that is refused at the last step — after they had named it. The panel is
   * rebuilt when the race changes rather than clamped silently, because
   * quietly moving a slider somebody set is the game editing a choice without
   * saying so.
   */
  private heightRange: readonly [number, number] = APPEARANCE_LIMITS.height;

  constructor(private seed: number, heightRange?: readonly [number, number] | null) {
    if (heightRange) {
      this.heightRange = heightRange;
    }
    this.state = this.rolled(seed);
  }

  /** Re-seeds every control from a fresh roll. */
  reroll(seed: number): void {
    this.seed = seed;
    this.state = this.rolled(seed);
  }

  /**
   * A fresh roll, brought inside the race's stature.
   *
   * ⚠ The seed generates from an ARCHETYPE (D-402), whose ranges are the
   * world's and not this race's — so a roll can legitimately land outside it.
   * Clamping here is not the silent edit the slider refuses to make: nobody
   * has chosen this number yet, and leaving it out of range would show a
   * slider whose handle sits past its own end.
   */
  private rolled(seed: number): Required<AppearanceOverride> {
    const state = overrideFromAppearance(resolveAppearance(seed, null));
    state.height = clamp(state.height, this.heightRange);
    return state;
  }

  /**
   * What creation submits. Sparse would be smaller on the wire, but the
   * player has now looked at and accepted every one of these values — sending
   * the complete set is what makes the preview a promise rather than a hint.
   */
  value(): AppearanceOverride {
    return { ...this.state };
  }

  get appearance(): Appearance {
    return resolveAppearance(this.seed, this.state);
  }

  /** Builds the controls and the preview into `parent`. */
  mount(parent: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'appearance';

    const stage = document.createElement('div');
    stage.className = 'app-preview';
    wrap.appendChild(stage);
    this.stage = stage;

    const controls = document.createElement('div');
    controls.className = 'app-controls';
    wrap.appendChild(controls);
    parent.appendChild(wrap);

    const descriptor = document.createElement('div');
    descriptor.className = 'app-descriptor';
    wrap.appendChild(descriptor);
    this.descriptorEl = descriptor;

    this.buildControls(controls);
    this.startPreview(stage);
    this.rebuild();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.visual?.dispose();
    this.visual = null;
    if (this.scene) {
      // Free the context explicitly: the wizard can be opened and abandoned
      // many times in one session, and browsers cap live WebGL contexts.
      this.scene.renderer.dispose();
      this.scene.renderer.domElement.remove();
      this.scene = null;
    }
    this.stage = null;
  }

  // -------------------------------------------------------------------------

  private startPreview(stage: HTMLElement): void {
    this.scene = new GameScene(stage);
    this.scene.applyLighting('overcast');
    // The game frustum frames a play field ~13 units across; a single figure
    // in a 240px box needs a portrait crop, not a battlefield.
    this.scene.setZoom(0.16);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 32).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x4a453d }),
    );
    ground.receiveShadow = true;
    this.scene.scene.add(ground);
    // The creator tool learned this: lights and camera must share layers or
    // the character renders unlit on its own layer.
    this.scene.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) o.layers.enableAll();
    });
    this.scene.camera.layers.enableAll();
    const frame = (): void => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(this.clock.getDelta(), 0.033);
      this.t += dt;
      if (this.turntable) this.azimuth += dt * 0.35;
      this.visual?.update(dt, this.t, false, 0.25);
      const s = this.scene;
      if (!s) return;
      const target = new THREE.Vector3(0, this.state.height * 0.52, 0);
      s.follow(target);
      s.camera.position.set(
        target.x + Math.cos(this.azimuth) * Math.cos(0.28) * 4.6,
        target.y + Math.sin(0.28) * 4.6,
        target.z + Math.sin(this.azimuth) * Math.cos(0.28) * 4.6,
      );
      s.camera.lookAt(target);
      s.render();
    };
    frame();
  }

  /**
   * Show the face the player is choosing, rather than a stand-in for it.
   *
   * ⚠ A creation preview that renders a DIFFERENT cast from the world is the
   * lie this whole screen exists to avoid: a player tunes a procedural face,
   * accepts it, and then walks into the tavern as somebody else. So once a
   * look names parts, the preview is the imported assembly — the same
   * `ImportedVisual` the world builds, from the same part files.
   *
   * ⚠ The procedural sliders do NOT stop mattering when it swaps. They are
   * what the descriptor pipeline reads to call a stranger "a towering,
   * heavy-built figure" (D-201/D-539), and those words are what other players
   * see before they are told a name. Height is the one the imported cast also
   * honours; the rest describe rather than draw.
   */
  setLook(look: CharacterLook | null): void {
    this.look = look;
    this.rebuild();
  }

  private look: CharacterLook | null = null;

  private rebuild(): void {
    this.visual?.dispose();
    if (!this.scene) return;
    const appearance = this.appearance;
    const chosen = this.look && Object.keys(this.look.parts).length > 0 ? this.look : null;
    this.visual = chosen
      ? new ImportedVisual(appearance, this.scene.scene, this.seed, chosen)
      : new CharacterVisual(appearance, this.scene.scene);
    this.visual.setPosition(0, 0);
    this.visual.setFacing('s');
    this.visual.setRenderLayer(1);
    // No helm, no pauldrons, no weapon: creation dresses nobody (D-522).
    this.visual.setEquipment({
      helm: false,
      pauldrons: false,
      weapon: false,
      weaponKind: 'sword',
      cape: this.state.hasCape,
      robe: false,
    });
    if (this.descriptorEl) {
      // Described UNDRESSED, matching the preview. Equipment presence still
      // comes from the seed in `Appearance` (an M1 placeholder that the
      // inventory will replace), and a creation screen that promised "in a
      // battered helm" would be describing gear the character does not own
      // and cannot choose — gear is stripped between rounds (D-522).
      const bare = { ...appearance, helm: false, pauldrons: false, weapon: false };
      this.descriptorEl.textContent =
        `A stranger would call you ${describeAppearance(bare)}.`
        + ' What you are carrying changes that; what you are does not.';
    }
  }

  // --- control construction -------------------------------------------------

  private row(parent: HTMLElement, label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'app-row';
    const name = document.createElement('div');
    name.className = 'app-label';
    name.textContent = label;
    row.appendChild(name);
    parent.appendChild(row);
    return row;
  }

  private slider(
    parent: HTMLElement,
    label: string,
    key: 'height' | 'bulk' | 'shoulder' | 'limb' | 'headScale' | 'hairLen' | 'bust',
    fmt: (v: number) => string,
  ): HTMLElement {
    const row = this.row(parent, label);
    const input = document.createElement('input');
    input.type = 'range';
    // The race's range where it has one; the world's otherwise.
    const [lo, hi] = key === 'height' ? this.heightRange : APPEARANCE_LIMITS[key];
    input.min = String(lo);
    input.max = String(hi);
    input.step = String((hi - lo) / 100);
    input.value = String(this.state[key]);
    const readout = document.createElement('div');
    readout.className = 'app-val';
    readout.textContent = fmt(this.state[key]);
    input.addEventListener('input', () => {
      const v = clamp(
        Number(input.value),
        key === 'height' ? this.heightRange : APPEARANCE_LIMITS[key],
      );
      this.state[key] = v;
      readout.textContent = fmt(v);
      this.rebuild();
    });
    row.appendChild(input);
    row.appendChild(readout);
    return row;
  }

  private swatches(
    parent: HTMLElement,
    label: string,
    palette: readonly number[],
    key: 'skin' | 'hairColor' | 'cloth' | 'accent' | 'capeColor',
  ): void {
    const row = this.row(parent, label);
    const strip = document.createElement('div');
    strip.className = 'app-swatches';
    for (const c of palette) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = hex(c);
      b.className = this.state[key] === c ? 'active' : '';
      b.addEventListener('click', () => {
        this.state[key] = c;
        for (const other of strip.querySelectorAll('button')) other.classList.remove('active');
        b.classList.add('active');
        this.rebuild();
      });
      strip.appendChild(b);
    }
    row.appendChild(strip);
  }

  private choice<T extends string>(
    parent: HTMLElement,
    label: string,
    options: readonly T[],
    current: T,
    onPick: (v: T) => void,
    labelFor: (v: T) => string = (v) => v,
  ): void {
    const row = this.row(parent, label);
    const strip = document.createElement('div');
    strip.className = 'app-choice';
    for (const opt of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = labelFor(opt);
      b.className = opt === current ? 'active' : '';
      b.addEventListener('click', () => {
        onPick(opt);
        for (const other of strip.querySelectorAll('button')) other.classList.remove('active');
        b.classList.add('active');
        this.rebuild();
      });
      strip.appendChild(b);
    }
    row.appendChild(strip);
  }

  private buildControls(parent: HTMLElement): void {
    // Build first: it is the silhouette, and silhouette is what strangers
    // read (D-219). Picking one snaps the body sliders to its middle, which
    // is a starting point rather than a cage — every slider stays free.
    this.choice<ArchetypeName>(
      parent,
      'build',
      ARCHETYPE_NAMES,
      this.state.archetype,
      (v) => {
        this.state.archetype = v;
        const a = ARCHETYPES[v];
        const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2;
        this.state.height = clamp(mid(a.height), APPEARANCE_LIMITS.height);
        this.state.bulk = clamp(mid(a.bulk), APPEARANCE_LIMITS.bulk);
        this.state.shoulder = clamp(mid(a.shoulder), APPEARANCE_LIMITS.shoulder);
        this.state.limb = clamp(mid(a.limb), APPEARANCE_LIMITS.limb);
        this.state.headScale = clamp(mid(a.headScale), APPEARANCE_LIMITS.headScale);
        // The sliders below now disagree with the state; rebuild them all.
        parent.innerHTML = '';
        this.buildControls(parent);
      },
      (v) => v,
    );
    this.choice<'male' | 'female'>(
      parent,
      'body',
      ['male', 'female'],
      this.state.sex,
      (v) => {
        this.state.sex = v;
        parent.innerHTML = '';
        this.buildControls(parent);
      },
    );
    const f2 = (v: number) => v.toFixed(2);
    this.slider(parent, 'height', 'height', (v) => `${v.toFixed(2)}m`);
    this.slider(parent, 'bulk', 'bulk', f2);
    this.slider(parent, 'shoulders', 'shoulder', (v) => v.toFixed(3));
    this.slider(parent, 'limbs', 'limb', f2);
    this.slider(parent, 'head', 'headScale', f2);
    if (this.state.sex === 'female') this.slider(parent, 'bust', 'bust', f2);
    this.choice<HairStyle>(parent, 'hair', HAIR_STYLES, this.state.hairStyle, (v) => {
      this.state.hairStyle = v;
    });
    this.slider(parent, 'hair length', 'hairLen', f2);
    this.swatches(parent, 'hair colour', HAIR_COLORS, 'hairColor');
    this.swatches(parent, 'skin', SKIN_COLORS, 'skin');
    this.swatches(parent, 'cloth', CLOTH_COLORS, 'cloth');
    this.swatches(parent, 'trim', ACCENT_COLORS, 'accent');
    this.choice<'yes' | 'no'>(
      parent,
      'cloak',
      ['yes', 'no'],
      this.state.hasCape ? 'yes' : 'no',
      (v) => {
        this.state.hasCape = v === 'yes';
      },
    );
    this.swatches(parent, 'cloak colour', ACCENT_COLORS, 'capeColor');
    this.choice<'turn' | 'hold'>(parent, 'preview', ['turn', 'hold'], this.turntable ? 'turn' : 'hold', (v) => {
      this.turntable = v === 'turn';
    });
  }
}
