import {
  mulberry32,
  type BotRoleId,
  type ObjectiveKind,
  type WireEntity,
} from '@rc/shared';
import type { BotClient } from './botClient';

/**
 * Bot AI (D-540). `BotClient` speaks the protocol; this drives it.
 *
 * The point is not to play well. It is to make a round HAPPEN without three
 * humans — bots that gather, craft, eat, drink, dive, fight what attacks them,
 * and, if one of them is the antagonist, eventually turn on the rest. Two
 * dozen unratified numbers (roamer strength, the warden, hunger rates, the
 * dungeon gradient) can only be judged against a round that actually runs its
 * length, and until now nothing could run one.
 *
 * Three design commitments, each of which changes what the bots can prove:
 *
 * 1. **They play through the wire, and only through the wire.** An agent sees
 *    exactly what a rendering client sees — its own area mirror, its own
 *    status, its own `round_role`. It has no handle on the server, cannot read
 *    another bot's role, and cannot see into an area it is not standing in. A
 *    bot that finds the keeper found it by walking there. This is what makes a
 *    bot round evidence about the GAME rather than about the harness.
 *
 * 2. **They learn the map by walking it.** Transition targets are deliberately
 *    server-side (the snapshot sends only where the exits ARE), so an agent
 *    discovers where a door goes by going through it and remembers the edge.
 *    A test therefore never encodes the shape of the map, and the cross
 *    (D-529) can be re-authored without breaking a single bot.
 *
 * 3. **The antagonist commits on its own clock.** A minimum delay, then a
 *    per-tick roll on its OWN random stream — never the shared one, which
 *    every wandering roamer consumes and which would make betrayal depend on
 *    run timing rather than on the seed. Before it commits it works like
 *    anybody else, which is the whole point: the deception has to be
 *    behavioural, or the bots would only ever test the combat code.
 */

/**
 * ⚠ The six roles are a CLOSED vocabulary in `shared` now (D-624), because
 * `content/bots/` names one. This alias keeps every existing caller working
 * and makes the agent and the content impossible to disagree: a seventh role
 * in a file the agent does not implement is a companion that stands still,
 * and `validate:content` refuses it rather than letting it ship.
 */
export type BotRole = BotRoleId;

export interface BotAgentOptions {
  role: BotRole;
  /** This agent's own random stream. Never shared (see the class comment). */
  seed: number;
  /** Objective id → kind, loaded from content by the caller. Without it an
   * antagonist can still act, but only opportunistically. */
  objectiveKinds?: Map<string, ObjectiveKind>;
  /** Ticks of agent decision-time before betrayal is even rolled for. */
  betrayEarliestMs?: number;
  /** Per-decision chance of committing, once past the earliest time. */
  betrayChance?: number;
  /** How often the agent decides. Deliberately slower than the sim tick. */
  decisionMs?: number;
  /**
   * Shortest gap between two things this agent says (D-610). Defaults to
   * thirty seconds; tests shrink it, the way every other pacing number in
   * this project is an option (D-114).
   */
  speechIntervalMs?: number;
  log?: (msg: string) => void;
  /** Chatter about every decision. For tuning sessions, not for tests. */
  verbose?: boolean;
}

/** What a role goes looking for, in order of preference. */
const ROLE_NODES: Record<BotRole, string[]> = {
  gatherer: ['rock', 'seam'],
  forager: ['grain', 'bitterleaf', 'tangle'],
  woodsman: ['timber', 'run', 'scrub'],
  physician: ['bitterleaf', 'tangle'],
  delver: [],
  idler: [],
};

/** Recipes a role will attempt when it has the materials. */
const ROLE_RECIPES: Record<BotRole, string[]> = {
  gatherer: ['iron-hatchet'],
  forager: ['coarse-bread'],
  woodsman: ['hide-jerkin'],
  physician: ['bandage'],
  delver: ['warding-charm'],
  idler: [],
};

const TRUCE_LINES = [
  'Everyone still standing, then. Good.',
  'I did not sleep. Did anyone see the light in the south?',
  'Say where you were and we will all be calmer for it.',
  'Keep to pairs today. Nobody goes out alone.',
];

