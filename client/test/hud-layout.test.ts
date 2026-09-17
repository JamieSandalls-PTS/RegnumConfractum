import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Layout facts that regressed, pinned (D-611).
 *
 * ⚠ These are source assertions, and they are honest about what that can and
 * cannot prove: a stylesheet cannot be laid out in node, so what is checked
 * here is the *anchor* each element declares, not the box it ends up
 * occupying. The boxes were measured in the browser, which is the only place
 * they exist — the point of this file is that the three specific mistakes
 * cannot come back silently.
 */

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

/** Every `selector { ... }` block for one selector, in source order. */
function rulesFor(selector: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = html.indexOf(`${selector} {`, from);
    if (at < 0) return out;
    out.push(html.slice(at, html.indexOf('}', at)));
    from = at + 1;
  }
}

describe('the centred card is not also a docked panel (D-611)', () => {
  it('⚠ never gives `.panel` an absolute position', () => {
    // `.panel` is the CENTRED card the login screen, the character wizard and
    // the level-up screen are all built from. A second `.panel` rule further
    // down the file gave it `position: absolute; right: 12px` for the in-game
    // side panels — later rule, so it won, and every screen shown before you
    // are in the world was flung against the right edge and squeezed from
    // 340px to 300px. Reported as "everything is shifted over to the right".
    const rules = rulesFor('.panel');
    expect(rules.length, 'the login card is styled at all').toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule, `a .panel rule positions it absolutely: ${rule.slice(0, 80)}`)
        .not.toMatch(/position:\s*absolute/);
    }
  });

  it('gives the in-game side panels their own class', () => {
    expect(html).toContain('id="char-panel" class="dock');
    expect(html).toContain('id="craft-panel" class="dock');
    expect(rulesFor('.dock')[0]).toMatch(/position:\s*absolute/);
  });
});

describe('nothing shares an anchor with the round HUD (D-611)', () => {
  it('⚠ keeps the target frame out of the top-centre column', () => {
    // The top centre is a COLUMN owned by the round: clock, then the
    // objective card, then the lobby controls — and its height changes with
    // what is showing. `#target-frame` declared the same `top: 12px;
    // left: 50%` anchor as `#round-hud`, so with real content in both they
    // overlapped by 264x30px, measured.
    const round = rulesFor('#round-hud')[0]!;
    const target = rulesFor('#target-frame')[0]!;
    expect(round).toMatch(/left:\s*50%/);
    expect(target, 'the target frame no longer centres itself').not.toMatch(/left:\s*50%/);
  });

  it('⚠ keeps the settings button off the dials', () => {
    // Both sat at `right: 12px` near the top and overlapped by 77x25px.
    const dials = rulesFor('#dials')[0]!;
    const settings = rulesFor('#btn-settings')[0]!;
    const rightOf = (rule: string): number => Number(/right:\s*(\d+)px/.exec(rule)?.[1] ?? -1);
    expect(rightOf(dials)).toBeGreaterThanOrEqual(0);
    expect(rightOf(settings)).toBeGreaterThan(rightOf(dials));
  });
});

describe('talk and what you notice are two panels (D-611)', () => {
  it('⚠ has a separate log for each, and a caption saying which is which', () => {
    // They shared one scrollback, so a line of dialogue could be pushed off
    // the top by four refusals and a change in the weather — in a mode whose
    // whole point is people talking to each other (D-521).
    expect(html).toContain('id="event-log"');
    expect(html).toContain('id="chat-log"');
    expect(html).toContain('what you notice');
    // Styling hangs off `.log` so both are dressed identically; a rule that
    // still named `#chat-log` would leave the event panel unstyled, which is
    // the D-576 failure exactly.
    expect(html).not.toMatch(/#chat-log\s+\./);
  });

  it('⚠ sits ABOVE the bottom row rather than beside it', () => {
    // The bottom strip is fully occupied — hotbar in the middle, vitals on the
    // right, the work bar centred above the hotbar — so a log anchored down
    // there had to be narrow enough to squeeze in beside them, and at 460px it
    // was not: the last sixty pixels of every line sat under the hotbar.
    //
    // ⚠ Two columns of readable width need the space, so the logs moved UP
    // instead of getting thinner. The clearance is now vertical, and that is
    // what is asserted: the log's bottom edge must be above everything in the
    // bottom row.
    const px = (rule: string, prop: string): number =>
      Number(new RegExp(String.raw`${prop}:\s*(\d+)px`).exec(rule)?.[1] ?? NaN);
    const chatBottom = px(rulesFor('#chat')[0]!, 'bottom');
    const hotbarBottom = px(rulesFor('#hotbar')[0]!, 'bottom');
    const workBottom = px(rulesFor('#work-bar')[0]!, 'bottom');
    const vitalsBottom = px(rulesFor('#vitals')[0]!, 'bottom');
    for (const [name, value] of [['hotbar', hotbarBottom], ['work bar', workBottom], ['vitals', vitalsBottom]] as const) {
      expect(Number.isNaN(value), `${name} is anchored to the bottom`).toBe(false);
      expect(chatBottom, `the logs clear the ${name}`).toBeGreaterThan(value);
    }
  });
});

/**
 * There is ONE cast, and nothing reaches for the other (D-612, closed in
 * D-617).
 *
 * ⚠ D-612 fixed five call sites that narrowed a person to the procedural
 * cast with `instanceof`, each silently switching a feature off for anybody
 * rendered by the other one — combat animations, the readiness layer, hurt
 * cries, a lootable corpse's pack, a carried body. D-571 had recorded the same
 * mistake once already, and the comment recording it sat fifteen lines above
 * two of the five.
 *
 * ⚠ The procedural cast is now deleted, which retires that whole class of
 * bug rather than guarding it: there is nothing to narrow TO. What is asserted
 * here is the stronger fact — the class is gone and nothing imports it — since
 * a half-removal that left one live reference would be the worst of both.
 */
describe('the procedural cast is gone (D-617)', () => {
  const clientSrc = fileURLToPath(new URL('../src', import.meta.url));

  const sources = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...sources(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  it('⚠ has no `character.ts`, and nothing imports one', () => {
    expect(existsSync(`${clientSrc}/render/character.ts`), 'the file is deleted').toBe(false);
    const offenders = sources(clientSrc)
      .filter((f) => /from '\.{1,2}(\/render)?\/character'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(clientSrc, 'client/src'));
    expect(offenders, 'nothing imports the deleted cast').toEqual([]);
  });

  it('⚠ constructs no CharacterVisual anywhere', () => {
    // Comments may still mention it — the decisions that name it are worth
    // keeping readable. Code may not.
    const built = sources(clientSrc)
      .filter((f) => /new\s+CharacterVisual\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(clientSrc, 'client/src'));
    expect(built).toEqual([]);
  });

  it('leaves the world code one kind of person', () => {
    const main = readFileSync(`${clientSrc}/main.ts`, 'utf8');
    expect(main).toMatch(/function isPerson\([^)]*\)[^{]*\{\s*return v instanceof ImportedVisual;/);
  });
});
