import {
  LOUDNESS_TARGETS,
  findSegments,
  measureLoudness,
  normalisationGain,
  type SoundCueDef,
} from '@rc/shared';

/**
 * Sampled sound (D-541): the stakeholder's drop, played by the game.
 *
 * The procedural layer in `audio.ts` stays exactly as it was — hearth
 * crackle, room tone, and the anonymous through-a-wall combat cue (D-531).
 * This module is everything that comes from a file.
 *
 * **Two playback paths, chosen by size rather than by taste.**
 *
 * *Effects* are short, so they are fetched, decoded, measured and normalised
 * once, then played from memory with an exact gain. Files marked `split` are
 * cut into their separate takes at this point — `maledeath` alone is nineteen
 * death cries in one file — and each take is normalised on its own, because
 * takes within one file differ by as much as 5×.
 *
 * *Beds and music* are minutes long: the menu track decodes to roughly half a
 * gigabyte, and the ambience beds to tens of megabytes each. Those are
 * STREAMED through an `<audio>` element, which means their samples are never
 * all in memory at once and therefore cannot be measured up front. They are
 * normalised instead by a slow automatic gain that reads the signal through
 * an analyser and eases toward the same category target the effects use. It
 * converges in a second or two and is inaudible while it does — which is
 * acceptable for a bed and would not be for a death cry, hence the split.
 *
 * Browsers refuse audio before a user gesture, so everything here is a silent
 * no-op until `attach` is called with a running context.
 */

/** Where the prepared files live, written by tools/src/build-audio.py. */
const AUDIO_ROOT = '/audio';

interface Variant {
  buffer: AudioBuffer;
  /** Seconds into the buffer where this take starts. */
  offset: number;
  duration: number;
  /** Normalisation × the cue's authored trim. */
  gain: number;
}

/** Per-category user volume, on top of normalisation. */
export interface Volumes {
  master: number;
  effects: number;
  ambience: number;
  music: number;
}

export const DEFAULT_VOLUMES: Volumes = {
  master: 0.8,
  effects: 1,
  ambience: 0.7,
  music: 0.5,
};

export class SoundBank {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private cues = new Map<string, SoundCueDef>();
  private loaded = new Map<string, Variant[]>();
  private loading = new Map<string, Promise<Variant[]>>();
  private volumes: Volumes = { ...DEFAULT_VOLUMES };

  /** The bed currently playing, and the one fading out behind it. */
  private bed: Bed | null = null;
  private bedCueId: string | null = null;
  private music: Bed | null = null;

  constructor(cues: SoundCueDef[]) {
    for (const cue of cues) this.cues.set(cue.id, cue);
  }

