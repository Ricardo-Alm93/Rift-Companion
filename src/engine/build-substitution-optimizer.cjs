'use strict';

const idsOf = build => (build || []).map(value => String(typeof value === 'object' ? value.itemId ?? value.id ?? '' : value ?? '')).filter(Boolean);

/**
 * Compare a complete build against evidence-backed item candidates. Scores are
 * heuristic weights supplied by the caller, never a probability or win rate.
 */
function optimizeBuildSubstitutions({
  baseItemIds = [], candidateItems = [], itemCatalog = {}, validate = () => ({ valid: false }),
  evaluate = () => ({ score: 0, justified: false }), lockedItemIds = [], maxChanges = 2,
  minimumGain = 1, limit = 6, minDifferences = 1, alternativeOrders = [], maxCandidates = 64
} = {}) {
  const base = idsOf(baseItemIds), locked = new Set(lockedItemIds.map(String));
  const invalid = reason => ({ baseline: null, alternatives: [], diagnostics: { status: reason, rejected: [] } });
  if (base.length !== 6 || new Set(base).size !== 6 || base.some(id => !itemCatalog[id])) return invalid('invalid-base-build');
  const baselineValidation = validate(base);
  if (!baselineValidation?.valid) return invalid('invalid-base-build');
  const baseEval = evaluate(base, { kind: 'baseline', changedSlots: [] }) || {};
  const candidateMap = new Map(), rejected = [];
  for (const row of candidateItems) {
    const id = String(row?.itemId ?? row?.id ?? '');
    if (!id || !itemCatalog[id] || base.includes(id)) continue;
    const evidence = row.evidence || row.sourceEvidence || null;
    // Candidates without a traceable source/profile are not eligible to change a set.
    if (!evidence && !row.source) { rejected.push({ itemIds: [id], reason: 'missing-candidate-provenance' }); continue; }
    const previous = candidateMap.get(id);
    const priority = Number(row.priority ?? row.score ?? 0) || 0;
    if (!previous || priority > previous.priority) candidateMap.set(id, { itemId: id, source: row.source || evidence?.source || '', evidence, priority });
  }
  const allCandidates = [...candidateMap.values()].sort((a, b) => b.priority - a.priority || a.itemId.localeCompare(b.itemId));
  const candidates = allCandidates.slice(0, Math.max(1, Number(maxCandidates) || 64));
  if (candidates.length < allCandidates.length) rejected.push({ itemIds: allCandidates.slice(candidates.length).map(row => row.itemId), reason: 'candidate-limit' });
  const results = [];
  let combinationsEvaluated = 0;
  const max = Math.max(0, Math.min(2, Number(maxChanges) || 0));
  const consider = (itemIds, changedSlots) => {
    combinationsEvaluated++;
    const key = itemIds.join('|');
    if (new Set(itemIds).size !== 6) { rejected.push({ itemIds, reason: 'duplicate-item' }); return; }
    const validation = validate(itemIds);
    if (!validation?.valid) { rejected.push({ itemIds, reason: 'technical-validation', errors: validation?.errors || [] }); return; }
    const result = evaluate(itemIds, { kind: 'substitution', changedSlots, validation }) || {};
    const gain = Number(result.score || 0) - Number(baseEval.score || 0);
    if (result.eligible === false || result.justified !== true || gain < minimumGain) {
      rejected.push({ itemIds, reason: result.eligible === false ? 'strategy-ineligible' : 'no-supported-improvement', reasons: result.reasons || [] }); return;
    }
    results.push({ itemIds, validation, evaluation: result, score: Number(result.score) || 0, gain, changedSlots, evidence: changedSlots.map(change => candidateMap.get(change.to)) });
  };
  for (let slot = 0; slot < base.length; slot++) {
    if (locked.has(base[slot])) continue;
    for (const candidate of candidates) {
      const next = [...base]; next[slot] = candidate.itemId;
      consider(next, [{ slot, from: base[slot], to: candidate.itemId }]);
    }
  }
  if (max >= 2) {
    const oneChanges = [];
    for (let slot = 0; slot < base.length; slot++) {
      if (locked.has(base[slot])) continue;
      for (const candidate of candidates) oneChanges.push({ slot, from: base[slot], to: candidate.itemId });
    }
    for (let i = 0; i < oneChanges.length; i++) for (let j = i + 1; j < oneChanges.length; j++) {
      const a = oneChanges[i], b = oneChanges[j];
      if (a.slot === b.slot || a.to === b.to) continue;
      const next = [...base]; next[a.slot] = a.to; next[b.slot] = b.to;
      consider(next, [a, b]);
    }
  }
  results.sort((a, b) => b.score - a.score || a.changedSlots.length - b.changedSlots.length || (a.changedSlots[0]?.slot ?? 99) - (b.changedSlots[0]?.slot ?? 99) || a.itemIds.join('|').localeCompare(b.itemIds.join('|')));
  const selected = [];
  for (const row of results) {
    if (selected.some(other => row.itemIds.filter(id => !other.itemIds.includes(id)).length < minDifferences * 2)) continue;
    selected.push(row);
    if (selected.length >= limit) break;
  }
  for (const row of alternativeOrders) {
    const order = row?.purchaseOrder;
    if (!row?.evidence && !row?.source || !Array.isArray(order) || order.length < 2) continue;
    const result = evaluate(base, { kind: 'order-only', purchaseOrder: order, evidence: row.evidence }) || {};
    if (result.eligible === false || result.justified !== true) continue;
    if (!order.every(step => base.includes(String(step.finalItemId || step.purchaseItemId || '')))) continue;
    selected.push({ itemIds: base, validation: baselineValidation, evaluation: result, score: Number(result.score) || 0, gain: Number(result.score || 0) - Number(baseEval.score || 0), changedSlots: [], kind: 'order-only', purchaseOrder: order, evidence: row.evidence, reasons: result.reasons || [] });
  }
  return {
    baseline: { itemIds: base, validation: baselineValidation, evaluation: baseEval, score: Number(baseEval.score) || 0 },
    alternatives: selected,
    diagnostics: { status: selected.length ? 'alternatives-found' : 'baseline-retained', candidateCount: allCandidates.length, candidatesEvaluated: candidates.length, candidateLimit: Math.max(1, Number(maxCandidates) || 64), candidateLimitReached: candidates.length < allCandidates.length, combinationCandidatesEvaluated: combinationsEvaluated, rejected: rejected.slice(0, 120), lockedItemIds: [...locked], lockedSlots: base.map((id, slot) => locked.has(id) ? slot : -1).filter(slot => slot >= 0) }
  };
}

module.exports = { optimizeBuildSubstitutions };
