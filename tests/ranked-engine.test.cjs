const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const itemData = require(path.join(root, 'data/dragon/cdn/16.22.1/data/en_US/item.json'));
const championData = require(path.join(root, 'data/dragon/cdn/16.22.1/data/en_US/champion.json')).data;
const taxonomy = require(path.join(root, 'data/item-taxonomy.json'));
const groups = require(path.join(root, 'data/ranked/item-groups-16.22.1.json'));
const seed = require(path.join(root, 'data/ranked/champion-role-seed-16.21.1.json'));
const { buildItemCatalog, validateBuildItems, validateCoreItems } = require('../src/engine/item-eligibility');
const { createRankedPatchContext } = require('../src/engine/ranked/ranked-patch-context.cjs');
const { createBuildAdvisor } = require('../src/engine/build-candidate-generator');

const catalog = buildItemCatalog({ itemData, taxonomy, patch: '16.22.1', exclusiveGroups: groups });
const base = ['6655', '3089', '3157', '3116', '3102', '3020'];
const validate = (ids, options = {}) => validateBuildItems(ids, catalog, { patch: '16.22.1', exclusiveGroups: groups, ...options });

test('R0: Data Dragon, exclusive groups, map and patch are aligned before Ranked validation', () => {
  assert.equal(itemData.version, '16.22.1');
  assert.equal(groups.patch, itemData.version);
  assert.equal(groups.mapId, '11');
  assert.equal(groups.status, 'verified');
  assert.equal(createRankedPatchContext({ patch: '16.22.1', itemData, exclusiveGroups: groups }).ready, true);
  assert.equal(createRankedPatchContext({ patch: '16.21.1', itemData, exclusiveGroups: groups }).ready, false);
});

test('T1: rejects two pairs of boots in the six normal slots', () => {
  assert.equal(validate(['6655', '3089', '3157', '3116', '3102', '3020']).valid, true);
  assert.ok(validate(['6655', '3089', '3157', '3116', '3020', '3158']).errors.includes('boots-limit-exceeded'));
});

test('T2: Cassiopeia can buy one pair of boots', () => {
  assert.equal(validate(base, { championId: 'Cassiopeia', role: 'mid' }).valid, true);
});

test('T3-T5: enforces overlapping Blight and Fatality groups, including Terminus', () => {
  assert.ok(validate(['3135', '3137', '6655', '3157', '3116', '3020']).errors.includes('unique-group-conflict'));
  assert.ok(validate(['3071', '3036', '6655', '3157', '3116', '3020']).errors.includes('unique-group-conflict'));
  const terminus = validate(['3302', '3135', '3071', '6655', '3157', '3020']);
  assert.ok(terminus.errors.includes('unique-group-conflict'));
  assert.ok(terminus.conflictingItemIds.includes('3302'));
});

test('R1.4: does not impose a false global limit across physical and magic percent penetration', () => {
  assert.equal(validate(['3135', '3036', '6655', '3157', '3116', '3020']).valid, true);
});

test('T6: rejects duplicate items and exposes the conflicting stable ID', () => {
  const result = validate(['6655', '6655', '3157', '3116', '3102', '3020']);
  assert.ok(result.errors.includes('duplicate-item'));
  assert.ok(result.conflictingItemIds.includes('6655'));
});

test('T7-T8: rejects unavailable modes, conditional store items and champion locks', () => {
  const arenaCatalog = { ...catalog, '3089': { ...catalog['3089'], tags: [...catalog['3089'].tags, 'arena'] } };
  assert.ok(validateBuildItems(['6655', '3089', '3157', '3116', '3102', '3020'], arenaCatalog, { patch: '16.22.1', exclusiveGroups: groups }).errors.includes('mode-exclusive-item'));
  const lockedCatalog = { ...catalog, '3089': { ...catalog['3089'], requiredChampion: 'Kassadin' } };
  assert.ok(validateBuildItems(base, lockedCatalog, { patch: '16.22.1', exclusiveGroups: groups, championId: 'Ahri' }).errors.includes('required-champion-mismatch'));
  const removedCatalog = { ...catalog, '3089': { ...catalog['3089'], inStore: false } };
  assert.ok(validateBuildItems(base, removedCatalog, { patch: '16.22.1', exclusiveGroups: groups }).errors.includes('item-not-available-in-mode'));
});

test('T9: components and an upgrade cannot be shown together as final items', () => {
  const result = validate(['4630', '3135', '6655', '3157', '3116', '3020']);
  assert.ok(result.errors.includes('component-not-final-slot'));
  assert.ok(result.errors.includes('component-and-upgrade-conflict'));
});

