'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reportPath = path.join(__dirname, '../data/ranked/generalization-report-16.22.1.json');
const report = fs.existsSync(reportPath) ? require(reportPath) : null;
const reportTest = report ? test : test.skip;
const profiles = require('../data/champion-build-profiles.json');

reportTest('generalization report covers five unprofiled champion-role pairs using the captured 16.22 source audit', () => {
  assert.equal(report.statisticsPatch, '16.22');
  assert.equal(report.catalogPatch, '16.22.1');
  assert.equal(report.results.length, 5);
  assert.equal(report.results.reduce((sum, row) => sum + row.contexts.length, 0), 35);
  for (const row of report.results) {
    assert.equal(row.manualSixItemProfilePresent, false);
    assert.equal(row.sourceStatus, 'success');
    assert.equal(row.sourcePatch, '16.22');
    assert.equal(row.contexts.length, 7);
    assert.ok(row.contexts.every(context => !('winRate' in (context.recommended || {}))));
  }
  assert.deepEqual(report.results.map(row => row.championId).sort(), ['KogMaw', 'Nami', 'Sejuani', 'Talon', 'Viktor']);
  for (const row of report.results) assert.equal(profiles.champions[row.championId]?.roles?.[row.role]?.some(profile => profile.itemIds?.length === 6) || false, false);
});

reportTest('partial-source cases stay partial instead of filling low-sample Nami or Sejuani slots', () => {
  for (const championId of ['Nami', 'Sejuani']) {
    const row = report.results.find(result => result.championId === championId);
    const baseline = row.contexts.find(context => context.scenarioId === 'baseline-no-enemies');
    assert.equal(baseline.recommended, null);
    assert.ok(baseline.partialCore?.itemIds.length >= 3 && baseline.partialCore.itemIds.length < 6);
    assert.ok(baseline.diagnostics.sourceRejections.length === 0 || baseline.diagnostics.sourceRejections.every(rejection => rejection.codes?.some(code => /activation|compatibility/i.test(code))));
  }
});

reportTest('context variants remain separately attributed and only appear when a known need is covered', () => {
  const viktor = report.results.find(row => row.championId === 'Viktor');
  const baseline = viktor.contexts.find(row => row.scenarioId === 'baseline-no-enemies');
  const healing = viktor.contexts.find(row => row.scenarioId === 'healing-composition');
  assert.equal(baseline.alternatives.length, 0);
  assert.ok(healing.alternatives.length > 0);
  assert.ok(healing.alternatives.every(alternative => alternative.sourceKind === 'strategic-substitution' && alternative.buildType === 'generated'));
  assert.ok(healing.alternatives.every(alternative => alternative.reasons.includes('confirmed-composition-need:anti-heal')));
  assert.ok(healing.alternatives.every(alternative => alternative.itemIds.length === 6 && new Set(alternative.itemIds).size === 6));
  assert.ok(healing.alternatives.every(alternative => alternative.itemIds.join('|') !== baseline.recommended.itemIds.join('|')));
  assert.ok(healing.alternatives.every(alternative => alternative.itemIds.includes('3165')));
  assert.ok(healing.alternatives.every(alternative => !alternative.itemIds.includes('3033') && !alternative.itemIds.includes('3075')), 'Mage anti-heal alternatives cannot substitute in a physical crit or reflection/armor item without matching archetype and conditions');
  const talonHealing = report.results.find(row => row.championId === 'Talon').contexts.find(row => row.scenarioId === 'healing-composition');
  assert.equal(talonHealing.alternatives.length, 0, 'no physical-crit or frontline-reflection anti-heal candidate is forced into an AD assassin');
});

reportTest('Zed comparison preserves provenance, validates the Serylda substitution, and rejects both penetration items together', () => {
  assert.match(report.zedItemReview.profile, /prior engine example/i);
  assert.equal(report.zedItemReview.swapValidated, true);
  assert.equal(report.zedItemReview.coexistenceRejected, true);
  assert.equal(report.zedItemReview.lordDominiks.exclusiveGroup, report.zedItemReview.seryldas.exclusiveGroup);
  assert.ok(report.zedItemReview.lordDominiks.tags.includes('anti-health'));
  assert.ok(report.zedItemReview.seryldas.tags.includes('abilityhaste'));
});

reportTest('bounded optimization diagnostics disclose alternatives, rejections, and search limits', () => {
  const contexts = report.results.flatMap(row => row.contexts);
  assert.ok(contexts.every(context => Number.isInteger(context.diagnostics.candidateCount)));
  assert.ok(contexts.every(context => Number.isInteger(context.diagnostics.combinationCandidatesEvaluated)));
  assert.ok(contexts.every(context => Array.isArray(context.diagnostics.searchLimits)));
  assert.ok(contexts.every(context => !context.diagnostics.candidateCapReached || context.diagnostics.searchLimits.some(limit => limit.candidateLimitReached)));
  assert.ok(report.scenarioLimitations.some(row => /not statistical|not measured/i.test(row)));
});
