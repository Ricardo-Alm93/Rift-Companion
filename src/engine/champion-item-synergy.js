'use strict';

const STAT_TAGS = Object.freeze({ ap: ['spelldamage', 'ap'], ad: ['damage', 'ad', 'attackdamage'], 'bonus-ad': ['damage', 'ad', 'attackdamage'], mana: ['mana'], 'bonus-mana': ['mana'] });
const { getChampionItemInteractions, getBuildStrategicReview } = require('./champion-item-interaction-catalog');
const normalizeTags = item => new Set((item?.tags || []).map(tag => String(tag).toLowerCase().replace(/[^a-z0-9]/g, '')));
const evidenceRecord = (kind, points, source, detail, evidenceLevel = 'documented') => ({ kind, points, source, detail, evidenceLevel, verified: evidenceLevel === 'documented' });

function evaluateChampionItemSynergy({ item = {}, selectedItems = [], mechanics = null, language = 'es', alternative = null, confirmedThreats = [], archetype = null } = {}) {
  const tags = normalizeTags(item), selected = selectedItems.map(row => typeof row === 'object' ? row : { id: String(row) });
  const selectedTags = new Set(selected.flatMap(row => [...normalizeTags(row)]));
  const selectedIds = new Set(selected.map(row => String(row.id || row.itemId || '')));
  const verifiedScalings = (mechanics?.scalings || mechanics?.verifiedScalings || []).filter(row => row.verified && row.verificationStatus !== 'stale');
  const evidence = [], reasons = [], mechanicsEvidence = [];
  for (const scaling of verifiedScalings) {
    const compatibleTags = STAT_TAGS[scaling.stat] || [];
    if (!compatibleTags.some(tag => tags.has(tag.replace(/[^a-z0-9]/g, '')))) continue;
    const ability = scaling.abilityName || scaling.abilityKey || 'habilidad documentada';
    evidence.push(evidenceRecord('documented-ability-scaling', 20, scaling.source || 'Riot Data Dragon', { stat: scaling.stat, abilityKey: scaling.abilityKey, abilityName: ability, sourcePatch: scaling.sourcePatch || mechanics?.patch || '', confidence: 0.95 }, 'documented'));
    reasons.push(language === 'en' ? `Supports the published ${scaling.stat} scaling on ${ability}.` : `Aprovecha el escalado publicado de ${scaling.stat} en ${ability}.`);
    mechanicsEvidence.push({ stat: scaling.stat, abilityKey: scaling.abilityKey, abilityName: ability, source: scaling.source || 'Riot Data Dragon vars', sourcePatch: scaling.sourcePatch || mechanics?.patch || '', evidenceLevel: 'documented', confidence: 0.95, verified: true });
  }
  const patch = String(mechanics?.patch || '');
  const championId = String(mechanics?.championId || '');
  const interactionMatches = getChampionItemInteractions({ championId, itemId: item.id, itemTags: [...tags], patch });
  for (const record of interactionMatches) {
    if (record.evidenceLevel === 'unknown') continue;
    const level = record.evidenceLevel;
    const points = level === 'documented' ? 18 : 10;
    const detail = { interactionId: record.id, interactionType: record.interactionType, abilityKeys: record.abilityKeys, sourcePatch: record.source?.sourcePatch || record.patch, confidence: record.confidence, claim: record.claim, sourceUrl: record.source?.url };
    evidence.push(evidenceRecord(record.interactionType, points, record.source.name, detail, level));
    mechanicsEvidence.push({ ...detail, evidenceLevel: level, verified: level === 'documented', mechanic: record.id, source: record.source.name });
    reasons.push(String(record.claim || ''));
  }
  const reviewedMatches = (mechanics?.reviewedMechanics || []).filter(record => {
    if (record.verified !== true || record.verificationStatus !== 'editorial-reviewed' || !record.source || String(record.sourcePatch || '') !== String(mechanics?.patch || '')) return false;
    const itemMatch = (record.itemIds || []).map(String).includes(String(item.id || '')) || (record.itemTags || []).some(tag => tags.has(String(tag).toLowerCase().replace(/[^a-z0-9]/g, '')));
    const selectedMatch = !record.requiresSelectedItemId || selectedIds.has(String(record.requiresSelectedItemId));
    return itemMatch && selectedMatch;
  });
  for (const record of reviewedMatches) {
    const weight = Number(record.weight);
    evidence.push(evidenceRecord(record.kind || 'patch-reviewed-item-interaction', Number.isFinite(weight) ? Math.max(1, Math.min(25, weight)) : 0, record.source, { mechanic: record.id || record.mechanic || '', abilityKey: record.abilityKey || '', sourcePatch: record.sourcePatch, requiresSelectedItemId: record.requiresSelectedItemId || '', confidence: Number(record.confidence) || 0.65 }, 'editorial-reviewed'));
    reasons.push(String(record.reason?.[language] || record.reason?.es || record.reason?.en || (language === 'en' ? 'A reviewed patch-specific item interaction is documented.' : 'Hay una interacción de objeto revisada para este parche.')));
    mechanicsEvidence.push({ mechanic: record.id || record.mechanic || '', abilityKey: record.abilityKey || '', source: record.source, sourcePatch: record.sourcePatch, evidenceLevel: 'editorial-reviewed', confidence: Number(record.confidence) || 0.65, verified: false });
  }
  const exactEffects = (mechanics?.abilityFacts || []).flatMap(fact => (fact.effects || []).map(effect => ({ effect, fact })));
  const communityCandidates = (mechanics?.supplementalEvidence || []).filter(record => record.verificationStatus === 'compatible-but-not-independently-verified' &&
    ((record.onHitEffects === true && tags.has('onhit')) || (record.spellEffects && tags.has('spell'))))
    .map(record => ({ mechanic: record.onHitEffects === true ? 'on-hit' : 'spell-effect', abilityKey: record.abilityKey, source: record.source, sourcePatch: record.sourcePatch, verified: false, status: 'community-candidate-unverified' }));
  const normalizedTags = [...tags];
  if (exactEffects.some(row => row.effect === 'healing') && normalizedTags.some(tag => ['healshield', 'healandsheildpower', 'healshieldpower', 'healing'].includes(tag))) {
    const fact = exactEffects.find(row => row.effect === 'healing').fact;
    evidence.push(evidenceRecord('documented-healing-stat-compatibility', 12, fact.source, { abilityKey: fact.abilityKey, sourcePatch: fact.sourcePatch, confidence: 0.85, interactionType: 'stat-compatibility' }, 'documented'));
    reasons.push(language === 'en' ? `Its healing-related stats fit ${fact.abilityName}.` : `Sus estadísticas de curación encajan con ${fact.abilityName}.`);
    mechanicsEvidence.push({ effect: 'healing', interactionType: 'stat-compatibility', abilityKey: fact.abilityKey, abilityName: fact.abilityName, source: fact.source, sourcePatch: fact.sourcePatch, evidenceLevel: 'documented', confidence: 0.85, verified: true });
  }
  const synergy = [...tags].filter(tag => selectedTags.has(tag) && ['abilityhaste', 'mana', 'manaregen', 'health', 'armor', 'spellblock', 'attackdamage', 'spelldamage', 'attackspeed', 'criticalstrike'].includes(tag));
  const selectedBuildSynergy = synergy.length ? { tags: synergy, status: 'shared-stat-profile-unverified', scoreContribution: 0 } : null;
  const championName = mechanics?.championName || mechanics?.championId || '';
  const itemName = item.name || 'este objeto';
  const primaryScaling = mechanicsEvidence[0];
  const what = language === 'en'
    ? (primaryScaling ? `Adds ${primaryScaling.stat} that supports ${primaryScaling.abilityName}.` : `Provides the item’s published stats and effect (${itemName}).`)
    : (primaryScaling ? `Aporta ${primaryScaling.stat} para aprovechar ${primaryScaling.abilityName}.` : `Aporta las estadísticas y el efecto publicados de ${itemName}.`);
  const threatEvidence = confirmedThreats.filter(row => row?.known && row?.mechanic && row?.source && row?.verified === true);
  const fit = reasons[0] || (threatEvidence.length
    ? (language === 'en' ? `The available verified threat notes support reviewing this item for ${championName}; the exact item interaction is not established.` : `Las notas verificadas de amenaza justifican revisar este objeto para ${championName}; no se ha establecido una interacción exacta.`)
    : (language === 'en' ? `No verified champion-specific interaction was found for this item${archetype?.label ? ` in the ${archetype.label} archetype` : ''}; it is not therefore invalid.` : `No hay una interacción verificada de este objeto con ${championName}${archetype?.label ? ` en el arquetipo ${archetype.label}` : ''}; eso no lo vuelve inválido.`));
  const sacrifice = alternative?.name
    ? (language === 'en' ? `Compared with ${alternative.name}, gives up ${alternative.tradeoff || 'that option’s distinct effect'}.` : `Frente a ${alternative.name}, renuncia a ${alternative.tradeoff || 'el efecto propio de esa alternativa'}.`)
    : (language === 'en' ? 'This slot delays a different damage, defense, or utility effect.' : 'Este espacio retrasa otro efecto de daño, defensa o utilidad.');
  const score = evidence.length && evidence.every(row => Number.isFinite(row.points) && row.points > 0) ? evidence.reduce((sum, row) => sum + row.points, 0) : null;
  const contextFactors = {
    championStats: mechanicsEvidence.length ? { status: 'documented-match', count: mechanicsEvidence.length } : { status: 'no-verified-match' },
    actualItemEffect: reviewedMatches.length || exactEffects.some(row => row.effect === 'healing' && normalizedTags.some(tag => ['healshield', 'healshieldpower', 'healing'].includes(tag))) ? { status: 'documented-effect-match' } : { status: 'no-verified-match' },
    selectedItems: selectedBuildSynergy ? { status: 'shared-stats-unverified', tags: synergy } : { status: 'no-shared-profile' },
    archetype: archetype?.status === 'editorial-reviewed' ? { status: 'reviewed-archetype', id: archetype.id || '' } : { status: archetype ? 'candidate-only' : 'not-provided' },
    confirmedThreats: threatEvidence.length ? { status: 'verified-threat-records', count: threatEvidence.length } : { status: confirmedThreats.length ? 'threat-known-no-verified-item-link' : 'no-confirmed-threat' },
    opportunityCost: { status: 'qualitative-tradeoff', text: sacrifice }
  };
  return {
    score, scoreMeaning: score == null ? 'not-scored-insufficient-evidence' : 'evidence-weight-only-not-winrate',
    weightOnly: true,
    status: mechanicsEvidence.some(row => row.evidenceLevel === 'documented') ? (mechanicsEvidence.filter(row => row.evidenceLevel === 'documented').length < 2 ? 'evidence-supported-limited' : 'evidence-supported') : mechanicsEvidence.length ? 'editorial-evidence-limited' : 'insufficient-evidence',
    evidenceLevel: mechanicsEvidence.some(row => row.evidenceLevel === 'documented') ? 'documented' : mechanicsEvidence.some(row => row.evidenceLevel === 'editorial-reviewed') ? 'editorial-reviewed' : 'unknown',
    what, fit, sacrifice, mechanicsEvidence,
    evidenceSummary: mechanicsEvidence.length ? { level: mechanicsEvidence.some(row => row.evidenceLevel === 'documented') ? 'documented' : 'editorial-reviewed', patch, confidence: Math.max(...mechanicsEvidence.map(row => Number(row.confidence) || 0)), sources: [...new Set(mechanicsEvidence.map(row => row.source).filter(Boolean))] } : { level: 'unknown', patch, confidence: 0, sources: [] },
    evidence, interactionCandidates: interactionMatches, communityCandidates, selectedBuildSynergy, contextFactors,
    rejectedSignals: (mechanics?.abilityFacts || []).flatMap(fact => fact.onHit?.status === 'not-established' ? [{ abilityKey: fact.abilityKey, mechanic: 'on-hit', reason: fact.onHit.reason }] : []),
    reasons
  };
}

