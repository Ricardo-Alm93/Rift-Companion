'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const patch = '16.22.1';
const { buildItemCatalog, validateBuildItems } = require('../src/engine/item-eligibility');
const { optimizeBuildSubstitutions } = require('../src/engine/build-substitution-optimizer.cjs');
const { evaluateCompleteBuildSet } = require('../src/engine/build-set-strategy.cjs');
const { createBuildAdvisor } = require('../src/engine/build-candidate-generator');
const { createThreatProfiler } = require('../src/engine/champion-threat-profiler');
const { normalizeChampionAbilityProfile } = require('../src/domain/champion-abilities');
const { createChampionMechanicsProfile } = require('../src/engine/champion-mechanics-profiler');

const itemData = require(`../data/dragon/cdn/${patch}/data/en_US/item.json`);
const championDefinitions = require(`../data/dragon/cdn/${patch}/data/en_US/champion.json`).data;
const taxonomy = require('../data/item-taxonomy.json');
const exclusiveGroups = require(`../data/ranked/item-groups-${patch}.json`);
const itemCatalog = buildItemCatalog({ itemData, taxonomy, patch, exclusiveGroups });
const profiles = require('../data/champion-build-profiles.json');
const threatProfiles = require('../data/champion-threat-profiles.json');
const advisor = createBuildAdvisor({
  buildProfiles: profiles,
  threatProfiles,
  matchupAdvice: require('../data/champion-matchup-item-advice.json'),
  itemAdvice: require('../data/item-advice.json'),
  itemCatalog,
  championDefinitions,
  profileChampion: createThreatProfiler({ champions: championDefinitions, threatProfiles }),
  patch,
  exclusiveGroups
});
const pilotFixtures = require('./fixtures/ranked-pilot-fixtures.cjs');
const pilotAdvisor = createBuildAdvisor({
  buildProfiles: { ...profiles, champions: { ...profiles.champions, ...pilotFixtures.champions } },
  threatProfiles,
  matchupAdvice: require('../data/champion-matchup-item-advice.json'),
  itemAdvice: require('../data/item-advice.json'),
  itemCatalog,
  championDefinitions,
  profileChampion: createThreatProfiler({ champions: championDefinitions, threatProfiles }),
  patch,
  exclusiveGroups
});

const roster = (championIds = []) => championIds.map((championId, slot) => ({ championId, slot, team: 'enemy', role: null, status: 'confirmed', confirmed: true, visible: true }));

