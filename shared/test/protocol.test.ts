import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage } from '@rc/shared';

describe('wire protocol schemas', () => {
  it('accepts well-formed client messages', () => {
    expect(parseClientMessage({ t: 'register', username: 'jamie_1', password: 'longenough' })).not.toBeNull();
    expect(parseClientMessage({ t: 'move', dir: 'ne' })).not.toBeNull();
    expect(parseClientMessage({ t: 'ping', nonce: 42 })).not.toBeNull();
    expect(
      parseClientMessage({ t: 'create_character', name: "Aldous Vane", appearanceSeed: 7 }),
    ).not.toBeNull();
  });

  it('rejects malformed or unknown client messages', () => {
    expect(parseClientMessage({ t: 'move', dir: 'up' })).toBeNull();
    expect(parseClientMessage({ t: 'register', username: 'x', password: 'longenough' })).toBeNull();
    expect(parseClientMessage({ t: 'register', username: 'jamie_1', password: 'short' })).toBeNull();
    expect(parseClientMessage({ t: 'teleport', x: 0, y: 0 })).toBeNull();
    expect(parseClientMessage('move north')).toBeNull();
    expect(parseClientMessage(null)).toBeNull();
    // Intent only (D-102): there is deliberately no message carrying a position.
    expect(parseClientMessage({ t: 'move', x: 3, y: 4 })).toBeNull();
  });

  it('rejects pay with non-positive or fractional amounts', () => {
    expect(parseClientMessage({ t: 'pay', toEntityId: 1, amount: 0 })).toBeNull();
    expect(parseClientMessage({ t: 'pay', toEntityId: 1, amount: -5 })).toBeNull();
    expect(parseClientMessage({ t: 'pay', toEntityId: 1, amount: 1.5 })).toBeNull();
    expect(parseClientMessage({ t: 'pay', toEntityId: 1, amount: 10 })).not.toBeNull();
  });

  it('round-trips server messages', () => {
    const delta = {
      t: 'delta',
      tick: 100,
      events: [{ type: 'entity_moved', id: 1, x: 5, y: 6, facing: 's' }],
    };
    expect(parseServerMessage(JSON.parse(JSON.stringify(delta)))).toEqual(delta);
    expect(parseServerMessage({ t: 'delta', tick: 1, events: [{ type: 'exploded' }] })).toBeNull();
  });
});
