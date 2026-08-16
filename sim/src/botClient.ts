import WebSocket from 'ws';
import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
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
  width: number;
  height: number;
  legend: Record<string, { walkable: boolean; kind: string }>;
  tiles: string[];
  transitions: { x: number; y: number }[];
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

  private walkable(x: number, y: number): boolean {
    const a = this.area;
    if (!a) return true; // can't judge yet
    if (x < 0 || y < 0 || x >= a.width || y >= a.height) return false;
    const ch = a.tiles[y]?.[x];
    return ch !== undefined && (a.legend[ch]?.walkable ?? false);
  }

  private apply(msg: ServerMessage): void {
    switch (msg.t) {
      case 'snapshot': {
        if (this.area !== null) this.lastResyncDiffs = this.diffAgainstSnapshot(msg);
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
            const dist = Math.max(Math.abs(e.x - event.x), Math.abs(e.y - event.y));
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