test('V2 Zed prior engine example is labeled accurately and is not swapped just because tanks appear', () => {
  // Prior engine example, not a user-validated or OP.GG-observed set.
  const baseline = ['6699', '2520', '3036', '3158', '3814', '2517'];
  const profile = profiles.champions.Zed.roles.mid[0];
  assert.equal(profile.provenanceKind, 'prior_engine_proposal');
  assert.equal(profile.confidence, 'prior-engine-proposal');
  assert.match(profile.source, /propuesta previa usada en un ejemplo/i);
  const legal = validateBuildItems(baseline, itemCatalog, { patch, exclusiveGroups, championId: 'Zed', role: 'mid' });
  assert.equal(legal.valid, true);
  assert.equal(itemCatalog['3036'].tags.includes('percent-armor-pen'), true);
  assert.equal(itemCatalog['3036'].tags.includes('anti-health'), true);
  assert.equal(itemCatalog['6694'].tags.includes('abilityhaste'), true);
  assert.equal(itemCatalog['6694'].tags.includes('percent-armor-pen'), true);
  const seryldaSwap = ['6699', '2520', '6694', '3158', '3814', '2517'];
  assert.equal(validateBuildItems(seryldaSwap, itemCatalog, { patch, exclusiveGroups, championId: 'Zed', role: 'mid' }).valid, true);
  const bothPenetrationItems = ['6699', '2520', '3036', '6694', '3814', '2517'];
  const exclusiveConflict = validateBuildItems(bothPenetrationItems, itemCatalog, { patch, exclusiveGroups, championId: 'Zed', role: 'mid' });
  assert.equal(exclusiveConflict.valid, false);
  assert.ok(exclusiveConflict.errors.includes('unique-group-conflict'));
  const ordinary = advisor({ player: { championId: 'Zed', role: 'mid' }, enemies: [] }, 'es').options[0];
  const vsFrontline = advisor({ player: { championId: 'Zed', role: 'mid' }, enemies: roster(['Ornn', 'Rammus']) }, 'es').options[0];
  assert.ok(ordinary && vsFrontline, 'the offline trainer can use the prior engine proposal as a review baseline');
  assert.equal(ordinary.evidenceType, 'educational-generated');
  assert.notEqual(ordinary.buildType, 'observed');
  assert.equal(ordinary.finalSlots.length, 6);
  assert.deepEqual(vsFrontline.finalSlots, ordinary.finalSlots, 'standard is independent of enemy selection');
  assert.equal(vsFrontline.winRate, undefined);

  const evaluate = ids => evaluateCompleteBuildSet({
    itemIds: ids,
    itemCatalog,
    composition: { needs: [{ id: 'anti-tank-damage', mitigatedByAllies: false }] }
  });
  const before = evaluate(baseline);
  assert.deepEqual(before.coveredNeeds, ['anti-tank-damage']);
  const compareSerylda = optimizeBuildSubstitutions({
    baseItemIds: baseline,
    candidateItems: [{ itemId: '6694', source: 'current-patch published Talon stage candidate', evidence: { source: 'OP.GG patch 16.22 item-stage sample', itemId: '6694' } }],
    itemCatalog,
    lockedItemIds: ['6699', '3158'],
    validate: ids => validateBuildItems(ids, itemCatalog, { patch, exclusiveGroups, championId: 'Zed', role: 'mid' }),
    evaluate: ids => {
      const set = evaluate(ids);
      const gained = set.coveredNeeds.filter(id => !before.coveredNeeds.includes(id));
      return { score: set.score, justified: gained.length > 0, reasons: gained };
    }
  });
  assert.equal(compareSerylda.alternatives.length, 0, 'without a confirmed need, Serylda does not replace Lord Dominik merely for having armor penetration too');
  assert.deepEqual(compareSerylda.baseline.itemIds, baseline);
  assert.equal(compareSerylda.diagnostics.rejected.some(row => row.reason === 'no-supported-improvement'), true);
  const result = optimizeBuildSubstitutions({
    baseItemIds: baseline,
    itemCatalog,
    candidateItems: [{ itemId: '3033', source: 'current patch item catalog', evidence: { source: 'Rift Companion 16.22.1 catalog' } }],
    lockedItemIds: ['6699', '3158'],
    validate: ids => validateBuildItems(ids, itemCatalog, { patch, exclusiveGroups, championId: 'Zed', role: 'mid' }),
    evaluate: ids => {
      const next = evaluate(ids);
      const gained = next.coveredNeeds.filter(id => !before.coveredNeeds.includes(id));
      return { score: next.score, justified: gained.length > 0, reasons: gained };
    }
  });
  assert.equal(result.alternatives.length, 0, 'a second similar armor-penetration item does not prove a better full set');
  assert.deepEqual(result.baseline.itemIds, baseline);
});

