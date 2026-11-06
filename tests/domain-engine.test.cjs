const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const patch = '16.22.1';
const dd = path.join(root, 'data', 'dragon', 'cdn', patch, 'data', 'en_US');
const exclusiveGroups = require(path.join(root, 'data', 'ranked', `item-groups-${patch}.json`));
const items = require(path.join(dd, 'item.json')).data;
const champions = require(path.join(dd, 'champion.json')).data;
const profiles = require(path.join(root, 'data', 'champion-build-profiles.json'));
const threatProfiles = require(path.join(root, 'data', 'champion-threat-profiles.json'));
const matchupAdvice = require(path.join(root, 'data', 'champion-matchup-item-advice.json'));
const taxonomy = require(path.join(root, 'data', 'item-taxonomy.json'));
const { normalizeRoster, validateRoster } = require('../src/domain/roster');
const { mergeRosterEvents } = require('../src/services/roster-normalizer');
const { fromFixture } = require('../src/adapters/lcu-champ-select-adapter');
const { DraftSessionController } = require('../src/services/draft-session-controller');
const { buildItemCatalog, validateBuildItems } = require('../src/engine/item-eligibility');
const { createThreatProfiler } = require('../src/engine/champion-threat-profiler');
const { createBuildAdvisor } = require('../src/engine/build-candidate-generator');
const catalog = buildItemCatalog({ itemData: items, taxonomy, mapId: '11', patch, exclusiveGroups });
const profileChampion = createThreatProfiler({ champions, threatProfiles });
const recommend = createBuildAdvisor({ buildProfiles: profiles, threatProfiles, matchupAdvice, itemCatalog: catalog, championDefinitions: champions, profileChampion, patch });

test('B0 roster has ten unknown slots and keeps hovers visible but unconfirmed', () => {
  const roster = normalizeRoster({ allies: [{ slot: 0, championId: 'Ahri', status: 'hover', visible: true, confirmed: false }], enemies: [] });
  assert.equal(roster.allies.length, 5); assert.equal(roster.enemies.length, 5);
  assert.equal(roster.allies[0].championId, 'Ahri'); assert.equal(roster.allies[0].confirmed, false);
  assert.equal(roster.enemies[0].championId, ''); assert.equal(roster.isComplete, false);
});

test('B0 roster validation rejects duplicate champion, unknown ID, and unconfirmed lane opponent', () => {
  const state = { player: { championId: 'Ahri', role: 'mid', identityConfirmed: true }, allies: [{ slot: 0, championId: 'Ahri', status: 'confirmed', visible: true, confirmed: true }], enemies: [{ slot: 0, championId: 'Zed', status: 'revealed', visible: true, confirmed: false }], laneOpponentChampionId: 'Zed' };
  assert.ok(validateRoster(state, Object.keys(champions)).errors.includes('lane-opponent'));
  assert.ok(validateRoster({ ...state, enemies: [{ slot: 0, championId: 'Unknown', visible: true, confirmed: true }] }, Object.keys(champions)).errors.includes('unknown-champion'));
});

test('manual confirmed roster outranks later unconfirmed live data and stale versions are discarded', () => {
  const current = { sessionId: 's1', version: 3, allies: [{ slot: 0, team: 'ally', championId: 'Ahri', source: 'manual', confirmed: true }], enemies: [] };
  const stale = mergeRosterEvents(current, { sessionId: 's1', version: 2, allies: [], enemies: [] });
  assert.equal(stale.version, 3); assert.equal(stale.allies[0].championId, 'Ahri');
  const later = mergeRosterEvents(current, { sessionId: 's1', version: 4, allies: [{ slot: 0, team: 'ally', championId: 'Zed', source: 'live-client', confirmed: false }], enemies: [] });
  assert.equal(later.allies[0].championId, 'Ahri');
});

test('LCU fixture maps own cell, preserves hover status, and drops unrevealed enemy picks', () => {
  const session = fromFixture({ sessionId: 's', localPlayerCellId: 3, championByKey: { 103: 'Ahri', 238: 'Zed' }, myTeam: [{ slot: 0, cellId: 1, championId: 103 }, { slot: 1, cellId: 3, championId: 103, assignedPosition: 'MIDDLE' }], theirTeam: [{ slot: 0, cellId: 6, championId: 238 }], actions: [[{ actorCellId: 3, type: 'pick', completed: false }]] });
  assert.equal(session.player.cellId, 3); assert.equal(session.player.championId, 'Ahri'); assert.equal(session.allies[1].status, 'hovered'); assert.equal(session.allies[1].confirmed, false); assert.equal(session.player.role, 'mid'); assert.equal(session.enemies[0].championId, '');
});

