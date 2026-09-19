import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * The launcher (stakeholder, 2026-08-20): one thing to double-click that
 * starts a round, restarts it, and fills it with bots.
 *
 * It exists because the go/no-go gate is somebody PLAYING a round (D-521),
 * and the thing standing between the stakeholder and that has never been the
 * game — it has been remembering four commands, three environment variables
 * and which port everything is on. This is a menu.
 *
 * It is deliberately a THIN wrapper. Every option below shells out to the
 * script that already exists, in the same way the docs say to run it by hand,
 * so there is exactly one way each thing starts and nothing here can drift
 * away from what CI runs.
 *
 *   npm run play          — or double-click rc.cmd
 */

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// ---------------------------------------------------------------------------
// Configuration, read the same way the server reads it
// ---------------------------------------------------------------------------

/**
 * Reads .env WITHOUT overriding real environment variables — the same
 * precedence `server/src/config.ts` uses, so the launcher and the server can
 * never disagree about which database or port is in play.
 */
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]!] = m[2]!;
  }
  return env;
}

const fileEnv = loadEnv();
const cfg = {
  databaseUrl: process.env.DATABASE_URL ?? fileEnv.DATABASE_URL ?? '',
  port: Number(process.env.PORT ?? fileEnv.PORT ?? 8080),
  adminPort: Number(process.env.ADMIN_PORT ?? fileEnv.ADMIN_PORT ?? 8081),
  adminToken: process.env.ADMIN_TOKEN ?? fileEnv.ADMIN_TOKEN ?? '',
  /**
   * The persistent world's starting room, if overridden. ⚠ Where a ROUND
   * opens is the scenario's `opensIn` (D-627, D-636), not this; the launcher
   * used to force `round-town` here from the days before scenarios existed.
   */
  area: process.env.DEFAULT_AREA_ID ?? fileEnv.DEFAULT_AREA_ID,
  /** D-522's floor. Bots make up the difference. */
  minCast: Number(process.env.ROUND_MIN_CAST ?? fileEnv.ROUND_MIN_CAST ?? 3),
  clientPort: 5173,
  /** The authoring server (D-629): studio, creation tool and map editor. */
  toolsPort: Number(process.env.STUDIO_PORT ?? fileEnv.STUDIO_PORT ?? 8150),
};

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

interface Child {
  name: string;
  proc: ChildProcess;
}

const children: Child[] = [];

/**
 * Spawns a long-running child with its output prefixed.
 *
 * `shell: true` because on Windows `npx`/`npm` are .cmd shims that cannot be
 * exec'd directly — the classic EINVAL that makes a launcher look broken on
 * the one platform it was written for.
 */
function start(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}): Child {
  const proc = spawn(command, args, {
    cwd: ROOT,
    shell: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relay = (data: Buffer, stream: 'out' | 'err'): void => {
    for (const raw of data.toString().split('\n')) {
      if (raw.trim() === '') continue;
      // The server tags its own lines `[server]`, so relaying them under our
      // tag read as `[server] [server] …`. Strip one if it is already there.
      const line = raw.replace(/^\[[a-z]+\]\s*/, '');
      process.stdout.write(`  ${dim(`[${name}]`)} ${stream === 'err' ? dim(line) : line}\n`);
    }
  };
  proc.stdout?.on('data', (d: Buffer) => relay(d, 'out'));
  proc.stderr?.on('data', (d: Buffer) => relay(d, 'err'));
  proc.on('exit', (code) => {
    const i = children.findIndex((c) => c.proc === proc);
    if (i >= 0) children.splice(i, 1);
    // A tree-kill leaves a non-zero exit code, so on the way out every child
    // would report itself as having crashed. Only say so when nobody asked.
    if (code !== 0 && code !== null && !closing) say(`${name} stopped (exit ${code}).`);
  });
  const child = { name, proc };
  children.push(child);
  return child;
}

function running(name: string): boolean {
  return children.some((c) => c.name === name && c.proc.exitCode === null);
}

function stopAll(): void {
  for (const c of [...children]) {
    // A tree-kill, because these are shell children: killing the shim leaves
    // the node process it launched holding the port, and the next start then
    // fails with EADDRINUSE for no visible reason.
    if (process.platform === 'win32' && c.proc.pid) {
      spawn('taskkill', ['/pid', String(c.proc.pid), '/T', '/F'], { stdio: 'ignore', shell: true });
    } else {
      c.proc.kill('SIGTERM');
    }
  }
  children.length = 0;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function portOpenOn(port: number, host: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ port, host });
    const done = (ok: boolean): void => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * Is anything listening? Cheaper and more honest than asking a process.
 *
 * ⚠ BOTH loopback addresses. Vite binds `localhost`, which Node 22 resolves
 * to `::1` alone, so a probe of 127.0.0.1 reported the client DOWN while it
 * was serving — and the launcher gave up waiting for a client that was
 * already up. The game server and Postgres answer on both.
 */
async function portOpen(port: number, timeoutMs = 400): Promise<boolean> {
  return (await portOpenOn(port, '127.0.0.1', timeoutMs)) || portOpenOn(port, '::1', timeoutMs);
}

async function waitForPort(port: number, what: string, ms = 30_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portOpen(port)) return true;
    await sleep(300);
  }
  say(`gave up waiting for ${what} on port ${port}.`);
  return false;
}

