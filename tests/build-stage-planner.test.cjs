'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planRankedStages } = require('../src/engine/build-stage-planner.cjs');

const builds = [
  { id: 'standard', score: 40, itemIds: ['1','2','3','4','5','6'], purchaseOrder: Array.from({length:6},(_,i)=>({stage:i<2?'early':i<4?'mid':'late'})) },
  { id: 'vs-physical', score: 80, profileConditions: ['physical-burst'], itemIds: ['1','2','3','7','5','6'], purchaseOrder: Array.from({length:6},(_,i)=>({stage:i<2?'early':i<4?'mid':'late'})) }
];

test('stage planner preserves the baseline without a confirmed context signal', () => {
  const stages = planRankedStages({ options: builds, enemies: [] });
  assert.deepEqual(Object.values(stages).map(row => row.optionId), ['standard','standard','standard']);
  assert.equal(stages.early.status, 'baseline-no-context');
  assert.match(stages.early.reason, /conserva la misma build/i);
  assert.equal(stages.early.changedFromPreviousStage, false);
});

test('early only responds to a selected known lane rival and keeps a shared six-item progression', () => {
  const enemies = [{ championId: 'Zed', known: true, tags: ['physical-burst'] }, { championId: 'Rammus', known: true, tags: ['durable-frontline'] }];
  const noLane = planRankedStages({ options: builds, enemies, laneOpponentChampionId: '' });
  const lane = planRankedStages({ options: builds, enemies, laneOpponentChampionId: 'Zed' });
  assert.equal(noLane.early.optionId, 'standard');
  assert.equal(lane.early.optionId, 'vs-physical');
  assert.equal(lane.early.itemIds.length, 6);
  assert.deepEqual(lane.early.purchaseOrder, builds[1].purchaseOrder.slice(0, 2));
  assert.equal(lane.early.changedFromPreviousStage, false);
});

test('late-stage composition needs are considered without treating estimates as statistics', () => {
  const options = [builds[0], { ...builds[1], profileConditions: ['anti-heal'] }];
  const stages = planRankedStages({ options, enemies: [{ championId:'Soraka', known:true, tags:['healing'] }], composition: { needs: [{ id: 'anti-heal', mitigatedByAllies: false }] } });
  assert.equal(stages.late.optionId, 'vs-physical');
  assert.equal(stages.late.status, 'context-evaluated');
  assert.equal(stages.late.itemIds.length, 6);
  assert.match(stages.late.reason, /anti-heal/);
});

test('a stage can reprioritize purchases without changing the six selected items', () => {
  const baseline = { ...builds[0], itemIds: ['1','2','3','4','5','6'], finalSlots: ['1','2','3','4','5','6'] };
  const reordered = {
    ...builds[1], score: 41, itemIds: baseline.itemIds, finalSlots: baseline.finalSlots,
    purchaseOrder: [
      { stage: 'early', purchaseItemId: '4' }, { stage: 'early', purchaseItemId: '1' },
      { stage: 'mid', purchaseItemId: '2' }, { stage: 'mid', purchaseItemId: '3' },
      { stage: 'late', purchaseItemId: '5' }, { stage: 'late', purchaseItemId: '6' }
    ]
  };
  const stages = planRankedStages({ options: [baseline, reordered], enemies: [{ championId: 'Zed', known: true, tags: ['physical-burst'] }], laneOpponentChampionId: 'Zed' });
  assert.deepEqual(stages.early.itemIds, stages.mid.itemIds);
  assert.deepEqual(stages.mid.itemIds, stages.late.itemIds);
  assert.deepEqual(stages.early.purchaseOrder.map(row => row.purchaseItemId), ['4','1']);
  assert.deepEqual(stages.mid.purchaseOrder.map(row => row.purchaseItemId), ['2','3']);
  assert.deepEqual(stages.late.purchaseOrder.map(row => row.purchaseItemId), ['5','6']);
});

test('confirmed inventory constrains all projections and labels the next unbought slot', () => {
  const options = [
    { ...builds[0], finalSlots: builds[0].itemIds },
    { ...builds[1], finalSlots: builds[1].itemIds }
  ];
  const stages = planRankedStages({ options, enemies: [], boughtItemIds: ['1','2'] });
  for (const stage of Object.values(stages)) {
    assert.equal(stage.inventoryStatus, 'inventory-aware');
    assert.ok(stage.itemIds.includes('1') && stage.itemIds.includes('2'));
    assert.deepEqual(stage.itemStates.filter(row => row.state === 'bought').map(row => row.itemId).sort(), ['1','2']);
    assert.equal(stage.itemStates.filter(row => row.state === 'next').length, 1);
    assert.deepEqual(stage.acquiredItemIds.sort(), ['1','2']);
    assert.equal(stage.proposedItemIds.length, 4);
    assert.ok(stage.nextPurchaseItemId);
  }
});

test('without runtime inventory stages are explicitly marked as study projections', () => {
  const stages = planRankedStages({ options: builds, enemies: [] });
  assert.equal(stages.early.inventoryStatus, 'study-projection');
  assert.equal(stages.early.itemStates.filter(row => row.state === 'next').length, 1);
});

test('no stage plan silently drops confirmed inventory when all options conflict', () => {
  const stages = planRankedStages({ options: builds, enemies: [], boughtItemIds: ['99'] });
  assert.equal(stages.early.status, 'inventory-conflict');
  assert.deepEqual(stages.early.itemIds, []);
});