test('unprofiled five champion pilot builds from the local published-data audit without adding manual six-item profiles', t => {
  const auditPath = path.join(__dirname, '../data/ranked/opgg-live-audit-batch-2026-11-04-expansion.json');
  if (!fs.existsSync(auditPath)) { t.skip('Local OP.GG audit is excluded from the repository; source-backed expansion validation requires a private local snapshot.'); return; }
  const audit = require(auditPath);
  const seed = require('../data/ranked/champion-role-seed-16.21.1.json');
  const sourceOnly = createBuildAdvisor({ archetypeSeed: seed, threatProfiles, itemAdvice: require('../data/item-advice.json'), itemPurposeCatalog: require('../data/ranked/item-purposes-16.22.1.json'), itemActivationRules: require('../data/ranked/item-activation-rules-16.22.1.json'), itemCatalog, championDefinitions, profileChampion: createThreatProfiler({ champions: championDefinitions, threatProfiles }), patch, exclusiveGroups });
  const roles = { TALON: ['Talon', 'mid'], VIKTOR: ['Viktor', 'mid'], NAMI: ['Nami', 'support'], KOGMAW: ['KogMaw', 'adc'], SEJUANI: ['Sejuani', 'jungle'] };
  const expected = { Talon: 'complete', Viktor: 'complete', Nami: 'partial', KogMaw: 'complete', Sejuani: 'partial' };
  for (const [sourceId, [championId, role]] of Object.entries(roles)) {
    assert.equal(profiles.champions[championId]?.roles?.[role]?.some(row => row.itemIds?.length === 6) || false, false, `${championId}/${role} must not rely on a manual six-item build`);
    const query = audit.queries.find(row => row.champion === sourceId && row.returnedPosition === ({ mid: 'MID', support: 'SUPPORT', adc: 'ADC', jungle: 'JUNGLE' })[role]);
    assert.ok(query && query.sourceStatus === 'success' && query.patch === '16.22');
    const abilities = normalizeChampionAbilityProfile(require(`../data/dragon/cdn/16.22.1/data/en_US/champion/${championId}.json`), { championId, version: '16.22.1', locale: 'en_US', retrievedAt: '2026-11-04T00:00:00.000Z' });
    const mechanics = createChampionMechanicsProfile(abilities, { role });
    const publishedData = { champion: query.champion, position: query.returnedPosition, patch: query.patch, summary: { average_stats: { play: query.sample.play }, positions: query.positions.map(row => ({ name: row.name, stats: { play: row.play } })) }, core_items: query.coreItems, boots: query.boots, last_items: query.lastItems, fourth_items: query.fourthItems, fifth_items: query.fifthItems, sixth_items: query.sixthItems };
    const result = sourceOnly({ player: { championId, role }, championMechanics: mechanics, publishedData: { source: audit.source, sourceQueried: true, queryContext: { championId, position: role }, data: publishedData } }, 'es');
    const full = result.options.find(option => option.finalSlots?.length === 6 && option.buildType === 'generated');
    assert.equal(!!full, expected[championId] === 'complete', `${championId}: expected ${expected[championId]}`);
    if (full) {
      assert.equal(full.validation.valid, true);
      assert.equal(new Set(full.finalSlots).size, 6);
      assert.equal(full.purchaseOrder.length, 6);
      assert.equal(full.winRate, undefined);
      assert.equal(full.sourceKind, 'published_core_plus_slot_candidates');
    } else {
      assert.ok(result.options.some(option => option.buildType === 'partial-core'), `${championId}: preserve a partial published core`);
      assert.notEqual(result.status, 'build-ready');
    }
  }
});

test('V2 Ahri compares a durable-frontline set that keeps Rabadon against the standard set', () => {
  const result=advisor({player:{championId:'Ahri',role:'mid'},enemies:roster(['Ornn','Rammus'])},'es');
  const standard=result.scenarios.standard.recommended;
  const sustained=result.scenarios.team.variants.find(option=>option.archetypeId==='sustained'&&option.itemIds.includes('6653'));
  assert.ok(standard&&sustained);assert.ok(sustained.itemIds.includes('3089'));assert.ok(sustained.itemIds.includes('6653'));assert.ok(sustained.itemIds.includes('3135'));
  assert.equal(sustained.validation.valid,true);assert.equal(sustained.winRate,undefined);assert.ok(result.scenarios.team.deltaFromStandard.reason);
});

test('V2 Jinx reserves Mortal Reminder for confirmed healing and explains the displaced value', () => {
  const standard=pilotAdvisor({player:{championId:'Jinx',role:'adc'},enemies:[]},'es');
  const healing=pilotAdvisor({player:{championId:'Jinx',role:'adc'},enemies:roster(['Soraka'])},'es');
  assert.equal(standard.options.some(option=>option.itemIds.includes('3033')),false);
  const option=healing.scenarios.team.variants.find(option=>option.itemIds.includes('3033'));
  assert.ok(option);assert.ok(option.tradeoffs.length);assert.equal(option.winRate,undefined);
});

test('V2 Soraka keeps enchanter utility and only surfaces protection for confirmed backline threats', () => {
  const standard=pilotAdvisor({player:{championId:'Soraka',role:'support'},enemies:[]},'es');
  const threatened=pilotAdvisor({player:{championId:'Soraka',role:'support'},enemies:roster(['Zed','Talon'])},'es');
  const baseline=standard.scenarios.standard.recommended,protection=threatened.scenarios.team.variants.find(option=>option.itemIds.includes('3190'));
  assert.ok(baseline&&protection);assert.ok(protection.itemIds.includes('3870'));assert.ok(protection.itemIds.includes('6617'));assert.equal(protection.validation.valid,true);assert.ok(protection.tradeoffs.length);
});
