import { defaultClothParams, type ClothParams } from './render/cloth';
import { LabGarment, presetConfig, type GarmentConfig } from './cloth-lab';
import type { WorkbenchBody } from './render/workbench-body';

/**
 * The cloth tab's controls. Kept apart from the solver and from the rest of
 * the viewer so the workbench is one readable file: build the widgets,
 * mutate the config, decide whether the change needs a solver rebuild.
 */

type Rebuild = 'geometry' | 'anchor' | 'live';

/** Which config fields force a new solver rather than a live tweak. */
const GEOMETRY_FIELDS = new Set([
  'cols', 'rows', 'width', 'height', 'collarRadius', 'shoulderHalfWidth',
  'rigidRows', 'layout', 'bone', 'preset',
]);

export class ClothTab {
  /** One garment per character on stage, all sharing ONE config object so a
   * slider moves every cape at once. The built-in garment is suppressed for
   * everybody, so anything less would strip the rest of the cast naked
   * (stakeholder, 2026-08-18). Judging drape across builds is also the
   * point of body-relative sizing. */
  private garments: LabGarment[] = [];
  private config: GarmentConfig = presetConfig('cape');
  private visuals: WorkbenchBody[] = [];

  constructor(
    private root: HTMLElement,
    /** Hides the characters' OWN cape/robe so the lab garment stands alone. */
    private setBuiltInGarments: (cape: boolean, robe: boolean) => void,
  ) {}

  /** Called whenever the viewer repopulates: re-attach to the new bodies. */
  attach(visuals: WorkbenchBody[]): void {
    for (const g of this.garments) g.dispose();
    this.garments = [];
    this.visuals = visuals;
    for (const v of visuals) this.garments.push(new LabGarment(v, this.config));
    this.render();
  }

  step(dt: number, wind: number, t: number): void {
    for (const g of this.garments) g.step(dt, wind, t);
  }

  /** True while the tab wants the built-in garment suppressed. */
  private syncBuiltIns(): void {
    // The lab's cape replaces the real one; robe pieces other than the
    // skirt stay so the body still reads as dressed.
    this.setBuiltInGarments(this.config.preset !== 'cape', this.config.preset !== 'robe skirt');
  }

  private apply(kind: Rebuild): void {
    // Every garment shares the one config, so a change lands on the whole
    // cast — the same edit, judged against every build at once.
    if (kind === 'geometry') for (const g of this.garments) g.rebuild();
    else if (kind === 'anchor') for (const g of this.garments) g.applyAnchor();
    // 'live' needs nothing: step() copies params every frame.
  }

  // --- widget helpers -------------------------------------------------------

  private label(text: string): void {
    const el = document.createElement('label');
    el.textContent = text;
    this.root.appendChild(el);
  }

