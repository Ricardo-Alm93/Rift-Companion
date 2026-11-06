'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createMayhemRuntime, MAYHEM_QUEUE_ID } = require('../src/experimental/overwolf-aram/mayhem-runtime.cjs');
const { attachOverwolfMayhemBridge, collectInitialUpdates, readOwnLiveItems } = require('../src/experimental/overwolf-aram/ow-electron-bridge.cjs');
const { loadMayhemCatalog } = require('../src/engine/aram-mayhem-catalog.cjs');

const root = path.resolve(__dirname, '..');
const catalog = loadMayhemCatalog(root);
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'data/aram-mayhem/interaction-evidence.json'), 'utf8'));
const itemData = JSON.parse(fs.readFileSync(path.join(root, 'data/dragon/cdn/16.22.1/data/en_US/item.json'), 'utf8')).data;
const mayhemItems = JSON.parse(fs.readFileSync(path.join(root, 'data/aram-mayhem/items.json'), 'utf8')).rows;
const transformations = JSON.parse(fs.readFileSync(path.join(root, 'data/aram-mayhem/transformations.json'), 'utf8')).transformations;
const core = mayhemItems.filter(row => row.category === 'legendary' && itemData[row.gameItemId]?.maps?.['12'] === true && itemData[row.gameItemId]?.gold?.purchasable === true).slice(0, 6).map(row => row.gameItemId);
const offers = (...names) => Object.fromEntries(names.map((name, index) => [`augment_${index + 1}`, { name }]));

function fixtureRuntime(overlays = []) {
  let context = { championId: 'Jinx', itemIds: core, boughtItemIds: [core[0]], itemData, mayhemItems, transformations };
  const runtime = createMayhemRuntime({ catalog, evidence, getBuildContext: async () => context, onState: state => overlays.push(state) });
  return { runtime, setContext(value) { context = value; } };
}

test('GEP Mayhem runtime records Jinx offers, accumulates picks, recalculates build, and publishes one shared overlay state', async () => {
  const mainStates = [], overlayStates = [];
  const runtime = createMayhemRuntime({ catalog, evidence, getBuildContext: async () => ({ championId: 'Jinx', itemIds: core, boughtItemIds: [core[0]], itemData, mayhemItems, transformations }), onState: state => { mainStates.push(state); overlayStates.push(state); } });
  await runtime.handleMatchStart({ providerGameId: 5426, matchId: 'match-1', queueId: MAYHEM_QUEUE_ID });
  await runtime.updateLiveSnapshot({ championId: 'Jinx', boughtItemIds: [core[0]] });
  await runtime.handleInfoUpdate({ gameId: 5426, feature: 'augments', category: 'me', key: 'augments', value: JSON.stringify(offers('Weapon of Destiny', 'RISE!', 'Jeweled Bracelet')) });
  assert.deepEqual(runtime.snapshot().offers.map(row => row.slug), ['weapon-of-destiny', 'rise', 'jeweled-bracelet']);
  await runtime.handleInfoUpdate({ gameId: 5426, feature: 'augments', category: 'me', key: 'picked_augment', value: 'Weapon of Destiny' });
  const first = runtime.snapshot();
  assert.equal(first.selected.length, 1);
  assert.equal(first.recommendation.buildAdaptation.nextPurchaseItemId, core[1]);
  assert.equal(first.recommendation.buildAdaptation.changed, false);
  assert.equal(first.recommendation.buildAdaptation.acquiredItemIds[0], core[0]);
  assert.equal(first.recommendation.boughtItemsStatus, 'fresh');
  assert.equal(first.recommendation.itemValidation.valid, true);
  await runtime.handleInfoUpdate({ gameId: 5426, feature: 'augments', category: 'me', key: 'augments', value: offers('RISE!', 'Group Hug', 'Soul Eater') });
  await runtime.handleInfoUpdate({ gameId: 5426, feature: 'augments', category: 'me', key: 'picked_augment', value: 'RISE!' });
  assert.equal(runtime.snapshot().selected.length, 2);
  assert.ok(runtime.snapshot().recommendation.results.some(row => row.slug === 'rise' || row.id === 'rise'));
  await runtime.handleInfoUpdate({ gameId: 5426, feature: 'augments', category: 'me', key: 'augments', value: offers('RISE!', 'One Hit Wonder', 'Soul Eater') });
  await runtime.handleInfoUpdate({ gameId: 5426, feature: 'augments', category: 'me', key: 'picked_augment', value: 'RISE!' });
  assert.equal(runtime.snapshot().selected.length, 3, 'same augment may be selected again in a new offer cycle');
  assert.deepEqual(mainStates.at(-1), overlayStates.at(-1), 'main and overlay callbacks receive the same versioned DTO');
});