  /**
   * Adopts an existing graph rather than building one: a second
   * AudioContext would double the hardware latency budget for no reason,
   * and browsers cap how many a page may hold open.
   */
  attach(ctx: AudioContext, destination: AudioNode): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.volumes.master;
    this.out.connect(destination);
  }

  get ready(): boolean {
    return this.ctx !== null;
  }

  setVolumes(v: Partial<Volumes>): void {
    this.volumes = { ...this.volumes, ...v };
    if (this.out && this.ctx) {
      this.out.gain.setTargetAtTime(this.volumes.master, this.ctx.currentTime, 0.05);
    }
    this.bed?.setVolume(this.volumes.ambience);
    this.music?.setVolume(this.volumes.music);
  }

  get volumeSettings(): Volumes {
    return { ...this.volumes };
  }

  // --- effects -------------------------------------------------------------

  /**
   * Decodes, normalises and (where asked) splits a cue. Cached, and safe to
   * call repeatedly — concurrent calls share one fetch.
   */
  private async loadEffect(cue: SoundCueDef): Promise<Variant[]> {
    const cached = this.loaded.get(cue.id);
    if (cached) return cached;
    const inFlight = this.loading.get(cue.id);
    if (inFlight) return inFlight;

    const ctx = this.ctx!;
    const job = (async (): Promise<Variant[]> => {
      const variants: Variant[] = [];
      for (const file of cue.files) {
        try {
          const res = await fetch(`${AUDIO_ROOT}/${file}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
          const samples = buffer.getChannelData(0);
          // One take, or several separated by silence. `findSegments` always
          // returns at least one, so both paths are the same code.
          const segments = cue.split
            ? findSegments(samples, buffer.sampleRate)
            : [{ start: 0, end: samples.length }];
          for (const seg of segments) {
            const slice = samples.subarray(seg.start, seg.end);
            const gain = normalisationGain(measureLoudness(slice), 'effect') * cue.trim;
            variants.push({
              buffer,
              offset: seg.start / buffer.sampleRate,
              duration: (seg.end - seg.start) / buffer.sampleRate,
              gain,
            });
          }
        } catch (err) {
          // A missing or undecodable file must not take the game down with
          // it. CI already fails on a cue pointing at a file that is not
          // there; this is the case where the browser cannot decode one.
          console.warn(`sound: ${cue.id} could not load ${file}`, err);
        }
      }
      this.loaded.set(cue.id, variants);
      this.loading.delete(cue.id);
      return variants;
    })();
    this.loading.set(cue.id, job);
    return job;
  }

  /** Warms a cue so the first play is not late. Fire and forget. */
  preload(cueId: string): void {
    const cue = this.cues.get(cueId);
    if (!this.ctx || !cue || cue.status !== 'live' || cue.kind !== 'effect') return;
    void this.loadEffect(cue);
  }

  /**
   * Plays one take of a cue.
   *
   * `pan` is -1..1 and `distance` is in tiles; both are cosmetic. Nothing
   * here can make a sound audible that the server did not already deliver —
   * a modified client cannot widen its hearing, because what it hears is
   * decided by which messages arrive (D-531).
   */
  play(cueId: string, opts: { pan?: number; distance?: number; volume?: number } = {}): void {
    const cue = this.cues.get(cueId);
    if (!this.ctx || !this.out || !cue || cue.status !== 'live') return;
    void this.loadEffect(cue).then((variants) => {
      if (variants.length === 0) return;
      const ctx = this.ctx!;
      const v = variants[Math.floor(Math.random() * variants.length)]!;
      // Distance is quietness and dullness together — the same rule the
      // procedural combat cue uses, so the two layers agree.
      const dist = Math.max(0, opts.distance ?? 0);
      const near = Math.max(0, 1 - dist / 24);
      if (near <= 0.001) return;
      const src = ctx.createBufferSource();
      src.buffer = v.buffer;
      const g = ctx.createGain();
      g.gain.value = v.gain * this.volumes.effects * (opts.volume ?? 1) * near * near;
      let node: AudioNode = g;
      if (dist > 2) {
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 1200 + 7000 * near;
        g.connect(tone);
        node = tone;
      }
      if (opts.pan !== undefined && opts.pan !== 0) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
        node.connect(pan).connect(this.out!);
      } else {
        node.connect(this.out!);
      }
      src.connect(g);
      src.start(0, v.offset, v.duration);
    });
  }

  // --- beds and music ------------------------------------------------------

  /**
   * Crossfades to a new ambience bed. Passing the same cue twice does
   * nothing, so this can be called on every snapshot without restarting the
   * bed each time a player walks through a door and back.
   */
  setAmbience(cueId: string | null): void {
    if (!this.ctx || !this.out) return;
    if (cueId === this.bedCueId) return;
    this.bedCueId = cueId;
    const previous = this.bed;
    previous?.fadeOutAndStop(1.4);
    this.bed = null;
    if (!cueId) return;
    const cue = this.cues.get(cueId);
    if (!cue || cue.status !== 'live' || cue.kind !== 'ambience') return;
    this.bed = new Bed(this.ctx, this.out, cue, 'ambience', this.volumes.ambience);
    this.bed.start(1.4);
  }

  /** The login/creation screen's track. Stops the moment the world opens. */
  setMusic(cueId: string | null): void {
    if (!this.ctx || !this.out) return;
    if (!cueId) {
      this.music?.fadeOutAndStop(1.2);
      this.music = null;
      return;
    }
    if (this.music) return;
    const cue = this.cues.get(cueId);
    if (!cue || cue.status !== 'live' || cue.kind !== 'music') return;
    this.music = new Bed(this.ctx, this.out, cue, 'music', this.volumes.music);
    this.music.start(2.0);
  }

  /**
   * What the streamed layers are doing. Sound is the one system that leaves
   * no visual trace, so this exists to be asserted against — and it asks the
   * beds themselves rather than the DOM, because `new Audio()` never appends
   * an element and querying the document finds nothing however well it plays.
   */
  streams(): { cue: string; kind: string; playing: boolean; time: number; gain: number }[] {
    const out = [];
    if (this.bed) out.push(this.bed.report());
    if (this.music) out.push(this.music.report());
    return out;
  }

  /**
   * What each loaded cue turned into: how many takes came out of it and at
   * what gains. This is how the splitter and the normaliser are checked in
   * the real decoder rather than only against the WAVs a test can read.
   */
  loadedCues(): { id: string; takes: number; seconds: number[]; gains: number[] }[] {
    return [...this.loaded.entries()].map(([id, variants]) => ({
      id,
      takes: variants.length,
      seconds: variants.map((v) => Number(v.duration.toFixed(2))),
      gains: variants.map((v) => Number(v.gain.toFixed(2))),
    }));
  }

  /** Per-frame: keeps the automatic gain on the streamed layers moving. */
  update(): void {
    this.bed?.update();
    this.music?.update();
  }

  dispose(): void {
    this.bed?.fadeOutAndStop(0.1);
    this.music?.fadeOutAndStop(0.1);
    this.bed = null;
    this.music = null;
    this.bedCueId = null;
  }
}

/**
 * A streamed loop with automatic gain.
 *
 * The AGC is what "normalised" means for a file too long to decode. It reads
 * the playing signal through an analyser and walks the gain toward the same
 * category target the effects are normalised to, slowly enough that it is
 * heard as a level rather than as a fade. Beds vary in level over their own
 * length, which is why this eases continuously instead of measuring once.
 */
class Bed {
  private el: HTMLAudioElement;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private probe: Float32Array<ArrayBuffer>;
  private measured = 1;
  private volume: number;
  private stopped = false;
  private lastCheck = 0;
  private cueId: string;

  constructor(
    private ctx: AudioContext,
    destination: AudioNode,
    cue: SoundCueDef,
    private category: 'ambience' | 'music',
    volume: number,
  ) {
    this.volume = volume;
    this.cueId = cue.id;
    this.el = new Audio(`${AUDIO_ROOT}/${cue.files[0]!}`);
    this.el.loop = true;
    this.el.crossOrigin = 'anonymous';
    this.el.preload = 'auto';
    const src = ctx.createMediaElementSource(this.el);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.probe = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    // The trim is authored; `measured` is the automatic half.
    this.measured = cue.trim;
    src.connect(this.analyser).connect(this.gain).connect(destination);
  }

  start(fadeSeconds: number): void {
    void this.el.play().catch(() => {
      // Autoplay refused — the caller enables sound from a gesture, so this
      // only happens if the gesture was not a real one. Silence is correct.
    });
    this.gain.gain.setTargetAtTime(this.target(), this.ctx.currentTime, fadeSeconds / 3);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (!this.stopped) {
      this.gain.gain.setTargetAtTime(this.target(), this.ctx.currentTime, 0.1);
    }
  }

  private target(): number {
    return this.measured * this.volume;
  }

  /** Eases the measured half toward the category's loudness target. */
  update(): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    if (now - this.lastCheck < 0.25) return;
    this.lastCheck = now;
    this.analyser.getFloatTimeDomainData(this.probe);
    let sum = 0;
    for (let i = 0; i < this.probe.length; i++) sum += this.probe[i]! * this.probe[i]!;
    const rms = Math.sqrt(sum / this.probe.length);
    // Silence tells us nothing — a gap in the bed must not send the gain
    // climbing, or the next loud passage arrives at full blast.
    if (rms < 0.002) return;
    const wanted = LOUDNESS_TARGETS[this.category] / rms;
    const clamped = Math.min(4, Math.max(0.15, wanted));
    this.measured += (clamped - this.measured) * 0.08;
    this.gain.gain.setTargetAtTime(this.target(), now, 0.4);
  }

  report(): { cue: string; kind: string; playing: boolean; time: number; gain: number } {
    return {
      cue: this.cueId,
      kind: this.category,
      playing: !this.el.paused && !this.stopped,
      time: Number(this.el.currentTime.toFixed(2)),
      gain: Number(this.gain.gain.value.toFixed(3)),
    };
  }

  fadeOutAndStop(seconds: number): void {
    if (this.stopped) return;
    this.stopped = true;
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, seconds / 3);
    window.setTimeout(() => {
      this.el.pause();
      this.el.src = '';
    }, seconds * 1000 + 200);
  }
}