  private slider(
    text: string, min: number, max: number, step: number, value: number,
    onInput: (v: number) => void, kind: Rebuild, digits = 2,
  ): void {
    this.label(text);
    const row = document.createElement('div');
    row.className = 'sl';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const out = document.createElement('b');
    out.textContent = value.toFixed(digits);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = v.toFixed(digits);
      onInput(v);
      this.apply(kind);
    });
    row.append(input, out);
    this.root.appendChild(row);
  }

  private select(
    text: string, options: string[], value: string,
    onChange: (v: string) => void, kind: Rebuild,
  ): void {
    this.label(text);
    const sel = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      if (o === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      onChange(sel.value);
      this.apply(kind);
      this.render();
    });
    this.root.appendChild(sel);
  }

  private check(text: string, value: boolean, onChange: (v: boolean) => void, kind: Rebuild): void {
    const row = document.createElement('div');
    row.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    const span = document.createElement('span');
    span.textContent = text;
    input.addEventListener('change', () => {
      onChange(input.checked);
      this.apply(kind);
    });
    row.append(input, span);
    this.root.appendChild(row);
  }

  // --- the panel ------------------------------------------------------------

  render(): void {
    this.root.innerHTML = '';
    this.syncBuiltIns();
    const c = this.config;
    // Bone and collider NAMES are the same for every build, so the first
    // body on stage is a fine source for the option lists.
    const sample = this.visuals[0];

    if (!sample) {
      this.root.textContent = 'No characters on stage — reroll on the Cast tab.';
      return;
    }

    const count = document.createElement('div');
    count.className = 'hint';
    count.style.marginTop = '0';
    count.textContent = `Tuning ${this.garments.length} garment(s) — one per character on stage.`;
    this.root.appendChild(count);

    this.select('garment', ['cape', 'robe skirt', 'sleeve'], c.preset, (v) => {
      // A different garment starts from its own sensible defaults.
      this.config = presetConfig(v as GarmentConfig['preset']);
      for (const g of this.garments) g.config = this.config;
    }, 'geometry');

    this.label('— attachment —');
    this.select('pinned to bone', Object.keys(sample.bones()), c.bone,
      (v) => { c.bone = v; }, 'geometry');
    this.slider('offset x (body widths)', -1.5, 1.5, 0.02, c.offset.x,
      (v) => { c.offset.x = v; }, 'anchor');
    this.slider('offset y (torso heights)', -1.5, 1.5, 0.02, c.offset.y,
      (v) => { c.offset.y = v; }, 'anchor');
    this.slider('offset z (body widths)', -1.5, 1.5, 0.02, c.offset.z,
      (v) => { c.offset.z = v; }, 'anchor');
    this.slider('tilt x', -1.6, 1.6, 0.02, c.rotation.x, (v) => { c.rotation.x = v; }, 'anchor');
    this.slider('turn y', -3.2, 3.2, 0.02, c.rotation.y, (v) => { c.rotation.y = v; }, 'anchor');
    this.slider('roll z', -1.6, 1.6, 0.02, c.rotation.z, (v) => { c.rotation.z = v; }, 'anchor');

    this.label('— cut & grid —');
    this.select('layout', ['bar', 'collar', 'tube'], c.layout,
      (v) => { c.layout = v as GarmentConfig['layout']; }, 'geometry');
    this.slider('columns', 3, 28, 1, c.cols, (v) => { c.cols = v; }, 'geometry', 0);
    this.slider('rows', 2, 24, 1, c.rows, (v) => { c.rows = v; }, 'geometry', 0);
    this.slider('width', 0, 3, 0.02, c.width, (v) => { c.width = v; }, 'geometry');
    this.slider('length', 0.05, 1.6, 0.02, c.height, (v) => { c.height = v; }, 'geometry');
    this.slider('top radius (collar / waist)', 0, 2, 0.01, c.collarRadius,
      (v) => { c.collarRadius = v; }, 'geometry');
    this.slider('bottom radius (shoulders / hem)', 0, 2.5, 0.01, c.shoulderHalfWidth,
      (v) => { c.shoulderHalfWidth = v; }, 'geometry');
    this.slider('rigid rows (tube)', 0, 8, 1, c.rigidRows,
      (v) => { c.rigidRows = v; }, 'geometry', 0);

    this.label('— collisions —');
    const catalogue = Object.keys(sample.colliderCatalog());
    for (const name of catalogue) {
      this.check(name, c.colliders.includes(name), (on) => {
        c.colliders = on
          ? [...c.colliders, name]
          : c.colliders.filter((x) => x !== name);
      }, 'live');
    }
    this.check('keep behind the body (back plane)', c.backPlane.enabled,
      (on) => { c.backPlane.enabled = on; }, 'live');
    this.slider('back-plane depth', -1, 0.6, 0.02, c.backPlane.maxZ,
      (v) => { c.backPlane.maxZ = v; }, 'live');
    this.slider('back-plane exempt above', -0.5, 1.5, 0.02, c.backPlane.exemptAboveY,
      (v) => { c.backPlane.exemptAboveY = v; }, 'live');

    this.label('— physics —');
    const P = c.params;
    const p = (
      text: string, key: keyof ClothParams, min: number, max: number, step: number,
    ): void => this.slider(text, min, max, step, P[key] as number,
      (v) => { (P as unknown as Record<string, number>)[key as string] = v; }, 'live');
    p('gravity (heavier ↓)', 'gravity', -30, 0, 0.5);
    p('damping (lower = deader)', 'damping', 0.5, 1, 0.005);
    p('wind response', 'windScale', 0, 3, 0.05);
    p('wind strength', 'windStrength', 0, 20, 0.5);
    p('hug the body', 'hug', 0, 12, 0.1);
    p('hug falloff at hem', 'hugHemFalloff', 0, 1, 0.05);
    p('hug hem starts at', 'hugHemStart', 0, 1, 0.05);
    p('soft-pin strength', 'softPin', 0, 1, 0.02);
    p('stiffness per pass', 'stiffness', 0.05, 0.5, 0.01);
    p('floor height', 'floor', 0, 0.3, 0.005);
    p('floor friction', 'floorFriction', 0, 1, 0.05);
    this.slider('solver passes (0 = follow global)', 0, 14, 1, P.iterations ?? 0,
      (v) => { P.iterations = v === 0 ? null : v; }, 'live', 0);

    const row = document.createElement('div');
    row.className = 'row2';
    const reset = document.createElement('button');
    reset.textContent = 'Reset garment';
    reset.addEventListener('click', () => {
      this.config = presetConfig(c.preset);
      for (const g of this.garments) {
        g.config = this.config;
        g.rebuild();
      }
      this.render();
    });
    const resetPhys = document.createElement('button');
    resetPhys.textContent = 'Reset physics only';
    resetPhys.addEventListener('click', () => {
      Object.assign(c.params, defaultClothParams(c.layout));
      this.render();
    });
    row.append(reset, resetPhys);
    this.root.appendChild(row);

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export settings (paste to Claude)';
    const out = document.createElement('textarea');
    out.style.height = '150px';
    out.style.fontFamily = 'monospace';
    out.style.fontSize = '10px';
    exportBtn.addEventListener('click', () => {
      out.value = JSON.stringify(this.config, null, 1);
      out.select();
      navigator.clipboard?.writeText(out.value).catch(() => { /* selection is enough */ });
    });
    this.root.append(exportBtn, out);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      'Sizes are body-relative, so a setting that works holds for every build. '
      + 'Grid and cut changes rebuild the solver; everything else is live.';
    this.root.appendChild(hint);
  }

  dispose(): void {
    for (const g of this.garments) g.dispose();
    this.garments = [];
  }
}
