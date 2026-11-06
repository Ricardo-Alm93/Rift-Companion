'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { optimizeItemBuilds } = require('../src/engine/build-search-optimizer.cjs');

const catalog = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index + 1), { id: String(index + 1), name: `Item ${index + 1}` }]));
const candidateSlots = Array.from({ length: 6 }, (_, slot) => [
  { itemId: String(slot + 1), score: 10, source: 'published-stage' },
  { itemId: String(slot + 5), score: 8, source: 'reviewed-profile' }
]);
const validate = ids => ({ valid: ids.length === 6 && new Set(ids).size === 6, errors: ids.length === 6 ? [] : ['six-slots-required'] });

test('beam search generates complete legal combinations jointly and reproducibly', () => {
  const request = { candidateSlots, itemCatalog: catalog, validate, beamWidth: 64, limit: 3 };
  const one = optimizeItemBuilds(request), two = optimizeItemBuilds(request);
  assert.deepEqual(one.combinations, two.combinations);
  for (const field of ['status', 'expandedStates', 'candidateRowsBeforeLimit', 'candidateCapReached', 'optimality']) assert.deepEqual(one.diagnostics[field], two.diagnostics[field]);
  assert.ok(one.combinations.length >= 2);
  assert.ok(one.combinations.every(row => row.itemIds.length === 6 && row.validation.valid));
  assert.equal(one.diagnostics.status, 'optimized');
  assert.ok(one.diagnostics.expandedStates <= 64 * 12);
});

test('fixed published core is preserved and duplicate or exclusive combinations are rejected', () => {
  const result = optimizeItemBuilds({
    coreIds: ['1', '2', '3'],
    candidateSlots: [[{ itemId: '1' }, { itemId: '4' }, { itemId: '7' }], [{ itemId: '5' }, { itemId: '8' }], [{ itemId: '6' }, { itemId: '9' }]],
    itemCatalog: catalog,
    validate: ids => ids.includes('4') ? { valid: false, errors: ['exclusive-group-conflict'] } : { valid: ids.length === 6, errors: [] },
    limit: 2
  });
  assert.ok(result.combinations.length >= 1);
  assert.deepEqual(result.combinations[0].itemIds.slice(0, 3), ['1', '2', '3']);
  assert.ok(result.diagnostics.rejected.some(row => row.reasons.includes('exclusive-group-conflict')));
});

test('combination callback can reject an untriggerable passive while keeping a coherent alternative', () => {
  const result = optimizeItemBuilds({
    candidateSlots: Array.from({ length: 6 }, (_, i) => [{ itemId: String(i + 1), score: 5 }, { itemId: String(i + 5), score: 4 }]),
    itemCatalog: catalog, validate,
    evaluateCombination: ids => ids.includes('10') ? { eligible: false, reasons: ['activation-requires-ally-heal-or-shield'] } : { eligible: true, score: ids.includes('9') ? 2 : 0 },
    limit: 3
  });
  assert.ok(result.combinations.length);
  assert.ok(result.combinations.every(row => !row.itemIds.includes('10')));
  assert.ok(result.diagnostics.rejected.some(row => row.reasons.includes('activation-requires-ally-heal-or-shield')));
});

test('missing evidence candidates produce an explicit partial result instead of fabricated slots', () => {
  const result = optimizeItemBuilds({ candidateSlots: [[{ itemId: '1' }], [], [{ itemId: '3' }]], itemCatalog: catalog, validate });
  assert.equal(result.combinations.length, 0);
  assert.equal(result.diagnostics.status, 'empty-candidate-slot');
});

test('bounded search reports candidate and state caps instead of implying a global optimum', () => {
  const result = optimizeItemBuilds({
    coreIds: [], itemCatalog: catalog,
    candidateSlots: [Array.from({ length: 6 }, (_, index) => ({ itemId: String(index + 1), score: index }))],
    maxCandidatesPerSlot: 2, maxExpandedStates: 1,
    validate: ids => ({ valid: ids.length === 1, errors: [] })
  });
  assert.equal(result.diagnostics.candidateCapReached, true);
  assert.equal(result.diagnostics.hitExpandedStateLimit, true);
  assert.equal(result.diagnostics.optimality, 'global-optimum-not-proven');
  assert.equal(result.diagnostics.candidatesPerSlot[0], 2);
  assert.ok(result.diagnostics.candidateRowsBeforeLimit[0] > 2);
});