const adminUrl = (path: string): string =>
  `http://127.0.0.1:${cfg.adminPort}${path}${cfg.adminToken ? `?token=${cfg.adminToken}` : ''}`;

async function roundState(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(adminUrl('/api/round'));
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Runs a command to completion and reports its exit code, output hidden. */
function run(command: string, args: string[]): Promise<number> {
  const proc = spawn(command, args, { cwd: ROOT, shell: true, stdio: 'ignore' });
  return new Promise<number>((res) => proc.on('exit', (c) => res(c ?? 1)));
}

/** Is the Docker engine answering? `docker info` is the honest probe. */
async function dockerUp(): Promise<boolean> {
  return (await run('docker', ['info'])) === 0;
}

/**
 * Starts Docker Desktop and waits for its engine.
 *
 * ⚠ This is the failure that made the launcher "not work any more": Docker
 * Desktop does not start with Windows on this machine, so after every reboot
 * `docker compose up` failed and the launcher stopped at "start Docker
 * Desktop and try again" — a message that reads as broken when the thing you
 * double-clicked exists to spare you exactly that. The engine takes half a
 * minute or more to come up after the window appears, so this waits on
 * `docker info` rather than on the process.
 */
async function ensureDocker(): Promise<boolean> {
  if (await dockerUp()) return true;
  say('Docker is not running. Starting Docker Desktop…');
  if (process.platform === 'win32') {
    const exe = resolve(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
    if (!existsSync(exe)) {
      say(`Docker Desktop is not installed at ${exe}.`);
      say('Install it from https://www.docker.com/products/docker-desktop and try again.');
      return false;
    }
    // PowerShell's Start-Process rather than cmd's `start`: the latter's
    // quoting through a shell shim is exactly the kind of thing that fails
    // silently, and this path was measured to work on the machine.
    spawn('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}'`], {
      stdio: 'ignore', detached: true, windowsHide: true,
    }).unref();
  } else {
    spawn('open', ['-a', 'Docker'], { stdio: 'ignore', detached: true }).unref();
  }
  // ⚠ Four minutes, reported as it goes. The engine can take well over two
  // on a cold start (measured here: the window appears at once and `docker
  // info` answers a good while later), and a launcher that gives up first
  // then tells you to do what it just did.
  const began = Date.now();
  const until = began + 240_000;
  let told = 0;
  while (Date.now() < until) {
    if (await dockerUp()) {
      say('Docker is up.');
      return true;
    }
    const waited = Math.round((Date.now() - began) / 1000);
    if (waited >= told + 30) {
      told = waited;
      say(`  still waiting for the Docker engine (${waited}s)…`);
    }
    await sleep(3000);
  }
  say('Docker Desktop did not come up within four minutes. Open it yourself and run this again.');
  return false;
}

async function ensureDatabase(): Promise<boolean> {
  if (await portOpen(5433)) return true;
  if (!(await ensureDocker())) return false;
  say('Postgres is not up on 5433. Starting it with Docker…');
  const code = await run('docker', ['compose', 'up', '-d', 'db']);
  if (code !== 0) {
    say('Docker would not start the database. Run `npm run db:up` to see why.');
    return false;
  }
  // The container answers before Postgres does; the server's own migration
  // step is what would fail, and it fails opaquely.
  return waitForPort(5433, 'the database', 60_000);
}

async function startTools(): Promise<void> {
  if (running('tools')) return say('The authoring server is already running.');
  if (await portOpen(cfg.toolsPort)) {
    say(`Something is already listening on ${cfg.toolsPort}; the authoring server may be up already.`);
    return;
  }
  say('Starting the authoring server…');
  start('tools', 'npm', ['run', 'dev:tools'], { STUDIO_PORT: String(cfg.toolsPort) });
  if (await waitForPort(cfg.toolsPort, 'the authoring server', 30_000)) {
    say(`Authoring server up. The tool is at http://localhost:${cfg.clientPort}/creation-tool.html`);
  }
}

/** Opens the game in the default browser, once. Windows `start`, or `open`. */
function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { shell: true, stdio: 'ignore', detached: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

async function startServer(): Promise<void> {
  if (running('server')) return say('The server is already running.');
  if (!cfg.databaseUrl) {
    say('DATABASE_URL is not set. Copy .env.example to .env first.');
    return;
  }
  if (!(await ensureDatabase())) return;
  if (await portOpen(cfg.port)) {
    say(`Something is already listening on ${cfg.port}. Close it, or change PORT in .env.`);
    return;
  }
  say('Starting the game server…');
  start('server', 'npx', ['tsx', 'server/src/index.ts'], {
    DATABASE_URL: cfg.databaseUrl,
    PORT: String(cfg.port),
    ADMIN_PORT: String(cfg.adminPort),
    ROUND_MODE: '1',
    ROUND_MIN_CAST: String(cfg.minCast),
    ...(cfg.area ? { DEFAULT_AREA_ID: cfg.area } : {}),
  });
  if (await waitForPort(cfg.adminPort, 'the server')) {
    say(`Server up. Game on ws://localhost:${cfg.port}, admin on http://localhost:${cfg.adminPort}`);
  }
}

async function startClient(): Promise<void> {
  if (running('client')) return say('The client is already running.');
  if (await portOpen(cfg.clientPort)) {
    say(`Something is already listening on ${cfg.clientPort}; the client may be up already.`);
    return;
  }
  say('Starting the client…');
  start('client', 'npm', ['run', 'dev:client']);
  // Vite picks the next free port when its own is taken and says so in its
  // output; the relayed lines above are the honest answer, so this only
  // reports the common case.
  if (await waitForPort(cfg.clientPort, 'the client', 20_000)) {
    say(`Client up: http://localhost:${cfg.clientPort}`);
  }
  say('Log in there and point it at ws://localhost:' + cfg.port);
}

let opened = false;

async function restartRound(): Promise<void> {
  if (!(await portOpen(cfg.adminPort))) {
    say('The server is not running. Start it first.');
    return;
  }
  say('Restarting the round…');
  try {
    const res = await fetch(adminUrl('/api/dm/round/restart'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) {
      say(`Refused: ${body.error ?? 'unknown reason'}`);
      return;
    }
    say('Round reset. Gear stripped, memories wiped; it starts again once the cast is big enough.');
  } catch (err) {
    say(`Could not reach the admin server: ${(err as Error).message}`);
  }
}

async function addBots(count: number): Promise<void> {
  if (!(await portOpen(cfg.port))) {
    say('The server is not running. Start it first.');
    return;
  }
  say(`Sending in ${count} bot${count === 1 ? '' : 's'}…`);
  // Each batch gets its own tag so repeated runs do not collide on account or
  // character names — the failure that reads as a mysterious timeout.
  const tag = String(Date.now() % 100000);
  start(`bots:${tag}`, 'npx', [
    'tsx', 'sim/src/run-bots.ts',
    '--count', String(count),
    '--url', `ws://localhost:${cfg.port}`,
    '--tag', tag,
  ]);
}

async function status(): Promise<void> {
  const db = await portOpen(5433);
  const server = await portOpen(cfg.port);
  const client = await portOpen(cfg.clientPort);
  const tools = await portOpen(cfg.toolsPort);
  const round = server ? await roundState() : null;
  const bots = children.filter((c) => c.name.startsWith('bots:')).length;
  line();
  say(`database   ${db ? 'up' : 'down'}   (5433)`);
  say(`server     ${server ? 'up' : 'down'}   (ws ${cfg.port}, admin ${cfg.adminPort})`);
  say(`client     ${client ? 'up' : 'down'}   (http ${cfg.clientPort})`);
  say(`tool       ${tools ? 'up' : 'down'}   (http ${cfg.toolsPort})`);
  say(`bot batches ${bots}`);
  if (round) {
    const phase = String(round.phase);
    const cast = `${round.cast}/${round.minCast}`;
    const clock = round.phase === 'running'
      ? `  ${String(round.hour).padStart(2, '0')}:00 ${round.night ? 'night' : 'day'}`
      : '';
    say(`round      ${phase}  cast ${cast}${clock}`);
    if (phase === 'lobby' && Number(round.cast) < Number(round.minCast)) {
      say(`           waiting for ${Number(round.minCast) - Number(round.cast)} more — option 4 fills it`);
    }
  }
  line();
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const dim = (s: string): string => (useColour ? `[2m${s}[0m` : s);
const warm = (s: string): string => (useColour ? `[38;5;173m${s}[0m` : s);

function say(msg: string): void {
  process.stdout.write(`${warm('·')} ${msg}\n`);
}

function line(): void {
  process.stdout.write(dim('  ────────────────────────────────────────────\n'));
}

function menu(): void {
  process.stdout.write(`
${warm('REGNUM CONFRACTUM')} ${dim('— launcher')}

  ${warm('1')}  Start everything    ${dim('Docker, database, server, client and the authoring tool')}
  ${warm('2')}  Start the server    ${dim('only')}
  ${warm('3')}  Start the client    ${dim('only')}
  ${warm('8')}  Start the tool      ${dim('the authoring server only')}
  ${warm('4')}  Add bots            ${dim('4 3  sends three; 4 alone sends three')}
  ${warm('5')}  Restart the round   ${dim('ends this one, wipes gear and memory')}
  ${warm('6')}  Status
  ${warm('7')}  Stop everything
  ${warm('q')}  Quit                ${dim('stops everything on the way out')}

`);
}

let closing = false;
let rl: ReturnType<typeof createInterface> | null = null;

/**
 * The interface is created only once we are ready to read.
 *
 * readline starts consuming stdin the moment it exists, and lines that
 * arrive before a `question` is pending are DROPPED. Interactively that never
 * shows, because a person types after the prompt; but it silently ate the
 * first instruction of `echo 2 | npm run play`, which is the form worth
 * keeping working — a launcher you cannot script is a launcher you cannot
 * test.
 */
function ask(): void {
  if (closing) return;
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    // End of input — a finished pipe, or Ctrl-D — means quit. Asking again
    // after that throws ERR_USE_AFTER_CLOSE, which is a stack trace where a
    // goodbye belongs.
    rl.on('close', () => {
      if (closing) return;
      closing = true;
      stopAll();
      setTimeout(() => process.exit(0), 200);
    });
  }
  rl.question(`${warm('>')} `, (answer) => {
    void handle(answer.trim()).then(() => ask());
  });
}

async function handle(input: string): Promise<void> {
  const [choice, arg] = input.split(/\s+/);
  switch (choice) {
    case '1':
      await startServer();
      if (running('server')) await startClient();
      await startTools();
      await status();
      // Straight to the login screen. Once per launcher session, so a second
      // "1" after a stop does not open a second tab.
      if (!opened && (await portOpen(cfg.clientPort))) {
        opened = true;
        openBrowser(`http://localhost:${cfg.clientPort}/`);
      }
      return;
    case '2':
      return startServer();
    case '3':
      return startClient();
    case '8':
      return startTools();
    case '4':
      return addBots(Math.max(1, Math.min(12, Number(arg ?? '3') || 3)));
    case '5':
      return restartRound();
    case '6':
      return status();
    case '7':
      stopAll();
      say('Stopped.');
      return;
    case 'q':
    case 'quit':
    case 'exit':
      closing = true;
      stopAll();
      say('Goodbye.');
      rl?.close();
      // Give the tree-kills a moment to land before the process leaves.
      setTimeout(() => process.exit(0), 400);
      return;
    case '':
      menu();
      return;
    default:
      say(`Not a choice. Press Enter for the menu.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

process.on('SIGINT', () => {
  closing = true;
  stopAll();
  process.exit(0);
});

menu();
void status().then(ask);
