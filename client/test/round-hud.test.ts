import { describe, expect, it } from 'vitest';
import {
  RoundHud,
  formatClock,
  formatOutcome,
  formatPhase,
  formatRemaining,
  type RoundHudElements,
} from '../src/game/round-hud';

/**
 * The round HUD, tested headlessly (D-114). The formatters are the easy half;
 * the half worth testing is the objective card, because this panel is the
 * only place the antagonist's brief is ever rendered and a leak here would
 * not show up in any server test.
 */

/** A DOM stand-in — enough of Element for the HUD, and nothing more. */
function fakeElement() {
  const classes = new Set<string>(['hidden']);
  return {
    textContent: '',
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      toggle: (c: string, on?: boolean) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    _classes: classes,
  };
}

function harness() {
  const els = {
    root: fakeElement(), phase: fakeElement(), clock: fakeElement(), cast: fakeElement(),
    objective: fakeElement(), objectiveName: fakeElement(), objectiveBrief: fakeElement(),
    ending: fakeElement(), endingTitle: fakeElement(), endingBody: fakeElement(),
  };
  return { els, hud: new RoundHud(els as unknown as RoundHudElements) };
}

const state = (over: Partial<Parameters<RoundHud['onState']>[0]> = {}) => ({
  t: 'round_state' as const,
  phase: 'running' as const,
  cast: 4,
  minCast: 3,
  remainingTicks: 6000,
  hour: 14,
  night: false,
  ...over,
});

describe('formatting', () => {
  it('counts the round down in minutes and seconds', () => {
    expect(formatRemaining(6000)).toBe('10:00'); // 10Hz
    expect(formatRemaining(95)).toBe('0:10');
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(null)).toBe('—');
  });

  it('shows the compressed clock with a sun or a moon', () => {
    expect(formatClock(14, false)).toBe('☀ 14:00');
    expect(formatClock(22, true)).toBe('☾ 22:00');
    expect(formatClock(24, false)).toBe('☀ 00:00'); // wraps
  });

  it('tells the lobby how many more are wanted', () => {
    expect(formatPhase(state({ phase: 'lobby', cast: 1 }))).toBe('waiting — 1/3');
    expect(formatPhase(state({ phase: 'lobby', cast: 3 }))).toBe('gathering…');
    expect(formatPhase(state())).toBe('10:00');
  });

  it('describes an ending without ever congratulating anyone (D-303)', () => {
    // A round ends; it does not grade. No wording may reward the cast for
    // having been right about who to accuse.
    const endings = (['antagonist_dead', 'cast_wiped', 'objective_complete', 'time_expired', 'abandoned'] as const)
      .map((outcome) => formatOutcome({
        t: 'round_ended', outcome, winner: 'cast', objectiveName: 'x',
        antagonistName: 'y', xpBanked: 0, survived: true,
      }));
    for (const text of endings) {
      expect(text.length).toBeGreaterThan(0);
      expect(text.toLowerCase()).not.toMatch(/win|won|victor|congratul|well done|correct/);
    }
  });
});

describe('the objective card', () => {
  it('stays hidden for a player with no objective, and holds no text', () => {
    const { els, hud } = harness();
    hud.onRole({ t: 'round_role', antagonist: false, objective: null });
    expect(els.objective.classList.contains('hidden')).toBe(true);
    // An empty-but-present card would be a tell to anyone glancing across.
    expect(els.objectiveName.textContent).toBe('');
    expect(els.objectiveBrief.textContent).toBe('');
    expect(hud.isAntagonist()).toBe(false);
  });

  it('shows the brief only to the one who was given it', () => {
    const { els, hud } = harness();
    hud.onRole({
      t: 'round_role',
      antagonist: true,
      objective: { id: 'silence-the-keeper', name: 'Silence the Keeper', brief: 'He must not see morning.' },
    });
    expect(els.objective.classList.contains('hidden')).toBe(false);
    expect(els.objectiveBrief.textContent).toBe('He must not see morning.');
    expect(hud.isAntagonist()).toBe(true);
  });

  it('is torn down when the next round opens', () => {
    const { els, hud } = harness();
    hud.onRole({
      t: 'round_role', antagonist: true,
      objective: { id: 'o', name: 'N', brief: 'secret orders' },
    });
    hud.onState(state({ phase: 'lobby', remainingTicks: null }));
    // Nothing from the last round may survive into the next one — the brief
    // above belonged to a round that is over.
    expect(els.objective.classList.contains('hidden')).toBe(true);
    expect(els.objectiveBrief.textContent).toBe('');
    expect(hud.isAntagonist()).toBe(false);
  });

  it('hides the objective the moment the round resolves', () => {
    const { els, hud } = harness();
    hud.onRole({
      t: 'round_role', antagonist: true,
      objective: { id: 'o', name: 'The Name in the Ledger', brief: 'kill them' },
    });
    hud.onEnded({
      t: 'round_ended', outcome: 'antagonist_dead', winner: 'cast',
      objectiveName: 'The Name in the Ledger', antagonistName: 'Torvald',
      xpBanked: 0, survived: false,
    });
    expect(els.objective.classList.contains('hidden')).toBe(true);
    expect(els.ending.classList.contains('hidden')).toBe(false);
    expect(els.endingBody.textContent).toContain('Torvald');
  });

  it('tells the dead they banked nothing (D-524)', () => {
    const { els, hud } = harness();
    hud.onEnded({
      t: 'round_ended', outcome: 'time_expired', winner: 'cast',
      objectiveName: 'o', antagonistName: 'Someone', xpBanked: 0, survived: false,
    });
    expect(els.endingBody.textContent).toContain('Nothing of what you earned came home');
  });
});

describe('the clock panel', () => {
  it('marks night so the player can see the danger has changed (D-527)', () => {
    const { els, hud } = harness();
    hud.onState(state({ night: true, hour: 20 }));
    expect(els.root.classList.contains('night')).toBe(true);
    hud.onState(state({ night: false, hour: 8 }));
    expect(els.root.classList.contains('night')).toBe(false);
  });

  it('shows no clock outside a running round', () => {
    const { els, hud } = harness();
    hud.onState(state({ phase: 'lobby', remainingTicks: null }));
    expect(els.clock.textContent).toBe('');
    expect(els.cast.textContent).toBe('');
  });
});
