/**
 * Ambient sound (stakeholder request, 2026-08-17): entirely procedural —
 * no audio assets, everything synthesized into loop buffers at runtime, so
 * the repo stays asset-free and the sound is deterministic-ish per session.
 *
 * Two layers, both derived from the AREA DATA rather than a schema field:
 * - fire crackle, spatialised against the area's hearth tiles (nearest
 *   hearth drives loudness);
 * - room tone for 'interior'/'underground' lighting profiles (low filtered
 *   noise — a hush of air, not voices).
 *
 * Browsers refuse audio before a user gesture: call enable() from the
 * first pointer/key event; everything before that is a silent no-op.
 */

/**
 * Stereo placement per bearing. Coarse on purpose: the server only sends an
 * eight-point direction, and a convincing stereo image would imply more
 * precision than the message carries (D-531).
 */
const PAN_BY_BEARING: Record<string, number> = {
  e: 0.9, ne: 0.65, se: 0.65, w: -0.9, nw: -0.65, sw: -0.65, n: 0, s: 0, here: 0,
};

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crackle: GainNode | null = null;
  private room: GainNode | null = null;
  private hearths: { x: number; y: number }[] = [];
  private roomTone = false;
  private crackleTarget = 0;

  /** Build the audio graph. Safe to call repeatedly; first call wins. */
  enable(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    // --- fire crackle: sparse decaying noise pops in a 3s loop ----------
    const crackleBuf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const cd = crackleBuf.getChannelData(0);
    let rngState = 12345;
    const rnd = () => {
      rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
      return rngState / 0x7fffffff;
    };
    // A soft ember-bed hiss under the pops.
    for (let i = 0; i < cd.length; i++) cd[i] = (rnd() - 0.5) * 0.02;
    for (let pop = 0; pop < 46; pop++) {
      const at = Math.floor(rnd() * (cd.length - 4000));
      const len = 120 + Math.floor(rnd() * 2200);
      const amp = 0.12 + rnd() * 0.5;
      for (let i = 0; i < len; i++) {
        const env = Math.exp((-4 * i) / len);
        cd[at + i]! += (rnd() - 0.5) * amp * env;
      }
    }
    const crackleSrc = ctx.createBufferSource();
    crackleSrc.buffer = crackleBuf;
    crackleSrc.loop = true;
    const crackleFilter = ctx.createBiquadFilter();
    crackleFilter.type = 'bandpass';
    crackleFilter.frequency.value = 2400;
    crackleFilter.Q.value = 0.6;
    this.crackle = ctx.createGain();
    this.crackle.gain.value = 0;
    crackleSrc.connect(crackleFilter).connect(this.crackle).connect(this.master);
    crackleSrc.start();

    // --- room tone: brown noise through a low shelf, very quiet ---------
    const roomBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const rd = roomBuf.getChannelData(0);
    let acc = 0;
    for (let i = 0; i < rd.length; i++) {
      acc = (acc + (rnd() - 0.5) * 0.04) * 0.985;
      rd[i] = acc;
    }
    const roomSrc = ctx.createBufferSource();
    roomSrc.buffer = roomBuf;
    roomSrc.loop = true;
    const roomFilter = ctx.createBiquadFilter();
    roomFilter.type = 'lowpass';
    roomFilter.frequency.value = 420;
    this.room = ctx.createGain();
    this.room.gain.value = 0;
    roomSrc.connect(roomFilter).connect(this.room).connect(this.master);
    roomSrc.start();
    this.applyRoom();
  }

  /** Called on every area snapshot with the tiles that make sound. */
  setScene(hearths: { x: number; y: number }[], roomTone: boolean): void {
    this.hearths = hearths;
    this.roomTone = roomTone;
    this.applyRoom();
  }

  private applyRoom(): void {
    if (this.ctx && this.room) {
      this.room.gain.setTargetAtTime(this.roomTone ? 0.05 : 0, this.ctx.currentTime, 0.6);
    }
  }

  /** Per-frame: loudness of the crackle follows the nearest hearth. */
  update(px: number, py: number): void {
    if (!this.ctx || !this.crackle) return;
    let best = Infinity;
    for (const h of this.hearths) {
      const d = Math.hypot(h.x - px, h.y - py);
      if (d < best) best = d;
    }
    // Audible from ~12 tiles, full at 2; smoothed to avoid zipper noise.
    const target = best === Infinity ? 0 : 0.34 * Math.max(0, Math.min(1, (12 - best) / 10));
    if (Math.abs(target - this.crackleTarget) > 0.005) {
      this.crackleTarget = target;
      this.crackle.gain.setTargetAtTime(target, this.ctx.currentTime, 0.25);
    }
  }

  /**
   * The sound of fighting somewhere nearby (D-531) — synthesized, like
   * everything else here, so the repo stays asset-free.
   *
   * Steel: a bright inharmonic cluster with a fast decay, over a filtered
   * noise burst for the scuffle under it. Panned by BEARING and attenuated
   * by the server's near/far band, so the cue points you the same way the
   * text does.
   *
   * The client cannot widen this: the server decides who receives a `sound`
   * at all, so hearing range is not something a modified client can extend.
   * All this does is make an already-delivered message audible.
   */
  combat(bearing: string, distance: 'near' | 'far'): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const near = distance === 'near';
    const level = near ? 0.32 : 0.13;

    const out = ctx.createGain();
    out.gain.value = 1;
    // Distance is dullness as well as quietness — far-off fighting loses its
    // edge before it loses its volume.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = near ? 7000 : 1700;
    const pan = ctx.createStereoPanner();
    pan.pan.value = PAN_BY_BEARING[bearing] ?? 0;
    out.connect(tone).connect(pan).connect(this.master);

    // --- the ring of steel: three inharmonic partials, fast decay --------
    for (const [mult, amp, decay] of [[1, 1, 0.28], [2.76, 0.5, 0.2], [5.4, 0.22, 0.14]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 620 * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level * amp, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + decay + 0.02);
    }

    // --- the scuffle: a short bandpassed noise burst ---------------------
    const len = Math.floor(ctx.sampleRate * 0.18);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() - 0.5) * Math.exp((-6 * i) / len);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.value = level * 0.8;
    src.connect(bp).connect(ng).connect(out);
    src.start(now);
  }

  dispose(): void {
    this.ctx?.close().catch(() => { /* already closed */ });
    this.ctx = null;
  }
}
