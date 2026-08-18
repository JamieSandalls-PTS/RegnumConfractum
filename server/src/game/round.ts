import {
  ROUND_LENGTH_TICKS,
  ROUND_MIN_CAST,
  winnerFor,
  type ObjectiveDef,
  type RoundOutcome,
  type RoundPhase,
  type RoundWinner,
  type Rng,
} from '@rc/shared';

/**
 * The round engine (D-521). Server-owned, tick-driven, and pure: no wall
 * clock, no Math.random, no I/O. The gateway feeds it facts — who is in the
 * cast, who has died, what tick it is — and it answers with a resolution or
 * nothing. That keeps the whole of the round's logic reproducible headlessly,
 * which is the only way any of it gets verified (D-114).
 *
 * Three properties are load-bearing and are asserted by the tests rather than
 * left to reading:
 *
 *   1. **Antagonist selection is random**, drawn from the seeded Rng. D-524's
 *      ruling that recognition may reset while faces persist depends on this:
 *      random assignment is what makes "X was the traitor last round"
 *      worthless. Any weighting, queueing or opt-in breaks that property and
 *      is a design change, not a tuning knob.
 *   2. **The objective never leaves this object except to the antagonist.**
 *      The engine exposes the antagonist's identity only through
 *      `secretRole()`, which the gateway sends to exactly one connection.
 *   3. **Nothing here scores virtue.** A round produces an outcome and a
 *      winner, and no credit for accusing correctly (D-303, D-521).
 */

export interface CastMember {
  characterId: string;
  entityId: number;
}

export interface RoundAssignment {
  objective: ObjectiveDef;
  antagonistCharacterId: string;
  /** Drawn at start for `kill_player`; null for every other kind. */
  targetCharacterId: string | null;
  startedAtTick: number;
  endsAtTick: number;
}

export interface RoundResolution {
  outcome: RoundOutcome;
  winner: RoundWinner;
  objective: ObjectiveDef;
  antagonistCharacterId: string;
  targetCharacterId: string | null;
  endedAtTick: number;
}

export interface RoundEngineOptions {
  objectives: ObjectiveDef[];
  rng: Rng;
  lengthTicks?: number;
  minCast?: number;
  log?: (msg: string) => void;
}

export class RoundEngine {
  private _phase: RoundPhase = 'lobby';
  private assignment: RoundAssignment | null = null;
  private resolution: RoundResolution | null = null;

  /** Cast at the moment the round started — the roll of who was playing. */
  private cast: CastMember[] = [];
  /** Characters who have died this round. No respawn, so this only grows. */
  private dead = new Set<string>();
  /** Public descriptors of NPCs killed this round, for `kill_npc`. */
  private npcsKilled = new Set<string>();
  /** Set by MR2's systems for objectives the engine cannot observe itself. */
  private objectiveForced = false;

  private readonly objectives: ObjectiveDef[];
  private readonly rng: Rng;
  private readonly lengthTicks: number;
  private readonly minCast: number;
  private readonly log: (msg: string) => void;

  constructor(opts: RoundEngineOptions) {
    this.objectives = opts.objectives;
    this.rng = opts.rng;
    this.lengthTicks = opts.lengthTicks ?? ROUND_LENGTH_TICKS;
    this.minCast = opts.minCast ?? ROUND_MIN_CAST;
    this.log = opts.log ?? (() => {});
  }

  get phase(): RoundPhase {
    return this._phase;
  }

  get minimumCast(): number {
    return this.minCast;
  }

  /** Ticks left, or null outside a running round. */
  remainingTicks(tick: number): number | null {
    if (this._phase !== 'running' || !this.assignment) return null;
    return Math.max(0, this.assignment.endsAtTick - tick);
  }

  lastResolution(): RoundResolution | null {
    return this.resolution;
  }

  /** True only for the one character carrying the objective. */
  isAntagonist(characterId: string): boolean {
    return this.assignment?.antagonistCharacterId === characterId;
  }

  /**
   * The antagonist's briefing. Returns null for everyone else — the caller
   * sends this to a single connection and must never broadcast it.
   */
  secretRole(characterId: string): { objective: ObjectiveDef; targetCharacterId: string | null } | null {
    if (!this.assignment || this.assignment.antagonistCharacterId !== characterId) return null;
    return {
      objective: this.assignment.objective,
      targetCharacterId: this.assignment.targetCharacterId,
    };
  }

  /**
   * Objectives playable at this cast size and evaluable today. 'planned'
   * documents are excluded here rather than at load: they are legitimate
   * content describing scenarios MR2 will make real, and a round must never
   * select one it cannot resolve.
   */
  eligibleObjectives(castSize: number): ObjectiveDef[] {
    return this.objectives.filter(
      (o) =>
        o.status === 'live' &&
        castSize >= o.minCast &&
        (o.maxCast === null || castSize <= o.maxCast),
    );
  }