/**
 * How often one bot will speak, at most (D-610).
 *
 * ⚠ The old rule was a 6% roll per DECISION, and a decision is every 160ms
 * — about one line every 2.7 seconds each, so three companions produced a line
 * roughly every second and buried anything a person said. The stakeholder's
 * ruling is thirty seconds, per bot.
 */
const SPEECH_INTERVAL_MS = 30_000;

/**
 * How far a `say` carries (`CHANNEL_RANGE.say` on the server).
 *
 * ⚠ Kept deliberately in step with the server's own number rather than
 * guessed generously: a bot talking to an empty field is the other half of
 * "they talk too much", and it is the half you cannot see, because the
 * transcript fills up with lines nobody was there to hear.
 */
const EARSHOT_METRES = 10;

export class BotAgent {
  /** Everything the agent did, in order. Tests read this. */
  readonly actions: string[] = [];
  /** Set the moment an antagonist decides to act. Null for everyone else. */
  committedAtMs: number | null = null;

  private timer: NodeJS.Timeout | null = null;
  private rng: () => number;
  private startedAt = 0;
  /** When this agent last opened its mouth. Staggered at start (see `start`). */
  private lastSpokeAtMs = 0;
  /** The last thing it said, so it does not repeat itself straight back. */
  private lastLine = '';
  private get speechInterval(): number {
    return this.opts.speechIntervalMs ?? SPEECH_INTERVAL_MS;
  }
  private stopped = false;
  private busy = false;

  /** Learned map: area → "x,y" of a transition → where it came out. */
  private edges = new Map<string, Map<string, string>>();
  /** Transitions walked into but whose destination is not yet recorded. */
  private pendingExit: { area: string; key: string } | null = null;
  private lastAreaId: string | null = null;
  /** The area this agent last found its own work in — its spoke. Once known
   * it goes back rather than re-searching the cross every time an errand
   * takes it home, which is both faster and what a player does. */
  private spokeArea: string | null = null;
  /** Nodes found empty, and when to believe in them again. */
  private spent = new Map<number, number>();
  private lastHarvestTarget: number | null = null;
  private readErrorsTo = 0;
  /** The door currently being walked to, held until reached or abandoned. */
  private exploreTarget: { area: string; key: string; x: number; y: number; tries: number } | null =
    null;

  constructor(
    private bot: BotClient,
    private opts: BotAgentOptions,
  ) {
    this.rng = mulberry32(opts.seed);
  }

  get role(): BotRole {
    return this.opts.role;
  }

  get antagonist(): boolean {
    return this.bot.roundRole?.antagonist === true;
  }

