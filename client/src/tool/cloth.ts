import type { LightingProfile } from '@rc/shared';
import { WorkbenchBody } from '../render/workbench-body';
import { clothTuning } from '../render/cloth';
import { ClothTab } from '../cloth-ui';
import { type ToolContext, type ToolTab, el, heading, hint, labelled, selectInput } from './context';

/**
 * The cloth workbench, as a tab of the Bodies stage (D-520, D-617, D-629).
 *
 * This was `/viewer.html`: one page, one scene, one jointed placeholder body,
 * and the panel that tunes a cape or a robe skirt against it and exports the
 * numbers. It is here now because a page of its own was a fourth thing to
 * open and the second reason the tools felt unlinked. What it does has not
 * changed, and neither has the caveat: the body is a STAND-IN at roughly human
 * proportions, not the cast, so a garment tuned here is tuned against an
 * approximation until something rigged replaces it.
 */

let panel: ClothTab | null = null;
let body: WorkbenchBody | null = null;

export const clothTab: ToolTab = {
  enter(ctx) {
    body = new WorkbenchBody(ctx.mount);
    ctx.view(0.05, 1.0, 0.24);
    ctx.banner('placeholder body — not the cast');

    ctx.list.replaceChildren(
      el('h1', { textContent: 'Cloth workbench' }),
      hint(
        'Tune a cape, a robe skirt or a sleeve against a <b>placeholder</b> body '
        + '— a jointed stand-in at roughly human proportions, not the cast. '
        + 'Wind keeps blowing even though the body stands still: a setting that '
        + 'only looks right in dead air is a setting nobody can trust.',
      ),
      heading('Scene'),
      labelled('Lighting', selectInput(
        [
          { value: 'overcast', label: 'overcast (outdoor)' },
          { value: 'interior', label: 'interior' },
          { value: 'underground', label: 'underground' },
          { value: 'night', label: 'night' },
        ],
        'overcast',
        (v) => ctx.scene.applyLighting(v as LightingProfile),
      )),
      heading('All garments'),
      slider('fidelity (segments; rebuilds)', 0.5, 2.5, 0.1, clothTuning.fidelity, (v) => {
        clothTuning.fidelity = v;
      }, 1, '×'),
      slider('floppiness (fewer passes = looser)', 1, 10, 1, clothTuning.solverIterations, (v) => {
        clothTuning.solverIterations = v;
      }, 0, ''),
    );
    ctx.scene.applyLighting('overcast');

    ctx.side.replaceChildren(el('h1', { textContent: 'Garment' }));
    const host = el('div');
    ctx.side.append(host);
    panel?.dispose();
    panel = new ClothTab(host, () => {
      // The workbench owns everything the body wears: there is no generated
      // cape or robe underneath to hide while a custom one is being tuned.
    });
    panel.attach([body]);

    let t = 0;
    ctx.onFrame((dt) => {
      t += dt;
      const wind = 0.5 + Math.sin(t * 0.7) * 0.5;
      body?.update();
      panel?.step(dt, wind, t);
    });
    // The verification hook this page carried (D-114), kept under its old name.
    (window as unknown as { __viewer: unknown }).__viewer = {
      body: () => body,
      bones: () => Object.keys(body?.bones() ?? {}),
      colliders: () => Object.keys(body?.colliderCatalog() ?? {}),
    };
  },
};

function slider(
  label: string, min: number, max: number, step: number, value: number,
  onInput: (v: number) => void, digits: number, unit: string,
): DocumentFragment {
  const row = el('div', { className: 'sl' });
  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = el('b', { textContent: `${value.toFixed(digits)}${unit}` });
  input.oninput = () => {
    const v = Number(input.value);
    out.textContent = `${v.toFixed(digits)}${unit}`;
    onInput(v);
  };
  row.append(input, out);
  return labelled(label, row);
}
