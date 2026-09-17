import type * as THREE from 'three';
import type { GameScene } from '../render/scene';

/**
 * What a tab of the authoring tool is handed (D-629).
 *
 * The tool grew as one file, one section at a time, and each section reached
 * for the page's globals directly — the stage, the list pane, the status line.
 * That is fine for the sections already there and wrong for the ones being
 * absorbed from other pages (the studio, the cloth workbench), which would
 * otherwise import six things each from a 7,000-line module. So the page
 * describes itself once, here, and a tab module takes this and nothing else.
 *
 * ⚠ Deliberately narrow. A tab that needs more than this is a tab that has
 * started to own the page, which is how two editors end up drawing into one
 * pane at once (D-570's "two editors at once, no error").
 */
export interface ToolContext {
  /** The authoring API base, `http://host:port/api`. */
  api: string;
  /** The left pane: what there is to pick. Emptied before a tab is entered. */
  list: HTMLElement;
  /** The right pane: the form for what is picked. Emptied before a tab is entered. */
  side: HTMLElement;
  /** The ONE place anything shown on the stage hangs; cleared on every tab change. */
  mount: THREE.Group;
  scene: GameScene;
  /** The caption over the stage. */
  banner(text: string): void;
  /** The status line in the top bar. */
  status(text: string, kind?: '' | 'good' | 'bad'): void;
  markDirty(): void;
  clearDirty(): void;
  /** Runs `fn` every frame for as long as this tab is open. */
  onFrame(fn: (dt: number) => void): void;
  /** Where the camera looks (height), how high it orbits, and how far back. */
  view(focusY: number, orbitH: number, zoom: number): void;
  /** The built clip library, loaded once. Empty when nothing is built. */
  clips(): Promise<THREE.AnimationClip[]>;
  /** Refusals in red, or the one good line. */
  problems(host: HTMLElement, lines: readonly string[], ok: string): void;
}

/** The shape every tab module exports. */
export interface ToolTab {
  /** Draw the tab into the panes. Called each time the tab is opened. */
  enter(ctx: ToolContext): Promise<void> | void;
}

/* --------------------------------------------------- small DOM helpers ---- */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Pick<HTMLElementTagNameMap[K], 'className' | 'textContent' | 'id' | 'title'>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

export function heading(text: string): HTMLHeadingElement {
  return el('h2', { textContent: text });
}

export function labelled(label: string, field: HTMLElement): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(el('label', { textContent: label }), field);
  return frag;
}

export function textInput(
  value: string,
  onInput: (v: string) => void,
  placeholder = '',
): HTMLInputElement {
  const input = el('input');
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.oninput = () => onInput(input.value);
  return input;
}

export function selectInput(
  options: { value: string; label: string }[],
  value: string,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const sel = el('select');
  for (const o of options) sel.add(new Option(o.label, o.value));
  sel.value = value;
  sel.onchange = () => onChange(sel.value);
  return sel;
}

export function button(
  text: string,
  onClick: () => void,
  primary = false,
): HTMLButtonElement {
  const b = el('button', { textContent: text, className: primary ? 'primary' : '' });
  b.onclick = onClick;
  return b;
}

export function hint(html: string): HTMLDivElement {
  const d = el('div', { className: 'hint' });
  d.innerHTML = html;
  return d;
}

/** A row in the list pane. */
export function listRow(
  text: string,
  sub: string,
  on: boolean,
  onClick: () => void,
): HTMLDivElement {
  const row = el('div', { className: `listrow${on ? ' on' : ''}` });
  row.append(text);
  if (sub) row.append(el('span', { className: 'sub', textContent: sub }));
  row.onclick = onClick;
  return row;
}

/** A chip: a small toggle, on or off. */
export function chip(text: string, on: boolean, onClick: () => void, title = ''): HTMLSpanElement {
  const c = el('span', { className: `chip${on ? ' on' : ''}`, textContent: text, title });
  c.onclick = onClick;
  return c;
}
