'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LCDA_ENDPOINTS, requestLoopback, summarizeLcda, augmentFieldEvidence, runMayhemLocalDiagnostic } = require('../src/services/mayhem-local-diagnostic.cjs');

test('local Mayhem diagnostic allowlists exactly the three requested LCDA routes', async () => {
  await assert.rejects(requestLoopback({ endpoint: '/swagger/v3/openapi.json', allowed: Object.values(LCDA_ENDPOINTS), ca: 'ca' }), { code: 'MAYHEM_DIAG_ENDPOINT_NOT_ALLOWED' });
  const called = [];
  const result = await runMayhemLocalDiagnostic({ ca: 'ca', lcu: { status: 'not-queried' }, request: async ({ endpoint }) => { called.push(endpoint); return endpoint.endsWith('allgamedata') ? { activePlayer: {}, allPlayers: [{ riotId: 'secret' }], gameData: { gameMode: 'CLASSIC', mapNumber: 11 } } : endpoint.endsWith('eventdata') ? { Events: [{ EventID: 1, EventName: 'GameStart', EventTime: 2 }, { EventID: 2, EventName: 'AugmentSelected', EventTime: 3, RiotId: 'secret' }] } : { summonerName: 'secret', championStats: {} }; } });
  assert.deepEqual(called.sort(), Object.values(LCDA_ENDPOINTS).sort());
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('secret'), false);
  assert.deepEqual(result.lcda.events.augmentNamedEvents, ['AugmentSelected']);
  assert.equal(result.lcda.allGameDataShape.playerCount, 1);
  assert.deepEqual(result.lcda.activePlayerAugmentFieldPaths, []);
});

test('diagnostic reports augment key paths only from the local player, not other players', () => {
  const report = summarizeLcda({
    allGameData: { ok: true, value: { activePlayer: { championStats: {}, augment: { id: 'hidden-value' } }, allPlayers: [{ augments: ['other-player'] }], gameData: {} } },
    activePlayer: { ok: true, value: { perks: { chosenAugment: 123 } } },
    eventData: { ok: true, value: { Events: [{ EventName: 'GameStart' }] } }
  });
  assert.deepEqual(report.allGameDataShape.augmentFieldPaths, ['activePlayer.augment']);
  assert.deepEqual(report.activePlayerAugmentFieldPaths, ['perks.chosenAugment']);
  assert.equal(JSON.stringify(report).includes('other-player'), false);
  assert.deepEqual(report.allGameDataShape.augmentCandidateIdentifiers, [{ path: 'activePlayer.augment.id', value: 'hidden-value' }]);
});

test('potential augment identifiers are extracted only below own-player augment fields and event ids remain candidates, not selections', () => {
  const evidence = augmentFieldEvidence({ activePlayer: { selectedAugment: { id: 'Augment_A', name: 'Known Augment' }, championStats: { abilityPower: 10 }, allPlayers: [{ selectedAugment: { id: 'OtherPlayerAugment' } }] } });
  assert.deepEqual(evidence.candidateIdentifiers, [
    { path: 'activePlayer.selectedAugment.id', value: 'Augment_A' },
    { path: 'activePlayer.selectedAugment.name', value: 'Known Augment' }
  ]);
  const summary = summarizeLcda({
    allGameData: { ok: true, value: { activePlayer: {}, gameData: {}, allPlayers: [] } },
    activePlayer: { ok: true, value: {} },
    eventData: { ok: true, value: { Events: [{ EventID: 14, EventName: 'AugmentSelected', EventTime: 15.5 }] } }
  });
  assert.deepEqual(summary.events.candidateEvents, [{ eventName: 'AugmentSelected', eventId: 14, eventTime: 15.5 }]);
  assert.equal(Object.hasOwn(summary.events.candidateEvents[0], 'selectedAugmentId'), false);
});
