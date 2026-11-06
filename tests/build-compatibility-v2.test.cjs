'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBuildCompatibility, resolveAugmentStatConversions } = require('../src/engine/build-compatibility-v2.cjs');
const rules = require('../data/ranked/item-activation-rules-16.22.1.json');

test('Ranked compatibility rejects Zed manacost/ally-heal passives without banning legal item ownership globally', () => {
  const itemCatalog = { '2522': { id: '2522', tags: ['SpellDamage', 'Mana', 'AbilityHaste'] }, '3504': { id: '3504', tags: ['SpellDamage', 'ManaRegen', 'HealShield'] } };
  const result = evaluateBuildCompatibility({ itemIds: ['2522', '3504'], itemCatalog, champion: { partype: 'Energy' }, mechanics: { championId: 'Zed', patch: '16.22.1', resource: 'Energy', abilityFacts: [{ effects: ['physical-damage'] }] }, activationRules: rules, patch: '16.22.1' });
  assert.deepEqual(result.rejectedItemIds, ['2522', '3504']);
  assert.ok(result.rows[0].issues.some(issue => issue.code === 'activation-requires-mana'));
  assert.ok(result.rows[1].issues.some(issue => issue.code === 'activation-requires-ally-heal-or-shield'));
});

test('support healer compatibility can retain Ardent Censer when an ally heal is documented', () => {
  const result = evaluateBuildCompatibility({ itemIds: ['3504'], itemCatalog: { '3504': { id: '3504', tags: ['SpellDamage', 'ManaRegen', 'HealShield'] } }, champion: { partype: 'Mana' }, mechanics: { championId: 'Soraka', patch: '16.22.1', resource: 'Mana', abilityFacts: [{ effects: ['healing'] }] }, activationRules: rules, patch: '16.22.1' });
  assert.deepEqual(result.rejectedItemIds, []);
  assert.ok(result.rows[0].supported.includes('ardent-censer-ally-heal-shield:activation'));
});

test('Mayhem conversions require selected, verified, patch-matched evidence and do not grant passive activations', () => {
  const rules = [{ augmentId: 'fixture', from: 'AP', to: 'AD', ratio: 1, patch: '26.22', verified: true, source: 'fixture official note' }];
  const converted = resolveAugmentStatConversions({ stats: { ap: 100 }, selectedAugments: ['fixture'], conversionRules: rules, patch: '26.22' });
  assert.deepEqual(converted.stats, { ad: 100 });
  assert.equal(converted.status, 'documented-conversion-applied');
  const unverified = resolveAugmentStatConversions({ stats: { ap: 100 }, selectedAugments: ['fixture'], conversionRules: [{ ...rules[0], verified: false }], patch: '26.22' });
  assert.deepEqual(unverified.stats, { ap: 100 });
  const cycle = resolveAugmentStatConversions({ stats: { ap: 100 }, selectedAugments: ['fixture', 'back'], conversionRules: [...rules, { augmentId: 'back', from: 'AD', to: 'AP', ratio: 1, patch: '26.22', verified: true, source: 'fixture official note' }], patch: '26.22' });
  assert.equal(cycle.applied.length, 1);
  assert.equal(cycle.stats.ad, 100);
  const itemCheck = evaluateBuildCompatibility({ itemIds: ['3504'], itemCatalog: { '3504': { id: '3504', tags: [] } }, champion: { partype: 'Energy' }, mechanics: { resource: 'Energy', abilityFacts: [] }, activationRules: { rules: [{ itemId: '3504', requires: ['ally-heal-or-shield'] }] }, mode: 'aram-mayhem', selectedAugments: ['fixture'], conversionRules: rules, patch: '26.22' });
  assert.equal(itemCheck.rows[0].eligible, false);
});
