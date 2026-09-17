import type { SoundCueDef } from '@rc/shared';
import { SoundBank } from '../sound';

/**
 * The cue editor's preview (D-635): a cue heard exactly as the game plays it.
 *
 * Nothing here decodes, normalises, splits or streams — it is the game's own
 * `SoundBank`, handed the cue as the FORM holds it (unsaved edits included),
 * so what the author hears is what a player will hear after Publish and not
 * the raw file. A `planned` cue is previewable: the point of the button is
 * to decide whether it should be live, so the copy the bank is given is
 * marked live whatever the form says.
 *
 * ⚠ One AudioContext, made on the first click. Browsers refuse audio before
 * a user gesture, and cap how many contexts a page may open, so it is built
 * lazily and kept. Each play builds a fresh bank for the cue — the bank
 * caches by id, and an author who changed the trim would otherwise hear the
 * version they had before.
 *
 * Effects play one take and end on their own; beds and music loop until
 * stopped, and this drives the bank's automatic gain from its own frame loop
 * because the tool's frame hooks belong to the tab on the STAGE, which sound
 * is not on.
 */
export interface PreviewReport {
  /** What is playing, or null. */
  cue: string | null;
  kind: string | null;
  /** For a file, which one; for a cue, null. */
  file: string | null;
  /** Effects: what the decoder made of the file(s). */
  takes: number | null;
  seconds: number[];
  gains: number[];
  /** Beds and music: the stream's position and the automatic gain. */
  time: number | null;
  gain: number | null;
  /** Set when the bank could make nothing of the file. */
  problem: string | null;
  /**
   * An effect that played to its end. The report stays so the line still
   * says what the decoder found — a swish is a third of a second, and a
   * line that blanks before anyone can read it has told them nothing.
   */
  ended: boolean;
}

const EMPTY: PreviewReport = {
  cue: null, kind: null, file: null, takes: null, seconds: [], gains: [],
  time: null, gain: null, problem: null, ended: false,
};

export class SoundPreview {
  private ctx: AudioContext | null = null;
  private bank: SoundBank | null = null;
  private raf = 0;
  private lastTold = 0;
  private current: PreviewReport = { ...EMPTY };
  /** Called whenever the report changes; the form redraws its line from it. */
  onChange: (report: PreviewReport) => void = () => {};

  report(): PreviewReport {
    return { ...this.current };
  }

  get playing(): boolean {
    return this.current.cue !== null && !this.current.ended && this.current.problem === null;
  }

  /**
   * Plays `cue` as the game would. With `file`, plays that one file alone
   * under the cue's settings — so a cue with three files can be audited a
   * file at a time.
   */
  async play(cue: SoundCueDef, file?: string): Promise<PreviewReport> {
    this.stop();
    const ctx = this.context();
    if (ctx.state !== 'running') await ctx.resume();
    const copy: SoundCueDef = {
      ...cue,
      files: file ? [file] : [...cue.files],
      status: 'live',
    };
    const bank = new SoundBank([copy]);
    bank.attach(ctx, ctx.destination);
    this.bank = bank;
    this.current = { ...EMPTY, cue: cue.id, kind: cue.kind, file: file ?? null };
    if (copy.files.length === 0) {
      this.current.problem = 'no files to play';
      this.tell();
      return this.report();
    }
    if (cue.kind === 'effect') {
      const made = await bank.prepare(cue.id);
      if (this.bank !== bank) return this.report(); // stopped or replaced meanwhile
      if (!made || made.takes === 0) {
        this.current.problem = 'the browser could not decode it — see the console';
        this.tell();
        return this.report();
      }
      this.current.takes = made.takes;
      this.current.seconds = made.seconds;
      this.current.gains = made.gains;
      bank.play(cue.id);
      this.tell();
      // An effect ends on its own; say so after the longest take, keeping
      // the report on screen.
      const longest = Math.max(...made.seconds, 0.1);
      window.setTimeout(() => {
        if (this.bank !== bank) return;
        this.bank = null;
        this.current.ended = true;
        this.tell();
      }, longest * 1000 + 300);
      return this.report();
    }
    if (cue.kind === 'ambience') bank.setAmbience(cue.id);
    else bank.setMusic(cue.id);
    this.loop();
    this.tell();
    return this.report();
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.bank?.dispose();
    this.bank = null;
    if (this.current.cue !== null) {
      this.current = { ...EMPTY };
      this.tell();
    }
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** Keeps a bed's automatic gain moving and the report current. */
  private loop(): void {
    const step = (): void => {
      const bank = this.bank;
      if (!bank) return;
      bank.update();
      const now = performance.now();
      if (now - this.lastTold > 250) {
        this.lastTold = now;
        const stream = bank.streams()[0];
        if (stream) {
          this.current.time = stream.time;
          this.current.gain = stream.gain;
          this.tell();
        }
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private tell(): void {
    this.onChange(this.report());
  }
}

/** The report as one line for the form. */
export function describePreview(r: PreviewReport): string {
  if (r.problem) return `⚠ ${r.problem}`;
  if (r.cue === null) return '';
  const what = r.file ? `${r.file}` : r.cue;
  if (r.kind === 'effect') {
    const takes = r.takes === null ? 'decoding…' : `${r.takes} take${r.takes === 1 ? '' : 's'}`;
    const gains = r.gains.length ? ` · gains ${r.gains.map((g) => g.toFixed(2)).join(', ')}` : '';
    const seconds = r.seconds.length ? ` · ${r.seconds.map((x) => `${x.toFixed(2)}s`).join(', ')}` : '';
    return `${r.ended ? '✓ played' : '▶'} ${what}: ${takes}${seconds}${gains}`;
  }
  const where = r.time === null ? 'starting…' : `${r.time.toFixed(1)}s`;
  const gain = r.gain === null ? '' : ` · automatic gain ${r.gain.toFixed(2)}`;
  return `▶ ${what}: streaming, ${where}${gain}`;
}
