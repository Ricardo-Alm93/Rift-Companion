const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const patch = '16.22.1';
const read = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT' && fallback !== null) return fallback; throw error; }
};
const patchRelations = read('data/ranked/patch-relations.json');
const { comparePatchVersions } = require('../src/domain/patch-compatibility');
const base = read('data/champion-build-profiles.json');
const pilot = read(`data/ranked/pilot-build-profiles-${patch}.json`, { patch: '', champions: {} });
const seed = read('data/ranked/champion-role-seed-16.21.1.json');
const itemData = read(`data/dragon/cdn/${patch}/data/en_US/item.json`);
const taxonomy = read('data/item-taxonomy.json');
const groups = read(`data/ranked/item-groups-${patch}.json`);
const { buildItemCatalog, validateBuildItems, validateCoreItems } = require('../src/engine/item-eligibility');
const catalog = buildItemCatalog({ itemData, taxonomy, patch, exclusiveGroups: groups });
const profiles = { ...(base.champions || {}), ...(pilot.patch === patch ? pilot.champions || {} : {}) };
const canonicalRole = role => role === 'bot' ? 'adc' : role;
const seedPairs = new Set();
const localCompletePairs = new Set();
const localCompleteChampions = new Set();
const localPartialPairs = new Set();
const staleProfilePairs = new Set();
const rejected = [];
const sources = new Map();
const publishedCorePairs = new Set();
const profileReviewStatuses = new Map();
const pairKinds = new Map();
let completeProfileCount = 0;
let generatedProfileCount = 0;
let observedProfileCount = 0;
let currentPatchPublishedCoreCount = 0;
let staleProfileCount = 0;

for (const [championId, row] of Object.entries(seed.champions || {})) {
  for (const candidate of row.candidateProfiles || []) seedPairs.add(`${championId}/${canonicalRole(candidate.role)}`);
}

for (const [championId, row] of Object.entries(profiles)) {
  for (const [role, optionsValue] of Object.entries(row.roles || {})) {
    const options = Array.isArray(optionsValue) ? optionsValue : [];
    const key = `${championId}/${canonicalRole(role)}`;
    let hasComplete = false;
    let hasCurrentPartial = false;
    for (const option of options) {
      const ids = (option.itemIds || option.items || []).map(String);
      if (option.publishedCoreIds?.length && (!option.patch || String(option.patch).startsWith('16.22'))) {
        const core = option.publishedCoreIds.map(String);
        const validCore = validateCoreItems(core, catalog, { patch, exclusiveGroups: groups, championId, role }).valid;
        if (validCore) {
          publishedCorePairs.add(key);
          currentPatchPublishedCoreCount += 1;
          if (ids.length < 6) hasCurrentPartial = true;
          const src = option.evidence?.source || option.source || row.source || pilot.evidence?.source || pilot.source || 'unknown';
          const current = sources.get(src) || { source: src, patches: new Set(), dates: new Set() };
          current.patches.add(option.evidence?.snapshotPatch || pilot.evidence?.snapshotPatch || option.patch || patch);
          const date = option.evidence?.collectedAt || pilot.evidence?.collectedAt || '';
          if (date) current.dates.add(date);
          sources.set(src, current);
        }
      }
      if (ids.length === 6) {
        const result = validateBuildItems(ids, catalog, { patch, exclusiveGroups: groups, championId, role });
        if (result.valid) {
          const profilePatch = option.patch || row.patch || '';
          if (String(profilePatch).startsWith('16.22')) {
            hasComplete = true;
            completeProfileCount += 1;
            const kinds = pairKinds.get(key) || new Set();
            if (option.buildType === 'observed' || option.sourceKind === 'observed_sequence') { observedProfileCount += 1; kinds.add('observed-six-item-combination'); }
            else if (option.publishedCoreIds?.length && option.publishedCoreIds.length < 6) { generatedProfileCount += 1; kinds.add('published-core-plus-educational-continuation'); }
            else kinds.add('editorial-local-profile');
            pairKinds.set(key, kinds);
          } else { staleProfilePairs.add(key); staleProfileCount += 1; }
        } else rejected.push({ championId, role: canonicalRole(role), profileId: option.id || '', codes: result.errors, itemIds: result.conflictingItemIds });
      } else if (ids.length && !option.publishedCoreIds?.length) {
        rejected.push({ championId, role: canonicalRole(role), profileId: option.id || '', codes: ['partial-profile-without-published-core'], itemIds: ids });
      }
    }
    if (hasComplete) {
      localCompletePairs.add(key);
      localCompleteChampions.add(championId);
    } else if (hasCurrentPartial) localPartialPairs.add(key);
    const reviewStatus = options.map(option => option.reviewStatus || row.reviewStatus || '').filter(Boolean);
    if (reviewStatus.length) profileReviewStatuses.set(key, [...new Set(reviewStatus)].sort());
  }
}

