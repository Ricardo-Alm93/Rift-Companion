'use strict';

const asId = value => String(typeof value === 'object' ? value.itemId ?? value.id ?? '' : value ?? '');
const stableCompare = (a, b) => b.score - a.score || a.itemIds.join('|').localeCompare(b.itemIds.join('|'));

/**
 * Deterministic bounded beam search. Every completed set is validated and evaluated
 * jointly; `score` is an evidence/heuristic weight and must never be presented as a
 * statistical outcome probability.
 */
function optimizeItemBuilds({
  candidateSlots = [], coreIds = [], itemCatalog = {}, validate = () => ({ valid: false }),
  validatePartial = null, evaluateCombination = null, beamWidth = 64,
  maxCandidatesPerSlot = 16, limit = 4, minDifferences = 2,
  maxExpandedStates = 50000, maxDurationMs = 2500, unorderedSets = false, setScoring = false
} = {}) {
  const startedAt = Date.now(), deadline = startedAt + Math.max(1, Number(maxDurationMs) || 2500);
  const core = coreIds.map(asId).filter(Boolean);
  if (!Array.isArray(candidateSlots) || !candidateSlots.length || typeof validate !== 'function') {
    return { combinations: [], diagnostics: { status: 'invalid-request', expandedStates: 0, rejected: [] } };
  }
  const candidateRowsBeforeLimit = [], slots = candidateSlots.map((rows, index) => {
    const unique = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = asId(row);
      if (!id || !itemCatalog[id] || unique.has(id)) continue;
      unique.set(id, { itemId: id, score: Number.isFinite(Number(row?.score)) ? Number(row.score) : 0, evidence: row?.evidence || null, source: row?.source || '', slot: index });
    }
    const ranked = [...unique.values()].sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
    candidateRowsBeforeLimit.push(ranked.length);
    return ranked.slice(0, Math.max(1, maxCandidatesPerSlot));
  });
  if (slots.some(rows => !rows.length)) return { combinations: [], diagnostics: { status: 'empty-candidate-slot', expandedStates: 0, rejected: [] } };

  const rejected = [], rejectedCap = 200;
  const rememberRejection = (itemIds, reasons) => { if (rejected.length < rejectedCap) rejected.push({ itemIds: [...itemIds], reasons: Array.isArray(reasons) ? reasons.slice(0, 8) : [String(reasons || 'rejected')] }); };
  let beam = [{ itemIds: core, score: 0, evidence: [] }], expandedStates = 0, partialCombinationsEvaluated = 0, stoppedBy = '';
  const maxStates = Math.max(1, Number(maxExpandedStates) || 50000);
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const next = new Map();
    search: for (const state of beam) for (const candidate of slots[slotIndex]) {
      if (expandedStates >= maxStates) { stoppedBy = 'expanded-state-limit'; break search; }
      if (Date.now() >= deadline) { stoppedBy = 'time-limit'; break search; }
      if (state.itemIds.includes(candidate.itemId)) continue;
      expandedStates++;
      const itemIds = [...state.itemIds, candidate.itemId];
      const partial = typeof validatePartial === 'function' ? validatePartial(itemIds) : null;
      if (partial?.valid === false) { rememberRejection(itemIds, partial.errors || ['partial-validation']); continue; }
      if (typeof evaluateCombination === 'function') partialCombinationsEvaluated++;
      const evaluation = typeof evaluateCombination === 'function' ? evaluateCombination(itemIds, { partial: true, slotIndex, candidate }) : null;
      if (evaluation?.eligible === false) { rememberRejection(itemIds, evaluation.reasons || ['combination-ineligible']); continue; }
      const score = setScoring ? Number(evaluation?.score) || 0 : state.score + candidate.score + (Number(evaluation?.score) || 0);
      const key = (unorderedSets ? [...itemIds].sort() : itemIds).join('|');
      if (next.has(key) && next.get(key).score >= score) continue;
      next.set(key, { itemIds, score, evidence: [...state.evidence, { itemId: candidate.itemId, source: candidate.source, evidence: candidate.evidence }], partialValidation: partial || null });
    }
    if (stoppedBy) break;
    beam = [...next.values()].sort(stableCompare).slice(0, Math.max(1, beamWidth));
    if (!beam.length) break;
  }

  const complete = [];
  let completeCandidatesEvaluated = 0;
  for (const state of beam) {
    if (state.itemIds.length !== core.length + slots.length || new Set(state.itemIds).size !== state.itemIds.length) continue;
    const validation = validate(state.itemIds);
    if (!validation?.valid) { rememberRejection(state.itemIds, validation?.errors || ['final-validation']); continue; }
    if (typeof evaluateCombination === 'function') completeCandidatesEvaluated++;
    const evaluation = typeof evaluateCombination === 'function' ? evaluateCombination(state.itemIds, { partial: false, validation }) : null;
    if (evaluation?.eligible === false) { rememberRejection(state.itemIds, evaluation.reasons || ['combination-ineligible']); continue; }
    complete.push({ itemIds: state.itemIds, score: setScoring ? Number(evaluation?.score) || 0 : state.score + (Number(evaluation?.score) || 0), validation, evaluation, evidence: state.evidence });
  }
  complete.sort(stableCompare);
  const selected = [];
  for (const candidate of complete) {
    const sufficientlyDifferent = selected.every(existing => candidate.itemIds.filter(id => !existing.itemIds.includes(id)).length >= minDifferences * (unorderedSets ? 1 : 2));
    if (!sufficientlyDifferent && selected.length) continue;
    selected.push(candidate);
    if (selected.length >= Math.max(1, limit)) break;
  }
  const elapsedMs = Date.now() - startedAt;
  const candidateCapReached = candidateRowsBeforeLimit.some((count, index) => count > slots[index].length);
  const stopped = !!stoppedBy;
  const rejectedByReason = {};
  for (const row of rejected) for (const reason of row.reasons || []) rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
  return { combinations: selected, diagnostics: {
    status: selected.length ? 'optimized' : 'no-valid-combination',
    searchScope: 'bounded-beam-search',
    optimality: stopped || candidateCapReached || beam.length >= Math.max(1, beamWidth) ? 'global-optimum-not-proven' : 'exhausted-within-configured-search',
    expandedStates, partialCombinationsEvaluated, completeCandidatesEvaluated,
    beamWidth: Math.max(1, beamWidth), candidateLimitPerSlot: Math.max(1, maxCandidatesPerSlot),
    candidatesPerSlot: slots.map(rows => rows.length), candidateRowsBeforeLimit,
    candidateCapReached, maxExpandedStates: maxStates, maxDurationMs: Math.max(1, Number(maxDurationMs) || 2500),
    hitExpandedStateLimit: stoppedBy === 'expanded-state-limit', hitTimeLimit: stoppedBy === 'time-limit',
    stoppedBy, elapsedMs, rejectedByReason, rejected
  } };
}

module.exports = { optimizeItemBuilds };