  /** Which areas this agent has stood in. A crude but real coverage signal. */
  get visited(): string[] {
    return [...this.edges.keys()];
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    // ⚠ Staggered on the agent's OWN stream, so a cast that all arrived in
    // the same second does not then speak in the same second forever after.
    // Three bots chorusing every thirty seconds is a different bug wearing the
    // same face as the one being fixed.
    this.lastSpokeAtMs = Date.now() - Math.floor(this.rng() * this.speechInterval);
    this.stopped = false;
    const every = this.opts.decisionMs ?? 160;
    this.timer = setInterval(() => {
      // Decisions are serialised: a slow one must not overlap the next, or
      // the agent issues contradictory intents and looks like a desync.
      if (this.busy || this.stopped) return;
      this.busy = true;
      try {
        this.decide();
      } catch (err) {
        this.note(`decision failed: ${(err as Error).message}`);
      } finally {
        this.busy = false;
      }
    }, every);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------

  /** Decision-level chatter, off unless asked for. */
  private trace(msg: string): void {
    if (this.opts.verbose) this.opts.log?.(`[${this.opts.role}] ${msg}`);
  }

  private note(msg: string): void {
    this.actions.push(msg);
    this.opts.log?.(`[${this.opts.role}] ${msg}`);
  }

  private get me(): WireEntity | null {
    if (this.bot.you === null) return null;
    return this.bot.entities.get(this.bot.you) ?? null;
  }

  private get areaId(): string | null {
    return this.bot.area?.id ?? null;
  }

  /** Records where the last door came out, the moment the area changes. */
  private observeArea(): void {
    const area = this.areaId;
    if (area === null) return;
    if (!this.edges.has(area)) this.edges.set(area, new Map());
    if (area !== this.lastAreaId) {
      if (this.pendingExit && this.pendingExit.area !== area) {
        this.edges.get(this.pendingExit.area)!.set(this.pendingExit.key, area);
      }
      this.pendingExit = null;
      this.exploreTarget = null;
      this.lastAreaId = area;
    }
  }

  private decide(): void {
    const me = this.me;
    if (!me || !this.bot.area) return;
    this.observeArea();
    this.noteLandmarks();
    const status = this.bot.status;
    // The dead do nothing. A ghost that kept acting would be the anti-scouting
    // invariant (D-203) failing quietly rather than loudly.
    if (status?.ghost) return;
    const state = this.bot.roundState;
    if (state && state.phase !== 'running') return;
    // The dawn truce (D-536): the clock is stopped and nobody can be hurt.
    // Bots talk through it, which is what the minute is for.
    this.maybeSpeak(state !== null && state.graceTicks > 0);
    if (state && state.graceTicks > 0) return;

    if (this.antagonist && this.considerBetrayal()) return;
    if (this.handleThreats()) return;
    if (this.handleNeeds()) return;
    this.work();
  }

  // --- talking -------------------------------------------------------------

  /**
   * Says one thing, at most every thirty seconds, and only to somebody who is
   * there to hear it (D-610).
   *
   * ⚠ What it says is read off the agent's ACTUAL state — the need it is
   * answering, the node it is stood at, the spoke it is walking to. The point
   * is not flavour: a companion that announces where it is going is the only
   * way a person playing alongside bots can form any picture of the round, and
   * a canned line rotation tells them nothing while costing exactly as much
   * screen space.
   *
   * ⚠ An antagonist says the SAME things as everybody else, drawn from the
   * same cover work, and nothing here ever reads the objective. D-540 is
   * explicit that the deception has to be behavioural; a bot whose chatter
   * changed once it was dealt the role would be a tell in text, and a tell a
   * person would learn in one round.
   */
  private maybeSpeak(inTruce: boolean): void {
    const now = Date.now();
    if (now - this.lastSpokeAtMs < this.speechInterval) return;
    if (!this.someoneInEarshot()) return;
    const line = inTruce
      ? TRUCE_LINES[Math.floor(this.rng() * TRUCE_LINES.length)]!
      : this.intentLine();
    if (!line || line === this.lastLine) return;
    this.lastSpokeAtMs = now;
    this.lastLine = line;
    this.bot.send({ t: 'say', channel: 'say', text: line });
  }

  /**
   * Whether anybody is close enough to hear.
   *
   * ⚠ Players and bots only. NPCs and roamers do not listen, and counting
   * them would put a companion in the tavern talking at the keeper all round.
   */
  private someoneInEarshot(): boolean {
    const me = this.me;
    if (!me) return false;
    for (const e of this.bot.entities.values()) {
      if (e.id === me.id || e.kind !== 'player') continue;
      if (Math.hypot(e.x - me.x, e.y - me.y) <= EARSHOT_METRES) return true;
    }
    return false;
  }

  /** One of two phrasings, so a long round is not word-for-word repetition. */
  private pick(a: string, b: string): string {
    return this.rng() < 0.5 ? a : b;
  }

  /**
   * What this agent is doing or about to do, in its own words.
   *
   * Ordered the way `decide()` is ordered, so the line matches what the agent
   * will actually do next rather than describing a plan it has already
   * abandoned.
   */
  private intentLine(): string {
    const status = this.bot.status;
    const where = this.bot.area?.name ?? 'here';
    if (status && status.hp <= Math.max(4, status.maxHp * 0.35)) {
      return this.pick(
        'I took a bad one out there. I need to sit a while.',
        'I am hurt. If anyone has a bandage I will not be proud about it.',
      );
    }
    if (status?.thirst !== undefined && status.thirst !== 'sated') {
      return this.pick(
        'My throat is gone. I am for the well.',
        'I need water before I do anything else.',
      );
    }
    if (status?.hunger !== undefined && status.hunger !== 'sated') {
      const hasFood = this.bot.inventory.some((i) => {
        const t = this.bot.itemCatalogue.find((c) => c.id === i.templateId);
        return t?.nourishes === 'hunger';
      });
      return hasFood
        ? this.pick('I will eat, then get back to it.', 'Stopping to eat. Back shortly.')
        : this.pick(
            'I have nothing left to eat. I am going for grain.',
            'The pack is empty. Someone needs to work the farm.',
          );
    }
    const job = this.bot.work[this.bot.work.length - 1];
    if (job && !job.done) {
      return this.pick(
        `Working here in ${where}. Give me a moment.`,
        `I am in the middle of something in ${where}.`,
      );
    }
    switch (this.opts.role) {
      case 'gatherer':
        return this.pick('I am for the mine. We will want iron before long.', 'Heading to the seams. Shout if the town needs me.');
      case 'forager':
        return this.pick('I am working the farm. Bread has to come from somewhere.', 'Off to the grain. We will all want feeding tonight.');
      case 'woodsman':
        return this.pick('I am for the wood, for timber.', 'Going to cut timber. I will keep to the road.');
      case 'physician':
        return this.pick('I have bandages. Come and find me if you are cut.', 'I will stay near the town in case anyone is hurt.');
      case 'delver':
        return this.pick('I am going down the stairs. Someone mark the hour.', 'I am for the dungeon. If I am not back by dark, I am not coming back.');
      case 'idler':
        return this.pick('I will keep to the square and watch the road.', 'I am staying put. Somebody should be where people can find them.');
    }
  }

  // --- survival ------------------------------------------------------------

  /**
   * Fight what is HITTING you, and run if it is winning.
   *
   * Aggression is keyed on having actually been struck, never on proximity.
   * An agent that swung at any NPC within reach would kill the tavern keeper
   * by walking past it — which would mean the good half of the cast could
   * complete the antagonist's objective by accident, and every kill_npc round
   * would resolve for the wrong reason. Bots also do not hunt roamers for
   * sport: night is to be survived, not farmed.
   */
  private handleThreats(): boolean {
    const me = this.me!;
    const status = this.bot.status;
    const hurt = status !== null && status.hp <= Math.max(4, status.maxHp * 0.35);
    const struckMe = new Set(
      this.bot.attacks.filter((a) => a.targetId === me.id).map((a) => a.attackerId),
    );
    const hostiles = [...this.bot.entities.values()].filter(
      (e) => struckMe.has(e.id) && e.id !== me.id && this.dist(e) <= 1,
    );
    if (hostiles.length === 0) return false;
    if (hurt) {
      // Away from the nearest one, one tile at a time.
      const away = hostiles[0]!;
      const dir = this.stepAwayFrom(away.x, away.y);
      if (dir) {
        this.bot.send({ t: 'move', dir });
        return true;
      }
    }
    this.bot.send({ t: 'attack', targetEntityId: hostiles[0]!.id });
    return true;
  }

  /**
   * Hunger pushes out, thirst pulls in (D-533). The agent obeys both, which
   * is what makes a bot round exercise the map instead of one corner of it.
   */
  private handleNeeds(): boolean {
    const status = this.bot.status;
    if (!status) return false;
    const thirsty = status.thirst !== 'sated';
    const hungry = status.hunger !== 'sated';
    if (!thirsty && !hungry) return false;

    if (thirsty) {
      const well = this.findEntity((e) => e.kind === 'station' && e.descriptor.includes('well'));
      if (well) {
        if (this.dist(well) <= 2) {
          this.bot.send({ t: 'drink' });
          this.note('drank at the well');
          return true;
        }
        return this.stepToward(well.x, well.y);
      }
      // No well here: the well is the town's, so head for the town.
      if (this.travelToward('settled')) return true;
    }
    if (hungry) {
      const food = this.bot.inventory.find((i) => {
        const t = this.bot.itemCatalogue.find((c) => c.id === i.templateId);
        return t?.nourishes === 'hunger';
      });
      if (food) {
        this.bot.send({ t: 'eat', templateId: food.templateId });
        this.note(`ate ${food.templateId}`);
        return true;
      }
      // Nothing to eat: bread comes from grain, and grain is on the farm.
      const grain = this.bot.inventory.some((i) => i.templateId === 'field-grain');
      if (grain && this.tryCraft('coarse-bread')) return true;
      if (!grain && this.goHarvest(['grain'])) return true;
    }
    return false;
  }

  // --- work ----------------------------------------------------------------

  private work(): void {
    if (this.bot.work.length > 0) {
      const last = this.bot.work[this.bot.work.length - 1]!;
      if (!last.done) return; // already busy; leave it alone
    }
    for (const recipe of ROLE_RECIPES[this.opts.role]) {
      if (this.tryCraft(recipe)) return;
    }
    if (this.opts.role === 'delver') {
      this.delve();
      return;
    }
    if (this.opts.role === 'physician') {
      const patient = this.findEntity(
        (e) => e.kind === 'player' && e.id !== this.me!.id && this.dist(e) <= 1,
      );
      if (patient) {
        // Treating costs a bandage and may simply fail; that is fine, the
        // agent tries again next time it is next to somebody.
        this.bot.send({ t: 'treat', targetEntityId: patient.id });
      }
    }
    const wanted = ROLE_NODES[this.opts.role];
    if (wanted.length > 0 && this.goHarvest(wanted)) return;
    // Idlers keep to the town; everyone else keeps looking for their spoke.
    if (this.opts.role === 'idler') this.shuffle();
    else this.explore();
  }

  /**
   * Harvest a node whose descriptor matches any of `words`.
   *
   * A spent seam is indistinguishable from a full one on the wire — charges
   * are server-side — so the agent finds out by trying and remembers the
   * refusal, which is exactly what a player does. Without this an agent
   * stands at the first exhausted vein for the rest of the round.
   */
  private goHarvest(words: string[]): boolean {
    this.absorbRefusals();
    const node = this.findEntity(
      (e) =>
        e.kind === 'node'
        && !this.spent.has(e.id)
        && words.some((w) => e.descriptor.includes(w)),
    );
    if (node) {
      this.spokeArea = this.areaId;
      this.trace(`nearest ${node.descriptor} at ${node.x},${node.y} (d=${this.dist(node)})`);
      if (this.dist(node) <= 1) {
        this.bot.send({ t: 'harvest', targetEntityId: node.id });
        this.lastHarvestTarget = node.id;
        this.note(`working ${node.descriptor}`);
        return true;
      }
      if (this.stepToward(node.x, node.y)) return true;
      this.trace(`cannot reach ${node.descriptor}`);
      return this.shuffle();
    }
    this.trace('no node of mine here');
    // Known spoke first, then unexplored doors. The second half is how the
    // agent maps the cross without being told its shape; the first is how it
    // stops re-discovering the map after every trip to the well.
    if (this.spokeArea && this.spokeArea !== this.areaId && this.routeTo(this.spokeArea)) {
      return true;
    }
    return this.explore();
  }

  /** Reads new refusals and turns the useful ones into memory. */
  private absorbRefusals(): void {
    while (this.readErrorsTo < this.bot.errors.length) {
      const err = this.bot.errors[this.readErrorsTo++]!;
      if (err.code === 'node_spent' && this.lastHarvestTarget !== null) {
        // Remembered, not forever: nodes refill within the round (D-537), so
        // an agent that blacklisted permanently would strip a spoke bare and
        // then never come back to it.
        this.spent.set(this.lastHarvestTarget, Date.now() + 90_000);
        this.lastHarvestTarget = null;
      }
    }
    for (const [id, until] of this.spent) if (Date.now() > until) this.spent.delete(id);
  }

  private tryCraft(recipeId: string): boolean {
    const recipe = this.bot.recipes.find((r) => r.id === recipeId);
    if (!recipe) return false;
    const have = (id: string): number =>
      this.bot.inventory.reduce((n, i) => n + (i.templateId === id ? i.qty : 0), 0);
    if (!recipe.inputs.every((need) => have(need.item) >= need.quantity)) return false;
    if (recipe.station && recipe.station !== 'anywhere') {
      const station = this.findEntity(
        (e) => e.kind === 'station' && this.stationMatches(e.descriptor, recipe.station),
      );
      if (!station) return this.travelToward('settled');
      if (this.dist(station) > 2) return this.stepToward(station.x, station.y);
    }
    this.bot.send({ t: 'craft', recipeId });
    this.note(`crafting ${recipeId}`);
    return true;
  }

  /** Station descriptors are prose, so match them by their distinctive word. */
  private stationMatches(descriptor: string, station: string): boolean {
    if (station === 'workshop') return descriptor.includes('anvil');
    if (station === 'storehouse') return descriptor.includes('barrels');
    if (station === 'infirmary') return descriptor.includes('stoppered');
    if (station === 'well') return descriptor.includes('well');
    return false;
  }

  /**
   * Down, and fight what lives there. The dungeon is the round's separation
   * engine (D-523) — an agent that goes into it is producing exactly the
   * "half the cast is elsewhere" condition the antagonist needs.
   */
  private delve(): boolean {
    // Only underground: everything in the dungeon is hostile by construction
    // (D-537), and the same rule applied in town would have a delver killing
    // the keeper on its way through.
    if (!this.underground) return this.explore();
    const dweller = this.findEntity((e) => e.kind === 'npc' && this.dist(e) <= 6);
    if (dweller) {
      if (this.dist(dweller) <= 1) {
        this.bot.send({ t: 'attack', targetEntityId: dweller.id });
        return true;
      }
      return this.stepToward(dweller.x, dweller.y);
    }
    return this.explore();
  }

  // --- betrayal ------------------------------------------------------------

  /**
   * The random trigger. Until it fires the antagonist is indistinguishable
   * from anybody else, because it is doing the same work as anybody else.
   */
  private considerBetrayal(): boolean {
    if (this.committedAtMs === null) {
      const earliest = this.opts.betrayEarliestMs ?? 4000;
      if (Date.now() - this.startedAt < earliest) return false;
      if (this.rng() > (this.opts.betrayChance ?? 0.05)) return false;
      this.committedAtMs = Date.now();
      this.note(`committed to the objective: ${this.bot.roundRole?.objective?.name ?? 'unknown'}`);
    }
    return this.pursueObjective();
  }

  private pursueObjective(): boolean {
    const id = this.bot.roundRole?.objective?.id;
    const kind = id ? this.opts.objectiveKinds?.get(id) : undefined;
    switch (kind?.type) {
      case 'kill_npc':
        return this.hunt((e) => e.kind === 'npc' && e.descriptor.includes(kind.descriptor));
      case 'kill_player':
        return this.huntPlayer();
      case 'survive':
        return this.hide();
      // Steal and starve have no verbs on the wire yet (both are `planned` in
      // content). An agent handed one falls back to opportunism rather than
      // standing still and quietly proving nothing.
      default:
        return this.huntPlayer();
    }
  }

  /** Look for a target, area by area, and kill it when found. */
  private hunt(match: (e: WireEntity) => boolean): boolean {
    const target = this.findEntity(match);
    if (!target) return this.explore();
    if (this.dist(target) <= 1) {
      this.bot.send({ t: 'attack', targetEntityId: target.id });
      this.note('struck the objective');
      return true;
    }
    return this.stepToward(target.x, target.y);
  }

  /**
   * Kill a player, preferring one who is alone. Not cleverness for its own
   * sake: a witness is what turns a killing into evidence (D-217), so an
   * antagonist that waits for privacy is exercising the recognition system
   * rather than only the combat code.
   */
  private huntPlayer(): boolean {
    const me = this.me!;
    const players = [...this.bot.entities.values()].filter(
      (e) => e.kind === 'player' && e.id !== me.id,
    );
    if (players.length === 0) return this.explore();
    if (players.length > 1 && this.rng() < 0.75) {
      // Too many eyes. Keep working and try again later.
      return false;
    }
    const target = players.sort((a, b) => this.dist(a) - this.dist(b))[0]!;
    if (this.dist(target) <= 1) {
      this.bot.send({ t: 'attack', targetEntityId: target.id });
      this.note('struck a companion');
      return true;
    }
    return this.stepToward(target.x, target.y);
  }

  /** Get away from everyone and stay away. */
  private hide(): boolean {
    const me = this.me!;
    const others = [...this.bot.entities.values()].filter(
      (e) => e.kind === 'player' && e.id !== me.id,
    );
    if (others.length === 0) return false;
    const nearest = others.sort((a, b) => this.dist(a) - this.dist(b))[0]!;
    if (this.dist(nearest) > 8) return false;
    const dir = this.stepAwayFrom(nearest.x, nearest.y);
    if (dir) {
      this.bot.send({ t: 'move', dir });
      return true;
    }
    return this.explore();
  }

  // --- movement ------------------------------------------------------------

  private dist(e: { x: number; y: number }): number {
    // ⚠ Euclidean, in metres (D-567). Chebyshev called a diagonal neighbour
    // one away; it is 1.41m, and every "am I close enough" in this agent
    // shifted the moment positions stopped being tiles.
    const me = this.me!;
    return Math.hypot(e.x - me.x, e.y - me.y);
  }

  private findEntity(match: (e: WireEntity) => boolean): WireEntity | null {
    const found = [...this.bot.entities.values()].filter(match);
    if (found.length === 0) return null;
    return found.sort((a, b) => this.dist(a) - this.dist(b))[0]!;
  }

  private grid() {
    const area = this.bot.area!;
    return {
      width: area.width,
      height: area.height,
      // ⚠ Rounded. Positions are metres now and `tiles[59.61]` is undefined,
      // which reads as "not walkable" and makes the whole world impassable.
      // The tile grid survives here only as the agent's rough picture of the
      // map; the server's collision layer is the truth.
      walkable: (fx: number, fy: number): boolean => {
        const x = Math.round(fx);
        const y = Math.round(fy);
        const ch = area.tiles[y]?.[x];
        if (ch === undefined || !(area.legend[ch]?.walkable ?? false)) return false;
        return true;
      },
    };
  }

  /**
   * Ask the server to walk there (D-567).
   *
   * ⚠ The agent's own A* is GONE, and losing it is the point. It ran over the
   * tile grid, so with continuous positions it indexed `tiles[59.61]`, found
   * nothing, and concluded the whole map was impassable — an agent standing
   * still for a whole round with no error anywhere. The route was never the
   * client's to choose (D-102); it only ever was because the server could not
   * path.
   *
   * Re-asked every decision, which is cheap and copes with doors opening,
   * nodes vanishing and bodies in the way.
   */
  private stepToward(x: number, y: number): boolean {
    const me = this.me!;
    if (Math.hypot(me.x - x, me.y - y) < 0.6) return false;
    this.bot.send({ t: 'move_to', x, y });
    return true;
  }

  private stepAwayFrom(x: number, y: number): 'n' | 's' | 'e' | 'w' | null {
    const me = this.me!;
    const grid = this.grid();
    const options: ['n' | 's' | 'e' | 'w', number, number][] = [
      ['n', me.x, me.y - 1],
      ['s', me.x, me.y + 1],
      ['e', me.x + 1, me.y],
      ['w', me.x - 1, me.y],
    ];
    let best: ['n' | 's' | 'e' | 'w', number] | null = null;
    for (const [dir, nx, ny] of options) {
      if (!grid.walkable(nx, ny)) continue;
      const d = Math.max(Math.abs(nx - x), Math.abs(ny - y));
      if (!best || d > best[1]) best = [dir, d];
    }
    return best?.[0] ?? null;
  }

  /**
   * Walk through a door — an unexplored one by preference. This is the whole
   * of the agent's navigation: it has no map, it acquires one.
   *
   * The chosen door is REMEMBERED until the agent arrives or the area
   * changes. Re-rolling every decision was the first version, and it produced
   * an agent that stood between two exits shuffling for the length of a round:
   * each tick it committed to a different one and took a single step towards
   * it. Anything that re-decides faster than it can act does this.
   */
  private explore(): boolean {
    const area = this.bot.area;
    const me = this.me;
    if (!area || !me) return false;
    const doors = area.transitions.map((t) => ({ ...t, key: `${t.x},${t.y}` }));
    if (doors.length === 0) return this.shuffle();
    if (!this.exploreTarget || this.exploreTarget.area !== area.id) {
      const known = this.edges.get(area.id) ?? new Map<string, string>();
      const unexplored = doors.filter((d) => !known.has(d.key));
      // ⚠ A door learned to go NOWHERE is left alone (D-636). The round has
      // edges (D-627): a transition out of the scenario is refused, and the
      // taproom every round now opens in has one. An agent that kept
      // choosing it stood on the threshold for the whole round.
      const open = doors.filter((d) => known.get(d.key) !== area.id);
      const pool = unexplored.length > 0 ? unexplored : open.length > 0 ? open : doors;
      const pick = pool[Math.floor(this.rng() * pool.length) % pool.length]!;
      this.exploreTarget = { area: area.id, key: pick.key, x: pick.x, y: pick.y, tries: 0 };
    }
    const target = this.exploreTarget;
    this.pendingExit = { area: area.id, key: target.key };
    // ⚠ Within the tile, not AT its centre: positions are metres (D-567) and
    // a body settles at 1.125 on a door at 1, so an exact comparison never
    // matched and a barred door was pressed against for the whole round.
    if (Math.hypot(me.x - target.x, me.y - target.y) < 0.6) {
      // Standing on it. A door that fires does so on the server's next
      // tick; one that has not fired after several decisions is barred, and
      // is remembered as leading back to this same area so nothing routes
      // through it again.
      if (++target.tries > 4) {
        if (!this.edges.has(area.id)) this.edges.set(area.id, new Map());
        this.edges.get(area.id)!.set(target.key, area.id);
        this.exploreTarget = null;
        this.pendingExit = null;
        return this.shuffle();
      }
      return true;
    }
    if (this.stepToward(target.x, target.y)) {
      target.tries = 0;
      return true;
    }
    // Unreachable from here (a body in the doorway, a wedged diagonal): give
    // up on this door rather than pressing against it for the whole round.
    if (++target.tries > 3) this.exploreTarget = null;
    return this.shuffle();
  }

  /** A single random legal step. The last resort, so an agent is never inert. */
  private shuffle(): boolean {
    const dirs = ['n', 's', 'e', 'w'] as const;
    const grid = this.grid();
    const me = this.me!;
    const order = [...dirs].sort(() => this.rng() - 0.5);
    for (const dir of order) {
      const nx = me.x + (dir === 'e' ? 1 : dir === 'w' ? -1 : 0);
      const ny = me.y + (dir === 's' ? 1 : dir === 'n' ? -1 : 0);
      if (!grid.walkable(nx, ny)) continue;
      this.bot.send({ t: 'move', dir });
      return true;
    }
    return false;
  }

  /**
   * Head for the nearest area of a given zone that the agent has SEEN. With
   * no memory of one it explores instead — the agent never teleports its
   * knowledge.
   */
  private travelToward(zone: 'settled'): boolean {
    // The agent cannot read zones off the wire, so it uses the one landmark
    // it can recognise: the town is where the well is, and it remembers the
    // area it last drank in.
    void zone;
    if (this.townAreaId && this.areaId !== this.townAreaId) {
      return this.routeTo(this.townAreaId);
    }
    return this.explore();
  }

  /** The area the agent last saw a well in. Its idea of "town". */
  private townAreaId: string | null = null;
  /** Set from the snapshot's lighting: the only cue the wire gives that a
   * place is under the ground rather than under the sky. */
  private underground = false;

  /** Breadth-first over learned edges; explores when the route is unknown. */
  private routeTo(target: string): boolean {
    const here = this.areaId;
    if (!here || here === target) return false;
    const queue: string[] = [here];
    const cameFrom = new Map<string, { from: string; key: string }>();
    const seen = new Set([here]);
    while (queue.length > 0) {
      const at = queue.shift()!;
      for (const [key, to] of this.edges.get(at) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        cameFrom.set(to, { from: at, key });
        if (to === target) {
          let step = target;
          while (cameFrom.get(step)!.from !== here) step = cameFrom.get(step)!.from;
          const [dx, dy] = cameFrom.get(step)!.key.split(',').map(Number);
          this.pendingExit = { area: here, key: cameFrom.get(step)!.key };
          return this.stepToward(dx!, dy!);
        }
        queue.push(to);
      }
    }
    return this.explore();
  }

  /** Called by the agent whenever it can see a well — cheap landmarking. */
  private noteLandmarks(): void {
    this.underground = this.bot.area?.lighting === 'underground';
    if (this.townAreaId) return;
    const well = [...this.bot.entities.values()].some(
      (e) => e.kind === 'station' && e.descriptor.includes('well'),
    );
    if (well && this.areaId) this.townAreaId = this.areaId;
  }

}
