import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RoundHud,
  botsToFill,
  formatClock,
  formatLobby,
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

/** A button stand-in: the HUD sets `disabled` and listens for clicks. */
function fakeButton() {
  const el = fakeElement() as ReturnType<typeof fakeElement> & {
    disabled: boolean;
    _click: () => void;
  };
  let handler = (): void => {};
  el.disabled = false;
  (el as unknown as { addEventListener: (t: string, f: () => void) => void })
    .addEventListener = (_t, f) => { handler = f; };
  el._click = () => handler();
  return el;
}

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
    lobby: fakeElement(), lobbyNote: fakeElement(),
    botAdd: fakeButton(), botFill: fakeButton(), botClear: fakeButton(),
  };
  const sent: unknown[] = [];
  const hud = new RoundHud(els as unknown as RoundHudElements, (m) => sent.push(m));
  return { els, hud, sent };
}

const state = (over: Partial<Parameters<RoundHud['onState']>[0]> = {}) => ({
  t: 'round_state' as const,
  phase: 'running' as const,
  cast: 4,
  minCast: 3,
  remainingTicks: 6000,
  hour: 14,
  night: false,
  graceTicks: 0,
  bots: 0,
  botsAllowed: true,
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

  it('shows the dawn truce instead of the countdown while it holds (D-536)', () => {
    // While the truce runs the round's clock is stopped, so showing the
    // countdown would be a lie — it is not moving.
    expect(formatPhase(state({ graceTicks: 600 }))).toBe('dawn · 1:00');
    expect(formatPhase(state({ graceTicks: 75 }))).toBe('dawn · 0:08');
    expect(formatPhase(state({ graceTicks: 0 }))).toBe('10:00');
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

describe('filling the cast from the lobby (D-607)', () => {
  it('offers the controls only where they could do something', () => {
    expect(formatLobby(state({ phase: 'lobby', cast: 1 })).show).toBe(true);
    expect(formatLobby(state({ phase: 'resolved' })).show).toBe(true);
    // ⚠ Never while a round runs. The panel exists to get one STARTED, and
    // a "fill the cast" button during play would be a way to walk companions
    // into a live round from the HUD.
    expect(formatLobby(state({ phase: 'running' })).show).toBe(false);
    // ⚠ And never on a server that forbids them, whatever the phase. A
    // control the client draws and the server refuses is worse than no
    // control: it reads as broken rather than as disallowed.
    expect(formatLobby(state({ phase: 'lobby', botsAllowed: false })).show).toBe(false);
  });

  it('says how many are bots and never which (D-521)', () => {
    const note = formatLobby(state({ phase: 'lobby', cast: 3, bots: 2 })).note;
    expect(note).toContain('2 are bots');
    // A bot can be dealt the objective like anybody else, so a name here
    // would hand the round away.
    expect(note).not.toMatch(/Dorn|Merrow|Ulf/);
  });

  it('counts the shortfall, and asks for at least one', () => {
    expect(botsToFill(state({ phase: 'lobby', cast: 1, minCast: 3 }))).toBe(2);
    expect(botsToFill(state({ phase: 'lobby', cast: 0, minCast: 3 }))).toBe(3);
    // Already enough: the button still brings somebody, rather than being a
    // control that silently does nothing.
    expect(botsToFill(state({ phase: 'lobby', cast: 5, minCast: 3 }))).toBe(1);
  });

  it('cannot send home what is not there', () => {
    expect(formatLobby(state({ phase: 'lobby', bots: 0 })).canClear).toBe(false);
    expect(formatLobby(state({ phase: 'lobby', bots: 1 })).canClear).toBe(true);
  });

  it('asks the server for the shortfall when told to fill', () => {
    const { els, hud, sent } = harness();
    hud.onState(state({ phase: 'lobby', cast: 1, minCast: 3 }));
    els.botFill._click();
    expect(sent).toEqual([{ t: 'add_bots', count: 2 }]);
    els.botAdd._click();
    expect(sent[1]).toEqual({ t: 'add_bots', count: 1 });
    els.botClear._click();
    expect(sent[2]).toEqual({ t: 'remove_bots' });
  });
});

describe('the controls can actually be clicked (D-609)', () => {
  /**
   * ⚠ The bug this pins was invisible to every test above, and that is the
   * point of it. The HUD is `pointer-events: none` — correctly, because it
   * floats over the world and must not swallow a click meant for the ground.
   * Everything in it had always been read-only, so the first controls put
   * inside it were unclickable while looking completely normal: styled,
   * enabled, even hovering. Hit-testing in the browser found `#overlay`
   * receiving every click aimed at a button.
   *
   * ⚠ The tests above cannot see it because they call the handler directly
   * on a fake element. Dispatching a handler proves the handler; it says
   * nothing about whether a person can reach it.
   */
  const html = readFileSync(
    fileURLToPath(new URL('../index.html', import.meta.url)),
    'utf8',
  );
  /** The declarations inside one `#id { ... }` rule. */
  const ruleFor = (selector: string): string => {
    const at = html.indexOf(`${selector} {`);
    if (at < 0) return '';
    return html.slice(at, html.indexOf('}', at));
  };

  it('⚠ opts the lobby panel back IN to pointer events', () => {
    // The container really is click-through — if that ever changes this test
    // is testing nothing, so assert it rather than assume it.
    expect(ruleFor('#round-hud')).toContain('pointer-events: none');
    expect(ruleFor('#round-lobby')).toContain('pointer-events: auto');
  });

  it('leaves the read-only parts of the HUD click-through', () => {
    // ⚠ Only the panel opts in. The clock and the objective card sit over
    // the world for twenty-five minutes; making those solid would put a dead
    // rectangle in the middle of the screen that eats movement clicks.
    expect(ruleFor('#round-bar')).not.toContain('pointer-events');
    expect(ruleFor('#round-objective')).not.toContain('pointer-events');
  });
});
