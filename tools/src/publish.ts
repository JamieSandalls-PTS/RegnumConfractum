import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { type BuildStep, type ReloadTier, buildsFor, reloadTierFor, routeFor } from '@rc/shared';

/**
 * Publish: a save reaches the running game without anyone remembering how
 * (D-630).
 *
 * The authoring server knows every directory it wrote since the last publish.
 * The dependency map (`shared/src/pipeline.ts`) says which BUILDS those
 * invalidate and how the running server can take them. Publish runs only
 * those builds, in order, streaming their output, and then asks the game
 * server to re-read its content. What the tool shows is what is pending, and
 * what it prints is what happened — including "the game is not running", which
 * is an answer and not an error.
 *
 * ⚠ Two pending sets, cleared separately. A build that finished is finished
 * whether or not the game was up to be told; a reload that could not be
 * delivered stays pending until it can. Folding them into one flag is how a
 * built-but-unreloaded state would read as "nothing to do".
 */
export class Publisher {
  private readonly buildsPending = new Set<BuildStep>();
  private readonly reloadPending = new Set<string>();
  private running = false;

  constructor(private readonly root: string) {}

  /** A directory under `content/` was written or a file in it deleted. */
  note(dir: string): void {
    for (const b of buildsFor([dir])) this.buildsPending.add(b);
    const tier = routeFor(dir)?.tier;
    if (tier === 'hot' || tier === 'warm' || tier === 'restart') this.reloadPending.add(dir);
  }

  pending(): {
    builds: BuildStep[];
    reload: string[];
    tier: ReloadTier;
    running: boolean;
    game: { url: string };
  } {
    return {
      builds: this.orderedBuilds(),
      reload: [...this.reloadPending].sort(),
      tier: reloadTierFor(this.reloadPending),
      running: this.running,
      game: { url: this.adminUrl() },
    };
  }

  private orderedBuilds(): BuildStep[] {
    const order: BuildStep[] = ['characters', 'environment'];
    return order.filter((b) => this.buildsPending.has(b));
  }

  /**
   * Where the game's admin API is, read the way the server reads it: `.env`
   * in the repository root, real environment variables winning. A second
   * copy of the default is how `npm run bots` came to point at a port the
   * server was not on (D-628).
   */
  private env(): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      for (const line of fs.readFileSync(path.join(this.root, '.env'), 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && !(m[1]! in process.env)) out[m[1]!] = m[2]!;
      }
    } catch {
      // no .env — the defaults below apply
    }
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
    return out;
  }

  private adminUrl(): string {
    const env = this.env();
    return `http://127.0.0.1:${env['ADMIN_PORT'] ?? '8081'}`;
  }

  /** Run everything pending, streaming one JSON line per event to `res`. */
  async run(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    const emit = (event: Record<string, unknown>): void => {
      res.write(`${JSON.stringify(event)}\n`);
    };
    if (this.running) {
      emit({ error: 'a publish is already running' });
      res.end();
      return;
    }
    this.running = true;
    try {
      for (const step of this.orderedBuilds()) {
        emit({ step, started: true });
        const code = await this.build(step, (line) => emit({ step, line }));
        if (code !== 0) {
          emit({ step, failed: code });
          emit({ done: false, pending: this.pending() });
          return;
        }
        this.buildsPending.delete(step);
        emit({ step, finished: true });
      }
      if (this.reloadPending.size > 0) {
        const result = await this.reload();
        emit({ reload: result });
        if (result.ok) this.reloadPending.clear();
      } else {
        emit({ reload: { ok: true, skipped: 'nothing the server reads changed' } });
      }
      emit({ done: true, pending: this.pending() });
    } finally {
      this.running = false;
      res.end();
    }
  }

  private build(step: BuildStep, onLine: (line: string) => void): Promise<number> {
    return new Promise((resolve) => {
      // Through npm, so the script that runs is the one `package.json` names
      // and CI runs — not a second copy of the command here.
      const child = spawn(`npm run build:${step}`, { cwd: this.root, shell: true });
      let buf = '';
      const feed = (chunk: Buffer): void => {
        buf += chunk.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) onLine(l);
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('close', (code) => {
        if (buf.trim()) onLine(buf);
        resolve(code ?? 1);
      });
      child.on('error', (err) => {
        onLine(`could not start: ${err.message}`);
        resolve(1);
      });
    });
  }

  private async reload(): Promise<{ ok: boolean; [k: string]: unknown }> {
    const env = this.env();
    const url = `${this.adminUrl()}/api/dm/reload-content`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env['ADMIN_TOKEN'] ? { 'X-Admin-Token': env['ADMIN_TOKEN'] } : {}),
        },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        return { ok: false, error: body.error ?? `the game answered ${res.status}`, url };
      }
      return { ok: true, ...body, url };
    } catch (err) {
      return {
        ok: false,
        error: `the game server is not running at ${url} — start it and publish again, or it reads the files at its next start`,
        url,
        unreachable: true,
      };
    }
  }
}
