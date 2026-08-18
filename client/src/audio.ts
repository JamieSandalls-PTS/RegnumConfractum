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

  dispose(): void {
    this.ctx?.close().catch(() => { /* already closed */ });
    this.ctx = null;
  }
}
