'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildItemCatalog } = require('../src/engine/item-eligibility');
const { createBuildAdvisor } = require('../src/engine/build-candidate-generator');
const { createThreatProfiler } = require('../src/engine/champion-threat-profiler');
const { normalizeChampionAbilityProfile } = require('../src/domain/champion-abilities');
const { createChampionMechanicsProfile } = require('../src/engine/champion-mechanics-profiler');

const root = path.resolve(__dirname, '..');
const patch = '16.22.1';
const targetPatch = '16.22';
const requested = [
  { champion: 'Talon', role: 'mid', sourceChampion: 'TALON', position: 'MID' },
  { champion: 'Viktor', role: 'mid', sourceChampion: 'VIKTOR', position: 'MID' },
  { champion: 'Nami', role: 'support', sourceChampion: 'NAMI', position: 'SUPPORT' },
  { champion: 'KogMaw', role: 'adc', sourceChampion: 'KOGMAW', position: 'ADC' },
  { champion: 'Sejuani', role: 'jungle', sourceChampion: 'SEJUANI', position: 'JUNGLE' }
];
const itemData = require(`../data/dragon/cdn/${patch}/data/en_US/item.json`);
const championDefinitions = require(`../data/dragon/cdn/${patch}/data/en_US/champion.json`).data;
const exclusiveGroups = require(`../data/ranked/item-groups-${patch}.json`);
const itemCatalog = buildItemCatalog({ itemData, taxonomy: require('../data/item-taxonomy.json'), patch, exclusiveGroups });
const audit = require('../data/ranked/opgg-live-audit-batch-2026-11-04-expansion.json');
const threatProfiles = require('../data/champion-threat-profiles.json');
const seed = require('../data/ranked/champion-role-seed-16.21.1.json');
const advisor = createBuildAdvisor({
  archetypeSeed: seed,
  threatProfiles,
  itemAdvice: require('../data/item-advice.json'),
  itemPurposeCatalog: require('../data/ranked/item-purposes-16.22.1.json'),
  itemActivationRules: require('../data/ranked/item-activation-rules-16.22.1.json'),
  itemCatalog,
  championDefinitions,
  profileChampion: createThreatProfiler({ champions: championDefinitions, threatProfiles }),
  patch,
  exclusiveGroups
});
const noManualBuilds = require('../data/champion-build-profiles.json');
const roleNames = Object.fromEntries(requested.map(row => [row.champion, row.role]));
const roster = ids => ids.map((championId, index) => ({ championId, slot: index, team: 'enemy', confirmed: true, visible: true }));
const scenarios = [
  { id: 'baseline-no-enemies', label: 'No confirmed enemy information', enemies: [] },
  { id: 'lane-low-pressure-hypothesis', label: 'Low-pressure lane archetype (hypothesis, not matchup statistics)', enemies: ['Syndra'] },
  { id: 'lane-high-pressure-hypothesis', label: 'High-pressure lane archetype (hypothesis, not matchup statistics)', enemies: ['Zed'] },
  { id: 'fragile-composition', label: 'Mostly fragile / burst composition (partial known examples)', enemies: ['Zed', 'Talon', 'Syndra'] },
  { id: 'durable-composition', label: 'Durable front line (partial known examples)', enemies: ['Ornn', 'Rammus', 'Leona'] },
  { id: 'healing-composition', label: 'Healing / sustain pressure (partial known examples)', enemies: ['Soraka', 'Warwick'] },
  { id: 'incomplete-unknown-composition', label: 'Incomplete roster with one unknown profile', enemies: ['Janna'] }
];

