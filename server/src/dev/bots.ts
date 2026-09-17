import type { BotDef, ObjectiveKind } from '@rc/shared';
import { BotClient } from '@rc/sim/botClient';
import { BotAgent } from '@rc/sim/botAgent';

/**
 * Bots summoned from the lobby (D-607).
 *
 * D-540 built bots that play a round through the wire and a script that
 * fills one (`npm run bots`). What it did not do is make them reachable from
 * inside the game, and that is the gap that stopped a round from happening:
 * the cast floor is three (D-522), the go/no-go gate is one person playing a
 * round and judging how it feels (D-114), and the only way to get from one to
 * three was a second terminal and a command nobody standing in the lobby can
 * see. A mode that cannot be started by the person it is for is not shipped.
 *
 * ⚠ These are ORDINARY CLIENTS and that is load-bearing, not convenient.
 * Each one opens a real WebSocket to the server's own port, registers, creates
 * a character and is dealt a role by the same code that deals one to a person
 * — so a bot can be the antagonist, and everything D-540 proves about bots
 * being evidence about the game rather than about the harness still holds. A
 * shortcut that spawned them in-process past the gateway would quietly make
 * every bot round test the wrong thing.
 *
 * ⚠ This is why it is off in production (`allowBots`). It registers accounts
 * and creates characters on demand; exposed publicly it is an
 * account-creation hole wearing a lobby button.
 */

export interface BotStableOptions {
  /** Resolved after the gateway is listening — the port is 0 until then. */
  url: () => string;
  objectiveKinds: Map<string, ObjectiveKind>;
  /**
   * The roster, in draw order, from `content/bots/` (D-624).
   *
   * ⚠ Passed in rather than imported, like every other piece of content the
   * gateway uses. The stakeholder's note was that "the definition of bots
   * needs to be added to the creation tool", and a roster the server reaches
   * for itself is a roster the tool cannot be the source of.
   */
  roster: readonly BotDef[];
  log?: (msg: string) => void;
}

interface Bot {
  client: BotClient;
  agent: BotAgent;
  characterId: string;
  name: string;
}

/**
 * Most a lobby will conjure at once.
 *
 * ⚠ It is the length of the AUTHORED roster now (D-624), not a constant.
 * Drawing past the end wrapped, so with eleven names a twelfth request handed
 * back a second Dorn — and character names are unique, so it surfaced as a
 * refusal that read like the server being broken. The cap is what content
 * says there are.
 *
 * ⚠ A roster of eleven leaves room for a player inside a cast of twelve,
 * and a cast much past that is not the mode D-522 describes. That is a
 * property of the authored file now and can be changed by adding one.
 */
export function maxBots(roster: readonly BotDef[]): number {
  return roster.length;
}

export class BotStable {
  private readonly bots: Bot[] = [];
  private readonly log: (msg: string) => void;
  /** Distinct per process, so a restart does not collide on account names. */
  private readonly tag = Math.floor(Math.random() * 36 ** 5).toString(36);
  private seq = 0;
  private busy = false;

  /** New roster and objective kinds (D-630). Bots already playing keep theirs. */
  replaceContent(roster: readonly BotDef[], objectiveKinds: Map<string, ObjectiveKind>): void {
    this.opts.roster = roster;
    this.opts.objectiveKinds = objectiveKinds;
  }

  constructor(private readonly opts: BotStableOptions) {
    this.log = opts.log ?? (() => {});
  }

  get count(): number {
    return this.bots.length;
  }

  /** Character ids of the bots in the world — never counted as players. */
  characterIds(): string[] {
    return this.bots.map((c) => c.characterId);
  }

  /**
   * Brings `count` more in. Returns the names that arrived.
   *
   * ⚠ Serialised. Two clicks arriving a frame apart would otherwise interleave
   * two registrations on the same sequence number and the second would be
   * refused for a name already taken — which surfaces as a bot that
   * silently never appears.
   */
  async add(count: number): Promise<string[]> {
    if (this.busy) return [];
    this.busy = true;
    const arrived: string[] = [];
    try {
      const room = Math.min(count, this.capacity - this.bots.length);
      for (let i = 0; i < room; i++) {
        const name = await this.summon().catch((err: unknown) => {
          this.log(`bots: could not join — ${String(err)}`);
          return null;
        });
        if (name) arrived.push(name);
      }
    } finally {
      this.busy = false;
    }
    return arrived;
  }

  /** Sends them all home. Their characters stay on the books; nothing is lost. */
  removeAll(): number {
    const n = this.bots.length;
    for (const c of this.bots) {
      c.agent.stop();
      c.client.close();
    }
    this.bots.length = 0;
    if (n > 0) this.log(`bots: ${n} sent home`);
    return n;
  }

  /** How many this stable can hold: however many companions are authored. */
  get capacity(): number {
    return maxBots(this.opts.roster);
  }

  private async summon(): Promise<string> {
    const index = this.seq++;
    const roster = this.opts.roster;
    // ⚠ Refused ALOUD rather than wrapping or crashing (D-624). An empty
    // `content/bots/` is a lobby button that summons nobody, and the failure
    // has to name the directory or it reads as the server being down.
    if (roster.length === 0) {
      throw new Error("no companions are authored — add one in content/bots/");
    }
    const entry = roster[index % roster.length]!;
    // ⚠ Character names are LETTERS ONLY on the wire, so the uniqueness tag is
    // spelled rather than numbered — D-540 lost twenty minutes to a refusal
    // that reported itself as a timeout.
    const surname = spellLetters(`${this.tag}${index}`);
    const client = await BotClient.connect(this.opts.url());
    client.send({
      t: 'register',
      username: `bot_${this.tag}_${index}`,
      password: 'bot-passphrase',
    });
    await client.expect('auth_ok');
    client.send({
      t: 'create_character',
      name: `${entry.name} ${surname}`,
      // ⚠ The AUTHORED seed where there is one (D-624). Without it a
      // companion's face came from the order it happened to be summoned in,
      // so Dorn was a different stranger depending on how many arrived first
      // — which is half of what "one of the bots shows up as a goblin" was
      // about, the other half being D-618's lottery over creatures.
      appearanceSeed: entry.appearanceSeed ?? 10_000 + index * 977,
      ...(entry.classId ? { classId: entry.classId } : {}),
      ...(entry.raceId ? { raceId: entry.raceId } : {}),
    });
    const created = await client.expect('character_created').catch(() => {
      const refusal = client.errors[client.errors.length - 1];
      client.close();
      throw new Error(refusal ? `${refusal.code}: ${refusal.message}` : 'character refused');
    });
    client.send({ t: 'enter_world', characterId: created.character.id });
    await client.expect('snapshot');
    const agent = new BotAgent(client, {
      role: entry.role,
      seed: 7000 + index * 131,
      objectiveKinds: this.opts.objectiveKinds,
    });
    agent.start();
    this.bots.push({
      client,
      agent,
      characterId: created.character.id,
      name: created.character.name,
    });
    this.log(`bots: ${created.character.name} (${entry.role}) is in`);
    return created.character.name;
  }
}

/** Digits → letters, letters kept. See the note at the call site. */
function spellLetters(tag: string): string {
  const body = [...tag.toLowerCase()]
    .map((c) => (/[0-9]/.test(c) ? 'abcdefghij'[Number(c)]! : /[a-z]/.test(c) ? c : 'x'))
    .join('');
  return body.charAt(0).toUpperCase() + body.slice(1);
}
