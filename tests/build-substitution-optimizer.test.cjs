'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { optimizeBuildSubstitutions } = require('../src/engine/build-substitution-optimizer.cjs');
const { evaluateCompleteBuildSet } = require('../src/engine/build-set-strategy.cjs');

const catalog = Object.fromEntries([...Array(10)].map((_, index) => [String(index + 1), { id: String(index + 1), tags: index === 7 ? ['anti-heal'] : index === 8 ? ['health'] : ['damage'] }]));
const validSix = ids => ({ valid: ids.length === 6 && new Set(ids).size === 6 && ids.every(id => catalog[id]), errors: [] });

test('replacement search can change each unlocked position and preserves core/bought items', () => {
  const base = ['1','2','3','4','5','6'];
  const result = optimizeBuildSubstitutions({
    baseItemIds: base, itemCatalog: catalog,
    candidateItems: [{ itemId: '8', source: 'confirmed matchup advice', evidence: { source: 'reviewed' } }],
    lockedItemIds: ['1','6'], maxChanges: 1,
    validate: validSix,
    evaluate: ids => ({ score: ids.includes('8') ? 10 : 0, justified: ids.includes('8'), reasons: ['confirmed-defense-need'] })
  });
  assert.ok(result.alternatives.length);
  assert.deepEqual(result.alternatives[0].changedSlots.map(x => x.slot), [1]);
  assert.ok(result.alternatives.every(row => row.itemIds.includes('1') && row.itemIds.includes('6')));
  assert.ok(result.alternatives.every(row => row.itemIds.length === 6));
});

test('coordinated two-slot alternatives only pass when the whole set validates and gains evidence', () => {
  const result = optimizeBuildSubstitutions({
    baseItemIds: ['1','2','3','4','5','6'], itemCatalog: catalog,
    candidateItems: ['7','8'].map(itemId => ({ itemId, source: 'current patch item profile' })), maxChanges: 2, minimumGain: 3,
    validate: ids => validSix(ids) && !(ids.includes('7') && ids.includes('8')) ? validSix(ids) : { valid: false, errors: ['exclusive-items'] },
    evaluate: (ids, meta) => ({ score: ids.includes('7') && ids.includes('8') ? 12 : 0, justified: ids.includes('7') && ids.includes('8'), reasons: ['coordinated-set-evidence'] })
  });
  assert.equal(result.alternatives.length, 0);
  const valid = optimizeBuildSubstitutions({
    baseItemIds: ['1','2','3','4','5','6'], itemCatalog: catalog,
    candidateItems: ['7','8'].map(itemId => ({ itemId, source: 'current patch item profile' })), maxChanges: 2, minimumGain: 3,
    validate: validSix,
    evaluate: ids => ({ score: ids.includes('7') && ids.includes('8') ? 12 : 0, justified: ids.includes('7') && ids.includes('8'), reasons: ['coordinated-set-evidence'] })
  });
  assert.ok(valid.alternatives.some(row => row.changedSlots.length === 2));
});

test('unsupported candidates and unjustified changes keep the original complete build', () => {
  const result = optimizeBuildSubstitutions({ baseItemIds: ['1','2','3','4','5','6'], itemCatalog: catalog,
    candidateItems: [{ itemId: '7' }], validate: validSix, evaluate: () => ({ score: 99, justified: false }) });
  assert.equal(result.alternatives.length, 0);
  assert.equal(result.baseline.itemIds.length, 6);
  assert.ok(result.diagnostics.rejected.length > 0);
});

test('whole-set review discounts allied-covered needs and reports heuristic meaning', () => {
  const items = { '1': { tags: ['anti-heal'] }, '2': { tags: ['health'] }, '3': { tags: [] }, '4': { tags: [] }, '5': { tags: [] }, '6': { tags: [] } };
  const covered = evaluateCompleteBuildSet({ itemIds: Object.keys(items), itemCatalog: items, composition: { needs: [{ id: 'anti-heal', mitigatedByAllies: false }] } });
  const mitigated = evaluateCompleteBuildSet({ itemIds: Object.keys(items), itemCatalog: items, composition: { needs: [{ id: 'anti-heal', mitigatedByAllies: true }] } });
  assert.deepEqual(covered.coveredNeeds, ['anti-heal']);
  assert.deepEqual(mitigated.coveredNeeds, []);
  assert.equal(covered.scoreMeaning, 'heuristic-weight-not-winrate');
  assert.equal(covered.opportunityCost.status, 'qualitative-review-required');
});

test('published purchase-order alternative can retain all six item IDs and change sequence only', () => {
  const base = ['1','2','3','4','5','6'];
  const order = base.map((finalItemId, index) => ({ order: index + 1, purchaseItemId: finalItemId, finalItemId, stage: index < 2 ? 'early' : index < 4 ? 'mid' : 'late' })).reverse();
  const result = optimizeBuildSubstitutions({
    baseItemIds: base, itemCatalog: catalog, validate: validSix,
    candidateItems: [], alternativeOrders: [{ purchaseOrder: order, source: 'published current-patch purchase order', evidence: { source: 'OP.GG' } }],
    evaluate: (_ids, context) => ({ justified: context.kind === 'order-only', eligible: true, score: 0, reasons: ['published-order-alternative'] })
  });
  const choice = result.alternatives.find(row => row.kind === 'order-only');
  assert.ok(choice);
  assert.deepEqual(choice.itemIds, base);
  assert.deepEqual(choice.purchaseOrder.map(row => row.finalItemId), order.map(row => row.finalItemId));
});
