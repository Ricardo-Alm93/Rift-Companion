const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const patch = '16.22.1';
const read = (name, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT' && fallback !== null) return fallback; throw error; }
};
const { normalizeChampionAbilityProfile } = require('../src/domain/champion-abilities');
const { createChampionMechanicsProfile } = require('../src/engine/champion-mechanics-profiler');
const { evaluateChampionItemSynergy } = require('../src/engine/champion-item-synergy');
const { buildItemCatalog, validateBuildItems, validateCoreItems } = require('../src/engine/item-eligibility');
const base = read('data/champion-build-profiles.json');
const pilots = read(`data/ranked/pilot-build-profiles-${patch}.json`, { champions: {} });
const definitions = read(`data/dragon/cdn/${patch}/data/en_US/champion.json`).data;
const itemData = read(`data/dragon/cdn/${patch}/data/en_US/item.json`);
const taxonomy = read('data/item-taxonomy.json');
const groups = read(`data/ranked/item-groups-${patch}.json`);
const sourceAudit = read(`data/ranked/knowledge-source-audit-${patch}.json`, { patch, records: [] });
const catalog = buildItemCatalog({ itemData, taxonomy, patch, exclusiveGroups: groups });
const profiles = { ...(base.champions || {}), ...(pilots.champions || {}) };
const pilotNames = ['Ahri', 'Ryze', 'Cassiopeia', 'Azir', 'Jinx', 'Kaisa', 'Ornn', 'Soraka'];
const onlineReport = read(`data/ranked/coverage-report-${patch}.json`, { onlineOpggQueries: [] });
const auditPairs = onlineReport.onlineOpggQueries || [];

