'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMayhemEventSession } = require('../src/engine/aram-mayhem-event-session.cjs');

test('provider-neutral Mayhem event session requires confirmation, isolates matches, deduplicates, and notifies recommendation consumer', () => {
  const selected = [], events = [];
  const session = createMayhemEventSession({ onAugmentSelected: row => selected.push(row), onEvent: event => events.push(event), now: () => '2026-11-05T00:00:00.000Z' });
  assert.equal(session.apply({ type: 'match-start', source: 'test-provider', matchId: 'm1', queueId: 2400, confirmed: false }).accepted, false);
  assert.equal(session.apply({ type: 'match-start', source: 'test-provider', matchId: 'm1', queueId: 2400, confirmed: true, eventId: 'start-1' }).state.mode, 'aram-mayhem');
  assert.equal(session.apply({ type: 'augment-offers', source: 'test-provider', matchId: 'm1', augmentIds: ['a', 'b'], confirmed: true }).accepted, true);
  const pick = { type: 'augment-selected', source: 'test-provider', matchId: 'm1', augmentId: 'a', confirmed: true, eventId: 'pick-1' };
  assert.equal(session.apply(pick).accepted, true);
  assert.equal(session.apply(pick).reason, 'duplicate');
  assert.equal(selected.length, 1);
  assert.equal(events.at(-1).type, 'augment-selected');
  assert.equal(session.apply({ type: 'item-acquired', source: 'test-provider', matchId: 'old-match', itemId: 1001, confirmed: true }).reason, 'match-id-mismatch');
  assert.equal(session.apply({ type: 'connection-state', source: 'test-provider', matchId: 'm1', connection: 'degraded' }).state.connection, 'degraded');
  assert.equal(session.apply({ type: 'match-end', source: 'test-provider', matchId: 'm1', confirmed: true }).state.status, 'ended');
  assert.equal(session.apply({ type: 'match-start', source: 'test-provider', matchId: 'm2', queueId: 2400, confirmed: true }).state.selectedAugments.length, 0);
});