const pending = [...seedPairs].filter(key => !localCompletePairs.has(key) && !localPartialPairs.has(key)).sort();
const toArray = set => [...set].sort();
const currentPublishedCoreOnlyPairs = new Set([...publishedCorePairs].filter(key => !localCompletePairs.has(key)));
for (const key of localPartialPairs) currentPublishedCoreOnlyPairs.add(key);
const pairReport = {};
for (const key of [...new Set([...seedPairs, ...localCompletePairs, ...publishedCorePairs, ...staleProfilePairs])].sort()) {
  pairReport[key] = {
    offline: localCompletePairs.has(key) ? 'complete-local' : publishedCorePairs.has(key) ? 'published-core' : 'uncovered',
    buildKinds: [...(pairKinds.get(key) || [])].sort(),
    hasCurrentPublishedCore: publishedCorePairs.has(key),
    pendingReview: pending.includes(key),
    staleEditorial: staleProfilePairs.has(key)
  };
}
const ddragonChampions = Object.keys(read(`data/dragon/cdn/${patch}/data/en_US/champion.json`).data);
const expansionAuditPath = path.join(root, 'data/ranked/opgg-live-audit-batch-2026-11-04-expansion.json');
const previousAuditPath = path.join(root, 'data/ranked/opgg-live-audit-batch-2026-11-04.json');
const liveAuditPath = fs.existsSync(expansionAuditPath) ? expansionAuditPath : previousAuditPath;
let onlineAudit = { verifiedInThisRun: false, status: 'not-queried', note: 'No local snapshot of real OP.GG queries is available.' };
let onlineBuildCounts = { queries: 0, queryErrors: 0, publishedCores: 0, acceptedCompleteBuilds: 0, currentPatchCompleteBuilds: 0, acceptedPartialCores: 0, rejectedCandidates: 0, educationalCompletions: 0, educationalBuilds: 0, localEditorialFallbacks: 0, staleEditorialFallbackBuilds: 0, partialOnly: 0, rejected: 0, noBuilds: 0, observedSixItemCombinations: 0 };
let onlineQueries = [];
if (fs.existsSync(liveAuditPath)) {
  const audit = JSON.parse(fs.readFileSync(liveAuditPath, 'utf8'));
  const { createBuildAdvisor } = require('../src/engine/build-candidate-generator');
  const { createThreatProfiler } = require('../src/engine/champion-threat-profiler');
  const definitions = read(`data/dragon/cdn/${patch}/data/en_US/champion.json`).data;
  const threatProfiles = read('data/champion-threat-profiles.json');
  const matchupAdvice = read('data/champion-matchup-item-advice.json');
  const itemAdvice = read('data/item-advice.json');
  const advisor = createBuildAdvisor({ buildProfiles: { champions: profiles }, archetypeSeed: seed, threatProfiles, matchupAdvice, itemAdvice, itemCatalog: catalog, championDefinitions: definitions, profileChampion: createThreatProfiler({ champions: definitions, threatProfiles }), patch, exclusiveGroups: groups });
  const roleMap = { MID: 'mid', TOP: 'top', JUNGLE: 'jungle', BOT: 'adc', ADC: 'adc', SUPPORT: 'support' };
  onlineQueries = (audit.queries || []).map(query => {
    onlineBuildCounts.queries += 1;
    if (query.sourceStatus !== 'success') onlineBuildCounts.queryErrors += 1;
    const role = roleMap[query.returnedPosition || query.requestedPosition] || String(query.requestedPosition || '').toLowerCase();
    const data = {
      champion: query.champion, position: query.returnedPosition || query.requestedPosition, patch: query.patch,
      summary: query.sample ? { average_stats: { play: query.sample.play, pick_rate: query.sample.pickRate, kda: query.sample.kda } } : {},
      core_items: query.coreItems || [], boots: query.boots || [], starter_items: query.starterItems || [],
      last_items: query.lastItems || [], fourth_items: query.fourthItems || [], fifth_items: query.fifthItems || [], sixth_items: query.sixthItems || [],
      combination_items: query.combinationItems || [], single_items: query.singleItems || []
    };
    const championId = definitions && Object.keys(definitions).find(id => id.toUpperCase() === query.champion) || query.champion;
    const result = advisor({ player: { championId, role }, publishedData: { source: audit.source, sourceQueried: true, queryContext: { championId, position: role }, data } }, 'es');
    const validFull = result.options.filter(option => option.finalSlots?.length === 6 && option.validation?.valid);
    const partialOptions = result.options.filter(option => option.buildType === 'partial-core' && option.validation?.valid);
    const partial = partialOptions[0];
    const rejectedCore = result.observedCore && !result.observedCore.validation?.valid;
    const normalizedCore = result.observedCore?.itemIds || [];
    const rawCore = result.observedCore?.rawItemIds || [];
    const transformedNormalization = rawCore.filter(id => !normalizedCore.includes(String(id))).map(id => ({ itemId: String(id), name: itemData.data?.[String(id)]?.name || String(id), reason: 'consumed-by-recipe-or-transformation' }));
    onlineBuildCounts.publishedCores += result.observedCore?.validation?.valid ? 1 : 0;
    onlineBuildCounts.acceptedCompleteBuilds += validFull.length;
    onlineBuildCounts.currentPatchCompleteBuilds += validFull.filter(option => option.buildStatus === 'build-ready').length;
    onlineBuildCounts.acceptedPartialCores += partialOptions.length;
    onlineBuildCounts.rejectedCandidates += (result.rejectedCandidates || []).length;
    const educational = validFull.filter(option => option.buildType === 'generated' && (option.sourceKind === 'published_core_plus_slot_candidates' || option.sourceKind === 'published_core_plus_editorial'));
    const editorialFallbacks = validFull.filter(option => option.buildType === 'editorial' || option.sourceKind === 'curated_item_rule' || option.sourceKind === 'curated_kit');
    onlineBuildCounts.educationalCompletions += educational.length > 0 ? 1 : 0;
    onlineBuildCounts.educationalBuilds += educational.length;
    onlineBuildCounts.localEditorialFallbacks += editorialFallbacks.length > 0 ? 1 : 0;
    onlineBuildCounts.staleEditorialFallbackBuilds += editorialFallbacks.filter(option => option.buildStatus === 'provisional-curated-stale').length;
    onlineBuildCounts.partialOnly += result.status === 'partial-core' && !!partial ? 1 : 0;
    onlineBuildCounts.rejected += rejectedCore ? 1 : 0;
    onlineBuildCounts.noBuilds += result.diagnostics?.sourceState === 'queried-no-builds' ? 1 : 0;
    onlineBuildCounts.observedSixItemCombinations += validFull.some(option => option.buildType === 'observed') ? 1 : 0;
    const hasEducationalCompletion = validFull.some(option => option.buildType === 'generated');
    const hasStaleEditorialFallback = validFull.some(option => option.buildType === 'editorial' && option.buildStatus === 'provisional-curated-stale');
    const caseClassification = hasEducationalCompletion ? 'educational-complete'
      : partial && hasStaleEditorialFallback ? 'partial-core-plus-stale-editorial-fallback'
        : partial ? 'partial-only'
          : validFull.length ? 'editorial-complete-not-currently-verified' : result.status;
    return {
      champion: championId, requestedRole: role, returnedRole: roleMap[query.returnedPosition] || query.returnedPosition,
      caseClassification,
      auditArchetype: query.auditArchetype || '', sourceStatus: query.sourceStatus, patch: query.patch, sampleGames: query.sample?.play || 0,
      positions: query.positions || [], coreItemIds: (query.coreItems || []).map(row => row.ids), boots: (query.boots || []).map(row => ({ ids: row.ids, games: row.play })),
      starterItemIds: (query.starterItems || []).map(row => row.ids),
      skillOrders: (query.skillOrders || []).slice(0, 3).map(row => ({ order: row.order || [], games: row.play || 0, pickRate: row.pick_rate || 0 })),
      seedArchetype: (seed.champions?.[championId]?.candidateProfiles || []).find(row => canonicalRole(row.role) === canonicalRole(role))?.primaryArchetype || '',
      itemEvidenceByStage: Object.fromEntries(['fourthItems', 'fifthItems', 'sixthItems', 'lastItems'].map(key => [key.replace('Items', '').toLowerCase(), (query[key] || []).map(row => ({ ids: row.ids, games: row.play, pickRate: row.pick_rate }))])),
      coreCombinationsReceived: (query.coreItems || []).length,
      alternativeCombinationsReceived: (query.combinationItems || []).length,
      normalization: { sourceCore: rawCore, normalizedCore, removedRecipeOrTransformationInputs: transformedNormalization, coreValidation: result.observedCore?.validation || null },
      engine: { status: result.status, sourceState: result.diagnostics?.sourceState, validSixItemOptions: validFull.length, optionKinds: validFull.map(option => option.buildType), validBuilds: validFull.map(option => ({ kind: option.buildType, buildStatus: option.buildStatus || '', sourceKind: option.sourceKind, label: option.label, style: option.style, confidence: option.confidence || '', itemIds: option.finalSlots, items: option.finalSlots.map(id => ({ id, name: itemData.data?.[id]?.name || id })), purchaseOrder: (option.purchaseOrder || []).map(step => ({ finalItemId: step.finalItemId, purchaseItemId: step.purchaseItemId, transform: step.transform || null })), reasons: option.reasons || [], tradeoffs: option.tradeoffs || [], validation: option.validation || null, slotEvidence: option.slotEvidence || [], strategicReview: { status: option.buildType === 'observed' ? 'observed-but-not-strategically-audited' : 'educational-proposal-requires-strategic-review', archetype: 'candidate-only-unless-reviewed-profile', skillMechanics: 'not-verified-by-this-offline-audit', itemSynergy: 'technical-legality-does-not-prove-strategic-quality' } })), partialCoreItems: partial?.finalSlots || [], rejectedCoreCodes: result.observedCore?.validation?.errors || [], rejectedCandidates: result.rejectedCandidates || [], compositionNeeds: result.composition?.needs || [], compositionDecision: result.composition?.compositionAdvice || null }
    };
  });
onlineAudit = { verifiedInThisRun: false, status: 'real-opgg-response-snapshot', snapshot: path.basename(liveAuditPath), batch: audit.batch || '', source: audit.source, mode: audit.mode, auditedAt: audit.auditAt, dataPatch: audit.queries?.[0]?.patch || '', queryCount: onlineBuildCounts.queries, queryErrors: onlineBuildCounts.queryErrors, note: 'These rows are a stored snapshot of actual OP.GG MCP responses; this coverage-report run evaluates the snapshot offline and does not issue new network requests.' };
}
const patchCompatibility = comparePatchVersions({
  publishedGamePatch: patchRelations.relations.find(row => row.dataDragonVersion === patch)?.publishedGamePatch || '',
  dataDragonVersion: patch,
  statisticsPatch: onlineAudit.dataPatch || '',
  relations: patchRelations.relations
});
const report = {
  generatedAt: new Date().toISOString(),
  patch,
  patchCompatibility,
  auditCaseClassification: {
    totalCases: onlineQueries.length,
    educationalComplete: onlineQueries.filter(row => row.caseClassification === 'educational-complete').length,
    partialOnly: onlineQueries.filter(row => row.caseClassification === 'partial-only').length,
    mixedPartialAndStaleEditorialFallback: onlineQueries.filter(row => row.caseClassification === 'partial-core-plus-stale-editorial-fallback').map(row => ({ champion: row.champion, role: row.requestedRole, classification: row.caseClassification, note: 'The current OP.GG core is partial; older local editorial profiles exist but are excluded from current-patch complete-build coverage.' })),
    other: onlineQueries.filter(row => !['educational-complete', 'partial-only', 'partial-core-plus-stale-editorial-fallback'].includes(row.caseClassification)).map(row => ({ champion: row.champion, role: row.requestedRole, classification: row.caseClassification }))
  },
  sources: {
    dataDragon: { patch, bundledAt: fs.statSync(path.join(root, `data/dragon/cdn/${patch}/data/en_US/champion.json`)).mtime.toISOString() },
    editorialSeed: { sourcePatch: seed.sourceDataDragonPatch || '', targetPatch: seed.targetPatch || '', sourceStatus: seed.sourceStatus || '', status: 'candidate-archetypes-only', candidateRoles: seedPairs.size },
    publishedBuildSnapshots: [...sources.values()].map(source => ({ source: source.source, patches: [...source.patches].sort(), collectedAt: [...source.dates].sort() })),
    online: onlineAudit
  },
  championsInDataDragon: ddragonChampions.length,
  coverage: {
    offlineCompleteChampionRolePairs: localCompletePairs.size,
    offlineCompleteChampions: localCompleteChampions.size,
    validatedCompleteProfiles: completeProfileCount,
    observedCompleteProfiles: observedProfileCount,
    offlineProfilesWithCurrentPublishedCore: currentPatchPublishedCoreCount,
    offlinePublishedCoreChampionRolePairs: publishedCorePairs.size,
    generatedFromPublishedCoreProfiles: generatedProfileCount,
    offlinePublishedCorePairsWithoutFullBuild: currentPublishedCoreOnlyPairs.size,
    staleEditorialPairsExcludedFromCurrentCoverage: staleProfilePairs.size,
    staleEditorialBuildProfilesExcludedFromCurrentCoverage: staleProfileCount,
    candidateSeedPairsAwaitingReview: pending.length,
    championsAwaitingReview: new Set(pending.map(key => key.split('/')[0])).size,
    onlineValidPublishedCores: onlineBuildCounts.publishedCores,
    onlinePartialOnlyResponses: onlineBuildCounts.partialOnly,
    onlineEducationalCompletions: onlineBuildCounts.educationalCompletions,
    onlineEducationalBuilds: onlineBuildCounts.educationalBuilds,
    onlineAcceptedCompleteBuilds: onlineBuildCounts.acceptedCompleteBuilds,
    onlineCurrentPatchCompleteBuilds: onlineBuildCounts.currentPatchCompleteBuilds,
    onlineAcceptedPartialCores: onlineBuildCounts.acceptedPartialCores,
    onlineRejectedCandidateRows: onlineBuildCounts.rejectedCandidates,
    onlineLocalEditorialFallbacks: onlineBuildCounts.localEditorialFallbacks,
    onlineStaleEditorialFallbackBuilds: onlineBuildCounts.staleEditorialFallbackBuilds,
    onlineRejectedResponses: onlineBuildCounts.rejected,
    onlineQueriesWithoutBuilds: onlineBuildCounts.noBuilds,
    onlineObservedSixItemCombinations: onlineBuildCounts.observedSixItemCombinations
  },
  buildCoverageByChampionRole: pairReport,
  onlineOpggQueries: onlineQueries,
  profileReviewStatuses: Object.fromEntries([...profileReviewStatuses.entries()].sort(([a], [b]) => a.localeCompare(b))),
  rejectedRecommendations: rejected,
  invalidLocalProfiles: rejected.filter(row => !row.codes.includes('partial-profile-without-published-core')),
  staleEditorialPairs: toArray(staleProfilePairs),
  pendingProfiles: pending
};

