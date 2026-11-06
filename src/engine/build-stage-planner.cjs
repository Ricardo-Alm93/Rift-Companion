'use strict';

const conditionAliases = Object.freeze({
  'physical-heavy': ['physical', 'physical-heavy', 'physical-burst'],
  'magic-heavy': ['magic', 'magic-heavy', 'magic-burst'],
  healing: ['healing', 'sustain'],
  'durable-frontline': ['durable-frontline'],
  'anti-tank-damage': ['durable-frontline'],
  'anti-heal': ['healing', 'sustain'],
  'survive-burst': ['physical-burst', 'magic-burst'],
  'physical-burst': ['physical-burst'],
  'magic-burst': ['magic-burst']
});

function planRankedStages({ options = [], enemies = [], laneOpponentChampionId = '', composition = {}, language = 'es', boughtItemIds = [] } = {}) {
  const known = enemies.filter(row => row?.known && row.championId), lane = String(laneOpponentChampionId || '');
  const bought = new Set(boughtItemIds.map(String));
  const stageContexts = {
    early: { rows: lane ? known.filter(row => row.championId === lane) : [], label: language === 'en' ? 'Lane matchup' : 'Enfrentamiento de línea' },
    mid: { rows: known, label: language === 'en' ? 'Skirmishes and objectives' : 'Escaramuzas y objetivos' },
    late: { rows: known, label: language === 'en' ? 'Full confirmed composition' : 'Composición confirmada' }
  };
  const output = {};
  for (const [stage, context] of Object.entries(stageContexts)) {
    const tags = new Set(context.rows.flatMap(row => row.tags || []));
    const needs = new Set(stage === 'late' ? (composition.needs || []).filter(row => !row.mitigatedByAllies).map(row => typeof row === 'string' ? row : row.id) : []);
    const scored = options.map(option => {
      const itemIds = (option.finalSlots || option.itemIds || []).map(String);
      const incompatibleBought = [...bought].filter(id => !itemIds.includes(id));
      if (itemIds.length !== 6 || incompatibleBought.length) return { option, score: Number.NEGATIVE_INFINITY, matchedConditions: [], incompatibleBought };
      const conditions = option.profileConditions || [];
      const matches = conditions.filter(condition => (conditionAliases[condition] || [condition]).some(tag => tags.has(tag) || needs.has(condition)));
      // With no confirmed lane rival or no relevant full-team signal, retain the
      // same baseline. A new enemy alone must not force a different set.
      const contextual = context.rows.length ? matches.length * (stage === 'early' ? 32 : stage === 'mid' ? 22 : 26) : 0;
      const standard = conditions.length ? 0 : 12;
      // Conditional alternatives have no value for this stage unless their
      // condition is confirmed in that stage's context. In particular, a
      // source ranking score must not switch an early lane build before the
      // selected lane opponent is known.
      const baseScore = conditions.length && !matches.length
        ? Number.NEGATIVE_INFINITY
        : (Number(option.score) || 0);
      return { option, score: baseScore + contextual + standard, matchedConditions: matches };
    }).sort((a, b) => b.score - a.score || String(a.option.id).localeCompare(String(b.option.id)));
    const chosen = scored.find(row => Number.isFinite(row.score));
    const plannedOrder = chosen ? [...(chosen.option.purchaseOrder || [])] : [];
    const nextUnbought = plannedOrder.find(step => { const id = String(step.finalItemId || step.purchaseItemId || ''); return id && !bought.has(id); });
    const selectedIds = (chosen?.option.finalSlots || chosen?.option.itemIds || []).map(String);
    const nextItemId = nextUnbought ? String(nextUnbought.finalItemId || nextUnbought.purchaseItemId || '') : selectedIds.find(id => !bought.has(id)) || null;
    const itemStates = chosen ? (chosen.option.finalSlots || chosen.option.itemIds || []).map((itemId, index) => {
      const id = String(itemId), isBought = bought.has(id);
      return { itemId: id, state: isBought ? 'bought' : id === nextItemId ? 'next' : 'future', slot: index + 1 };
    }) : [];
    output[stage] = chosen ? {
      stage, context: context.label, optionId: chosen.option.id,
      itemIds: (chosen.option.finalSlots || chosen.option.itemIds || []).map(String),
      purchaseOrder: (chosen.option.purchaseOrder || []).filter(step => step.stage === stage),
      itemStates,
      inventoryStatus: bought.size ? 'inventory-aware' : 'study-projection',
      boughtItemIds: [...bought],
      nextPurchaseItemId: nextItemId,
      matchedConditions: chosen.matchedConditions,
      status: context.rows.length ? 'context-evaluated' : 'baseline-no-context',
      changedFromPreviousStage: false,
      reason: chosen.matchedConditions.length
        ? (language === 'en' ? `This profile answers confirmed ${chosen.matchedConditions.join(', ')} pressure; compare its costs before switching.` : `Este perfil responde a ${chosen.matchedConditions.join(', ')} confirmado; compara sus costes antes de cambiar.`)
        : (language === 'en' ? 'No stage-specific evidence justifies changing the current direction.' : 'No hay evidencia específica de etapa que justifique cambiar la dirección actual.')
    } : { stage, context: context.label, optionId: '', itemIds: [], itemStates: [], purchaseOrder: [], matchedConditions: [], status: bought.size ? 'inventory-conflict' : 'insufficient-evidence', inventoryStatus: bought.size ? 'inventory-conflict' : 'study-projection', boughtItemIds: [...bought], changedFromPreviousStage: false, reason: bought.size ? (language === 'en' ? 'No six-item candidate preserves every confirmed purchase; keep the inventory and review alternatives manually.' : 'Ninguna opción de seis objetos conserva todas las compras confirmadas; mantén el inventario y revisa alternativas manualmente.') : language === 'en' ? 'No valid build candidate is available.' : 'No hay una build válida disponible.' };
  }
  const selected = Object.values(output);
  for (let index = 0; index < selected.length; index++) {
    const current = selected[index], previous = selected[index - 1];
    current.changedFromPreviousStage = !!previous && current.optionId !== previous.optionId;
    current.changedItemIds = previous && current.changedFromPreviousStage
      ? previous.itemIds.filter(id => !current.itemIds.includes(id)).map(from => ({ from, to: current.itemIds.find(id => !previous.itemIds.includes(id)) || '' }))
      : [];
    current.acquiredItemIds = current.itemIds.filter(id => bought.has(id));
    current.proposedItemIds = current.itemIds.filter(id => !bought.has(id));
    if (current.optionId) {
      const name = current.optionId;
      if (current.changedFromPreviousStage) {
        const swaps = current.changedItemIds.map(change => `${change.from} → ${change.to}`).join(', ');
        current.reason += language === 'en' ? ` Stage comparison selects ${name}; changed slots: ${swaps || 'build profile changed'}.` : ` La comparación de etapa selecciona ${name}; cambia: ${swaps || 'cambió el perfil de build'}.`;
      } else {
        current.reason += language === 'en' ? ' Stage comparison retains the same build; no confirmed context justifies a switch.' : ' La comparación del optimizador conserva la misma build; el contexto confirmado no justifica cambiarla.';
      }
    }
  }
  return output;
}

module.exports = { planRankedStages };
