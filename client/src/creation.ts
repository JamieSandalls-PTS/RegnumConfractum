import {
  ATTRIBUTES,
  ATTRIBUTE_INFO,
  baseAttributes,
  carryBonusFor,
  damageBonusFor,
  describeAppearance,
  glanceChanceFor,
  maxHpFor,
  maxManaFor,
  progressionPreview,
  validateBuild,
  type AppearanceOverride,
  type Attribute,
  type AttributeSet,
  type CharacterBuildInput,
  type ClassDef,
  type FeatDef,
  type ServerMessage,
  type SkillDef,
  type SpellDef,
  raceHeightRange,
  racesForClass,
  partsForSlot,
  cutOfFace,
  facesByCut,
  partLabel as nameOfPart,
  BODY_SLOTS,
  type CharacterLook,
  type CharacterSlot,
  type RaceDef,
} from '@rc/shared';
import { AppearancePanel } from './appearance-panel';

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

type StepId =
  | 'class' | 'race' | 'appearance' | 'attributes' | 'skills' | 'feats' | 'spells' | 'name';

interface StepDef {
  id: StepId;
  label: string;
}

export interface CreationCallbacks {
  /** Fires when the player confirms a finished, locally-valid character. */
  onSubmit: (
    name: string,
    classId: string,
    build: CharacterBuildInput,
    appearance: AppearanceOverride,
    /** Absent when content has no races, so the step never appeared. */
    raceId: string | undefined,
    /** Absent when nothing was picked — every bot and every older client. */
    look: CharacterLook | undefined,
  ) => void;
  /** Fires when they back out of the first step. */
  onCancel: () => void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class CreationWizard {
  private content: CreationContent | null = null;
  private step = 0;
  private classId: string | null = null;
  /**
   * The chosen race, or null when the step has not been reached — and also
   * when content has no races and the step never existed at all. Both read
   * the same way downstream: nothing is sent, and the server treats the
   * character as raceless (D-572).
   */
  private raceId: string | null = null;
  /** The parts and colours chosen on the face step (D-574). */
  private look: CharacterLook = { parts: {} };
  /** Attribute TOTALS, base 10 each plus what the player has placed (D-546). */
  private attributes: AttributeSet = baseAttributes();
  private skills: Record<string, number> = {};
  private feats: string[] = [];
  private spells: string[] = [];
  private name = '';
  private appearanceSeed = Math.floor(Math.random() * 2 ** 31);
  /**
   * The appearance step's live panel (D-539). Created when the step is first
   * shown and disposed when the wizard closes — it owns a WebGL context, and
   * an abandoned creation must not leave one open behind the login screen.
   */
  private appearance: AppearancePanel | null = null;

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
    this.attributes = baseAttributes();
    this.skills = {};
    this.feats = [];
    this.spells = [];
    this.name = '';
    this.raceId = null;
    this.look = { parts: {} };
    this.appearanceSeed = Math.floor(Math.random() * 2 ** 31);
    this.appearance?.dispose();
    this.appearance = null;
    // ⚠ The wizard owns the WHOLE overlay panel while it is open, login form
    // included. It used to hide `char-form` only and rely on whoever called
    // it having already hidden the login fields — true on the one real path
    // (`showCharacters` hides them when you log in), and silently false for
    // any other caller, which is how a screenshot of the creation screen ended
    // up with a username and password box above it. A screen that is correct
    // only because of what ran before it is one edit from being wrong.
    $('login-form').classList.add('hidden');
    $('char-form').classList.add('hidden');
    $('create-form').classList.remove('hidden');
    document.querySelector('#overlay .panel')?.classList.add('wide');
    this.render();
  }

  /**
   * Put the wizard away. Says nothing about what should be shown INSTEAD.
   *
   * ⚠ It used to un-hide `char-form`, which is right for cancelling and wrong
   * for a dropped connection — the disconnect path re-shows the login fields
   * and then hides the character list on the very next line, so the screen was
   * correct only because of statement ORDER. Each caller now names its own
   * destination, which is the thing that can be read and checked.
   */
  close(): void {
    this.appearance?.dispose();
    this.appearance = null;
    $('create-form').classList.add('hidden');
    document.querySelector('#overlay .panel')?.classList.remove('wide');
  }