test('T10: requires exactly six final inventory slots and does not count a trinket', () => {
  assert.ok(validate(base.slice(0, 5)).errors.includes('six-slots-required'));
  assert.ok(validate([...base, '3135']).errors.includes('six-slots-required'));
  assert.ok(!catalog['3363']);
});

test('R3: accepts a validated published three-item core without treating it as a full build', () => {
  const core = validateCoreItems(['3118', '4645', '3157'], catalog, { patch: '16.22.1', exclusiveGroups: groups, championId: 'Ahri', role: 'mid' });
  assert.equal(core.valid, true);
  assert.equal(validate(['3118', '4645', '3157']).valid, false);
  assert.ok(validateCoreItems([], catalog, { patch: '16.22.1', exclusiveGroups: groups }).errors.includes('empty-core'));
});

test('R3: permits Seraph and Muramana final transformations only from their correct purchasable bases', () => {
  const seraph = validateCoreItems(['3040', '4645', '3157'], catalog, { patch: '16.22.1', exclusiveGroups: groups, championId: 'Ryze', role: 'mid' });
  const muramana = validateCoreItems(['3042', '3071', '3158'], catalog, { patch: '16.22.1', exclusiveGroups: groups, championId: 'Ezreal', role: 'adc' });
  assert.equal(seraph.valid, true);
  assert.equal(muramana.valid, true);
  assert.equal(groups.transformations['3042'].fromItemId, '3004');
});

test('T20: rejects patch mismatch instead of silently validating stale rules', () => {
  assert.ok(validateBuildItems(base, catalog, { patch: '16.21.1', exclusiveGroups: groups }).errors.includes('exclusive-matrix-patch-mismatch'));
});

test('T22: repeated validation is deterministic and never invents a legality result', () => {
  assert.deepEqual(validate(base), validate(base));
  const noMatrix = validateBuildItems(base, catalog, { patch: '16.22.1', exclusiveGroups: { ...groups, status: 'review-required' } });
  assert.equal(noMatrix.valid, false);
  assert.equal(noMatrix.buildStatus, 'unverified');
});

test('T25: Bot quest boots stay in the separate slot; Cassiopeia remains eligible', () => {
  assert.equal(validate(['6655', '3089', '3157', '3116', '3102', '3020'], { role: 'bot', roleQuestCompleted: true }).valid, true);
  assert.equal(validate(['6655', '3089', '3157', '3116', '3102', '6653'], { role: 'adc', roleQuestCompleted: true, questBootsItemId: '3020' }).valid, true);
  assert.ok(validate(base, { role: 'mid', roleQuestCompleted: true, questBootsItemId: '3020' }).errors.includes('role-quest-slot-role-mismatch'));
});

test('T26: Mid tier-three boots replace, rather than add to, the single normal boot slot', () => {
  assert.equal(validate(['6655', '3089', '3157', '3116', '3102', '3009'], { role: 'mid', roleQuestCompleted: true }).valid, true);
  assert.ok(validate(['6655', '3089', '3157', '3116', '3102', '3009'], { role: 'mid', roleQuestCompleted: true, questBootsItemId: '3158' }).errors.includes('boots-limit-exceeded'));
});

test('Seed remains editorial-only and does not contain statistical builds', () => {
  assert.equal(Object.keys(seed.champions).length, 173);
  assert.match(seed.disclaimer, /NO build recomendada validada|NO.*build/i);
  for (const champion of Object.values(seed.champions)) for (const profile of champion.candidateProfiles) assert.equal(profile.reviewStatus, 'EDITORIAL_SEED_REQUIRES_VERIFICATION');
  assert.ok(!seed.champions.Ahri.statisticalBuilds || seed.champions.Ahri.statisticalBuilds.length === 0);
});

test('Advisor does not assemble six independent item scores or borrow an unrelated role', () => {
  const profiles = { schemaVersion: 2, champions: { Ahri: { roles: { mid: [] } } } };
  const advisor = createBuildAdvisor({ buildProfiles: profiles, itemCatalog: catalog, championDefinitions: championData, patch: '16.22.1', exclusiveGroups: groups });
  const result = advisor({ player: { championId: 'Ahri', role: 'support' }, allies: [], enemies: [] }, 'es');
  assert.deepEqual(result.options, []);
  assert.equal(result.status, 'no-profile');
  assert.doesNotMatch(result.notice, /mid|MID/);
});
