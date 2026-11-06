'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { loadMayhemCatalog, availableAugments } = require('../src/engine/aram-mayhem-catalog.cjs');
const { evaluateAugments } = require('../src/engine/aram-augment-evaluator.cjs');
const { adaptMayhemBuild } = require('../src/engine/aram-build-adapter.cjs');
const { validateMayhemBuild } = require('../src/engine/aram-mayhem-item-validator.cjs');

const root = path.resolve(__dirname, '..');
const catalog = loadMayhemCatalog(root);
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'data/aram-mayhem/interaction-evidence.json'), 'utf8'));
const itemData = JSON.parse(fs.readFileSync(path.join(root, 'data/dragon/cdn/16.22.1/data/en_US/item.json'), 'utf8')).data;
const mayhemItems = JSON.parse(fs.readFileSync(path.join(root, 'data/aram-mayhem/items.json'), 'utf8')).rows;
const transformations = JSON.parse(fs.readFileSync(path.join(root, 'data/aram-mayhem/transformations.json'), 'utf8')).transformations;

test('Mayhem patch mechanics and statistical snapshot stay explicitly separated', () => {
  assert.equal(catalog.patch, '26.22');
  assert.equal(catalog.basePatch, '26.21');
  assert.equal(catalog.statsDate, '2026-11-01');
  assert.equal(catalog.rows.find(row => row.slug === 'one-hit-wonder').effectComplete, false);
  assert.equal(catalog.rows.find(row => row.slug === 'one-hit-wonder').pickRate, null);
  assert.equal(catalog.rows.find(row => row.slug === 'rise').verification, 'official-effect-confirmed');
  assert.equal(catalog.rows.find(row => row.slug === 'titans-resolve').mechanicsPatch, '26.22');
});

test('confirmed 26.21 retirements cannot appear in the available augment list', () => {
  const available = new Set(availableAugments(catalog).map(row => row.slug));
  for (const slug of catalog.patchNotes.retirements.confirmedRetired) assert.equal(available.has(slug), false, slug);
  assert.equal(catalog.patchNotes.retirements.newlyRetiredThisPatch.length, 0);
});

test('Headliners and Journey rewards are separate from augment offers', () => {
  assert.equal(catalog.headliners.rows.length, 8);
  assert.match(catalog.headliners.catalogCompleteness, /minimum/i);
  assert.equal(catalog.rows.some(row => row.slug === 'kda'), false);
  assert.equal(catalog.journey.progression.find(row => row.status === 'Legend').fame, 8800);
  assert.equal(catalog.journey.augmentMilestones.Worlds, null);
});

test('Jinx offers get only reviewed/documented evidence; arbitrary tag overlap yields unknown', () => {
  const [rise] = evaluateAugments({ championId: 'Jinx', headlinerId: 'kda', candidateAugments: ['rise'], evidence, language: 'es' });
  assert.equal(rise.evidenceLevel, 'editorial-reviewed');
  assert.match(rise.championFit, /Jinx/);
  assert.equal(rise.headlinerInteraction.length > 0, true);
  const [falseSynergy] = evaluateAugments({ championId: 'Ryze', selectedAugments: ['archmage'], candidateAugments: ['scopier-weapons'], evidence, language: 'en' });
  assert.equal(falseSynergy.evidenceLevel, 'unknown');
  assert.equal(falseSynergy.status, 'insufficient-evidence');
  assert.equal(Object.hasOwn(falseSynergy, 'score'), false);
});

test('Jinx ultimate crit, Soraka healing, and Ornn armor augments retain their evidence confidence', () => {
  const evaluate = (championId, slug) => evaluateAugments({ championId, candidateAugments: [slug], evidence })[0];
  assert.equal(evaluate('Jinx', 'jeweled-bracelet').evidenceLevel, 'editorial-reviewed');
  assert.equal(evaluate('Soraka', 'group-hug').evidenceLevel, 'editorial-reviewed');
  assert.equal(evaluate('Ornn', 'armored-impact').confidence, 'low');
  for (const championId of ['Ahri', 'Ryze', 'Cassiopeia', 'Azir', 'Jinx', 'KaiSa', 'Ornn', 'Soraka']) {
    const row = evaluateAugments({ championId, candidateAugments: ['one-hit-wonder'], evidence })[0];
    assert.equal(row.evidenceLevel, 'unknown', `${championId} should not receive an invented target ability`);
  }
});

test('picking RISE keeps Jinx items; acquired items are not repeated as planned purchases', () => {
  const itemIds = ['3031', '3087', '3006', '3036', '3094', '3026'];
  const result = adaptMayhemBuild({ itemIds, selectedAugments: ['rise'], boughtItemIds: ['3031'], interactions: evidence.interactions });
  assert.deepEqual(result.itemIds, itemIds);
  assert.deepEqual(result.acquiredItemIds, ['3031']);
  assert.equal(result.changed, false);
  assert.equal(result.status, 'build-preserved');
  const generic = adaptMayhemBuild({ itemIds, selectedAugments: ['weapon-of-destiny'], boughtItemIds: ['3031'], interactions: evidence.interactions });
  assert.equal(generic.nextPurchaseItemId, '3087');
  assert.match(generic.explanation, /retroactivamente/i);
});

test('Mayhem item validation uses its own map-12 catalog and supports verified transformations', () => {
  const goodIds = mayhemItems.filter(row => row.category === 'legendary' && itemData[row.gameItemId]?.maps?.['12'] === true && itemData[row.gameItemId]?.gold?.purchasable !== false).slice(0, 6).map(row => row.gameItemId);
  const good = validateMayhemBuild({ itemIds: goodIds, itemData, mayhemItems, transformations });
  assert.equal(good.valid, true);
  const arenaOnly = { '7777': { maps: { '30': true }, gold: { purchasable: true } } };
  assert.equal(validateMayhemBuild({ itemIds: ['7777'], itemData: arenaOnly, mayhemItemIds: ['7777'] }).valid, false);
  const transformed = validateMayhemBuild({ itemIds: ['3121','6655','3020','3089','3135','3157'], itemData, mayhemItems, transformations });
  assert.equal(transformed.valid, true);
  assert.ok(transformed.warnings.some(value => value === 'transformed-item:3121'));
  assert.equal(validateMayhemBuild({ itemIds: ['3121','3119','3020','3089','3135','3157'], itemData, mayhemItems, transformations }).valid, false);
});

test('manual Mayhem catalog and UI data retain the eight requested pilot champions', () => {
  const champions = JSON.parse(fs.readFileSync(path.join(root, 'data/aram-mayhem/champions.json'), 'utf8')).rows.map(row => row.championId);
  for (const champion of ['Ahri', 'Ryze', 'Cassiopeia', 'Azir', 'Jinx', 'Kaisa', 'Ornn', 'Soraka']) assert.ok(champions.includes(champion), champion);
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  for (const id of ['augment-headliner', 'augment-owned', 'augment-offer-1', 'augment-offer-2', 'augment-offer-3', 'augment-enemies']) assert.match(html, new RegExp(id));
});