  /** Casters get a spell step; everyone else never sees one. */
  private get steps(): StepDef[] {
    const cls = this.content?.classes.find((c) => c.id === this.classId);
    const out: StepDef[] = [{ id: 'class', label: 'Calling' }];
    // ⚠ Only when there is something to choose. A server whose content has no
    // races skips this entirely — the same rule the spell step follows for a
    // calling that does not cast — because an empty step is a question with
    // no answers.
    if ((this.content?.races.length ?? 0) > 0) out.push({ id: 'race', label: 'Race' });
    out.push(
      { id: 'appearance', label: 'Face' },
      { id: 'attributes', label: 'Body' },
      { id: 'skills', label: 'Skills' },
      { id: 'feats', label: 'Feats' },
    );
    if (cls?.spellcasting) out.push({ id: 'spells', label: 'Spells' });
    out.push({ id: 'name', label: 'Name' });
    return out;
  }

  private spent(): number {
    return Object.values(this.skills).reduce((a, b) => a + b, 0);
  }

  /** Attribute points placed so far, over the base of 10 apiece. */
  private attrSpent(): number {
    const base = baseAttributes();
    return ATTRIBUTES.reduce((sum, a) => sum + (this.attributes[a] - base[a]), 0);
  }

  private build(): CharacterBuildInput {
    return {
      attributes: this.attributes,
      skills: this.skills,
      feats: this.feats,
      spells: this.spells,
    };
  }

  /** Local legality for THIS step only — the server decides the whole. */
  private stepProblem(): string | null {
    const c = this.content;
    if (!c) return 'still loading';
    const step = this.steps[this.step]!.id;
    if (step === 'class' && !this.classId) return 'choose a calling';
    if (step === 'race' && !this.raceId) return 'choose a race';
    if (step === 'attributes' && this.attrSpent() > c.budget.attributePoints) {
      return `you have placed ${this.attrSpent()} of ${c.budget.attributePoints} points`;
    }
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
      this.cb.onSubmit(
        this.name.trim(),
        this.classId!,
        this.build(),
        this.appearancePanel().value(),
        this.raceId ?? undefined,
        Object.keys(this.look.parts).length > 0 ? this.look : undefined,
      );
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
    // The appearance panel lives in `body`, which is about to be emptied.
    // Detaching it here rather than in every branch is what stops a dead
    // renderer animating an orphaned canvas.
    if (steps[this.step]!.id !== 'appearance') {
      this.appearance?.dispose();
      this.appearance = null;
    }
    body.innerHTML = '';
    switch (steps[this.step]!.id) {
      case 'class':
        this.renderClasses(body, c);
        break;
      case 'race':
        this.renderRaces(body, c);
        break;
      case 'appearance':
        this.renderAppearance(body);
        break;
      case 'attributes':
        this.renderAttributes(body, c);
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
      // What the calling becomes (D-538). Shown at the point of choosing,
      // because "a physician has the full kit by five" is exactly the sort of
      // thing a player should be able to plan a character around.
      const grants = progressionPreview(cls)
        .slice(0, 4)
        .map((g) => `<div class="cgrant"><b>${g.level}</b> ${g.text}</div>`)
        .join('');
      card.innerHTML = `<div class="crole">${cls.role}${cls.spellcasting ? ' · caster' : ''}</div>`
        + `<div class="cname">${cls.name}</div>`
        + `<div class="cdesc">${cls.description}</div>`
        + (grants ? `<div class="cgrants">as it grows${grants}</div>` : '')
        + (locked ? '<div class="creq">Requires a Legacy Point — a life given up.</div>' : '');
      if (!locked) {
        card.addEventListener('click', () => {
          this.classId = cls.id;
          // A class change can invalidate earlier picks; drop them rather
          // than carry an illegal build forward.
          this.feats = [];
          this.spells = [];
          // ⚠ Including the RACE. A calling admits some races (D-566), and
          // carrying one the new calling refuses would build a character the
          // server rejects at the last step — after the player has named it.
          if (this.raceId && !this.admittedRaces(c).some((r) => r.id === this.raceId)) {
            this.raceId = null;
            this.look = { parts: {} };
            this.appearance?.dispose();
            this.appearance = null;
          }
          this.render();
        });
      }
      grid.appendChild(card);
    }
    parent.appendChild(grid);
  }