test('GEP repeated notifications dedupe within one offer round; unknown events are not added', async () => {
  const { runtime } = fixtureRuntime();
  await runtime.handleMatchStart({ providerGameId: 7, matchId: 'm-a', queueId: MAYHEM_QUEUE_ID });
  await runtime.handleInfoUpdate({ gameId: 7, feature: 'augments', key: 'augments', value: offers('RISE!', 'Weapon of Destiny', 'Jeweled Bracelet') });
  await runtime.handleInfoUpdate({ gameId: 7, feature: 'augments', key: 'picked_augment', value: 'RISE!' });
  const afterFirst = runtime.snapshot().selected.length;
  await runtime.handleInfoUpdate({ gameId: 7, feature: 'augments', key: 'picked_augment', value: 'RISE!' });
  assert.equal(runtime.snapshot().selected.length, afterFirst);
  await runtime.handleInfoUpdate({ gameId: 7, feature: 'augments', key: 'picked_augment', value: 'Unknown Augment Name' });
  assert.equal(runtime.snapshot().selected.length, afterFirst);
  assert.equal(runtime.snapshot().unknownPickCount, 1);
  assert.equal(runtime.snapshot().syncGap, true);
});

test('new match clears prior augment history, non-Mayhem queues remain waiting, and unidentified build stays unchanged', async () => {
  const { runtime } = fixtureRuntime();
  await runtime.handleMatchStart({ providerGameId: 7, matchId: 'm-a', queueId: MAYHEM_QUEUE_ID });
  await runtime.handleInfoUpdate({ gameId: 7, feature: 'augments', key: 'augments', value: offers('RISE!', 'Weapon of Destiny', 'Jeweled Bracelet') });
  await runtime.handleInfoUpdate({ gameId: 7, feature: 'augments', key: 'picked_augment', value: 'RISE!' });
  const oldBuild = runtime.snapshot().recommendation.buildAdaptation.itemIds;
  await runtime.handleMatchStart({ providerGameId: 7, matchId: 'm-b', queueId: MAYHEM_QUEUE_ID });
  assert.equal(runtime.snapshot().selected.length, 0);
  await runtime.handleInfoUpdate({ gameId: 7, feature: 'augments', key: 'augments', value: offers('New unknown', 'Unknown two', 'Unknown three') });
  assert.equal(runtime.snapshot().recommendation, undefined);
  const normal = fixtureRuntime().runtime;
  await normal.handleMatchStart({ providerGameId: 7, matchId: 'not-mayhem', queueId: 450 });
  assert.equal(normal.snapshot().status, 'waiting');
  assert.equal(normal.snapshot().mode, 'unknown');
  assert.deepEqual(oldBuild, core);
});

test('resumed provider state marks incomplete history and restores only the current known pick', async () => {
  const { runtime } = fixtureRuntime();
  await runtime.handleInfoUpdate({ gameId: 9, feature: 'matchState', key: 'queueId', value: 2400 }, { providerGameId: 9, initialSnapshot: true });
  await runtime.handleInfoUpdate({ gameId: 9, feature: 'matchState', key: 'matchId', value: 'resume-1' }, { providerGameId: 9, initialSnapshot: true });
  await runtime.handleInfoUpdate({ gameId: 9, feature: 'matchState', key: 'matchStarted', value: 'true' }, { providerGameId: 9, initialSnapshot: true });
  await runtime.handleInfoUpdate({ gameId: 9, feature: 'augments', key: 'augments', value: offers('RISE!', 'Soul Eater', 'Jeweled Bracelet') }, { providerGameId: 9, initialSnapshot: true });
  await runtime.handleInfoUpdate({ gameId: 9, feature: 'augments', key: 'picked_augment', value: 'RISE!' }, { providerGameId: 9, initialSnapshot: true });
  assert.equal(runtime.snapshot().selected.length, 1);
  assert.equal(runtime.snapshot().selected[0].provenance, 'provider-current-state');
  assert.equal(runtime.snapshot().historyComplete, false);
  assert.equal(runtime.snapshot().syncGap, true);
});

