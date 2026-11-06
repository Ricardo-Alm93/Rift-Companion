const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { comparePatchVersions } = require('../src/domain/patch-compatibility');
const { normalizeChampionAbilityProfile } = require('../src/domain/champion-abilities');
const { createChampionMechanicsProfile } = require('../src/engine/champion-mechanics-profiler');
const { evaluateChampionItemSynergy, evaluateChampionBuildSynergy, compareChampionBuilds } = require('../src/engine/champion-item-synergy');
const { catalog: interactionCatalog, evaluateAbilityItemInteraction, validateInteractionCatalog } = require('../src/engine/champion-item-interaction-catalog');
const { normalizeMerakiChampion, mergeAbilityEvidence, createCommunityDragonAdapter } = require('../src/domain/champion-knowledge-sources');
const { createMerakiAdapter } = require('../src/services/champion-knowledge-adapters.cjs');
const { ChampionAbilityCache, championAbilityResource } = require('../src/services/champion-ability-cache.cjs');
const { createBuildAdvisor } = require('../src/engine/build-candidate-generator');
const { buildItemCatalog } = require('../src/engine/item-eligibility');
const itemData = require('../data/dragon/cdn/16.22.1/data/en_US/item.json');
const taxonomy = require('../data/item-taxonomy.json');
const itemGroups = require('../data/ranked/item-groups-16.22.1.json');

const relations = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/ranked/patch-relations.json'), 'utf8')).relations;

test('patch diagnostics compare League 26.22, Data Dragon 16.22.1, OP.GG 16.22 and optional regional version', () => {
  const result = comparePatchVersions({ publishedGamePatch: '26.22', dataDragonVersion: '16.22.1', statisticsPatch: '16.22', regionalServerVersion: '26.22.1.1234', relations });
  assert.equal(result.status, 'compatible');
  assert.deepEqual(result.comparisons, { dataDragonMatchesPublished: true, statisticsMatchesPublished: true, regionalMatchesPublished: true });
  assert.equal(comparePatchVersions({ publishedGamePatch: '26.22', dataDragonVersion: '16.22.1', statisticsPatch: '16.21', relations }).status, 'mismatch');
  assert.equal(comparePatchVersions({ publishedGamePatch: '26.22', dataDragonVersion: '16.22.1', statisticsPatch: '', relations }).comparisons.statisticsMatchesPublished, null);
});

function championFixture() {
  const ability = (id, name, description, link, coeff) => ({ id, name, description, tooltip: description, vars: link ? [{ key: 'a1', link, coeff: [coeff] }] : [], range: [600], cooldown: [8], cost: [50], resource: '50 Mana' });
  return { version: '16.22.1', data: { Lux: {
    id: 'Lux', name: 'Lux', partype: 'Mana', tags: ['Mage', 'Support'],
    passive: { name: 'Illumination', description: 'Magic damage.', image: { full: 'Lux_Passive.png' } },
    spells: [
      ability('LuxLightBinding', 'Light Binding', 'Deals <magicDamage>{{ totaldamage }}</magicDamage> magic damage, slows the target.', 'spelldamage', 0.65),
      ability('LuxPrismaticWave', 'Prismatic Barrier', 'Shields allies.', 'spelldamage', 0.35),
      ability('LuxLightStrikeKugel', 'Lucent Singularity', 'Deals magic damage over time.', 'spelldamage', 0.6),
      ability('LuxMaliceCannon', 'Final Spark', 'Deals <magicDamage>300</magicDamage> magic damage.', 'spelldamage', 0.75)
    ]
  } } };
}

test('champion detail normalization keeps passive/Q/W/E/R, source text, explicit tags and only published scaling values', () => {
  const normalized = normalizeChampionAbilityProfile(championFixture(), { championId: 'Lux', version: '16.22.1', locale: 'en_US' });
  assert.deepEqual(normalized.abilities.map(row => row.key), ['P', 'Q', 'W', 'E', 'R']);
  assert.equal(normalized.coverage.abilityCount, 5);
  assert.deepEqual(normalized.abilities[1].scalings[0].values, [0.65]);
  assert.ok(normalized.verifiedMechanics.includes('magic-damage'));
  assert.ok(normalized.inferredMechanics.some(row => row.id === 'crowd-control' && row.verified === false));
  assert.ok(normalized.abilities[1].formulaTokens.includes('totaldamage'));
  assert.equal(normalized.abilities[0].scalings.length, 0);
});

