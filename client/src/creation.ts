import {
  validateBuild,
  type CharacterBuild,
  type ClassDef,
  type FeatDef,
  type ServerMessage,
  type SkillDef,
  type SpellDef,
} from '@rc/shared';

/**
 * The character creation wizard (D-208): class → skills → feats → spells →
 * name. Every option is rendered from the server's `creation_content`
 * message, which comes straight from content files (D-110) — adding a feat
 * is a data change, never a client deploy.
 *
 * This module owns only the creation UI and its local legality feedback.
 * The server re-validates the finished build and is the authority on what
 * is legal (D-102); nothing here can grant a character anything.
 */

export type CreationContent = Extract<ServerMessage, { t: 'creation_content' }>;

type StepId = 'class' | 'skills' | 'feats' | 'spells' | 'name';

interface StepDef {
  id: StepId;
  label: string;
}

export interface CreationCallbacks {
  /** Fires when the player confirms a finished, locally-valid character. */
  onSubmit: (name: string, classId: string, build: CharacterBuild) => void;
  /** Fires when they back out of the first step. */
  onCancel: () => void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class CreationWizard {
  private content: CreationContent | null = null;
  private step = 0;
  private classId: string | null = null;
  private skills: Record<string, number> = {};
  private feats: string[] = [];
  private spells: string[] = [];
  private name = '';
  private appearanceSeed = Math.floor(Math.random() * 2 ** 31);

  constructor(private cb: CreationCallbacks) {
    $('btn-create-back').addEventListener('click', () => this.back());
    $('btn-create-next').addEventListener('click', () => this.next());
  }

  /** True once the catalogue has arrived and the wizard can be shown. */
  get ready(): boolean {
    return this.content !== null;
  }

  setContent(content: CreationContent): void {
    this.content = content;
    if (!$('create-form').classList.contains('hidden')) this.render();
  }

  /** Restarts the wizard at step one with a fresh character. */
  open(): void {
    this.step = 0;
    this.classId = null;
    this.skills = {};
    this.feats = [];
    this.spells = [];
    this.name = '';
    this.appearanceSeed = Math.floor(Math.random() * 2 ** 31);
    $('char-form').classList.add('hidden');
    $('create-form').classList.remove('hidden');
    document.querySelector('.panel')?.classList.add('wide');
    this.render();
  }

  close(): void {
    $('create-form').classList.add('hidden');
    $('char-form').classList.remove('hidden');
    document.querySelector('.panel')?.classList.remove('wide');
  }

  /** Casters get a spell step; everyone else never sees one. */
  private get steps(): StepDef[] {
    const cls = this.content?.classes.find((c) => c.id === this.classId);
    const out: StepDef[] = [
      { id: 'class', label: 'Calling' },
      { id: 'skills', label: 'Skills' },
      { id: 'feats', label: 'Feats' },
    ];
    if (cls?.spellcasting) out.push({ id: 'spells', label: 'Spells' });
    out.push({ id: 'name', label: 'Name' });
    return out;
  }

  private spent(): number {
    return Object.values(this.skills).reduce((a, b) => a + b, 0);
  }

  private build(): CharacterBuild {
    return { skills: this.skills, feats: this.feats, spells: this.spells };
  }

  /** Local legality for THIS step only — the server decides the whole. */
  private stepProblem(): string | null {
    const c = this.content;
    if (!c) return 'still loading';
    const step = this.steps[this.step]!.id;
    if (step === 'class' && !this.classId) return 'choose a calling';
    if (step === 'skills' && this.spent() > c.budget.skillPoints) {
      return `you have spent ${this.spent()} of ${c.budget.skillPoints} points`;
    }
    if (step === 'name') {
      if (this.name.trim().length < 2) return 'a name of at least two letters';
      const problems = validateBuild(
        { classes: c.classes, skills: c.skills, feats: c.feats, spells: c.spells },
        this.classId ?? undefined,
        this.build(),
      );
      if (problems.length > 0) return problems[0]!;
    }
    return null;
  }

  private back(): void {
    if (this.step === 0) {
      this.close();
      this.cb.onCancel();
      return;
    }
    this.step--;
    this.render();
  }

  private next(): void {
    const problem = this.stepProblem();
    if (problem) {
      $('create-error').textContent = problem;
      return;
    }
    if (this.steps[this.step]!.id === 'name') {
      this.cb.onSubmit(this.name.trim(), this.classId!, this.build());
      return;
    }
    this.step++;
    this.render();
  }

  /** The seed the finished character is created with. */
  get seed(): number {
    return this.appearanceSeed;
  }

  private render(): void {
    const c = this.content;
    const body = $('create-body');
    $('create-error').textContent = '';
    if (!c) {
      body.textContent = 'Loading the catalogue…';
      return;
    }
    const steps = this.steps;
    this.step = Math.min(this.step, steps.length - 1);
    $('create-steps').innerHTML = steps
      .map((s, i) => {
        const cls = i === this.step ? 'step active' : i < this.step ? 'step done' : 'step';
        return `<div class="${cls}">${i + 1}. ${s.label}</div>`;
      })
      .join('');
    const nextBtn = $<HTMLButtonElement>('btn-create-next');
    nextBtn.textContent = steps[this.step]!.id === 'name' ? 'Create & enter' : 'Continue';
    $('btn-create-back').textContent = this.step === 0 ? 'Cancel' : 'Back';
    body.innerHTML = '';
    switch (steps[this.step]!.id) {
      case 'class':
        this.renderClasses(body, c);
        break;
      case 'skills':
        this.renderSkills(body, c);
        break;
      case 'feats':
        this.renderFeats(body, c);
        break;
      case 'spells':
        this.renderSpells(body, c);
        break;
      case 'name':
        this.renderName(body, c);
        break;
    }
  }

  private hint(parent: HTMLElement, text: string): void {
    const el = document.createElement('div');
    el.className = 'create-hint';
    el.textContent = text;
    parent.appendChild(el);
  }

  private renderClasses(parent: HTMLElement, c: CreationContent): void {
    this.hint(
      parent,
      'What they trained as, not what they are. A calling opens some doors and closes others; '
      + 'none of them make you good, and none of them make being good cheaper.',
    );
    const grid = document.createElement('div');
    grid.className = 'cardgrid';
    for (const cls of c.classes) {
      // Legacy-locked callings are bought with a life already spent (D-207).
      const locked = cls.legacyLocked && c.legacyPoints < 1;
      const card = document.createElement('div');
      card.className = `card${this.classId === cls.id ? ' selected' : ''}${locked ? ' locked' : ''}`;
      card.innerHTML = `<div class="crole">${cls.role}${cls.spellcasting ? ' · caster' : ''}</div>`
        + `<div class="cname">${cls.name}</div>`
        + `<div class="cdesc">${cls.description}</div>`
        + (locked ? '<div class="creq">Requires a Legacy Point — a life given up.</div>' : '');
      if (!locked) {
        card.addEventListener('click', () => {
          this.classId = cls.id;
          // A class change can invalidate earlier picks; drop them rather
          // than carry an illegal build forward.
          this.feats = [];
          this.spells = [];
          this.render();
        });
      }
      grid.appendChild(card);
    }
    parent.appendChild(grid);
  }

  private renderSkills(parent: HTMLElement, c: CreationContent): void {
    const cls = c.classes.find((x) => x.id === this.classId);
    this.hint(
      parent,
      `Spend ${c.budget.skillPoints} points, at most ${c.budget.skillMax} in any one skill. `
      + `Highlighted skills are what a ${cls?.name ?? 'character'} usually leans on — advice, not a rail.`,
    );
    const budget = document.createElement('div');
    const refreshBudget = (): void => {
      const left = c.budget.skillPoints - this.spent();
      budget.className = left < 0 ? 'budget over' : 'budget';
      budget.innerHTML = `points remaining: <b>${left}</b>`;
    };
    budget.className = 'budget';
    parent.appendChild(budget);
    refreshBudget();
    for (const skill of c.skills) {
      const row = document.createElement('div');
      row.className = 'skillrow';
      const affinity = cls?.affinities.includes(skill.id) ?? false;
      const value = this.skills[skill.id] ?? 0;
      row.innerHTML = `<div class="sname">${affinity ? '<span class="aff">◆</span> ' : ''}${skill.name}</div>`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = String(c.budget.skillMax);
      input.step = String(c.budget.skillStep);
      input.value = String(value);
      const val = document.createElement('div');
      val.className = 'sval';
      val.textContent = String(value);
      input.addEventListener('input', () => {
        const want = Number(input.value);
        // Clamp live against the remaining budget so the bar can never be
        // dragged into an illegal build.
        const others = this.spent() - (this.skills[skill.id] ?? 0);
        const allowed = Math.min(want, c.budget.skillPoints - others);
        this.skills[skill.id] = allowed;
        input.value = String(allowed);
        val.textContent = String(allowed);
        refreshBudget();
      });
      row.appendChild(input);
      row.appendChild(val);
      const desc = document.createElement('div');
      desc.className = 'sdesc';
      desc.textContent = skill.description;
      row.appendChild(desc);
      parent.appendChild(row);
    }
  }

  /** Shared renderer for the feat and spell pick lists. */
  private renderPicks(
    parent: HTMLElement,
    items: (FeatDef | SpellDef)[],
    chosen: string[],
    limit: number,
    canTake: (item: FeatDef | SpellDef) => string | null,
    onToggle: (id: string) => void,
    subtitle: (item: FeatDef | SpellDef) => string,
  ): void {
    const budget = document.createElement('div');
    budget.className = chosen.length > limit ? 'budget over' : 'budget';
    budget.innerHTML = `chosen: <b>${chosen.length} / ${limit}</b>`;
    parent.appendChild(budget);
    const grid = document.createElement('div');
    grid.className = 'cardgrid';
    for (const item of items) {
      const blocked = canTake(item);
      const selected = chosen.includes(item.id);
      const full = chosen.length >= limit && !selected;
      const locked = blocked !== null || full;
      const card = document.createElement('div');
      card.className = `card${selected ? ' selected' : ''}${locked ? ' locked' : ''}`;
      card.innerHTML = `<div class="crole">${subtitle(item)}</div>`
        + `<div class="cname">${item.name}</div>`
        + `<div class="cdesc">${item.description}</div>`
        + (blocked ? `<div class="creq">${blocked}</div>` : '');
      if (!locked || selected) {
        card.addEventListener('click', () => {
          onToggle(item.id);
          this.render();
        });
      }
      grid.appendChild(card);
    }
    parent.appendChild(grid);
  }

  private renderFeats(parent: HTMLElement, c: CreationContent): void {
    const cls = c.classes.find((x) => x.id === this.classId);
    this.hint(parent, `Pick up to ${c.budget.feats}. Greyed feats need a class or skill you do not have.`);
    const available = c.feats.filter((f) => f.classes.length === 0 || f.classes.includes(this.classId ?? ''));
    const blockedFor = (f: FeatDef | SpellDef): string | null => {
      const feat = f as FeatDef;
      for (const [skillId, min] of Object.entries(feat.requiresSkills)) {
        if ((this.skills[skillId] ?? 0) < min) {
          const skill = c.skills.find((s) => s.id === skillId);
          return `Requires ${skill?.name ?? skillId} ${min}.`;
        }
      }
      return null;
    };
    this.renderPicks(
      parent, available, this.feats, c.budget.feats, blockedFor,
      (id) => {
        this.feats = this.feats.includes(id) ? this.feats.filter((f) => f !== id) : [...this.feats, id];
      },
      (f) => ((f as FeatDef).classes.length > 0 ? `${cls?.name ?? ''} only` : 'open to all'),
    );
  }

  private renderSpells(parent: HTMLElement, c: CreationContent): void {
    this.hint(parent, `Pick up to ${c.budget.spells}. Small magics — this world has no fireballs.`);
    const available = c.spells.filter((s) => s.classes.length === 0 || s.classes.includes(this.classId ?? ''));
    this.renderPicks(
      parent, available, this.spells, c.budget.spells, () => null,
      (id) => {
        this.spells = this.spells.includes(id) ? this.spells.filter((s) => s !== id) : [...this.spells, id];
      },
      (s) => (s as SpellDef).school,
    );
  }

  private renderName(parent: HTMLElement, c: CreationContent): void {
    const cls = c.classes.find((x) => x.id === this.classId);
    this.hint(
      parent,
      'A name is only what they answer to. Nobody learns it until they are told it — '
      + 'and being told it is no guarantee it is true.',
    );
    const label = document.createElement('label');
    label.textContent = 'name';
    parent.appendChild(label);
    const input = document.createElement('input');
    input.placeholder = 'a name they will answer to';
    input.spellcheck = false;
    input.value = this.name;
    input.addEventListener('input', () => {
      this.name = input.value;
      $('create-error').textContent = '';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.next();
    });
    parent.appendChild(input);

    // A plain-language summary: the last chance to catch a wrong pick.
    const summary = document.createElement('div');
    summary.className = 'create-hint';
    summary.style.marginTop = '14px';
    const named = (ids: string[], list: { id: string; name: string }[]): string =>
      ids.map((id) => list.find((x) => x.id === id)?.name ?? id).join(', ') || 'none';
    const allocated = Object.entries(this.skills)
      .filter(([, v]) => v > 0)
      .map(([id, v]) => `${c.skills.find((s) => s.id === id)?.name ?? id} ${v}`)
      .join(', ') || 'nothing allocated';
    summary.innerHTML = `<b>${cls?.name ?? '—'}</b><br>skills: ${allocated}<br>`
      + `feats: ${named(this.feats, c.feats)}<br>`
      + (cls?.spellcasting ? `spells: ${named(this.spells, c.spells)}<br>` : '')
      + `appearance seed: ${this.appearanceSeed}`;
    parent.appendChild(summary);

    const reroll = document.createElement('button');
    reroll.textContent = 'Reroll appearance';
    reroll.addEventListener('click', () => {
      this.appearanceSeed = Math.floor(Math.random() * 2 ** 31);
      this.render();
    });
    parent.appendChild(reroll);
    input.focus();
  }

  /** Surfaces a server rejection on the step the player is looking at. */
  showError(message: string): void {
    $('create-error').textContent = message;
  }
}