function abilityProfile(championId, locale = 'en_US') {
  const file = path.join(root, 'data', 'dragon', 'cdn', patch, 'data', locale, 'champion', `${championId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return normalizeChampionAbilityProfile(read(path.relative(root, file)), { championId, version: patch, locale }); }
  catch { return null; }
}

function mechanicsSummary(championId, role, profileRows = []) {
  const abilities = abilityProfile(championId);
  if (!abilities) return { status: 'insufficient-data', abilityCoverage: { present: 0, expected: 5 }, explicitDamageTypes: [], verifiedScalingStats: [], inferredMechanics: [], provenance: 'no-local-detail-file' };
  const mechanics = createChampionMechanicsProfile(abilities, { role, editorialProfiles: profileRows });
  return {
    status: mechanics.status,
    abilityCoverage: { present: abilities.coverage.abilityCount, expected: 5 },
    explicitDamageTypes: mechanics.damageTypes,
    verifiedScalingStats: [...new Set(mechanics.scalings.map(row => row.stat))].sort(),
    baseStatFields: Object.keys(mechanics.baseStats || {}).sort(),
    publishedCooldownAbilities: mechanics.abilityFacts.filter(fact => fact.cooldown.length).map(fact => fact.abilityKey),
    publishedCostAbilities: mechanics.abilityFacts.filter(fact => fact.cost.length).map(fact => fact.abilityKey),
    resource: mechanics.resource,
    inferredMechanics: mechanics.inferredMechanics.map(row => row.id),
    documentedAbilityFacts: mechanics.abilityFacts.map(fact => ({ abilityKey: fact.abilityKey, damageTypes: fact.damageTypes, effects: fact.effects, scalingStats: fact.scalings.map(row => row.stat), cooldownRanks: fact.cooldown.length, costRanks: fact.cost.length, onHitStatus: fact.onHit.status, verificationStatus: fact.verificationStatus })),
    classifications: mechanics.classifications,
    provenance: abilities.provenance.source,
    warnings: mechanics.warnings
  };
}

function buildAudit(championId, role, ids, mechanics, kind, suppliedValidation = null, status = '') {
  const itemIds = (ids || []).map(String);
  const validation = suppliedValidation || (itemIds.length === 6
    ? validateBuildItems(itemIds, catalog, { championId, role, patch, exclusiveGroups: groups })
    : validateCoreItems(itemIds, catalog, { championId, role, patch, exclusiveGroups: groups }));
  const profile = mechanics.status === 'insufficient-data' ? null : createChampionMechanicsProfile(abilityProfile(championId), { role });
  const synergies = itemIds.filter(id => catalog[id]).map(id => ({ itemId: id, ...evaluateChampionItemSynergy({ item: catalog[id], selectedItems: itemIds.filter(other => other !== id).map(other => catalog[other]).filter(Boolean), mechanics: profile, language: 'en' }) }));
  const evidenceMatches = synergies.filter(row => row.mechanicsEvidence.length > 0).length;
  const strategicStatus = !validation.valid ? 'build-rejected'
    : itemIds.length !== 6 ? 'insufficient-data-partial-core'
      : profile?.status !== 'verified-static-abilities' ? 'insufficient-data'
        : evidenceMatches === 0 ? 'legal-mechanics-documented-synergy-unverified'
          : 'coherence-partially-verified';
  return { kind, status, itemIds, legality: validation.valid ? 'legal' : 'invalid', validationErrors: validation.errors || [], strategicStatus, synergyEvidenceMatches: evidenceMatches, itemSynergies: synergies };
}

function profileRows(championId, role) {
  const value = profiles[championId]?.roles?.[role] || profiles[championId]?.roles?.[role === 'adc' ? 'bot' : role] || [];
  return Array.isArray(value) ? value : [value];
}

const pilotReport = pilotNames.flatMap(championId => {
  const roles = profiles[championId]?.roles || {};
  const role = championId === 'Ornn' ? 'top' : championId === 'Soraka' ? 'support' : ['Jinx', 'Kaisa'].includes(championId) ? 'adc' : 'mid';
  const rows = profileRows(championId, role);
  const mechanics = mechanicsSummary(championId, role, rows);
  const builds = rows.map(row => buildAudit(championId, role, row.itemIds || row.items || [], mechanics, row.buildType || 'editorial', null, row.patch || ''));
  return [{ championId, role, mechanics, builds }];
});

const liveAuditReport = auditPairs.map(row => {
  const championId = Object.keys(definitions).find(id => id.toLowerCase() === String(row.champion).toLowerCase()) || row.champion;
  const rows = profileRows(championId, row.requestedRole);
  const mechanics = mechanicsSummary(championId, row.requestedRole, rows);
  const builds = (row.engine?.validBuilds || []).map(build => buildAudit(championId, row.requestedRole, build.itemIds, mechanics, build.kind, build.validation, build.buildStatus || ''));
  if (row.engine?.partialCoreItems?.length) builds.push(buildAudit(championId, row.requestedRole, row.engine.partialCoreItems, mechanics, 'published-core', row.engine.observedCore?.validation || null, 'partial'));
  return { championId, role: row.requestedRole, sourcePatch: row.patch, source: onlineReport.sources?.online?.source || '', sourceQueryStatus: row.sourceStatus, caseClassification: row.caseClassification, mechanics, builds };
});

const summarize = rows => ({
  championRolePairs: rows.length,
  withAllFiveAbilityDescriptions: rows.filter(row => row.mechanics.abilityCoverage.present === 5).length,
  withAtLeastOnePublishedScaling: rows.filter(row => row.mechanics.verifiedScalingStats.length > 0).length,
  withPublishedBaseStats: rows.filter(row => row.mechanics.baseStatFields.length > 0).length,
  withExplicitDamageType: rows.filter(row => row.mechanics.explicitDamageTypes.length > 0).length,
  withInferredControlOrMobilitySignals: rows.filter(row => row.mechanics.inferredMechanics.some(id => ['crowd-control', 'mobility'].includes(id))).length,
  insufficientAbilityData: rows.filter(row => row.mechanics.status === 'insufficient-data').length,
  legalBuilds: rows.flatMap(row => row.builds).filter(build => build.legality === 'legal' && build.itemIds.length === 6).length,
  partialCasePairs: rows.filter(row => row.caseClassification === 'partial-only' || row.caseClassification === 'partial-core-plus-stale-editorial-fallback').length,
  publishedPartialCoreRecords: rows.flatMap(row => row.builds).filter(build => build.kind === 'published-core' && build.itemIds.length > 0 && build.itemIds.length < 6).length,
  strategicCoherenceVerified: rows.flatMap(row => row.builds).filter(build => build.strategicStatus === 'coherence-verified').length,
  strategicCoherencePartiallyVerified: rows.flatMap(row => row.builds).filter(build => build.strategicStatus === 'coherence-partially-verified').length,
  legalWithDocumentedMechanicsButNoItemLink: rows.flatMap(row => row.builds).filter(build => build.strategicStatus === 'legal-mechanics-documented-synergy-unverified').length,
  dataInsufficientForStrategy: rows.flatMap(row => row.builds).filter(build => build.strategicStatus === 'insufficient-data').length,
  rejectedBuilds: rows.flatMap(row => row.builds).filter(build => build.strategicStatus === 'build-rejected').length
});

const report = {
  generatedAt: new Date().toISOString(), patch,
  methodology: { note: 'Static ability details and explicit tags/vars are verified source fields; text-derived patterns are indicators, not proof. Passing item legality is not strategic verification. No profile in this report is marked fully strategically verified without independent human review.', categories: { mutuallyExclusivePerBuildStatus: ['build-rejected', 'insufficient-data-partial-core', 'insufficient-data', 'legal-mechanics-documented-synergy-unverified', 'coherence-partially-verified', 'coherence-verified'], cumulativeBuildCounts: ['legalBuilds', 'publishedPartialCoreRecords', 'documentedAbilityPairs'], pairClassificationCounts: ['partialCasePairs'] }, staleDataHandling: 'Mismatched or stale community source data is ignored for current-patch facts and listed in source audit.' },
  sourceAudit,
  pilots: { champions: pilotNames.length, summary: summarize(pilotReport), rows: pilotReport },
  previous50PairAudit: { sourceSnapshot: onlineReport.sources?.online?.snapshot || '', statisticsPatch: onlineReport.sources?.online?.dataPatch || '', summary: summarize(liveAuditReport), rows: liveAuditReport }
};
const output = path.join(root, 'data/ranked', `champion-intelligence-report-${patch}.json`);
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: path.relative(root, output), pilots: report.pilots.summary, previous50PairAudit: report.previous50PairAudit.summary }, null, 2));