test('bundled individual Data Dragon files normalize for the pilot champions and every bundled champion file', () => {
  const championDirectory = path.join(__dirname, '../data/dragon/cdn/16.22.1/data/en_US/champion');
  const bundledChampionIds = fs.readdirSync(championDirectory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  const championIds = new Set(['Ahri', 'Ryze', 'Cassiopeia', 'Azir', 'Jinx', 'Kaisa', 'Ornn', 'Soraka', ...bundledChampionIds]);
  for (const championId of championIds) {
    const file = path.join(__dirname, `../data/dragon/cdn/16.22.1/data/en_US/champion/${championId}.json`);
    assert.ok(fs.existsSync(file), `missing individual champion file: ${championId}`);
    const profile = normalizeChampionAbilityProfile(JSON.parse(fs.readFileSync(file, 'utf8')), { championId, version: '16.22.1', locale: 'en_US' });
    assert.equal(profile.coverage.abilityCount, 5, championId);
    assert.equal(profile.abilities.length, 5, championId);
  }
});

test('mechanics profiler separates Data Dragon evidence from unverified text inferences and editorial candidates', () => {
  const abilityProfile = normalizeChampionAbilityProfile(championFixture(), { championId: 'Lux', version: '16.22.1', locale: 'en_US' });
  const profile = createChampionMechanicsProfile(abilityProfile, { role: 'mid', editorialProfiles: [{ style: 'ap_burst', source: 'seed', reviewStatus: 'candidate' }] });
  assert.equal(profile.status, 'verified-static-abilities');
  assert.ok(profile.damageTypes.includes('magic-damage'));
  assert.ok(profile.scalings.some(row => row.stat === 'ap' && row.abilityKey === 'Q'));
  assert.ok(profile.mechanics.some(row => row.confidence === 'heuristic-text-signal' && row.verified === false));
  assert.equal(profile.buildArchetypes[0].status, 'editorial-candidate');
  assert.equal(profile.abilityFacts.find(row => row.abilityKey === 'Q').onHit.status, 'not-established');
  assert.ok(profile.classifications.burst);
  assert.ok(profile.warnings.some(row => row.includes('candidatos')));
});

test('champion item synergy is weighted evidence, not an eligibility rule', () => {
  const mechanics = { championId: 'Lux', championName: 'Lux', status: 'verified-static-abilities', resource: 'Mana', scalings: [{ stat: 'ap', abilityKey: 'Q', abilityName: 'Light Binding', source: 'Data Dragon vars', verified: true }] };
  const supported = evaluateChampionItemSynergy({ item: { name: 'AP item', tags: ['SpellDamage', 'Mana'] }, selectedItems: [], mechanics, language: 'es' });
  const absent = evaluateChampionItemSynergy({ item: { name: 'Unusual item', tags: ['CriticalStrike'] }, selectedItems: [], mechanics, language: 'es' });
  assert.equal(supported.status, 'evidence-supported-limited');
  assert.match(supported.fit, /Light Binding/);
  assert.equal(supported.mechanicsEvidence[0].source, 'Data Dragon vars');
  assert.equal(absent.status, 'insufficient-evidence');
  assert.equal(absent.score, null);
  assert.equal(absent.weightOnly, true);
  assert.ok(absent.score >= 0);
  const wholeBuild = evaluateChampionBuildSynergy({ itemIds: ['100', '200'], itemCatalog: { '100': { tags: ['SpellDamage', 'Mana'] }, '200': { tags: ['CriticalStrike'] } }, mechanics, language: 'es' });
  assert.equal(wholeBuild.itemCount, 2);
  assert.equal(wholeBuild.itemsWithMechanicEvidence, 1);
  assert.equal(wholeBuild.status, 'partially-supported');
});

test('ability prose mentioning basic attacks does not establish an on-hit item interaction or create synergy points', () => {
  const abilityProfile = normalizeChampionAbilityProfile(championFixture(), { championId: 'Lux', version: '16.22.1', locale: 'en_US' });
  abilityProfile.abilities[1].description = 'Her next basic attack deals additional magic damage.';
  const mechanics = createChampionMechanicsProfile(abilityProfile);
  const result = evaluateChampionItemSynergy({ item: { name: 'On-hit item', tags: ['AttackSpeed', 'OnHit'] }, mechanics, language: 'en' });
  assert.equal(result.status, 'insufficient-evidence');
  assert.equal(result.score, null);
  assert.ok(result.rejectedSignals.some(row => row.mechanic === 'on-hit'));
});

test('patch-compatible Meraki on-hit metadata remains an unverified candidate and cannot award verified synergy points', () => {
  const mechanics = { championId: 'Test', championName: 'Test', patch: '16.22.1', status: 'verified-static-abilities', scalings: [], abilityFacts: [], supplementalEvidence: [{ championId: 'Test', abilityKey: 'Q', onHitEffects: true, verificationStatus: 'compatible-but-not-independently-verified', source: 'meraki-lolstaticdata', sourcePatch: '16.22.1', verified: false }] };
  const result = evaluateChampionItemSynergy({ item: { id: '1', tags: ['on-hit', 'attack-speed'] }, mechanics });
  assert.equal(result.score, null);
  assert.equal(result.status, 'insufficient-evidence');
  assert.equal(result.communityCandidates[0].status, 'community-candidate-unverified');
});

test('Meraki adapter preserves per-effect source metadata and excludes stale patch data from current knowledge', () => {
  const fixture = { Ahri: { id: 103, key: 'Ahri', icon: 'https://ddragon.leagueoflegends.com/cdn/15.15.1/img/champion/Ahri.png', abilities: { Q: [{ effects: [{ description: 'Deals magic damage', damageType: 'Magic', onHitEffects: false, leveling: [{ modifiers: [{ values: [60, 90] }] }] }] }] } } };
  const normalized = normalizeMerakiChampion(fixture, 'Ahri', { expectedPatch: '16.22.1', fetchedAt: '2026-11-04T00:00:00.000Z', lastModified: '2025-08-01T08:37:37.000Z' });
  assert.equal(normalized.sourcePatch, '15.15.1');
  assert.equal(normalized.status, 'stale-source');
  assert.equal(normalized.records[0].verified, false);
  const merged = mergeAbilityEvidence({ championId: 'Ahri', version: '16.22.1' }, [normalized]);
  assert.equal(merged.supplementalRecords.length, 0);
  assert.equal(merged.ignoredSources[0].status, 'stale-source');
  const compatibleFixture = { Ahri: { ...fixture.Ahri, icon: 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion/Ahri.png' } };
  const compatible = normalizeMerakiChampion(compatibleFixture, 'Ahri', { expectedPatch: '16.22.1' });
  const compatibleMerge = mergeAbilityEvidence({ championId: 'Ahri', version: '16.22.1' }, [compatible]);
  assert.equal(compatibleMerge.supplementalRecords.length, 1);
  assert.equal(compatibleMerge.supplementalRecords[0].verified, false);
});

test('Meraki service caches, coalesces concurrent reads and exposes stale data state without overriding official source', async () => {
  let requests = 0, saved = null;
  const payload = { Ahri: { id: 103, key: 'Ahri', icon: 'https://ddragon.leagueoflegends.com/cdn/15.15.1/img/champion/Ahri.png', abilities: { Q: [{ effects: [{ description: 'Q' }] }] } } };
  const adapter = createMerakiAdapter({ fetchImpl: async () => { requests += 1; await new Promise(resolve => setTimeout(resolve, 3)); return { ok: true, status: 200, headers: { get: name => name === 'last-modified' ? 'Fri, 01 Aug 2025 08:37:37 GMT' : 'etag1' }, json: async () => payload }; }, readCache: async () => saved, writeCache: async (_key, value) => { saved = value; } });
  const [one, two] = await Promise.all([adapter.getChampion({ championId: 'Ahri', expectedPatch: '16.22.1' }), adapter.getChampion({ championId: 'Ahri', expectedPatch: '16.22.1' })]);
  assert.equal(requests, 1);
  assert.equal(one.status, 'stale-source');
  assert.equal(two.sourcePatch, '15.15.1');
  assert.ok(saved);
});

test('CommunityDragon adapter blocks extracted game data until its reuse license is verified', () => {
  assert.equal(createCommunityDragonAdapter().inspect().status, 'blocked-license-unverified');
  assert.equal(createCommunityDragonAdapter().normalize().records.length, 0);
});

test('build comparison refuses to rank alternatives without verified mechanics and keeps source categories', () => {
  const compared = compareChampionBuilds({ builds: [{ id: 'observed', sourceKind: 'observed', itemIds: ['100'] }, { id: 'proposal', sourceKind: 'educational', itemIds: ['200'] }], itemCatalog: { 100: { tags: ['CriticalStrike'] }, 200: { tags: ['Armor'] } }, mechanics: { status: 'verified-static-abilities', scalings: [] }, language: 'es' });
  assert.equal(compared.status, 'comparison-limited');
  assert.match(compared.conclusion, /insuficiente/);
  assert.deepEqual(compared.evaluated.map(row => row.sourceKind), ['observed', 'educational']);
});

test('eight-pilot evidence review supports Soraka healing items but does not invent Jinx on-hit or crit interactions', () => {
  const load = championId => normalizeChampionAbilityProfile(JSON.parse(fs.readFileSync(path.join(__dirname, `../data/dragon/cdn/16.22.1/data/en_US/champion/${championId}.json`))), { championId, version: '16.22.1', locale: 'en_US', retrievedAt: '2026-11-04T00:00:00.000Z' });
  const soraka = createChampionMechanicsProfile(load('Soraka'));
  const jinx = createChampionMechanicsProfile(load('Jinx'));
  const supportItem = evaluateChampionItemSynergy({ item: { name: 'Heal/shield item', tags: ['heal-shield-power', 'support'] }, mechanics: soraka });
  const unsupportedJinxInteraction = evaluateChampionItemSynergy({ item: { name: 'Crit/on-hit item', tags: ['critical-strike', 'attack-speed', 'on-hit'] }, mechanics: jinx });
  assert.ok(soraka.abilityFacts.some(fact => fact.effects.includes('healing') && fact.sourcePatch === '16.22.1' && fact.sourceDate));
  assert.equal(supportItem.status, 'evidence-supported-limited');
  assert.ok(supportItem.mechanicsEvidence.some(row => row.effect === 'healing'));
  assert.equal(unsupportedJinxInteraction.status, 'insufficient-evidence');
  assert.equal(unsupportedJinxInteraction.score, null);
  assert.ok(unsupportedJinxInteraction.rejectedSignals.some(row => row.mechanic === 'on-hit'));
});

test('all eight pilot profiles expose five versioned ability facts and keep absent coefficients absent', () => {
  for (const championId of ['Ahri', 'Ryze', 'Cassiopeia', 'Azir', 'Jinx', 'Kaisa', 'Ornn', 'Soraka']) {
    const response = JSON.parse(fs.readFileSync(path.join(__dirname, `../data/dragon/cdn/16.22.1/data/en_US/champion/${championId}.json`)));
    const abilities = normalizeChampionAbilityProfile(response, { championId, version: '16.22.1', locale: 'en_US', retrievedAt: '2026-11-04T00:00:00.000Z' });
    const mechanics = createChampionMechanicsProfile(abilities);
    assert.ok(Object.keys(mechanics.baseStats).length > 0, `${championId} base stats`);
    assert.ok(mechanics.baseStats.health?.sourcePatch === '16.22.1' || mechanics.baseStats.hp?.sourcePatch === '16.22.1', `${championId} health provenance`);
    assert.equal(mechanics.abilityFacts.length, 5, championId);
    assert.ok(mechanics.abilityFacts.every(fact => fact.sourcePatch === '16.22.1' && fact.sourceDate), championId);
    assert.equal(mechanics.scalings.length, 0, `${championId} must not gain invented coefficients`);
    assert.ok(mechanics.abilityFacts.every(fact => fact.onHit.status === 'not-established'), championId);
  }
});

test('ranked advisor feeds skill evidence into one concise per-item fit explanation without altering legal item choices', () => {
  const itemCatalog = buildItemCatalog({ itemData, taxonomy, patch: '16.22.1', exclusiveGroups: itemGroups });
  const buildProfiles = { champions: { Lux: { roles: { mid: [{ id: 'ap-core', patch: '16.22.1', style: 'ap_burst', label: 'AP core', label_es: 'Núcleo AP', source: 'test', confidence: 'curated', itemIds: ['6655', '3089', '3157', '3116', '3102', '3020'], when: [], tradeoffs: [] }] } } } };
  const advisor = createBuildAdvisor({ buildProfiles, itemCatalog, championDefinitions: { Lux: { name: 'Lux', tags: ['Mage'] } }, patch: '16.22.1', exclusiveGroups: itemGroups });
  const abilityProfile = normalizeChampionAbilityProfile(championFixture(), { championId: 'Lux', version: '16.22.1', locale: 'en_US' });
  const championMechanics = createChampionMechanicsProfile(abilityProfile, { role: 'mid' });
  const result = advisor({ player: { championId: 'Lux', role: 'mid' }, championMechanics }, 'en');
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].validation.valid, true);
  assert.equal(result.championMechanics.status, 'verified-static-abilities');
  assert.equal(result.buildComparison.status, 'comparison-limited');
  const explanation = result.options[0].itemExplanations['6655'];
  assert.equal(explanation.what, undefined);
  assert.equal(typeof explanation.fit, 'string');
  assert.equal(explanation.sacrifice, undefined);
  assert.equal(explanation.whyFits.text, explanation.fit);
  assert.equal(explanation.evidenceStatus, 'evidence-supported');
  assert.equal(explanation.evidenceSummary.level, 'documented');
  assert.equal(explanation.evidenceSummary.patch, '16.22.1');
  assert.match(explanation.fit, /Light Binding|Final Spark/);
});

test('main window and overlay both load the same evidence-aware item tooltip renderer', () => {
  const mainHtml = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  const overlayHtml = fs.readFileSync(path.join(__dirname, '../src/overlay.html'), 'utf8');
  const tooltipRenderer = fs.readFileSync(path.join(__dirname, '../src/item-tooltip.js'), 'utf8');
  assert.match(mainHtml, /<script src="item-tooltip\.js"><\/script>/);
  assert.match(overlayHtml, /<script src="item-tooltip\.js"><\/script>/);
  assert.match(tooltipRenderer, /education\?\.evidenceSummary/);
  assert.match(tooltipRenderer, /Documented interaction/);
  assert.match(tooltipRenderer, /Revisión editorial/);
});

test('ability cache keys by version, locale and champion, shares concurrent fetches, and returns stored profile offline', async () => {
  assert.equal(championAbilityResource({ championId: 'Lux', version: '16.22.1', locale: 'es_ES' }), 'cdn/16.22.1/data/es_ES/champion/Lux.json');
  assert.throws(() => championAbilityResource({ championId: '../Lux', version: '16.22.1', locale: 'es_ES' }));
  let fetchCount = 0, stored = null;
  const cache = new ChampionAbilityCache({ fetchJson: async () => { fetchCount += 1; await new Promise(resolve => setTimeout(resolve, 5)); return championFixture(); }, readCache: async () => stored, writeCache: async (_key, value) => { stored = value; } });
  const [first, concurrent] = await Promise.all(['Lux', 'Lux'].map(championId => cache.get({ championId, version: '16.22.1', locale: 'en_US' })));
  assert.equal(fetchCount, 1);
  assert.equal(first.championId, concurrent.championId);
  cache.clearMemory();
  const offlineCache = new ChampionAbilityCache({ fetchJson: async () => { throw new Error('offline'); }, readCache: async () => stored });
  assert.equal((await offlineCache.get({ championId: 'Lux', version: '16.22.1', locale: 'en_US' })).championName, 'Lux');
});

test('champion-item interaction catalog requires patch, provenance, confidence, and a known evidence level', () => {
  assert.deepEqual(validateInteractionCatalog(interactionCatalog), []);
  assert.ok(interactionCatalog.interactions.every(row => row.patch === '16.22.1' && row.source?.sourcePatch === '16.22.1'));
  assert.ok(interactionCatalog.interactions.every(row => ['documented', 'editorial-reviewed', 'unknown'].includes(row.evidenceLevel)));
  assert.ok(interactionCatalog.interactions.every(row => row.confidence >= 0 && row.confidence <= 1));
  assert.equal(interactionCatalog.interactions.find(row => row.id === 'jinx-spells-onhit-unknown').verified, false);
});

test('ability-item resolver distinguishes actual triggers, stat compatibility, and unknown interactions', () => {
  const ahriMalignance = evaluateAbilityItemInteraction({ championId: 'Ahri', abilityKey: 'R', itemId: '3118', patch: '16.22.1' });
  const azirSoldierNashor = evaluateAbilityItemInteraction({ championId: 'Azir', abilityKey: 'W', itemId: '3115', patch: '16.22.1' });
  const jinxWRunaan = evaluateAbilityItemInteraction({ championId: 'Jinx', abilityKey: 'W', itemId: '3085', patch: '16.22.1' });
  const oldPatch = evaluateAbilityItemInteraction({ championId: 'Ahri', abilityKey: 'R', itemId: '3118', patch: '15.15.1' });
  assert.equal(ahriMalignance.evidenceLevel, 'documented');
  assert.equal(ahriMalignance.interactionType, 'passive-trigger');
  assert.equal(azirSoldierNashor.evidenceLevel, 'editorial-reviewed');
  assert.match(azirSoldierNashor.claim, /reduced effectiveness/);
  assert.equal(jinxWRunaan.evidenceLevel, 'unknown');
  assert.equal(jinxWRunaan.verified, false);
  assert.equal(oldPatch.evidenceLevel, 'unknown');
});

test('build certification separates legality from item evidence and requires an exact full-set review', () => {
  const mechanics = createChampionMechanicsProfile(normalizeChampionAbilityProfile(JSON.parse(fs.readFileSync(path.join(__dirname, '../data/dragon/cdn/16.22.1/data/en_US/champion/Ahri.json'))), { championId: 'Ahri', version: '16.22.1', locale: 'en_US', retrievedAt: '2026-11-04T00:00:00.000Z' }));
  const ids = ['3118', '4645', '3157', '3020', '3089', '3135'];
  const itemCatalog = buildItemCatalog({ itemData, taxonomy, patch: '16.22.1', exclusiveGroups: itemGroups });
  const legalButPartialReview = evaluateChampionBuildSynergy({ itemIds: ids, itemCatalog, mechanics, role: 'mid', buildId: 'observed-core-completion', validation: { valid: true }, purchaseOrder: ids.map((purchaseItemId, index) => ({ order: index + 1, purchaseItemId })) });
  const partial = evaluateChampionBuildSynergy({ itemIds: ids.slice(0, 3), itemCatalog, mechanics, role: 'mid', buildId: 'observed-core-completion', validation: { valid: true }, purchaseOrder: ids.slice(0, 3).map(purchaseItemId => ({ purchaseItemId })) });
  const invalid = evaluateChampionBuildSynergy({ itemIds: ids, itemCatalog, mechanics, validation: { valid: false }, purchaseOrder: ids.map(purchaseItemId => ({ purchaseItemId })) });
  assert.equal(legalButPartialReview.certification.legalStatus, 'legal');
  assert.equal(legalButPartialReview.certification.reviewStatus, 'partial');
  assert.notEqual(legalButPartialReview.certification.status, 'strategically-reviewed');
  assert.equal(partial.certification.status, 'insufficient-evidence');
  assert.equal(invalid.certification.status, 'legally-invalid');
});