const output = path.join(root, 'data/ranked', `coverage-report-${patch}.json`);
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const shortIds = ids => (ids || []).map(String).join(' · ') || '—';
const auditMarkdown = [
  '# Auditoría del lote Ranked OP.GG · Parche 16.22.1',
  '',
  `Snapshot real consultado: ${onlineAudit.snapshot || 'no disponible'} (${onlineAudit.auditedAt || 'fecha no disponible'}). Este proceso vuelve a ejecutar el motor sobre la captura guardada; no hace una nueva consulta de red.`,
  '',
  `**Compatibilidad de parche:** League ${patchCompatibility.publishedGamePatch || '—'} · Data Dragon ${patchCompatibility.dataDragonVersion || '—'} · OP.GG ${patchCompatibility.statisticsPatch || '—'} → ${patchCompatibility.status === 'compatible' ? 'compatibles según la relación verificada de Riot' : 'relación sin verificar o incompatible'}.`,
  '',
  `Resultados técnicos: ${onlineBuildCounts.queries} pares, ${onlineBuildCounts.queryErrors} errores de consulta, ${onlineBuildCounts.publishedCores} núcleos válidos, ${onlineBuildCounts.educationalCompletions} pares con propuesta educativa completa, ${onlineBuildCounts.partialOnly} solo parciales, ${onlineBuildCounts.rejected} respuestas rechazadas. No se observó una combinación completa de seis objetos publicada.`,
  `Clasificación que completa los ${onlineQueries.length} casos sin alterar métricas: ${report.auditCaseClassification.educationalComplete} completos educativos + ${report.auditCaseClassification.partialOnly} parciales solamente + ${report.auditCaseClassification.mixedPartialAndStaleEditorialFallback.length} caso mixto. El caso mixto es ${report.auditCaseClassification.mixedPartialAndStaleEditorialFallback.map(row => `${row.champion}/${row.role}`).join(', ') || '—'}: núcleo OP.GG parcial y perfiles editoriales antiguos que se excluyen de la cobertura actual.`,
  '',
  'La legalidad se valida automáticamente. Este lote no contiene descripciones completas de habilidades ni auditoría manual de sinergias para todos los campeones; por eso el estado estratégico queda explícitamente pendiente y no se declara correcto por pasar el validador.',
  '',
  '| Campeón/rol | Arquetipo candidato | Núcleo recibido → normalizado | Entrada transformada eliminada | Estado/builds aceptadas | Rechazos | Revisión estratégica |',
  '|---|---|---|---|---|---|---|',
  ...onlineQueries.map(row => {
    const full = row.engine.validBuilds.map(build => `${build.kind}:${shortIds(build.itemIds)}`).join('<br>') || '—';
    const technical = row.engine.validSixItemOptions ? `completa ${row.engine.validSixItemOptions}` : row.engine.partialCoreItems.length ? `parcial ${shortIds(row.engine.partialCoreItems)}` : row.engine.status;
    const removed = row.normalization.removedRecipeOrTransformationInputs.map(item => `${item.name} (${item.itemId})`).join(', ') || '—';
    const rejection = [...new Set([...(row.engine.rejectedCoreCodes || []), ...(row.engine.rejectedCandidates || []).flatMap(candidate => candidate.codes || [])])].join(', ') || 'ninguno';
    return `| ${row.champion}/${row.requestedRole} | ${row.auditArchetype || '—'} | ${shortIds(row.normalization.sourceCore)} → ${shortIds(row.normalization.normalizedCore)} | ${removed} | ${technical}<br>${full} | ${rejection} | pendiente: validar escalados/habilidades, sinergia y oportunidad de compra |`;
  }),
  '',
  '## Criterio estratégico',
  '',
  '- Los arquetipos provenientes de la auditoría/seed son etiquetas candidatas, no restricciones del motor.',
  '- Las continuaciones armadas con muestras independientes no son combinaciones observadas y no reciben sus estadísticas.',
  '- La decisión de composición es educativa: sugiere revisar espacios situacionales; no cambia automáticamente el núcleo.',
  '- Los núcleos transformados se normalizan por receta verificada y parche; las entradas consumidas se quitan del conteo de espacios.',
  '- La revisión mecánica de habilidades sigue pendiente si el lote no contiene el detalle de habilidades necesario.'
].join('\n');
const auditMarkdownPath = path.join(root, 'data/ranked', `audit-50-cases-${patch}.md`);
fs.writeFileSync(auditMarkdownPath, auditMarkdown + '\n');
const summary = { ...report, pendingProfiles: undefined, rejectedRecommendations: report.rejectedRecommendations.length, invalidLocalProfiles: report.invalidLocalProfiles.length, output: `data/ranked/coverage-report-${patch}.json`, firstPendingProfiles: pending.slice(0, 12) };
console.log(JSON.stringify(summary, null, 2));
