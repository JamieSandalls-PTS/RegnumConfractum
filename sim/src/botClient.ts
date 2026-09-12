import WebSocket from 'ws';
import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type SimEvent,
  type WireEntity,
  type WireItem,
} from '@rc/shared';

/**
 * Headless bot client (D-114). Speaks the real wire protocol over a real
 * socket, validates every server message against the shared schema, and
 * maintains a client-side mirror of the area by applying snapshot + deltas —
 * exactly what a rendering client will do. The mirror is what makes desync
 * mechanically detectable: compare it against a fresh snapshot.
 *
 * Any protocol violation or impossible event (schema failure, a move onto an
 * unwalkable tile, a delta for an unknown entity) is recorded in `violations`;
 * tests assert that array stays empty.
 */

interface AreaMirror {
  id: string;
  name: string;
  /** Render profile, and the only cue on the wire that a place is under the
   * ground rather than under the sky (D-527 keeps `outdoor` server-side). */
  lighting: 'overcast' | 'night' | 'underground' | 'interior';
  width: number;
  height: number;
  legend: Record<string, { walkable: boolean; kind: string }>;
  tiles: string[];
  transitions: { x: number; y: number }[];
  /** Pack meshes standing on the map (D-567) — where, turned, scaled. */
  assets: {
    pack: string;
    asset: string;
    x: number;
    y: number;
    z: number;
    rotation: number;
    scale: number;
  }[];
}

export class BotClient {
  readonly violations: string[] = [];
  readonly entities = new Map<number, WireEntity>();
  /**
   * Set whenever a snapshot arrives while a mirror already exists: the
   * discrepancies between what this client believed (built from deltas) and
   * what the server says. A non-empty array IS a desync.
   */
  lastResyncDiffs: string[] | null = null;
  /** Every speech line this client has heard, in order. */
  readonly speeches: Extract<ServerMessage, { t: 'speech' }>[] = [];
  /** Every narration line, in order (DM/scripts/spirit notices). */
  readonly narrations: string[] = [];
  /** Every blow this client witnessed, with the server's chosen variant. */
  readonly attacks: Extract<SimEvent, { type: 'entity_attacked' }>[] = [];
  /** Latest séance state (D-204), if any ever arrived. */
  seance: Extract<ServerMessage, { t: 'seance' }> | null = null;
  /** Whether this client is riding its corpse (D-224). */
  observing = false;
  /** Latest vitals (hp, ghost, injuries, debt). */
  status: Extract<ServerMessage, { t: 'status' }> | null = null;
  /** Latest round state (D-521): phase, cast size, clock. Broadcast, so it
   * must never carry the objective or the antagonist's identity. */
  roundState: Extract<ServerMessage, { t: 'round_state' }> | null = null;
  /** This client's role, delivered once at round start. Every player gets
   * one; only the antagonist's carries an objective. */
  roundRole: Extract<ServerMessage, { t: 'round_role' }> | null = null;
  /**
   * What the common stores held, last time this client was told (D-580).
   *
   * ⚠ Pushed rather than polled: everybody standing at the stores is told
   * when they change, because pooling is public and that is its whole cost.
   * A bot that only saw its OWN deposits would be testing a private chest.
   */
  storeContents: Extract<ServerMessage, { t: 'store_contents' }> | null = null;
  /** Every round this client saw end, in order — including the reveal. */
  readonly roundsEnded: Extract<ServerMessage, { t: 'round_ended' }>[] = [];
  /** Everything this client HEARD (D-531). Never carries an identity. */
  readonly sounds: Extract<ServerMessage, { t: 'sound' }>[] = [];
  /** Every refusal the server sent, in order. A bot learns from these the
   * way a player learns from a message in the log — a spent seam looks
   * exactly like a full one on the wire. */
  readonly errors: Extract<ServerMessage, { t: 'error' }>[] = [];
  /** Every work report (MR2) — progress, completion, and interruptions. */
  readonly work: Extract<ServerMessage, { t: 'work' }>[] = [];
  /** The craft catalogue, sent on entering the world. */
  recipes: Extract<ServerMessage, { t: 'catalogue' }>['recipes'] = [];
  /** Item templates, so a test can read a name rather than an id. */
  itemCatalogue: Extract<ServerMessage, { t: 'catalogue' }>['items'] = [];
  area: AreaMirror | null = null;
  you: number | null = null;
  inventory: WireItem[] = [];
  coin = 0;
  lastTick = 0;

