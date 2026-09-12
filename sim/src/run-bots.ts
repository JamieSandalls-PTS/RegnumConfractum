import { fileURLToPath } from 'node:url';
import { loadContent } from '@rc/server/content';
import type { ObjectiveKind } from '@rc/shared';
import { BotClient } from './botClient';
import { BotAgent, type BotRole } from './botAgent';

/**
 * Fills a round with bots so one person can play it (D-540).
 *
 * The Round needs a cast of three before it will start, and the project's own
 * go/no-go gate is somebody playing one and judging how it feels. Waiting for
 * three humans to be free at the same time is the thing most likely to stop
 * that from happening — so this connects companions to a running server and
 * lets them get on with gathering, crafting, eating and dying.
 *
 *   npm run bots                       three bots at ws://localhost:8080
 *   npm run bots -- --count 5          five
 *   npm run bots -- --url ws://host:8090 --verbose
 *   npm run bots -- --betray 0.02      how eager an antagonist bot is
 *
 * The bots are ordinary clients: they register accounts, create characters,
 * and are dealt roles by the server like anybody else. One of them may be the
 * antagonist, and if it is, it will eventually come for you.
 */

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const url = flag('url', 'ws://localhost:8080');
const count = Math.max(1, Math.min(12, Number(flag('count', '3'))));
const betray = Number(flag('betray', '0.02'));
const verbose = has('verbose');
/** Distinct accounts per run, so repeated runs do not collide on names. */
const tag = flag('tag', String(Math.floor(Date.now() / 1000) % 100000));

/**
 * Character names are LETTERS only (the wire schema says so), so a numeric
 * run tag is spelled out: 'Dorn Cabdegh' rather than an illegal 'Dorn 20487'.
 * Letters in the tag are kept as they are — mapping them all to 'x' made two
 * different tags collide on the same name, and the second run failed with a
 * name-taken error dressed up as a timeout.
 */
const spell = (tag: string): string =>
  [...tag.toLowerCase()]
    .map((c) => (/[0-9]/.test(c) ? 'abcdefghij'[Number(c)]! : /[a-z]/.test(c) ? c : 'x'))
    .join('');

const ROSTER: { role: BotRole; name: string }[] = [
  { role: 'gatherer', name: 'Dorn Pickett' },
  { role: 'forager', name: 'Merrow Fenn' },
  { role: 'woodsman', name: 'Ulf Rethe' },
  { role: 'physician', name: 'Isolde Marr' },
  { role: 'delver', name: 'Cass Vellin' },
  { role: 'idler', name: 'Perrin Ostry' },
  { role: 'gatherer', name: 'Hale Marrowby' },
  { role: 'forager', name: 'Nessa Crowe' },
  { role: 'woodsman', name: 'Bran Toller' },
  { role: 'delver', name: 'Wick Aldren' },
  { role: 'physician', name: 'Sera Vosk' },
  { role: 'idler', name: 'Otho Sallow' },
];

async function main(): Promise<void> {
  const content = loadContent(fileURLToPath(new URL('../../content', import.meta.url)));
  const objectiveKinds = new Map<string, ObjectiveKind>(
    content.objectives.map((o) => [o.id, o.kind]),
  );
  const bots: BotClient[] = [];
  const agents: BotAgent[] = [];

  for (let i = 0; i < count; i++) {
    const entry = ROSTER[i % ROSTER.length]!;
    const username = `bot_${tag}_${i}`;
    const bot = await BotClient.connect(url);
    bot.send({ t: 'register', username, password: 'bot-passphrase' });
    const auth = await bot.expect('auth_ok').catch(() => null);
    if (!auth) {
      console.error(`bot ${i}: could not register as ${username}`);
      continue;
    }
    // The name must be unique across the whole world, not just this run —
    // and character names are LETTERS only (the wire schema says so), so the
    // run tag is spelled rather than numbered.
    bot.send({
      t: 'create_character',
      name: `${entry.name.split(' ')[0]} ${spell(tag)}${spell(String(i))}`,
      appearanceSeed: 10_000 + i * 977,
    });
    const created = await bot.expect('character_created').catch(async () => {
      // Say WHY. A creation refusal buffered as an error and then reported as
      // a timeout cost twenty minutes once already.
      const refusal = bot.errors[bot.errors.length - 1];
      throw new Error(
        `bot ${i}: the server refused the character`
        + `${refusal ? ` — ${refusal.code}: ${refusal.message}` : ''}`,
      );
    });
    bot.send({ t: 'enter_world', characterId: created.character.id });
    await bot.expect('snapshot');
    const agent = new BotAgent(bot, {
      role: entry.role,
      seed: 7000 + i * 131,
      objectiveKinds,
      betrayChance: betray,
      verbose,
      log: (msg) => console.log(`  ${created.character.name}: ${msg}`),
    });
    agent.start();
    bots.push(bot);
    agents.push(agent);
    console.log(`bot ${i}: ${created.character.name} (${entry.role}) is in`);
  }

  console.log(`\n${bots.length} companions playing. Ctrl-C to send them home.\n`);

  // A quiet heartbeat: enough to see the round move without watching a log.
  setInterval(() => {
    const first = bots[0];
    const state = first?.roundState;
    if (!state) return;
    const alive = bots.filter((b) => b.status && !b.status.ghost).length;
    console.log(
      `[${state.phase}] hour ${state.hour}${state.night ? ' (night)' : ''}`
      + `${state.graceTicks > 0 ? ' · truce' : ''} · cast ${state.cast}`
      + ` · bots standing ${alive}/${bots.length}`,
    );
  }, 10_000);

  const shutdown = (): void => {
    for (const a of agents) a.stop();
    for (const b of bots) b.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