function evaluateChampionBuildSynergy({ itemIds = [], itemCatalog = {}, mechanics = null, language = 'es', confirmedThreats = [], archetype = null, buildId = '', role = '', validation = null, purchaseOrder = [] } = {}) {
  const rows = itemIds.map(String).filter(id => itemCatalog[id]).map(id => ({ itemId: id, ...evaluateChampionItemSynergy({
    item: itemCatalog[id], selectedItems: itemIds.map(String).filter(other => other !== id).map(other => itemCatalog[other]).filter(Boolean), mechanics, language, confirmedThreats, archetype
  }) }));
  const supported = rows.filter(row => row.mechanicsEvidence.length > 0).length;
  const status = !rows.length || supported === 0 ? 'insufficient-evidence' : supported < rows.length ? 'partially-supported' : 'mechanics-supported';
  const review = getBuildStrategicReview({ championId: mechanics?.championId, role, buildId, patch: mechanics?.patch });
  const legalStatus = validation?.valid === true ? 'legal' : validation?.valid === false ? 'invalid' : 'not-validated';
  const fullSixSlots = rows.length === 6 && new Set(itemIds.map(String)).size === 6;
  const exactReviewedSlots = !!review && JSON.stringify((review.itemIds || []).map(String)) === JSON.stringify(itemIds.map(String));
  const hasCompleteOrder = Array.isArray(purchaseOrder) && purchaseOrder.length >= 6;
  const fullStrategicReview = fullSixSlots && exactReviewedSlots && review.strategicStatus === 'reviewed' && hasCompleteOrder;
  const certificationStatus = legalStatus === 'invalid' ? 'legally-invalid'
    : legalStatus !== 'legal' ? 'insufficient-evidence'
      : fullStrategicReview ? 'strategically-reviewed'
        : !fullSixSlots ? 'insufficient-evidence'
          : rows.some(row => row.mechanicsEvidence.some(record => record.evidenceLevel === 'documented')) ? 'documented-interactions'
            : review || supported ? 'legal-valid' : 'insufficient-evidence';
  return {
    status, confidence: status === 'mechanics-supported' ? 'limited-explicit-evidence' : status === 'partially-supported' ? 'partial-explicit-evidence' : 'insufficient-data',
    certification: { status: certificationStatus, legalStatus, fullSixSlots, reviewStatus: review?.strategicStatus || 'unreviewed', reviewId: review?.buildId || '', patch: review?.patch || mechanics?.patch || '', findings: review?.findings || [], alternativeContext: review?.alternativeContext || '', source: review?.source || null, exactBuildMatch: exactReviewedSlots, purchaseOrderReviewed: hasCompleteOrder && !!review },
    itemCount: rows.length, itemsWithMechanicEvidence: supported, evidenceCoverage: rows.length ? supported / rows.length : 0,
    weightedEvidencePoints: rows.reduce((sum, row) => sum + (row.score || 0), 0),
    unverifiedBuildContinuity: rows.filter(row => row.selectedBuildSynergy).length, rows
  };
}