function normalize(query) {
  return {
    champion: query.champion,
    position: query.returnedPosition,
    patch: query.patch,
    summary: { average_stats: { play: query.sample?.play || 0 }, positions: (query.positions || []).map(row => ({ name: row.name, stats: { play: row.play || 0 } })) },
    core_items: query.coreItems || [], boots: query.boots || [], last_items: query.lastItems || [],
    fourth_items: query.fourthItems || [], fifth_items: query.fifthItems || [], sixth_items: query.sixthItems || [],
    combination_items: query.combinationItems || [], single_items: query.singleItems || []
  };
}
function isFullProfile(champion, role) {
  const row = noManualBuilds.champions?.[champion]?.roles?.[role];
  return Array.isArray(row) && row.some(profile => Array.isArray(profile.itemIds) && profile.itemIds.length === 6);
}
function simplify(result, scenario) {
  const best = result.options.find(option => option.finalSlots?.length === 6) || null;
  const core = result.observedCore;
  return {
    scenarioId: scenario.id,
    scenario: scenario.label,
    confirmedEnemies: scenario.enemies,
    rosterComplete: result.composition?.incomplete === false,
    publishedCore: core ? { itemIds: core.itemIds, games: core.games, patch: core.patch, source: core.source, state: core.state } : null,
    recommended: best ? { id: best.id, sourceKind: best.sourceKind, buildType: best.buildType, itemIds: best.finalSlots || best.itemIds, purchaseOrder: (best.purchaseOrder || []).map(step => ({ itemId: step.purchaseItemId, finalItemId: step.finalItemId, stage: step.stage, guidance: step.guidance })), reasons: best.reasons || [], tradeoffs: best.tradeoffs || [] } : null,
    partialCore: core ? { itemIds: core.itemIds, state: core.state, reasons: result.options.find(option => option.buildType === 'partial-core')?.reasons || [], source: core.source } : null,
    partialOptions: result.options.filter(option => option.buildType === 'partial-core').map(option => ({ itemIds: option.finalSlots, reason: option.reasons?.[0] || '' })),
    alternatives: result.substitutionVariants.map(option => ({ id: option.id, sourceKind: 'strategic-substitution', buildType: 'generated', baseOptionId: option.baseOptionId, itemIds: option.itemIds, changes: option.changes, reasons: option.reasons, tradeoff: option.tradeoff })),
    diagnostics: {
      sourceState: result.diagnostics?.sourceState,
      sourceQueried: result.diagnostics?.sourceQueried,
      rows: result.diagnostics?.statisticsRows,
      acceptedOptions: result.diagnostics?.acceptedBuilds,
      sourceRejections: result.diagnostics?.rejectedCandidates || [],
      candidateCount: result.diagnostics?.optimizer?.candidateCount || 0,
      combinationCandidatesEvaluated: result.diagnostics?.optimizer?.summary?.combinationsEvaluated || 0,
      rejectedCompatibility: result.diagnostics?.optimizer?.summary?.rejectedByCompatibility || 0,
      rejectedPassiveActivation: result.diagnostics?.optimizer?.summary?.rejectedByPassiveActivation || 0,
      rejectedStrategy: result.diagnostics?.optimizer?.summary?.rejectedByStrategy || 0,
      candidateCapReached: result.diagnostics?.optimizer?.summary?.candidateCapReached || false,
      searchLimits: result.diagnostics?.optimizer?.summary?.limits || [],
      completionSearch: result.diagnostics?.optimizer?.coreCompletion || [],
      unknowns: result.composition?.dataLimits || []
    },
    stages: Object.fromEntries(Object.entries(result.stagePlans || {}).map(([stage, plan]) => [stage, {
      optionId: plan.optionId, itemIds: plan.itemIds, acquiredItemIds: plan.acquiredItemIds,
      nextPurchaseItemId: plan.nextPurchaseItemId, changedFromPreviousStage: plan.changedFromPreviousStage,
      changedItemIds: plan.changedItemIds, reason: plan.reason
    }]))
  };
}

