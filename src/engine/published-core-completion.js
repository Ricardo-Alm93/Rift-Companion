const { optimizeItemBuilds } = require('./build-search-optimizer.cjs');
function rows(value) { return Array.isArray(value) ? value : value ? [value] : []; }

function rankPublishedCoreCompletions({ coreIds = [], published = {}, itemCatalog = {}, validate, evaluateCombination = null, maxCandidatesPerSlot = 8, limit = 24 } = {}) {
  const core = coreIds.map(String);
  if (core.length !== 3 || new Set(core).size !== 3 || typeof validate !== 'function') return { combinations: [], slots: [] };
  const hasCoreBoots = core.some(id => itemCatalog[id]?.tags?.some(tag => ['boots', 'boot', 'botas'].includes(String(tag).toLowerCase())));
  // OP.GG publishes boots separately from item-stage distributions. If the
  // three-item core has no boots, reserve one inventory slot for the published
  // boot choice, then use the fourth/fifth item-stage samples for slots 5–6.
  // If boots are already in the core, retain the fourth/fifth/sixth stages.
  const stages = !hasCoreBoots && rows(published.boots).length
    ? ['boots', 'fourth_items', 'fifth_items']
    : ['fourth_items', 'fifth_items', 'sixth_items'];
  const candidates = stages.map(stage => rows(published[stage])
    .map(row => ({ row, id: Array.isArray(row?.ids) && row.ids.length === 1 ? String(row.ids[0]) : '' }))
    .filter(({ row, id }) => id && !core.includes(id) && itemCatalog[id] && Number(row.play) >= 20 && Number(row.pick_rate) > 0)
    .sort((a, b) => Number(b.row.pick_rate) - Number(a.row.pick_rate) || Number(b.row.play) - Number(a.row.play))
    .slice(0, maxCandidatesPerSlot));
  if (candidates.some(stage => !stage.length)) return { combinations: [], slots: [] };

  const candidateSlots = candidates.map((slotRows, index) => slotRows.map(({ row, id }) => ({
    itemId: id, stage: stages[index], source: 'published-item-stage', evidence: row,
    // A deterministic sample-support tie-breaker only; it is not a win-rate estimate.
    score: Math.log1p(Number(row.play) || 0) + Math.log1p(Number(row.pick_rate) || 0) * 2
  })));
  const optimized = optimizeItemBuilds({
    coreIds: core, candidateSlots, itemCatalog, validate,
    beamWidth: Math.max(1, maxCandidatesPerSlot ** stages.length), maxCandidatesPerSlot,
    limit, minDifferences: 1,
    evaluateCombination: (itemIds, context) => {
      if (context.partial) return null;
      return evaluateCombination?.(itemIds, context.validation) || null;
    }
  });
  const combinations = optimized.combinations.map(result => {
    const selected = result.evidence.map((entry, index) => ({ id: entry.itemId, row: entry.evidence, stage: stages[index] }));
    const publishedStageScore = selected.reduce((sum, item) => sum + Math.log1p(Number(item.row?.play) || 0) + Math.log1p(Number(item.row?.pick_rate) || 0) * 2, 0);
    return { ...result, publishedStageScore, jointEvaluation: result.evaluation, slots: selected.map((item, index) => ({ position: index + 4, stage: item.stage, itemId: item.id, name: itemCatalog[item.id]?.name || item.id, play: Number(item.row?.play) || 0, pickRate: Number(item.row?.pick_rate) || 0 })) };
  });
  const accepted = combinations;
  const slots = stages.map((stage, index) => ({
    stage,
    position: index + 4,
    label: `${index + 4}.º objeto`,
    items: [...new Map(accepted.flatMap(combo => combo.slots[index].stage === stage ? [combo.slots[index]] : []).map(item => [item.itemId, item])).values()].slice(0, 3)
  })).filter(stage => stage.items.length);
  return { combinations: accepted, slots, diagnostics: optimized.diagnostics };
}

module.exports = { rankPublishedCoreCompletions };