test('draft controller rejects old session updates and expires snapshots on end', () => {
  const controller = new DraftSessionController(); controller.begin('new');
  controller.apply({ sessionId: 'old', version: 9, allies: [{ slot: 0, team: 'ally', championId: 'Zed', source: 'lcu' }], enemies: [] });
  assert.equal(controller.snapshot().allies[0].championId, '');
  controller.apply({ sessionId: 'new', version: 1, allies: [{ slot: 0, team: 'ally', championId: 'Ahri', source: 'lcu', status: 'locked', visible: true, confirmed: true }], enemies: [] });
  assert.equal(controller.snapshot().allies[0].championId, 'Ahri'); assert.equal(controller.end('new'), true); assert.equal(controller.snapshot(), null);
});

test('ranked catalog excludes ARAM-only and invalid items, validates six unique items', () => {
  assert.ok(catalog['3089']); assert.ok(!catalog['3001']);
  assert.deepEqual(validateBuildItems(['3006','3031','3085','3036','3091','6655'], catalog, { patch, exclusiveGroups }).valid, true);
  assert.deepEqual(validateBuildItems(['3006','3031','3085','3036','3091','3006'], catalog, { patch, exclusiveGroups }).valid, false);
});

function roster(enemy = '') {
  return normalizeRoster({ mode: 'ranked', phase: 'ready', player: { championId: 'Ahri', role: 'mid', identityConfirmed: true }, allies: [{ slot: 0, championId: 'Ahri', team: 'ally', status: 'confirmed', visible: true, confirmed: true }, { slot: 1, championId: 'Sona', team: 'ally', status: 'confirmed', visible: true, confirmed: true }], enemies: enemy ? [{ slot: 0, championId: enemy, team: 'enemy', status: 'confirmed', visible: true, confirmed: true }] : [], laneOpponentChampionId: enemy });
}

test('composition changes introduce threat-specific build, unknown enemy does not', () => {
  const safe=recommend(roster(),'es'),zed=recommend(roster('Zed'),'es'),syndra=recommend(roster('Syndra'),'es');
  assert.equal(safe.scenarios.lane,undefined);assert.ok(zed.scenarios.lane);assert.ok(syndra.scenarios.lane);
  assert.deepEqual(safe.scenarios.standard.recommended.itemIds,zed.scenarios.standard.recommended.itemIds);
  assert.ok(zed.scenarios.lane.deltaFromStandard.reason);
});

test('build recommendations are deterministic, six-slot legal and never expose match percentages', () => {
  const input = roster('Zed'), one = recommend(input, 'es'), two = recommend(input, 'en');
  assert.deepEqual(one.options.map(x => x.itemIds), recommend(input, 'es').options.map(x => x.itemIds));
  for (const option of one.options) { assert.equal(option.itemIds.length, 6); assert.equal(validateBuildItems(option.itemIds, catalog, { patch, exclusiveGroups }).valid, true); assert.ok(!('winRate' in option)); assert.ok(!('pickRate' in option)); }
  assert.equal(one.options[0].id, two.options[0].id); assert.notEqual(one.options[0].label, two.options[0].label);
});

test('editorial coverage uses distinct six-item sets and current Data Dragon IDs', () => {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data/champion-build-profiles.json'), 'utf8'));
  for (const [championId, profile] of Object.entries(data.champions)) for (const [role, options] of Object.entries(profile.roles)) {
    const sets = options.map(x => x.itemIds.map(String).sort().join(','));
    assert.equal(new Set(sets).size, sets.length, `${championId}/${role} duplicate builds`);
    for (const option of options) { assert.equal(option.itemIds.length, 6); for (const id of option.itemIds) assert.equal(items[id]?.maps?.['11'], true, `${championId}/${role}/${id}`); }
  }
});

test('champions without a curated profile still receive a clearly labeled legal general build', () => {
  const advisor=createBuildAdvisor({buildProfiles:{champions:{}},itemCatalog:catalog,championDefinitions:champions,profileChampion,patch,exclusiveGroups});
  const result=advisor(roster(),'es');assert.equal(result.status,'build-ready');assert.equal(result.options[0].itemIds.length,6);assert.equal(result.options[0].evidenceType,'educational-generated');assert.equal(result.options[0].winRate,undefined);
});

test('Jinx vs Master Yi keeps a base build on role mismatch and explains targeted item options', () => {
  const input = normalizeRoster({ player: { championId: 'Jinx', role: 'mid', identityConfirmed: true }, allies: [], enemies: [{ slot: 0, championId: 'MasterYi', team: 'enemy', status: 'confirmed', visible: true, confirmed: true }] });
  const result = recommend(input, 'es');
  assert.deepEqual(result.options, []);
  assert.equal(result.status, 'no-profile');
  assert.deepEqual(result.matchupItems.map(row => row.itemId), ['3026', '6673', '3046']);
  assert.ok(result.matchupItems.every(row => row.enemyName === 'Maestro Yi' && row.reason.includes('Maestro Yi')));
});

test('matchup item advice only references legal catalog items', () => {
  for (const championsForEnemy of Object.values(matchupAdvice.matchups || {})) for (const rows of Object.values(championsForEnemy)) for (const row of rows) assert.ok(catalog[String(row.itemId)], `Unknown or unavailable matchup item ${row.itemId}`);
});