  private ws: WebSocket;
  private inbox: ServerMessage[] = [];
  private waiters: {
    pred: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }[] = [];
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => this.onRaw(raw.toString()));
    ws.on('close', () => {
      this.closed = true;
    });
  }

  static connect(url: string, timeoutMs = 5000): Promise<BotClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error(`connect timeout: ${url}`)), timeoutMs);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(new BotClient(ws));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Resolves with the next (possibly already-buffered) message of type `t`.
   * Messages of other types stay buffered for later expects.
   */
  expect<T extends ServerMessage['t']>(
    t: T,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    return this.expectWhere((m) => m.t === t, `message '${t}'`, timeoutMs) as Promise<
      Extract<ServerMessage, { t: T }>
    >;
  }

  expectError(code: string, timeoutMs = 5000): Promise<Extract<ServerMessage, { t: 'error' }>> {
    return this.expectWhere(
      (m) => m.t === 'error' && m.code === code,
      `error '${code}'`,
      timeoutMs,
    ) as Promise<Extract<ServerMessage, { t: 'error' }>>;
  }

  /** Waits until a delta moves entity `id` to `pos`, or times out. */
  async expectMoveTo(id: number, pos: { x: number; y: number }, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const e = this.entities.get(id);
      if (e && e.x === pos.x && e.y === pos.y) return;
      await this.expectWhere(
        (m) => m.t === 'delta',
        'delta',
        Math.max(1, deadline - Date.now()),
      );
    }
    throw new Error(`entity ${id} never reached (${pos.x},${pos.y})`);
  }

  private expectWhere(
    pred: (m: ServerMessage) => boolean,
    label: string,
    timeoutMs: number,
  ): Promise<ServerMessage> {
    const idx = this.inbox.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (m: ServerMessage) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(
          new Error(
            `timed out waiting for ${label}; buffered: [${this.inbox.map((m) => m.t).join(', ')}]`,
          ),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Discards buffered messages of a type — e.g. stale snapshots before a
   * resync assertion. */
  drain(t: ServerMessage['t']): void {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      if (this.inbox[i]!.t === t) this.inbox.splice(i, 1);
    }
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }

  // -------------------------------------------------------------------------

  private onRaw(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.violations.push(`unparseable frame: ${raw.slice(0, 120)}`);
      return;
    }
    const msg = parseServerMessage(json);
    if (!msg) {
      this.violations.push(`schema violation: ${raw.slice(0, 200)}`);
      return;
    }
    this.apply(msg);
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const waiter = this.waiters.splice(idx, 1)[0]!;
      waiter.resolve(msg);
    } else {
      this.inbox.push(msg);
    }
  }

  /**
   * A coarse "the server did not put me inside a wall" check.
   *
   * ⚠ Positions are METRES now (D-567), so this ROUNDS. Indexing `tiles[59.6]`
   * returns undefined, which reads as "not walkable", which made the bot
   * report every single step as a protocol violation — eighty-eight of them in
   * one short test, all of them false.
   *
   * ⚠ It is deliberately coarser than the server's own rule. The collision
   * layer keeps a body a third of a metre clear of anything solid, so a legal
   * position always rounds to a walkable tile; the reverse does not hold, and
   * this check is not trying to. It catches a body in the middle of masonry,
   * which is the failure worth shouting about.
   */
  private walkable(fx: number, fy: number): boolean {
    const a = this.area;
    if (!a) return true; // can't judge yet
    const x = Math.round(fx);
    const y = Math.round(fy);
    if (x < 0 || y < 0 || x >= a.width || y >= a.height) return false;
    const ch = a.tiles[y]?.[x];
    if (ch === undefined || !(a.legend[ch]?.walkable ?? false)) return false;
    return true;
  }

  private apply(msg: ServerMessage): void {
    switch (msg.t) {
      case 'snapshot': {
        // A snapshot for a DIFFERENT area is not a resync — it is arrival.
        // Diffing across a door reports every entity in the room you left as
        // a discrepancy, which turns the desync check into noise exactly when
        // a bot starts using the map.
        if (this.area !== null && this.area.id === msg.area.id) {
          this.lastResyncDiffs = this.diffAgainstSnapshot(msg);
        }
        this.area = msg.area;
        this.you = msg.you;
        this.lastTick = msg.tick;
        this.entities.clear();
        for (const e of msg.entities) {
          this.entities.set(e.id, { ...e });
          if (!this.walkable(e.x, e.y)) {
            this.violations.push(`snapshot places entity ${e.id} on unwalkable (${e.x},${e.y})`);
          }
        }
        this.inventory = msg.inventory;
        this.coin = msg.coin;
        break;
      }
      case 'delta': {
        if (msg.tick < this.lastTick) {
          this.violations.push(`delta tick went backwards: ${this.lastTick} -> ${msg.tick}`);
        }
        this.lastTick = msg.tick;
        for (const event of msg.events) {
          if (event.type === 'entity_moved') {
            const e = this.entities.get(event.id);
            if (!e) {
              this.violations.push(`entity_moved for unknown entity ${event.id}`);
              continue;
            }
            // Euclidean, in metres (D-567). One tick of walking is a third of
            // a metre, so anything past a metre in one event is a teleport.
            const dist = Math.hypot(e.x - event.x, e.y - event.y);
            if (dist > 1) {
              this.violations.push(
                `entity ${event.id} teleported (${e.x},${e.y}) -> (${event.x},${event.y})`,
              );
            }
            if (!this.walkable(event.x, event.y)) {
              this.violations.push(`entity ${event.id} moved onto unwalkable (${event.x},${event.y})`);
            }
            e.x = event.x;
            e.y = event.y;
            e.z = event.z;
            e.facing = event.facing;
            e.posture = 'standing'; // protocol rule: moving implies standing
          } else if (event.type === 'entity_entered') {
            this.entities.set(event.entity.id, { ...event.entity });
          } else if (event.type === 'entity_left') {
            if (!this.entities.delete(event.id)) {
              this.violations.push(`entity_left for unknown entity ${event.id}`);
            }
          } else if (event.type === 'entity_emote') {
            const e = this.entities.get(event.id);
            if (!e) {
              this.violations.push(`entity_emote for unknown entity ${event.id}`);
            } else if (event.posture) {
              e.posture = event.posture;
            }
          } else if (event.type === 'entity_presentation') {
            const e = this.entities.get(event.id);
            if (!e) this.violations.push(`entity_presentation for unknown entity ${event.id}`);
            else e.presentation = event.state;
          } else if (event.type === 'entity_worn') {
            // ⚠ This was not handled at all, so a bot's view of what anybody
            // was wearing froze at the snapshot. D-554 put the event on the
            // wire and nothing headless ever read it — which means every
            // assertion about equipment silently tested the starting kit.
            //
            // ⚠ An unknown entity is NOT a violation here, unlike every
            // neighbour in this switch. Entering the world grants the kit and
            // publishes the silhouette before the new entity has been
            // broadcast to anybody, so observers legitimately receive one
            // delta about somebody they cannot see yet — and the
            // `entity_entered` that follows carries the authoritative `worn`
            // anyway. The real client drops it on the same `if`. Recording a
            // violation would fail ten honest tests to flag a redundant
            // message.
            const e = this.entities.get(event.id);
            if (e) e.worn = event.worn;
          } else if (event.type === 'entity_combat') {
            const e = this.entities.get(event.id);
            if (!e) this.violations.push(`entity_combat for unknown entity ${event.id}`);
            else e.combat = event.inCombat;
          } else if (event.type === 'entity_carried') {
            const e = this.entities.get(event.id);
            if (!e) this.violations.push(`entity_carried for unknown entity ${event.id}`);
            else e.carriedBy = event.carrierId;
          } else if (event.type === 'entity_attacked') {
            this.attacks.push(event);
          } else if (event.type === 'entity_died') {
            if (!this.entities.delete(event.id)) {
              this.violations.push(`entity_died for unknown entity ${event.id}`);
            }
          }
        }
        break;
      }
      case 'inventory': {
        this.inventory = msg.items;
        this.coin = msg.coin;
        break;
      }
      case 'speech': {
        this.speeches.push(msg);
        break;
      }
      case 'narrate': {
        this.narrations.push(msg.text);
        break;
      }
      case 'seance': {
        this.seance = msg;
        break;
      }
      case 'observing': {
        this.observing = msg.on;
        break;
      }
      case 'status': {
        this.status = msg;
        break;
      }
      case 'round_state': {
        this.roundState = msg;
        break;
      }
      case 'round_role': {
        this.roundRole = msg;
        break;
      }
      case 'store_contents': {
        this.storeContents = msg;
        break;
      }
      case 'round_ended': {
        this.roundsEnded.push(msg);
        break;
      }
      case 'sound': {
        this.sounds.push(msg);
        break;
      }
      case 'work': {
        this.work.push(msg);
        break;
      }
      case 'error': {
        this.errors.push(msg);
        break;
      }
      case 'catalogue': {
        this.recipes = msg.recipes;
        this.itemCatalogue = msg.items;
        break;
      }
      default:
        break;
    }
  }

  /** Mirror vs a fresh snapshot — the desync check. Returns discrepancies. */
  diffAgainstSnapshot(snapshot: Extract<ServerMessage, { t: 'snapshot' }>): string[] {
    const diffs: string[] = [];
    const seen = new Set<number>();
    for (const e of snapshot.entities) {
      seen.add(e.id);
      const mine = this.entities.get(e.id);
      if (!mine) {
        diffs.push(`server has entity ${e.id} (${e.descriptor}) missing from mirror`);
      } else if (mine.x !== e.x || mine.y !== e.y) {
        diffs.push(`entity ${e.id}: mirror (${mine.x},${mine.y}) vs server (${e.x},${e.y})`);
      }
    }
    for (const id of this.entities.keys()) {
      if (!seen.has(id)) diffs.push(`mirror has entity ${id} the server does not`);
    }
    return diffs;
  }
}