test('matchStarted false ends the active session and clears its augments before another game', async () => {
  const { runtime } = fixtureRuntime();
  await runtime.handleMatchStart({ providerGameId: 11, matchId: 'end-test', queueId: MAYHEM_QUEUE_ID });
  await runtime.handleInfoUpdate({ gameId: 11, feature: 'augments', key: 'augments', value: offers('RISE!', 'Soul Eater', 'Weapon of Destiny') });
  await runtime.handleInfoUpdate({ gameId: 11, feature: 'augments', key: 'picked_augment', value: 'RISE!' });
  await runtime.handleInfoUpdate({ gameId: 11, feature: 'matchState', key: 'matchStarted', value: 'false' });
  assert.equal(runtime.snapshot().status, 'ended');
  assert.equal(runtime.snapshot().mode, 'unknown');
  assert.deepEqual(runtime.snapshot().selected, []);
});

test('GEP initial info parser flattens supported current-state shapes in dependency order', () => {
  const updates = collectInitialUpdates({ gameId: 5426, info: { matchState: { game_info: { matchStarted: 'true', matchId: 'm-1', queueId: 2400 } }, augments: { me: { picked_augment: 'RISE!', augments: JSON.stringify(offers('RISE!')) } } } });
  assert.deepEqual(updates.map(row => row.key), ['queueId', 'matchId', 'matchStarted', 'augments', 'picked_augment']);
});

test('Live Client Data item reader returns only identified player champion and item IDs', async () => {
  const request = async ({ endpoint }) => endpoint.endsWith('activeplayername') ? 'Test Summoner' : [{ summonerName: 'Test Summoner', championName: 'Jinx', items: [{ itemID: 3031 }, { itemID: 3087 }] }, { summonerName: 'Other', championName: 'Lux', items: [{ itemID: 6655 }] }];
  const data = await readOwnLiveItems({ ca: 'CA', request, championByName: { testsummoner: 'Jinx', jinx: 'Jinx' } });
  assert.deepEqual(data, { status: 'live-player-items-read', championId: 'Jinx', boughtItemIds: ['3031', '3087'] });
});

test('Live Client Data identity loss marks purchased items stale instead of silently using them as current', async () => {
  const { runtime } = fixtureRuntime();
  await runtime.handleMatchStart({ providerGameId: 17, matchId: 'stale-items', queueId: MAYHEM_QUEUE_ID });
  await runtime.updateLiveSnapshot({ championId: 'Jinx', boughtItemIds: ['3031'] });
  await runtime.markLiveItemsStale('LIVE_CLIENT_IDENTITY_UNRESOLVED');
  assert.equal(runtime.snapshot().boughtItemsStatus, 'stale');
  assert.equal(runtime.snapshot().liveItemsErrorCode, 'LIVE_CLIENT_IDENTITY_UNRESOLVED');
});

test('Overwolf Electron bridge is isolated, subscribes to required GEP features and resumes current info without main Electron changes', async () => {
  const gep = new EventEmitter();
  gep.getFeatures = async () => ['matchState', 'augments'];
  gep.setRequiredFeatures = async (_id, features) => { gep.required = features; };
  gep.getInfo = async () => ({ gameId: 5426, info: { matchState: { game_info: { matchStarted: 'true', matchId: 'gep-1', queueId: 2400 } }, augments: { me: { augments: JSON.stringify(offers('RISE!', 'Soul Eater', 'Weapon of Destiny')), picked_augment: 'RISE!' } } } });
  const { runtime } = fixtureRuntime();
  const statuses = [];
  const bridge = attachOverwolfMayhemBridge({ app: { overwolf: { packages: { gep } } }, runtime, readLiveItems: async () => ({ status: 'no-match', championId: '', boughtItemIds: [] }), onStatus: status => statuses.push(status) });
  let enabled = false;
  gep.emit('game-detected', { enable: async () => { enabled = true; } }, 5426, 'League of Legends');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(enabled, true);
  assert.deepEqual(gep.required, ['augments', 'matchState']);
  assert.equal(runtime.snapshot().status, 'active');
  assert.equal(runtime.snapshot().selected[0].slug, 'rise');
  assert.equal(runtime.snapshot().historyComplete, false);
  assert.ok(statuses.some(value => value.status === 'gep-ready'));
  bridge.stop();
});
