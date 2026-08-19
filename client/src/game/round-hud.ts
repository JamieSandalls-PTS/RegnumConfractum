import { TICK_RATE, type ServerMessage } from '@rc/shared';

/**
 * The round HUD (D-521): the clock, the cast, and — for exactly one player —
 * the objective.
 *
 * The formatting is pure and lives apart from the DOM so it can be tested
 * headlessly, which matters more here than it looks: this panel is the only
 * place the antagonist's brief is ever rendered, and a mistake that showed it
 * to the wrong player, or leaked it into a shared element, would not be
 * visible in any server test.
 */

export type RoundState = Extract<ServerMessage, { t: 'round_state' }>;
export type RoundRole = Extract<ServerMessage, { t: 'round_role' }>;
export type RoundEnded = Extract<ServerMessage, { t: 'round_ended' }>;

/** Ticks → m:ss. The round's clock is the only countdown players see. */
export function formatRemaining(ticks: number | null): string {
  if (ticks === null) return '—';
  const total = Math.max(0, Math.round(ticks / TICK_RATE));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** The round's compressed hour, as a face a player can read at a glance. */
export function formatClock(hour: number, night: boolean): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  return `${night ? '☾' : '☀'} ${h.toString().padStart(2, '0')}:00`;
}

/** The lobby's own line: how many are here, and how many are wanted. */
export function formatPhase(state: RoundState): string {
  // The dawn truce takes over the clock while it holds (D-536). It has to be
  // legible: a safety you can only discover by trying to hit someone is not
  // a safety anybody will plan a conversation around.
  if (state.phase === 'running' && state.graceTicks > 0) {
    return `dawn · ${formatRemaining(state.graceTicks)}`;
  }
  switch (state.phase) {
    case 'lobby':
      return state.cast >= state.minCast
        ? 'gathering…'
        : `waiting — ${state.cast}/${state.minCast}`;
    case 'running':
      return formatRemaining(state.remainingTicks);
    case 'resolved':
      return 'the round is over';
  }
}

/**
 * The ending, in words. Deliberately descriptive and never congratulatory:
 * a round ENDS, it does not grade (D-303, D-521). Nobody is told they were
 * right about anyone.
 */
export function formatOutcome(ended: RoundEnded): string {
  switch (ended.outcome) {
    case 'antagonist_dead':
      return 'The traitor lies dead. The rest saw morning.';
    case 'cast_wiped':
      return 'Nobody was left standing.';
    case 'objective_complete':
      return 'It was done. Whatever it was, it was done.';
    case 'time_expired':
      return 'The hours ran out with the work undone.';
    case 'abandoned':
      return 'Too few remained. The round was abandoned.';
  }
}

/** Live pieces of the panel, resolved once so the hot path does no lookups. */
export interface RoundHudElements {
  root: HTMLElement;
  phase: HTMLElement;
  clock: HTMLElement;
  cast: HTMLElement;
  objective: HTMLElement;
  objectiveName: HTMLElement;
  objectiveBrief: HTMLElement;
  ending: HTMLElement;
  endingTitle: HTMLElement;
  endingBody: HTMLElement;
}

export class RoundHud {
  private role: RoundRole | null = null;

  constructor(private el: RoundHudElements) {}

  /** Clears everything — used when a round resets, so nothing carries over. */
  reset(): void {
    this.role = null;
    this.el.objective.classList.add('hidden');
    this.el.ending.classList.add('hidden');
    this.el.objectiveName.textContent = '';
    this.el.objectiveBrief.textContent = '';
  }

  onState(state: RoundState): void {
    this.el.root.classList.remove('hidden');
    this.el.phase.textContent = formatPhase(state);
    this.el.clock.textContent = state.phase === 'running' ? formatClock(state.hour, state.night) : '';
    this.el.cast.textContent = state.phase === 'running' ? `${state.cast} in the round` : '';
    this.el.root.classList.toggle('night', state.phase === 'running' && state.night);
    this.el.root.classList.toggle('grace', state.phase === 'running' && state.graceTicks > 0);
    // A new round clears the last one's reveal; the objective card is
    // rebuilt from round_role rather than surviving the reset.
    if (state.phase === 'lobby') this.reset();
  }

  onRole(role: RoundRole): void {
    this.role = role;
    // Every player receives a role message, but only one has an objective.
    // The card is created ONLY when there is something to put in it — an
    // empty card would be a tell to anyone glancing at a second screen.
    if (!role.objective) {
      this.el.objective.classList.add('hidden');
      return;
    }
    this.el.objectiveName.textContent = role.objective.name;
    this.el.objectiveBrief.textContent = role.objective.brief;
    this.el.objective.classList.remove('hidden');
  }

  onEnded(ended: RoundEnded): void {
    this.el.objective.classList.add('hidden');
    this.el.endingTitle.textContent = formatOutcome(ended);
    const banked = ended.survived
      ? `You lived. ${ended.xpBanked} experience banked.`
      : 'You died out there. Nothing of what you earned came home.';
    this.el.endingBody.textContent =
      `The one carrying it was ${ended.antagonistName} — “${ended.objectiveName}”. ${banked}`;
    this.el.ending.classList.remove('hidden');
  }

  /** For tests and the verification hook: what this client believes it is. */
  isAntagonist(): boolean {
    return this.role?.antagonist ?? false;
  }
}