  /**
   * Starts a round. Returns null if the cast is short or no objective fits —
   * the caller stays in lobby and tries again when someone else joins.
   */
  start(cast: CastMember[], tick: number): RoundAssignment | null {
    if (this._phase === 'running') return null;
    if (cast.length < this.minCast) return null;
    const eligible = this.eligibleObjectives(cast.length);
    if (eligible.length === 0) {
      this.log(`round: no live objective fits a cast of ${cast.length}`);
      return null;
    }

    // Random, every round, with no memory of previous rounds (D-524).
    const objective = this.rng.pick(eligible);
    const antagonist = this.rng.pick(cast);
    let targetCharacterId: string | null = null;
    if (objective.kind.type === 'kill_player') {
      const others = cast.filter((c) => c.characterId !== antagonist.characterId);
      if (others.length === 0) return null;
      targetCharacterId = this.rng.pick(others).characterId;
    }

    this.cast = [...cast];
    this.dead.clear();
    this.npcsKilled.clear();
    this.objectiveForced = false;
    this.resolution = null;
    this.assignment = {
      objective,
      antagonistCharacterId: antagonist.characterId,
      targetCharacterId,
      startedAtTick: tick,
      endsAtTick: tick + this.lengthTicks,
    };
    this._phase = 'running';
    this.log(`round: begins, cast of ${cast.length}, objective '${objective.id}'`);
    return this.assignment;
  }

  /** A member of the cast died. There is no respawn, so this is terminal. */
  noteCharacterDeath(characterId: string): void {
    if (this._phase !== 'running') return;
    this.dead.add(characterId);
  }

  /** An NPC died. Matched against `kill_npc` by public descriptor. */
  noteNpcDeath(descriptor: string): void {
    if (this._phase !== 'running') return;
    this.npcsKilled.add(descriptor);
  }

  /**
   * For objectives the engine cannot observe on its own — `steal` and
   * `starve` land with MR2's item and survival systems and will call this.
   */
  noteObjectiveComplete(): void {
    if (this._phase !== 'running') return;
    this.objectiveForced = true;
  }

  /** A character left the cast entirely (logged out, retired). */
  noteDeparture(characterId: string): void {
    this.cast = this.cast.filter((c) => c.characterId !== characterId);
  }

  livingCast(): string[] {
    return this.cast.map((c) => c.characterId).filter((id) => !this.dead.has(id));
  }

  /**
   * Advances the round and resolves it if a condition is met. Call once per
   * server tick, and again after any death so a resolution is not delayed by
   * up to a tick.
   */
  evaluate(tick: number): RoundResolution | null {
    if (this._phase !== 'running' || !this.assignment) return null;
    const a = this.assignment;

    // Objective first: a deed done stands even if the antagonist falls in the
    // same tick. The alternative — letting a simultaneous kill erase a
    // completed objective — would make the last second of a round arbitrary.
    if (this.objectiveSatisfied()) return this.resolve('objective_complete', tick);

    if (this.dead.has(a.antagonistCharacterId)) return this.resolve('antagonist_dead', tick);

    const livingGood = this.cast.filter(
      (c) => c.characterId !== a.antagonistCharacterId && !this.dead.has(c.characterId),
    );
    if (this.cast.length > 1 && livingGood.length === 0) return this.resolve('cast_wiped', tick);

    if (tick >= a.endsAtTick) {
      // 'survive' inverts the clock: reaching the end alive IS the deed, so
      // the same event that is a cast victory in every other scenario is an
      // antagonist victory here.
      if (a.objective.kind.type === 'survive' && !this.dead.has(a.antagonistCharacterId)) {
        return this.resolve('objective_complete', tick);
      }
      return this.resolve('time_expired', tick);
    }
    return null;
  }

  /** Ends the round early — too few players left to continue. */
  abandon(tick: number): RoundResolution | null {
    if (this._phase !== 'running') return null;
    return this.resolve('abandoned', tick);
  }

  /**
   * Clears the round for the next one. The caller is responsible for the
   * world-side reset that must accompany it: gear stripped, recognition
   * knowledge wiped (D-525), the dungeon repopulated (D-523).
   */
  reset(): void {
    this._phase = 'lobby';
    this.assignment = null;
    this.cast = [];
    this.dead.clear();
    this.npcsKilled.clear();
    this.objectiveForced = false;
  }

  // -------------------------------------------------------------------------

  private objectiveSatisfied(): boolean {
    const a = this.assignment;
    if (!a) return false;
    switch (a.objective.kind.type) {
      case 'kill_npc':
        return this.npcsKilled.has(a.objective.kind.descriptor);
      case 'kill_player':
        // Any death of the target counts, whatever killed them — the genre
        // convention, and it keeps the antagonist from being robbed by a
        // monster finishing the job first. ⚠ Unratified.
        return a.targetCharacterId !== null && this.dead.has(a.targetCharacterId);
      case 'survive':
        return false; // resolved at the deadline, in evaluate()
      case 'steal':
      case 'starve':
        return this.objectiveForced; // MR2 reports these in
    }
  }

  private resolve(outcome: RoundOutcome, tick: number): RoundResolution {
    const a = this.assignment!;
    this.resolution = {
      outcome,
      winner: winnerFor(outcome),
      objective: a.objective,
      antagonistCharacterId: a.antagonistCharacterId,
      targetCharacterId: a.targetCharacterId,
      endedAtTick: tick,
    };
    this._phase = 'resolved';
    this.log(`round: ${outcome} (${this.resolution.winner})`);
    return this.resolution;
  }
}