  /**
   * What a player may BE, at the point of being it (D-560, D-572, built here).
   *
   * ⚠ The step exists only when there is something to choose. A server whose
   * content has no races skips it — the same rule the spell step already
   * follows for a calling that does not cast — because an empty step is a
   * question with no answers and a player has to click past it anyway.
   *
   * ⚠ It comes AFTER the calling and BEFORE the face, and the order is the
   * design. A calling may admit only some races (D-566), so the choice has to
   * be narrowed by one that is already made; and a race curates which faces
   * and statures exist (D-560), so it has to be made before the face is.
   */
  private renderRaces(parent: HTMLElement, c: CreationContent): void {
    this.hint(
      parent,
      'Where they are from, and what that makes them look like. A race is a set of '
      + 'faces and a range of statures — never a bonus. Nothing here makes anybody '
      + 'better at anything.',
    );
    const admitted = this.admittedRaces(c);
    if (admitted.length === 0) {
      // ⚠ Reachable, and it is a CONTENT error rather than a bug: a calling
      // can name races that no longer exist. Say which calling, because the
      // fix is on that calling and not on this screen.
      const cls = c.classes.find((x) => x.id === this.classId);
      this.hint(
        parent,
        `⚠ No race is available to a ${cls?.name ?? 'character'} — the calling admits `
        + `${(cls?.races ?? []).join(', ') || 'nothing'}, and none of those is authored. `
        + 'Go back and choose another calling.',
      );
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'cardgrid';
    for (const race of admitted) {
      const card = document.createElement('div');
      card.className = `card${this.raceId === race.id ? ' selected' : ''}`;
      const range = raceHeightRange(race);
      const tones = race.skinTones.length;
      card.innerHTML = `<div class="crole">${range ? `${range[0].toFixed(2)}–${range[1].toFixed(2)}m` : 'any stature'}</div>`
        + `<div class="cname">${race.name}</div>`
        + `<div class="cdesc">${race.description}</div>`
        + (tones ? `<div class="cgrants">${tones} skin tone${tones === 1 ? '' : 's'}</div>` : '');
      card.addEventListener('click', () => {
        this.raceId = race.id;
        // ⚠ A face belongs to the race that offered it. Carrying one across
        // would send parts the new race does not curate, which the server
        // refuses — after the character has been named.
        this.look = { parts: {} };
        // ⚠ The face is built against the race, so changing race throws the
        // panel away rather than carrying a head this race may not offer and
        // a height it may not reach. Losing a face somebody tuned is worse
        // than annoying — but showing them a character the server will then
        // refuse is worse still, and silently clamping their height would be
        // the game editing their choice without saying so.
        this.appearance?.dispose();
        this.appearance = null;
        this.render();
      });
      grid.appendChild(card);
    }
    parent.appendChild(grid);
  }

  /** The races this calling admits — the rule lives in `shared` and is tested. */
  private admittedRaces(c: CreationContent): RaceDef[] {
    const cls = c.classes.find((x) => x.id === this.classId);
    return racesForClass(c.races, cls?.races ?? []);
  }

  /**
   * The faces this race offers, and the skin it comes in (D-560, D-574).
   *
   * ⚠ Curated, and that is the whole point of a race here: "46 heads is a
   * catalogue not a choice, and a race that offers the same faces as every
   * other race is not a race". What is listed is exactly what the SERVER will
   * accept for that slot, so a player cannot build a face that is refused
   * after they have named it.
   *
   * ⚠ Shown as stems where a part has no player-facing name. That is ugly on
   * purpose — `SK_Chr_Head_Male_04` is the right name for a file and the wrong
   * one for a person (D-560) — and it is a prompt to go and name it in the
   * creation tool rather than something to paper over here.
   */
  private renderFace(parent: HTMLElement, race: RaceDef): void {
    const heading = document.createElement('div');
    heading.className = 'create-hint';
    heading.style.marginTop = '10px';
    heading.textContent = `What a ${race.name.toLowerCase()} looks like. `
      + 'These are the only faces this race has; another race has others.';
    parent.appendChild(heading);

    // The slots a player picks a FACE from. Body slots are curated too, but a
    // race offers one bare option per body and choosing between two identical
    // torsos is not a choice — they are filled in from the head's own cut.
    const FACE_SLOTS: { slot: CharacterSlot; label: string }[] = [
      { slot: 'head', label: 'face' },
      { slot: 'hair', label: 'hair' },
      { slot: 'eyebrows', label: 'brows' },
      { slot: 'ears', label: 'ears' },
    ];

    for (const { slot, label } of FACE_SLOTS) {
      const offered = race.parts[slot] ?? [];
      if (offered.length === 0) continue;
      const row = document.createElement('div');
      row.className = 'app-row';
      const name = document.createElement('label');
      name.textContent = label;
      row.appendChild(name);
      const chips = document.createElement('div');
      chips.className = 'chips';

      // ⚠ `hair`, `eyebrows` and `ears` can legitimately be NONE — a shaved
      // head is a face. `head` cannot: something has to be there.
      if (slot !== 'head') {
        chips.appendChild(this.faceChip(race, slot, null, 'none'));
      }
      // ⚠ The rule lives in `shared` and is tested, because it got this
      // wrong: the HEAD must never be filtered by the cut the head decides,
      // or picking a male face silently removes all 23 female ones for good.
      const shown = partsForSlot(offered, slot, this.look.parts.head);
      const byCut = facesByCut(shown);
      // ⚠ A row showing BOTH cuts is grouped by cut, and naming the parts is
      // what made that necessary. 20 of the 23 head names are shared across
      // the two cuts — "Burnt" is a male face and a female face — so with all
      // 46 on screen at once (which D-575 requires) the names alone give
      // twenty pairs of identical chips, which is a worse row than the file
      // stems were.
      //
      // ⚠ Keyed on what the row actually CONTAINS rather than on `head`,
      // because the head is not the only row that can show both: until a face
      // is picked nothing is filtered, and the brows row was offering
      // "Flared", "Scruffy", "Stylish", "Normal" and "Angry" twice each. Once
      // a face is chosen every other row holds one cut and no heading appears
      // — the grouping is not a question put to the player, it is a label on
      // an ambiguity that is genuinely on screen.
      if (byCut.male.length > 0 && byCut.female.length > 0) {
        for (const [cut, stems] of [
          ['', byCut.common],
          ['male', byCut.male],
          ['female', byCut.female],
        ] as const) {
          if (stems.length === 0) continue;
          if (cut) {
            const head = document.createElement('div');
            head.className = 'chip-group';
            head.textContent = cut;
            chips.appendChild(head);
          }
          for (const stem of stems) {
            chips.appendChild(this.faceChip(race, slot, stem, this.partLabel(stem)));
          }
        }
      } else {
        for (const stem of shown) {
          chips.appendChild(this.faceChip(race, slot, stem, this.partLabel(stem)));
        }
      }
      row.appendChild(chips);
      parent.appendChild(row);
    }

    if (race.skinTones.length > 0) {
      const row = document.createElement('div');
      row.className = 'app-row';
      const name = document.createElement('label');
      name.textContent = 'skin';
      row.appendChild(name);
      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;flex:1';
      for (const tone of race.skinTones) {
        const swatch = document.createElement('span');
        const on = (this.look.skin ?? '').toLowerCase() === tone.rgb.toLowerCase();
        swatch.className = `chip${on ? ' on' : ''}`;
        swatch.title = tone.name;
        swatch.style.cssText =
          `background:${tone.rgb};width:24px;height:18px;display:inline-block;`
          + `border:2px solid ${on ? 'var(--warm)' : 'transparent'}`;
        swatch.onclick = () => {
          this.look.skin = tone.rgb;
          this.pushLook();
        };
        chips.appendChild(swatch);
      }
      row.appendChild(chips);
      parent.appendChild(row);
    }
  }

  /** One choosable part, or the "none" that clears an optional slot. */
  private faceChip(
    race: RaceDef,
    slot: CharacterSlot,
    stem: string | null,
    label: string,
  ): HTMLElement {
    const chip = document.createElement('span');
    const on = (this.look.parts[slot] ?? null) === stem;
    chip.className = `chip${on ? ' on' : ''}`;
    chip.textContent = label;
    chip.onclick = () => {
      if (stem === null) delete this.look.parts[slot];
      else this.look.parts[slot] = stem;
      // ⚠ Changing the FACE can invalidate the hair and brows beside it: they
      // are cut per body, and a face of the other cut leaves a mismatched set.
      // Dropping them is visible; leaving them is a seam nobody chose.
      if (slot === 'head') this.dropMismatchedFaceParts();
      this.fillBodyFromFace(race);
      this.pushLook();
      this.render();
    };
    return chip;
  }

  /**
   * What a player is told a part is called, or its file stem if nobody named it.
   *
   * ⚠ The name comes from the SERVER's `content/parts/` (D-560), which until
   * D-576 nothing outside the authoring tools loaded — so this fell back to a
   * stem for every part, including the 142 the stakeholder had already named.
   *
   * ⚠ The fallback KEEPS the body word, and that is not an oversight tidied up
   * later. Stripping it made every face read "Head 00" … "Head 08" with no
   * clue which cut it was, and "Eyebrow 01" appeared in both the male and the
   * female list meaning two different meshes. A fallback label exists to be
   * legible until somebody names the part properly; one that hides the only
   * distinction on screen is worse than the filename it came from.
   */
  private partLabel(stem: string): string {
    return nameOfPart(stem, this.content?.partNames ?? {});
  }

  private dropMismatchedFaceParts(): void {
    // ⚠ Changing the face can orphan the hair and brows beside it. Asked
    // through the same rule that decides what is OFFERED, so what survives a
    // change and what is offered afterwards can never disagree.
    for (const slot of ['hair', 'eyebrows', 'ears'] as CharacterSlot[]) {
      const stem = this.look.parts[slot];
      if (!stem) continue;
      if (!partsForSlot([stem], slot, this.look.parts.head).includes(stem)) {
        delete this.look.parts[slot];
      }
    }
  }

  /**
   * A face arrives with a body to hang it on.
   *
   * ⚠ Not a choice the player is asked to make. A race curates ONE bare option
   * per body for each of the eleven body slots (D-563), so offering them would
   * be eleven rows of a single button. What matters is that the cut MATCHES
   * the face — a female forearm on a male upper arm meets it at the wrong
   * diameter (D-558) — so the body is filled from the face's own cut and
   * refilled whenever that changes.
   */
  private fillBodyFromFace(race: RaceDef): void {
    if (!cutOfFace(this.look.parts.head)) return;
    for (const slot of BODY_SLOTS) {
      if (slot === 'head') continue;
      const fit = partsForSlot(race.parts[slot] ?? [], slot, this.look.parts.head)[0];
      if (fit) this.look.parts[slot] = fit;
      else delete this.look.parts[slot];
    }
  }

  /** Hand the panel what to render, so the preview is the face being chosen. */
  private pushLook(): void {
    this.appearancePanel().setLook(
      Object.keys(this.look.parts).length > 0 ? this.look : null,
    );
  }

  /** Lazily built so the wizard costs nothing until the step is reached. */
  private appearancePanel(): AppearancePanel {
    // ⚠ Built with the RACE's stature, not the world's. The server refuses a
    // height the race cannot be (D-572), so a panel that offered the full
    // 1.5–2.1m would be letting somebody build a character that is rejected
    // at the last step, after they had named it. The panel is thrown away and
    // rebuilt when the race changes, which is why this is lazy.
    if (!this.appearance) {
      const race = this.content?.races.find((r) => r.id === this.raceId);
      this.appearance = new AppearancePanel(
        this.appearanceSeed,
        race ? raceHeightRange(race) : null,
      );
    }
    return this.appearance;
  }

  private renderAppearance(parent: HTMLElement): void {
    const race = this.content?.races.find((r) => r.id === this.raceId);
    if (race) this.renderFace(parent, race);
    this.hint(
      parent,
      'Build, face and cloth. This is what strangers read before they are told a name, '
      + 'and a hood hides the face but never the frame — so choose a silhouette you are '
      + 'willing to be recognised by.',
    );
    const panel = this.appearancePanel();
    panel.mount(parent);
    const reroll = document.createElement('button');
    reroll.textContent = 'Roll a different face';
    reroll.addEventListener('click', () => {
      this.appearanceSeed = Math.floor(Math.random() * 2 ** 31);
      this.appearance?.dispose();
      this.appearance = null;
      this.render();
    });
    parent.appendChild(reroll);
  }

  /**
   * The attribute step (D-546). Every calling starts at ten in all four with
   * ten to place, and the SAME ten regardless of calling — a class is access
   * and options (D-208), not a stat block.
   *
   * What is shown alongside is what the numbers actually DO, live. A screen
   * that says "Vigor 16" and nothing else asks the player to take on faith
   * that it matters; showing the health it produces makes the trade legible,
   * which is the only way a budget of ten points is a decision rather than a
   * guess.
   */
  private renderAttributes(parent: HTMLElement, c: CreationContent): void {
    this.hint(
      parent,
      'Four numbers, ten points, and no calling gets a better start than another. '
      + 'Spread them and you will be adequate everywhere; spend them all in one place '
      + 'and you will be very good at exactly one thing and ordinary at the rest.',
    );
    const left = c.budget.attributePoints - this.attrSpent();
    const head = document.createElement('div');
    head.className = 'lvl-group';
    head.innerHTML = `<h4>To place <span class="left">${left}</span></h4>`;
    parent.appendChild(head);

    for (const attr of ATTRIBUTES) {
      const row = document.createElement('div');
      row.className = 'lvl-row';
      const name = document.createElement('div');
      name.className = 'lname';
      name.innerHTML = `${ATTRIBUTE_INFO[attr].name}`
        + `<span class="blurb" style="display:block;font-size:10.5px;color:#5d5867">`
        + `${ATTRIBUTE_INFO[attr].blurb}</span>`;
      const minus = document.createElement('button');
      minus.textContent = '−';
      minus.disabled = this.attributes[attr] <= c.budget.attributeBase;
      minus.addEventListener('click', () => {
        this.attributes = { ...this.attributes, [attr]: this.attributes[attr] - 1 };
        this.render();
      });
      const val = document.createElement('div');
      val.className = 'lval';
      val.textContent = String(this.attributes[attr]);
      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.disabled = left <= 0 || this.attributes[attr] >= c.budget.attributeMax;
      plus.addEventListener('click', () => {
        this.attributes = { ...this.attributes, [attr]: this.attributes[attr] + 1 };
        this.render();
      });
      row.append(name, minus, val, plus);
      parent.appendChild(row);
    }

    // What it adds up to. Computed from the shared helpers, so this preview
    // and the server's real numbers cannot disagree (D-102).
    const a = this.attributes;
    const summary = document.createElement('div');
    summary.className = 'lvl-note';
    summary.style.marginTop = '10px';
    summary.textContent =
      `That makes ${maxHpFor(a)} health, ${maxManaFor(a)} of reserve, `
      + `${damageBonusFor(a) >= 0 ? '+' : ''}${damageBonusFor(a)} to a blow, `
      + `${carryBonusFor(a) >= 0 ? '+' : ''}${carryBonusFor(a)} carried, `
      + `and ${Math.round(glanceChanceFor(a) * 100)}% of blows turned aside.`;
    parent.appendChild(summary);
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
    const earned = c.feats.filter(
      (f) => f.minLevel > 1 && (f.classes.length === 0 || f.classes.includes(this.classId ?? '')),
    );
    this.hint(
      parent,
      `Pick up to ${c.budget.feats}. Greyed feats need a skill you have not bought.`
      + (earned.length > 0
        ? ` A ${cls?.name ?? 'character'} is also GRANTED ${earned.length} more as it levels — `
          + `${earned.map((f) => `${f.name} at ${f.minLevel}`).join(', ')} — those are earned, not chosen.`
        : ''),
    );
    // Levelled feats are excluded rather than shown greyed: offering a card
    // that can never be clicked at creation is a worse lie than not offering
    // it, and the class card on step one already says when it arrives.
    const available = c.feats.filter(
      (f) => f.minLevel === 1 && (f.classes.length === 0 || f.classes.includes(this.classId ?? '')),
    );
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
    // Attributes belong in the review too (D-546): a summary that silently
    // omits a whole step's choices is the one place a wrong pick survives.
    const attrs = ATTRIBUTES
      .map((a) => `${ATTRIBUTE_INFO[a].name} ${this.attributes[a]}`)
      .join(', ');
    // ⚠ The race belongs here for the same reason the attributes do: a summary
    // that silently omits a whole step's choice is the one place a wrong pick
    // survives to the character you then have to live with. It is chosen five
    // steps earlier and never mentioned again otherwise.
    const race = c.races.find((r) => r.id === this.raceId);
    summary.innerHTML = `<b>${race ? `${race.name} ` : ''}${cls?.name ?? '—'}</b><br>`
      + `body: ${attrs} — ${maxHpFor(this.attributes)} health, `
      + `${maxManaFor(this.attributes)} of reserve<br>`
      + `skills: ${allocated}<br>`
      + `feats: ${named(this.feats, c.feats)}<br>`
      + (cls?.spellcasting ? `spells: ${named(this.spells, c.spells)}<br>` : '')
      + `appearance: ${describeAppearance(this.appearancePanel().appearance)}`;
    parent.appendChild(summary);

    input.focus();
  }

  /** Surfaces a server rejection on the step the player is looking at. */
  showError(message: string): void {
    $('create-error').textContent = message;
  }
}