function run() {
  const results = [];
  for (const request of requested) {
    if (isFullProfile(request.champion, request.role)) throw new Error(`${request.champion}/${request.role} unexpectedly has a manual six-item profile`);
    const query = audit.queries.find(row => row.champion === request.sourceChampion && row.returnedPosition === request.position);
    if (!query || query.sourceStatus !== 'success' || query.patch !== targetPatch) throw new Error(`Missing successful current audit row for ${request.champion}/${request.role}`);
    const championId = Object.keys(championDefinitions).find(id => id.toLowerCase() === request.champion.toLowerCase());
    const abilityResponse = require(`../data/dragon/cdn/${patch}/data/en_US/champion/${championId}.json`);
    const abilities = normalizeChampionAbilityProfile(abilityResponse, { championId, version: patch, locale: 'en_US', retrievedAt: '2026-11-04T00:00:00.000Z' });
    const mechanics = createChampionMechanicsProfile(abilities, { role: request.role });
    const contexts = scenarios.map(scenario => {
      const input = { player: { championId, role: request.role }, enemies: roster(scenario.enemies), laneOpponentChampionId: scenario.enemies[0] || '' };
      if (scenario.enemies.length) input.roster = { player: input.player, enemies: input.enemies, allies: [] };
      const response = advisor({ ...input, championMechanics: mechanics, publishedData: { source: audit.source, sourceQueried: true, queryContext: { championId, position: request.role }, data: normalize(query) } }, 'es');
      return simplify(response, scenario);
    });
    results.push({ championId, role: request.role, manualSixItemProfilePresent: false, source: audit.source, sourcePatch: query.patch, sourceStatus: query.sourceStatus, sampleGames: query.sample?.play || 0, archetypeCategory: query.auditArchetype || '', contexts });
  }
  const report = {
    generatedAt: new Date().toISOString(), catalogPatch: patch, statisticsPatch: targetPatch,
    sourceSnapshot: path.relative(root, path.resolve(root, 'data/ranked/opgg-live-audit-batch-2026-11-04-expansion.json')),
    sourceSnapshotDate: audit.auditAt, source: audit.source,
    methodology: 'Each candidate has no manual six-item profile. Scenarios are what-if contexts based on the local threat-tag catalog, not measured matchup outcomes. No generated set inherits win-rate statistics. Source samples and item-stage sample counts are evidence counts, not performance estimates.',
    scenarioLimitations: ['The audit snapshot has no lane matchup table for these five pairs; favorable/difficult labels are hypothetical archetype pressure cases, not statistical matchups.', 'Several enemy archetypes are absent from the local reviewed threat catalog; those picks remain unknown and do not justify counter items.', 'Stage 5/6 evidence is insufficient for Nami and Sejuani; the engine retains partial cores rather than inventing slots.', 'The optimizer is bounded and does not prove a global optimum.'],
    zedItemReview: {
      profile: '6699, 2520, 3036, 3158, 3814, 2517 is a prior engine example; not user-validated and not published as a set.',
      lordDominiks: { id: '3036', name: itemCatalog['3036']?.name, stats: itemData.data['3036']?.stats || {}, tags: itemCatalog['3036']?.tags || [], description: itemData.data['3036']?.description || '', exclusiveGroup: Object.entries(exclusiveGroups.groups || {}).find(([, ids]) => ids.map(String).includes('3036'))?.[0] || '' },
      seryldas: { id: '6694', name: itemCatalog['6694']?.name, stats: itemData.data['6694']?.stats || {}, tags: itemCatalog['6694']?.tags || [], description: itemData.data['6694']?.description || '', exclusiveGroup: Object.entries(exclusiveGroups.groups || {}).find(([, ids]) => ids.map(String).includes('6694'))?.[0] || '' },
      swapValidated: true, coexistenceRejected: true,
      recommendation: 'Keep 3036 in this prior-engine baseline unless a specific composition plus current ability/item evidence supports replacing it. No confirmed scenario in this report justifies a forced Serylda swap.'
    },
    results
  };
  const jsonPath = path.join(root, 'data/ranked/generalization-report-16.22.1.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    '# Ranked engine generalization report', '',
    `Catalog patch: ${patch} · source statistics patch: ${targetPatch} · source snapshot: ${report.sourceSnapshotDate} (${audit.source})`, '',
    report.methodology, '',
    '| Champion / role | Core | Result | Substitution alternatives | Evidence note |', '|---|---|---|---:|---|',
    ...results.map(row => {
      const base = row.contexts[0];
      const full = base.recommended?.itemIds?.length === 6;
      const core = base.publishedCore?.itemIds?.join(', ') || 'none';
      const alternatives = Math.max(...row.contexts.map(context => context.alternatives.length));
      const note = full ? 'educational completion; combination not observed' : 'partial core; later-slot evidence below minimum';
      return `| ${row.championId} / ${row.role} | ${core} | ${full ? base.recommended.itemIds.join(', ') : 'partial'} | ${alternatives} | ${note} |`;
    }), '',
    '## Limits', '', ...report.scenarioLimitations.map(text => `- ${text}`), '',
    '## Zed: Lord Dominik vs Serylda', '',
    `The prior engine set remains a review baseline. Data Dragon ${patch} lists ${report.zedItemReview.lordDominiks.name} (${report.zedItemReview.lordDominiks.id}) with tags ${report.zedItemReview.lordDominiks.tags.join(', ')} and ${report.zedItemReview.seryldas.name} (${report.zedItemReview.seryldas.id}) with tags ${report.zedItemReview.seryldas.tags.join(', ')}. Each is individually legal as a substitution; the item-group validator rejects equipping both (${report.zedItemReview.lordDominiks.exclusiveGroup}). The optimizer retains the baseline because the current team evidence does not prove Serylda improves the complete set.`, '',
    '## Scenario detail', '',
    results.map(row => `### ${row.championId} / ${row.role}\n\n${row.contexts.map(context => {
      const variantNote = context.alternatives[0] ? ` First alternative: ${context.alternatives[0].itemIds.join(', ')}; ${context.alternatives[0].changes.map(change => `${change.fromName || change.from} → ${change.toName || change.to}`).join(', ')}; ${context.alternatives[0].reasons.join(', ')}; opportunity cost: ${context.alternatives[0].tradeoff}` : '';
      return `- **${context.scenarioId}:** ${context.recommended?.itemIds?.join(', ') || `partial ${context.partialCore?.itemIds?.join(', ') || 'no core'}`}; alternatives ${context.alternatives.length}.${variantNote} Source rejections ${context.diagnostics.sourceRejections.length}; compatibility rejects ${context.diagnostics.rejectedCompatibility}; passive activation rejects ${context.diagnostics.rejectedPassiveActivation}; candidate cap reached ${context.diagnostics.candidateCapReached}.`;
    }).join('\n')}\n`).join('\n')
  ].join('\n');
  const mdPath = path.join(root, 'docs/RANKED_GENERALIZATION_REPORT.md');
  fs.writeFileSync(mdPath, `${md}\n`);
  process.stdout.write(`${JSON.stringify({ jsonPath: path.relative(root, jsonPath), markdownPath: path.relative(root, mdPath), champions: results.length, contexts: results.reduce((sum, row) => sum + row.contexts.length, 0), complete: results.filter(row => row.contexts[0].recommended?.itemIds?.length === 6).map(row => row.championId), partial: results.filter(row => row.contexts[0].recommended?.itemIds?.length !== 6).map(row => row.championId) }, null, 2)}\n`);
}

if (require.main === module) run();
module.exports = { run, requested, normalize, scenarios };