function compareChampionBuilds({ builds = [], itemCatalog = {}, mechanics = null, language = 'es', condition = '', confirmedThreats = [] } = {}) {
  const evaluated = builds.map(build => ({
    id: String(build.id || ''), label: String(build.label || build.id || ''), sourceKind: String(build.sourceKind || build.buildType || 'unknown'),
    itemIds: (build.itemIds || build.finalSlots || []).map(String),
    evaluation: evaluateChampionBuildSynergy({ itemIds: build.itemIds || build.finalSlots || [], itemCatalog, mechanics, language, confirmedThreats, buildId: build.id, role: build.role || '', validation: build.validation, purchaseOrder: build.purchaseOrder || [] })
  }));
  const enoughEvidence = evaluated.length >= 2 && evaluated.every(row => row.evaluation.status !== 'insufficient-evidence');
  return { status: enoughEvidence ? 'evidence-comparison-available' : 'comparison-limited', condition: String(condition || ''), evaluated,
    conclusion: enoughEvidence
      ? (language === 'en' ? 'Compare the shown evidence and item tradeoffs; this is not a win-rate or outcome prediction.' : 'Compara la evidencia y los costes de oportunidad; no es una predicción ni una comparación de win rate.')
      : (language === 'en' ? 'Insufficient verified mechanics to rank these builds; keep published source categories separate.' : 'Evidencia insuficiente para ordenar estas builds; conserva separadas las categorías publicadas.') };
}

module.exports = { evaluateChampionItemSynergy, evaluateChampionBuildSynergy, compareChampionBuilds };
