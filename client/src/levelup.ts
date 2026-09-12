import {
  ATTRIBUTES,
  ATTRIBUTE_INFO,
  SKILL_CEILING,
  emptyAdvances,
  type CharacterAdvances,
  type ServerMessage,
} from '@rc/shared';
import type { CreationContent } from './creation';

/**
 * The level-up screen (D-546).
 *
 * It appears whenever the server says something is unspent — which is not
 * quite the same as "you just levelled", and the difference matters: a player
 * who levelled twice while away, or who closed the screen without spending,
 * gets it again. Nothing is ever lost by ignoring it.
 *
 * The screen edits a WHOLE advancement record and submits the whole thing.
 * The alternative — sending each pick as it is made — would spray a dozen
 * messages at exactly the moment a round is tearing its sockets down, and any
 * one of them going missing would leave the player short a feat with nothing
 * to show for it.
 *
 * ⚠ Everything the class grants AUTOMATICALLY (D-538) is not shown here and
 * is not choosable. This screen is only the player's own half.
 */

type Status = Extract<ServerMessage, { t: 'status' }>;

export interface LevelUpCallbacks {
  onSubmit: (advances: CharacterAdvances) => void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class LevelUpScreen {
  private content: CreationContent | null = null;
  private status: Status | null = null;
  private draft: CharacterAdvances = emptyAdvances();
  /** Dismissed for now; re-armed when the next level arrives. */
  private dismissedAtLevel: number | null = null;

  constructor(private cb: LevelUpCallbacks) {
    $('btn-lvl-later').addEventListener('click', () => {
      this.dismissedAtLevel = this.status?.level ?? null;
      this.hide();
    });
    $('btn-lvl-confirm').addEventListener('click', () => {
      this.cb.onSubmit(this.draft);
      this.hide();
    });
  }

  setContent(content: CreationContent): void {
    this.content = content;
  }

  /**
   * Takes a fresh status. Opens the screen when something is unspent and the
   * player has not already waved it away at this level.
   */
  setStatus(status: Status): void {
    const levelled = this.status !== null && status.level > this.status.level;
    this.status = status;
    // Start from what the server says has already been spent, so re-opening
    // the screen edits the real record rather than a blank one — which would
    // otherwise submit an empty set and look like the points were revoked.
    this.draft = {
      attributes: { ...(status.advances?.attributes ?? {}) },
      skills: { ...(status.advances?.skills ?? {}) },
      feats: [...(status.advances?.feats ?? [])],
      spells: [...(status.advances?.spells ?? [])],
    };
    if (levelled) this.dismissedAtLevel = null;
    const owed =
      status.unspent.attributePoints > 0 ||
      status.unspent.skillPoints > 0 ||
      status.unspent.feats > 0 ||
      status.unspent.spells > 0;
    if (owed && this.dismissedAtLevel !== status.level && this.content) this.show();
    else if (!owed) this.hide();
    else if (this.visible) this.render();
  }

  get visible(): boolean {
    return !$('levelup').classList.contains('hidden');
  }

  /** Opened by hand from the character sheet, as well as automatically. */
  show(): void {
    if (!this.status || !this.content) return;
    $('levelup').classList.remove('hidden');
    this.render();
  }

  hide(): void {
    $('levelup').classList.add('hidden');
  }

  // -------------------------------------------------------------------------

  /** What is still on the table, given the draft rather than what is saved. */
  private left(): { attributePoints: number; skillPoints: number; feats: number; spells: number } {
    const s = this.status!;
    const savedAttrs = Object.values(s.advances?.attributes ?? {}).reduce((a, b) => a + b, 0);
    const savedSkills = Object.values(s.advances?.skills ?? {}).reduce((a, b) => a + b, 0);
    const draftAttrs = Object.values(this.draft.attributes).reduce((a, b) => a + b, 0);
    const draftSkills = Object.values(this.draft.skills).reduce((a, b) => a + b, 0);
    // `unspent` is measured against what is SAVED, so the draft's own spending
    // has to be added back before subtracting. Reading `unspent` directly
    // would let a player re-spend points they had already committed.
    return {
      attributePoints: s.unspent.attributePoints + savedAttrs - draftAttrs,
      skillPoints: s.unspent.skillPoints + savedSkills - draftSkills,
      feats: s.unspent.feats + (s.advances?.feats.length ?? 0) - this.draft.feats.length,
      spells: s.unspent.spells + (s.advances?.spells.length ?? 0) - this.draft.spells.length,
    };
  }

  private render(): void {
    const s = this.status;
    const c = this.content;
    if (!s || !c) return;
    const left = this.left();
    $('lvl-title').textContent = `Level ${s.level}`;
    $('lvl-sub').textContent =
      'What the calling gives you, it has already given. This is the part you choose.';
    const body = $('lvl-body');
    body.innerHTML = '';
    $('lvl-error').textContent = '';

    if (s.unspent.attributePoints > 0 || left.attributePoints > 0) {
      this.renderAttributes(body, left.attributePoints);
    }
    if (s.unspent.skillPoints > 0 || left.skillPoints > 0) {
      this.renderSkills(body, c, left.skillPoints);
    }
    if (s.unspent.feats > 0 || left.feats > 0) this.renderFeats(body, c, left.feats);
    if (s.unspent.spells > 0 || left.spells > 0) this.renderSpells(body, c, left.spells);

    const confirm = $('btn-lvl-confirm') as HTMLButtonElement;
    const spentSomething =
      left.attributePoints < s.unspent.attributePoints ||
      left.skillPoints < s.unspent.skillPoints ||
      left.feats < s.unspent.feats ||
      left.spells < s.unspent.spells;
    confirm.disabled = !spentSomething;
  }

  private group(parent: HTMLElement, title: string, left: number): HTMLElement {
    const g = document.createElement('div');
    g.className = 'lvl-group';
    g.innerHTML = `<h4>${title} <span class="left">${left} left</span></h4>`;
    parent.appendChild(g);
    return g;
  }

  private renderAttributes(parent: HTMLElement, left: number): void {
    const g = this.group(parent, 'Attributes', left);
    const base = this.status!.attributes;
    for (const attr of ATTRIBUTES) {
      const placed = this.draft.attributes[attr] ?? 0;
      const row = document.createElement('div');
      row.className = 'lvl-row';
      const name = document.createElement('div');
      name.className = 'lname';
      // The CURRENT total is shown, not the delta: "Strength 15 (+1)" is what
      // the player is choosing between, and a bare "+1" makes them do the sum.
      const saved = this.status!.advances?.attributes[attr] ?? 0;
      const current = (base[attr] ?? 10) - saved + placed;
      name.textContent = `${ATTRIBUTE_INFO[attr].name} ${current}`;
      const minus = document.createElement('button');
      minus.textContent = '−';
      // Points already SAVED cannot be taken back — the server would refuse a
      // record that spent less than the last one it wrote, and offering the
      // button anyway would be a lie.
      minus.disabled = placed <= saved;
      minus.addEventListener('click', () => {
        this.draft.attributes[attr] = placed - 1;
        this.render();
      });
      const val = document.createElement('div');
      val.className = 'lval';
      val.textContent = placed > 0 ? `+${placed}` : '—';
      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.disabled = left <= 0;
      plus.addEventListener('click', () => {
        this.draft.attributes[attr] = placed + 1;
        this.render();
      });
      row.append(name, minus, val, plus);
      g.appendChild(row);
    }
  }

  private renderSkills(parent: HTMLElement, c: CreationContent, left: number): void {
    const g = this.group(parent, 'Skills', left);
    const note = document.createElement('div');
    note.className = 'lvl-note';
    // The fence, said out loud rather than silently enforced (D-538).
    note.textContent =
      'Martial training is bought once, at creation, and never earned — everyone swings '
      + 'with what they started with.';
    g.appendChild(note);
    const step = c.budget.skillStep;
    const s = this.status!;
    for (const skill of c.skills) {
      if (skill.creationOnly) continue;
      const placed = this.draft.skills[skill.id] ?? 0;
      const saved = s.advances?.skills[skill.id] ?? 0;
      const effective = s.skills[skill.id] ?? 0;
      const row = document.createElement('div');
      row.className = 'lvl-row';
      const name = document.createElement('div');
      name.className = 'lname';
      name.textContent = `${skill.name} ${effective - saved + placed}`;
      const minus = document.createElement('button');
      minus.textContent = '−';
      minus.disabled = placed - step < saved;
      minus.addEventListener('click', () => {
        this.draft.skills[skill.id] = placed - step;
        this.render();
      });
      const val = document.createElement('div');
      val.className = 'lval';
      val.textContent = placed > 0 ? `+${placed}` : '—';
      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.disabled = left < step || effective - saved + placed + step > SKILL_CEILING;
      plus.addEventListener('click', () => {
        this.draft.skills[skill.id] = placed + step;
        this.render();
      });
      row.append(name, minus, val, plus);
      g.appendChild(row);
    }
  }

  private renderFeats(parent: HTMLElement, c: CreationContent, left: number): void {
    const g = this.group(parent, 'Feats', left);
    const s = this.status!;
    for (const feat of c.feats) {
      // A feat the calling is barred from is not shown at all. The server
      // would refuse it anyway (D-102), but offering a button that cannot
      // work is how a player concludes the screen is broken.
      if (feat.classes.length > 0 && !feat.classes.includes(s.classId ?? '')) continue;
      // Feats the class already grants are not offered — picking one would
      // spend a choice on something arriving anyway.
      if (s.feats.includes(feat.id) && !this.draft.feats.includes(feat.id)) continue;
      if (feat.minLevel > s.level) continue;
      const on = this.draft.feats.includes(feat.id);
      const saved = s.advances?.feats.includes(feat.id) ?? false;
      const short = Object.entries(feat.requiresSkills).filter(
        ([id, min]) => (s.skills[id] ?? 0) + (this.draft.skills[id] ?? 0) < min,
      );
      const btn = document.createElement('button');
      btn.className = `lvl-pick${on ? ' on' : ''}`;
      btn.textContent = feat.name;
      btn.title = short.length > 0
        ? `${feat.description}\n\nNeeds: ${short.map(([id, n]) => `${id} ${n}`).join(', ')}`
        : feat.description;
      btn.disabled = saved || short.length > 0 || (!on && left <= 0);
      btn.addEventListener('click', () => {
        this.draft.feats = on
          ? this.draft.feats.filter((f) => f !== feat.id)
          : [...this.draft.feats, feat.id];
        this.render();
      });
      g.appendChild(btn);
    }
  }

  private renderSpells(parent: HTMLElement, c: CreationContent, left: number): void {
    const g = this.group(parent, 'Spells', left);
    const s = this.status!;
    for (const spell of c.spells) {
      if (spell.classes.length > 0 && !spell.classes.includes(s.classId ?? '')) continue;
      if (s.spells.includes(spell.id) && !this.draft.spells.includes(spell.id)) continue;
      const on = this.draft.spells.includes(spell.id);
      const saved = s.advances?.spells.includes(spell.id) ?? false;
      const btn = document.createElement('button');
      btn.className = `lvl-pick${on ? ' on' : ''}`;
      btn.textContent = spell.name;
      btn.title = spell.description;
      btn.disabled = saved || (!on && left <= 0);
      btn.addEventListener('click', () => {
        this.draft.spells = on
          ? this.draft.spells.filter((x) => x !== spell.id)
          : [...this.draft.spells, spell.id];
        this.render();
      });
      g.appendChild(btn);
    }
  }
}
