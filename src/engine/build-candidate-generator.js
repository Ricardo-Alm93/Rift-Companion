const { loadChampionProfiles } = require('../domain/champion-profiles');
const { validateBuildItems, validateCoreItems } = require('./item-eligibility');
const { scoreBuild } = require('./build-coherence-scorer');
const { planPurchasePath, planPurchaseOrder } = require('./purchase-path-planner');
const fallbackItemPurposeCatalog = require('../../data/ranked/item-purposes-16.22.1.json');
const { explainBuild } = require('./explanation-generator');
const { analyzeComposition } = require('./team-composition-analyzer');
const { evaluateChampionItemSynergy, evaluateChampionBuildSynergy, compareChampionBuilds } = require('./champion-item-synergy');
const { rankPublishedCoreCompletions } = require('./published-core-completion');
const { evaluateBuildCompatibility } = require('./build-compatibility-v2.cjs');
const { planRankedStages } = require('./build-stage-planner.cjs');
const { optimizeBuildSubstitutions } = require('./build-substitution-optimizer.cjs');
const { evaluateCompleteBuildSet } = require('./build-set-strategy.cjs');
const { knowledgeFor, editorialStatFit } = require('./champion-knowledge-v3.cjs');
const { optimizeItemBuilds } = require('./build-search-optimizer.cjs');
const { scoreArchetypeSet, V4_WEIGHTS } = require('./build-set-strategy.cjs');
const archetypeCandidates = require('../../data/ranked/archetype-candidates-16.22.1.json');
const { getConsumedItemIds } = require('./ranked/item-transformation');

function rows(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function canonicalRole(value) { const role = String(value || '').toLowerCase(); return role === 'bot' ? 'adc' : role; }
function patchLine(value) { const match = String(value || '').match(/^(\d+)\.(\d+)/); return match ? `${match[1]}.${match[2]}` : ''; }
function sourcePatch(data) { return data?.patch || rows(data?.trends?.win)[0]?.version || ''; }
function shortReason(value, max = 132) { const text = String(value || '').replace(/\s+/g, ' ').trim(); if (text.length <= max) return text; const cut = text.slice(0, max - 1).replace(/\s+\S*$/, ''); return `${cut}…`; }
function clamp(value,min,max){return Math.max(min,Math.min(max,Number(value)||0))}
function sourceSlotRows(data, key, catalog, excluded = new Set(), minimumGames = 20) {
  return rows(data?.[key]).map(row => ({ row, id: Array.isArray(row?.ids) && row.ids.length === 1 ? String(row.ids[0]) : '' }))
    .filter(({ row, id }) => id && Number(row.play) >= minimumGames && Number(row.pick_rate) > 0 && catalog[id] && !excluded.has(id))
    .sort((a, b) => (Number(b.row.pick_rate) || 0) - (Number(a.row.pick_rate) || 0) || (Number(b.row.play) || 0) - (Number(a.row.play) || 0));
}
function publishedSubstitutionCandidates(data, catalog, source = 'Published champion-role data', minimumGames = 20) {
  const candidates = [];
  for (const key of ['core_items', 'boots', 'last_items', 'fourth_items', 'fifth_items', 'sixth_items']) {
    for (const row of rows(data?.[key])) {
      const play = Number(row?.play) || 0, pickRate = Number(row?.pick_rate) || 0;
      if (play < minimumGames || pickRate <= 0 || !Array.isArray(row?.ids)) continue;
      const ids = row.ids.map(String);
      if (key !== 'core_items' && ids.length !== 1) continue;
      for (const id of ids) if (catalog[id]) candidates.push({
        itemId: id, source, priority: pickRate * 10000 + play,
        evidence: { kind: key === 'core_items' ? 'published-core-member' : 'published-item-stage', source, patch: sourcePatch(data), stage: key, play, pickRate }
      });
    }
  }
  return candidates;
}
function publishedSlotEvidence(data, source = 'OP.GG') {
  const stageSlots={boots:2,fourth_items:4,fifth_items:5,sixth_items:6,last_items:6};
  return Object.entries(stageSlots).flatMap(([key,slot])=>rows(data?.[key]).filter(row=>Array.isArray(row?.ids)&&row.ids.length===1&&Number(row.play)>0&&Number(row.pick_rate)>0).map(row=>{const rawPickRate=Number(row.pick_rate)||0;return {itemId:String(row.ids[0]),slot,play:Number(row.play)||0,pickRate:rawPickRate>1?rawPickRate/100:rawPickRate,source,kind:'published-item-at-slot'};}));
}

function optimizeEvidenceBackedVariants({ options = [], published = null, itemCatalog = {}, itemAdvice = { items: [] }, itemPurposeCatalog = { items: {} }, candidateItems = [], boughtItemIds = [], explicitLockedItemIds = [], composition = {}, championId = '', role = '', champion = {}, mechanics = null, activationRules = { rules: [] }, patch = '', exclusiveGroups = null, language = 'es', validateBuild = () => ({ valid: false }), decorate = () => {}, planPurchasePathFn = planPurchasePath } = {}) {
  const needs = (composition.needs || []).filter(need => !need?.mitigatedByAllies).map(need => typeof need === 'string' ? need : need.id);
  const needTagMap = {
    'anti-heal': ['anti-heal', 'grievous-wounds'], 'anti-tank-damage': ['armorpenetration', 'armor-penetration', 'magicpenetration', 'magic-penetration', 'anti-health', 'damage-high-health', 'attack-speed', 'critical-strike'],
    'survive-burst': ['health', 'armor', 'spellblock', 'magic-resistance', 'shield'], 'anti-shield': ['anti-shield', 'shield-reduction'], 'cc-protection': ['tenacity', 'quicksilver', 'spell-shield']
  };
  const enemyTags = new Set((composition.enemies || []).flatMap(row => row.tags || []));
  const championTags = new Set((champion.tags || []).map(tag => String(tag).toLowerCase()));
  const adviceCandidates = (itemAdvice.items || []).flatMap(row => (row.ids || []).map(String).filter(id => itemCatalog[id]).map(id => {
    const tags = itemCatalog[id].tags || [];
    const answers = needs.filter(need => (needTagMap[need] || []).some(tag => tags.includes(tag)));
    const purpose = itemPurposeCatalog.items?.[id] || null;
    const conditions = new Set(purpose?.conditions || []), archetypes = new Set(purpose?.archetypes || []);
    const hasMagicDamage = championTags.has('mage') || (mechanics?.damageTypes || []).includes('magic-damage');
    const hasPhysicalDamage = championTags.has('marksman') || championTags.has('fighter') || championTags.has('assassin') || (mechanics?.damageTypes || []).includes('physical-damage');
    const hasCritBuild = archetypes.has('physical-crit') && (options.some(option => (option.finalSlots || []).some(itemId => (itemCatalog[itemId]?.tags || []).some(tag => /critical.?strike|crit-build/i.test(tag)))) || championTags.has('marksman') && /crit/i.test(options.map(option => option.style).join(' ')));
    const conditionReady = [...conditions].every(condition => {
      if (condition === 'confirmed-enemy-healing') return needs.includes('anti-heal');
      if (condition === 'enemy-basic-attack-threat') return ['physical', 'physical-heavy', 'physical-burst'].some(tag => enemyTags.has(tag));
      if (condition === 'physical-crit-build') return hasCritBuild;
      return true;
    });
    const archetypeReady = !archetypes.size || [...archetypes].some(archetype => archetype === 'magic-damage' && hasMagicDamage || archetype === 'physical-crit' && hasPhysicalDamage && hasCritBuild || ['tank', 'fighter'].includes(archetype) && (championTags.has('tank') || championTags.has('fighter')) || archetype === 'ad-assassin' && championTags.has('assassin'));
    if (!purpose || purpose.patch !== patch || !purpose.reviewStatus?.startsWith('editorially-reviewed') || !conditionReady || !archetypeReady || !answers.length) return null;
    return { itemId: id, source: purpose.source?.name || 'Rift Companion · propósito editorial revisado', priority: answers.length * 1_000_000, evidence: { kind: 'editorial-item-purpose-candidate', source: purpose.source?.name || 'Rift Companion · propósito editorial revisado', patch: purpose.patch, primaryFunction: purpose.primaryFunction, advice: row.advice?.[language] || row.advice?.es || '', candidateForNeeds: answers, conditions: purpose.conditions, archetypes: purpose.archetypes } };
  }).filter(Boolean));
  const sourceCandidates = [...candidateItems, ...adviceCandidates, ...publishedSubstitutionCandidates(published, itemCatalog, published?.source || 'OP.GG · muestra de compras')];
  for (const option of options) for (const row of option.items || []) {
    const itemId = String(row.id || row.itemId || '');
    if (itemId) sourceCandidates.push({ itemId, source: row.sourceEvidence?.source || option.source || option.id, priority: Number(row.sourceEvidence?.pickRate || 0) * 10000 + Number(row.sourceEvidence?.play || 0), evidence: row.sourceEvidence || { kind: option.sourceKind === 'observed_sequence' ? 'published-build-member' : 'reviewed-profile-member', source: option.source || option.id, profileId: option.id } });
  }
  const pool = new Map();
  for (const row of sourceCandidates) {
    const id = String(row.itemId || '');
    if (!id || !itemCatalog[id]) continue;
    const existing = pool.get(id);
    if (!existing || Number(row.priority || 0) > Number(existing.priority || 0)) pool.set(id, { ...row, itemId: id });
  }
  const diagnostics = [];
  const variants = [];
  for (const base of options.filter(option => (option.finalSlots || option.itemIds || []).length === 6 && option.buildType !== 'partial-core')) {
    const baseIds = (base.finalSlots || base.itemIds).map(String);
    const locked = new Set([...boughtItemIds, ...explicitLockedItemIds].map(String));
    for (const id of baseIds) if ((itemCatalog[id]?.tags || []).some(tag => /boots|boot|botas|support.?quest|ward.?item|mission/i.test(String(tag)))) locked.add(id);
    const validate = ids => {
      const legality = validateBuild(ids);
      if (!legality?.valid) return legality;
      const compatibility = evaluateBuildCompatibility({ itemIds: ids, itemCatalog, champion, mechanics, activationRules, mode: 'ranked', patch });
      return compatibility.rejectedItemIds.length
        ? { ...legality, valid: false, errors: [...(legality.errors || []), ...compatibility.rows.flatMap(row => row.issues.map(issue => issue.code))] }
        : legality;
    };
    const synergyFor = ids => evaluateChampionBuildSynergy({ itemIds: ids, itemCatalog, mechanics, language, confirmedThreats: composition.enemies || [], archetype: champion.archetypes, role, validation: validate(ids) });
    const baselineSynergy = synergyFor(baseIds);
    const baselineSet = evaluateCompleteBuildSet({ itemIds: baseIds, itemCatalog, itemSynergy: baselineSynergy, composition, boughtItemIds, language });
    const result = optimizeBuildSubstitutions({
      baseItemIds: baseIds, candidateItems: [...pool.values()], itemCatalog, lockedItemIds: [...locked], maxChanges: 2, minimumGain: 5, limit: 3, maxCandidates: 64, minDifferences: 1, validate,
      evaluate: ids => {
        const synergy = synergyFor(ids);
        const set = evaluateCompleteBuildSet({ itemIds: ids, itemCatalog, itemSynergy: synergy, composition, boughtItemIds, language });
        const gainedNeeds = set.coveredNeeds.filter(id => !baselineSet.coveredNeeds.includes(id));
        const evidenceGain = set.evidenceCoverage > baselineSet.evidenceCoverage ? Math.ceil((set.evidenceCoverage - baselineSet.evidenceCoverage) * 12) : 0;
        const justified = gainedNeeds.length > 0 || evidenceGain >= 5;
        return { eligible: set.status !== 'invalid-set', score: set.score + evidenceGain, justified, reasons: [...gainedNeeds.map(id => `confirmed-composition-need:${id}`), ...(evidenceGain ? ['increased-documented-mechanics-coverage'] : [])], strategy: set };
      }
    });
    diagnostics.push({ baseOptionId: base.id, baselineItemIds: baseIds, baselineCoreIds: base.observedCore?.itemIds || [], alternativesFound: result.alternatives.length, ...result.diagnostics });
    for (const [index, alternative] of result.alternatives.entries()) {
      const ids = alternative.itemIds;
      const changes = alternative.changedSlots.map(change => ({ ...change, fromName: itemCatalog[change.from]?.name || change.from, toName: itemCatalog[change.to]?.name || change.to }));
      const variant = {
        ...base,
        id: `${base.id}-strategic-${index + 1}`,
        label: language === 'en' ? `${base.label} · educational composition variant` : `${base.label} · variante educativa por composición`,
        itemIds: ids, finalSlots: ids,
        items: ids.map(id => ({ id, name: itemCatalog[id]?.name || id, cost: itemCatalog[id]?.gold || 0, sourceEvidence: pool.get(id)?.evidence || null })),
        score: (Number(base.score) || 0) + alternative.gain,
        buildType: 'generated', sourceKind: 'strategic-substitution', buildStatus: 'build-ready',
        substitution: { baseOptionId: base.id, changes, reasons: alternative.evaluation.reasons, tradeoff: alternative.evaluation.strategy?.opportunityCost?.note || '' },
        reasons: [...(base.reasons || []), ...changes.map(change => `${change.fromName} → ${change.toName}`), ...(alternative.evaluation.reasons || []), language === 'en' ? 'This is an educational alternative, not an OP.GG-observed combination.' : 'Es una alternativa educativa; no es una combinación observada por OP.GG.'],
        tradeoffs: [...(base.tradeoffs || []), alternative.evaluation.strategy?.opportunityCost?.note || (language === 'en' ? 'Each substitution gives up the displaced effect; compare before switching.' : 'Cada sustitución cede el efecto desplazado; compárala antes de cambiar.')],
        validation: alternative.validation
      };
      variant.purchaseOrder = planPurchasePathFn(ids, itemCatalog, { exclusiveGroups, sourceKind: 'strategic-proposal', language, orderIds: ids, championId, role, archetype: variant.style, composition });
      decorate(variant);
      variants.push(variant);
    }
  }
  const rejectionSummary = diagnostics.reduce((summary, row) => {
    summary.combinationsEvaluated += Number(row.combinationCandidatesEvaluated) || 0;
    summary.alternativesAccepted += Number(row.alternativesFound) || 0;
    summary.candidateCapReached ||= row.candidateLimitReached === true;
    summary.limits.push({ baseOptionId: row.baseOptionId, candidateLimitReached: row.candidateLimitReached === true, candidatesEvaluated: row.candidatesEvaluated || 0, candidateLimit: row.candidateLimit || 0 });
    for (const rejection of row.rejected || []) {
      const codes = [...(rejection.errors || []), rejection.reason || '', ...(rejection.reasons || [])].map(String);
      if (codes.some(code => /activation|requires-(?:ally|heal|shield|damage)|passive-not-triggered/i.test(code))) summary.rejectedByPassiveActivation++;
      else if (rejection.reason === 'technical-validation' || codes.some(code => /exclusive|wrong-mode|unavailable|invalid-item|patch|transform/i.test(code))) summary.rejectedByCompatibility++;
      else if (rejection.reason === 'missing-candidate-provenance') summary.rejectedForMissingEvidence++;
      else summary.rejectedByStrategy++;
    }
    return summary;
  }, { combinationsEvaluated: 0, alternativesAccepted: 0, rejectedByCompatibility: 0, rejectedByPassiveActivation: 0, rejectedForMissingEvidence: 0, rejectedByStrategy: 0, candidateCapReached: false, limits: [] });
  return { variants, diagnostics, candidateCount: pool.size, rejectionSummary };
}
function enemiesForCondition(condition, enemies = []) {
  const tags = ({ 'physical-heavy': ['physical', 'physical-burst'], 'magic-heavy': ['magic', 'magic-burst'], healing: ['healing', 'sustain'] })[condition] || [condition];
  return enemies.filter(enemy => enemy.known && tags.some(tag => enemy.tags.includes(tag)));
}

function createBuildAdvisor({ buildProfiles = {}, threatProfiles = {}, matchupAdvice = {}, itemAdvice = { items: [] }, itemPurposeCatalog = { items: {} }, archetypeSeed = {}, itemCatalog = {}, championDefinitions = {}, itemActivationRules = { rules: [] }, profileChampion = () => ({ known: false, tags: [] }), patch = '', exclusiveGroups = itemCatalog?.exclusiveGroups || null } = {}) {
  const champions = loadChampionProfiles(buildProfiles);
  const matchupItemsFor = (championId, enemies = [], language = 'es') => {
    const rowsOut = [];
    for (const enemy of enemies) {
      if (!enemy?.known || !enemy.championId) continue;
      for (const entry of matchupAdvice?.matchups?.[championId]?.[enemy.championId] || []) {
        const itemId = String(entry.itemId || '');
        if (!itemCatalog[itemId]) continue;
        rowsOut.push({ itemId, enemyChampionId: enemy.championId, enemyName: entry.enemyName?.[language] || entry.enemyName?.es || enemy.championId, reason: entry.reason?.[language] || entry.reason?.es || '', source: entry.source || matchupAdvice.source || 'Rift Companion · consejo editorial' });
      }
    }
    const seen = new Set();
    return rowsOut.filter(row => !seen.has(row.itemId) && seen.add(row.itemId));
  };
  const explainItem = (itemId, profile, championId, language = 'es', reasons = [], tradeoffs = [], threatChampions = [], mechanics = null, selectedIds = []) => {
    const item = itemCatalog[String(itemId)] || {}, tags = new Set(item.tags || []), advice = (itemAdvice.items || []).find(row => (row.ids || []).map(String).includes(String(itemId)))?.advice?.[language];
    const what = (tags.has('anti-heal') ? language === 'en' ? 'Reduces the impact of enemy healing when applied consistently.' : 'Reduce el efecto de las curaciones rivales si puedes aplicarlo de forma constante.'
      : tags.has('armorpenetration') || tags.has('armor-penetration') ? language === 'en' ? 'Helps physical damage get through armor.' : 'Ayuda a que el daño físico atraviese armadura.'
        : tags.has('magicpenetration') || tags.has('magic-penetration') ? language === 'en' ? 'Helps magic damage get through magic resistance.' : 'Ayuda a que el daño mágico atraviese resistencia mágica.'
          : tags.has('team-heal') || tags.has('ally-buff') ? language === 'en' ? 'Adds team healing, shielding, or an ally buff.' : 'Aporta curación, escudo o una mejora para tus aliados.'
            : tags.has('mana') || tags.has('manaregen') || tags.has('mana-regen') ? language === 'en' ? 'Supports repeated casts or mana sustain.' : 'Sostiene lanzamientos repetidos o el maná.'
              : tags.has('armor') ? language === 'en' ? 'Adds physical durability against attacks and physical damage.' : 'Aporta aguante físico contra ataques y daño físico.'
                : tags.has('spellblock') || tags.has('magic-resistance') ? language === 'en' ? 'Adds protection against magic damage.' : 'Aporta protección contra daño mágico.'
                  : tags.has('health') ? language === 'en' ? 'Adds a health buffer for trades and team fights.' : 'Aporta vida para intercambios y peleas de equipo.'
                    : tags.has('spelldamage') || tags.has('ap') ? language === 'en' ? 'Increases ability damage for an ability-power build.' : 'Aumenta el daño de habilidades en una build de poder de habilidad.'
                      : tags.has('damage') || tags.has('ad') ? language === 'en' ? 'Adds physical damage to attacks and physical scaling.' : 'Aporta daño físico a ataques y escalados físicos.'
                        : language === 'en' ? 'Provides the listed item effect.' : 'Aporta el efecto propio del objeto.');
    const championName = championDefinitions[championId]?.name || championId;
    const damageStyle = String(profile.style || '').replace(/[_-]+/g, ' ');
    const genericFit = tags.has('anti-heal')
      ? language === 'en' ? `Lets ${championName} reduce healing while continuing their ${damageStyle} build.` : `Permite a ${championName} reducir curaciones sin salir de su build ${damageStyle}.`
      : tags.has('armorpenetration') || tags.has('armor-penetration')
        ? language === 'en' ? `Supports ${championName}'s physical damage against armor-stacking targets.` : `Ayuda al daño físico de ${championName} contra rivales que acumulan armadura.`
        : tags.has('magicpenetration') || tags.has('magic-penetration')
          ? language === 'en' ? `Helps ${championName}'s ability burst against targets with magic resistance.` : `Ayuda al burst de habilidades de ${championName} contra objetivos con resistencia mágica.`
          : tags.has('team-heal') || tags.has('ally-buff')
            ? language === 'en' ? `Turns ${championName}'s repeated ally healing or shielding into more team value.` : `Convierte las curaciones o escudos frecuentes de ${championName} en más apoyo al equipo.`
            : tags.has('armor')
              ? language === 'en' ? `Gives ${championName} time to use their kit against physical engage.` : `Da a ${championName} tiempo para usar su kit frente a una entrada física.`
              : tags.has('spellblock') || tags.has('magic-resistance')
                ? language === 'en' ? `Helps ${championName} survive magic damage without changing their core pattern.` : `Ayuda a ${championName} a sobrevivir daño mágico sin cambiar su patrón principal.`
                : tags.has('mana') || tags.has('manaregen') || tags.has('mana-regen')
                  ? language === 'en' ? `Supports ${championName}'s repeated casts in the ${damageStyle} build.` : `Sostiene los lanzamientos de ${championName} en su build ${damageStyle}.`
                  : tags.has('health')
                    ? language === 'en' ? `Adds a survival buffer while ${championName} keeps contributing in fights.` : `Aporta margen de supervivencia para que ${championName} siga aportando en peleas.`
                    : language === 'en' ? `Complements ${championName}'s ${damageStyle} pattern; buy it when its effect answers the match.` : `Complementa el patrón ${damageStyle} de ${championName}; cómpralo si su efecto responde a la partida.`;
    const threatLabel = threatChampions.join(', '), conditions = profile.when || [];
    const answersHealing = tags.has('anti-heal') && conditions.includes('healing');
    const answersPhysicalBurst = (tags.has('armor') || tags.has('health')) && (conditions.includes('physical-burst') || conditions.includes('physical-heavy'));
    const answersMagicBurst = (tags.has('spellblock') || tags.has('magic-resistance') || tags.has('health')) && (conditions.includes('magic-burst') || conditions.includes('magic-heavy'));
    const answersDurableFrontline = (tags.has('armorpenetration') || tags.has('armor-penetration') || tags.has('magicpenetration') || tags.has('magic-penetration')) && conditions.includes('durable-frontline');
    const matchupFit = threatLabel && (answersHealing || answersPhysicalBurst || answersMagicBurst || answersDurableFrontline)
      ? language === 'en' ? `Against ${threatLabel}: ${advice || genericFit}` : `Contra ${threatLabel}: ${advice || genericFit}` : '';
    const fit = profile.itemReasons?.[String(itemId)]?.[language] || profile.itemReasons?.[String(itemId)] || matchupFit || advice || genericFit;
    const genericSacrifice = tags.has('anti-heal') || tags.has('armorpenetration') || tags.has('armor-penetration') || tags.has('magicpenetration') || tags.has('magic-penetration')
      ? language === 'en' ? 'This utility delays a higher-damage or higher-penetration option.' : 'Esta utilidad retrasa una opción de más daño o penetración.'
      : tags.has('armor') || tags.has('spellblock') || tags.has('magic-resistance') || tags.has('health')
        ? language === 'en' ? 'The defensive slot gives up some damage or tempo.' : 'El espacio defensivo sacrifica algo de daño o ritmo.'
        : tags.has('team-heal') || tags.has('ally-buff')
          ? language === 'en' ? 'Team utility replaces a personal damage spike.' : 'La utilidad para el equipo reemplaza un pico de daño propio.'
          : language === 'en' ? 'This slot delays another damage or utility effect.' : 'Este espacio retrasa otra opción de daño o utilidad.';
    const sacrifice = profile.itemTradeoffs?.[String(itemId)]?.[language] || profile.itemTradeoffs?.[String(itemId)] || genericSacrifice;
    const synergy = evaluateChampionItemSynergy({ item, selectedItems: selectedIds.filter(id => String(id) !== String(itemId)).map(id => itemCatalog[String(id)] || { id: String(id) }), mechanics, language });
    const mechanicFit = synergy.mechanicsEvidence?.length ? synergy.fit : fit;
    const fitText=shortReason(mechanicFit);
    return { whyFits: { title: language === 'en' ? 'Why it fits' : 'Por qué encaja', text: fitText }, fit: fitText, evidenceStatus: synergy.status, evidenceSummary: synergy.evidenceSummary, mechanicsEvidence: synergy.mechanicsEvidence || [], communityCandidates: synergy.communityCandidates || [], selectedBuildSynergy: synergy.selectedBuildSynergy || null };
  };

  return function recommend(input = {}, language = 'es') {
    const championId = String(input.player?.championId || ''), role = String(input.player?.role || ''), champion = champions[championId];
    const reviewedChampion = archetypeCandidates.champions[championId];
    if (reviewedChampion?.roles.includes(canonicalRole(role)) && patch === archetypeCandidates.patch && exclusiveGroups?.status === 'verified') {
      return recommendArchetypes({ input, language, championId, role, itemCatalog, itemPurposeCatalog, championDefinitions, exclusiveGroups, patch, profileChampion, itemActivationRules });
    }
    const profileRows = (champion?.roles?.[role] || []).filter(profile => profile.mode !== 'aram' && profile.mode !== 'arena' && profile.mode !== 'mayhem' && !/\b(?:ARAM|Mayhem|Arena)\b/i.test(String(profile.source || '')));
    const composition = analyzeComposition({ roster: input, profileChampion, championProfiles: champions });
    const threats = composition.enemies;
    const compositionSummary = { tags: composition.tags, enemyCounts: composition.enemyCounts, needs: composition.needs || [], compositionAdvice: composition.compositionAdvice || null, recommendation: language === 'en' ? (composition.compositionAdvice?.action === 'review-situational-options' ? 'Confirmed composition needs are worth reviewing in situational slots; the standard core is not changed automatically.' : 'No confirmed combined threat justifies changing the standard core.') : composition.compositionAdvice?.summary || '', allyCoverage: composition.allyCoverage, knownEnemies: composition.knownEnemies, knownAllies: composition.knownAllies, enemyProfilesKnown: composition.enemyProfilesKnown, allyProfilesKnown: composition.allyProfilesKnown, incomplete: composition.incomplete, dataLimits: composition.dataLimits };
    const validationUnavailable = exclusiveGroups?.status !== 'verified' || exclusiveGroups?.patch !== patch;
    const provenance = { method: 'ranked-staged-evidence-and-editorial-candidate', patch, sourceKind: 'no_data', winRatesShown: false };
    const published = input.publishedData?.data?.summary ? input.publishedData.data : input.publishedData?.summary ? input.publishedData : input.publishedData?.data?.data?.summary ? input.publishedData.data.data : null;
    const publishedVersion = sourcePatch(published), publishedPatchCompatible = !!publishedVersion && patchLine(publishedVersion) === patchLine(patch);
    const publishedRows = rows(published?.core_items).filter(row => Array.isArray(row?.ids) && row.ids.length).sort((a, b) => (Number(b.pick_rate) || 0) - (Number(a.pick_rate) || 0) || (Number(b.play) || 0) - (Number(a.play) || 0));
    const rejectedCandidates = [], fullOptions = [];
    const decorateMechanics = option => {
      option.editorialKnowledge = knowledgeFor(championId, role);
      const ids = (option.finalSlots || option.itemIds || []).map(String);
      const profile = { id: option.id, style: option.style || '', when: option.when || [], tradeoffs: option.tradeoffs || [], itemReasons: option.itemReasons || {}, itemTradeoffs: option.itemTradeoffs || {} };
      const generatedExplanations = Object.fromEntries(ids.map(id => [id, explainItem(id, profile, championId, language, option.reasons || [], option.tradeoffs || [], option.threatChampions || [], input.championMechanics, ids)]));
      const orderedWhy = new Map((option.purchaseOrder || []).map(step => [String(step.finalItemId || step.itemId), step.whyFits]).filter(([id, why]) => id && why?.text));
      option.itemExplanations = Object.fromEntries(ids.map(id => {
        const generated = generatedExplanations[id], previous = option.itemExplanations?.[id];
        const explanation = previous ? {
          ...previous,
          fit: generated.mechanicsEvidence?.length ? generated.fit : previous.fit || generated.fit,
          evidenceStatus: generated.evidenceStatus,
          evidenceSummary: generated.evidenceSummary,
          mechanicsEvidence: generated.mechanicsEvidence,
          communityCandidates: generated.communityCandidates,
          selectedBuildSynergy: generated.selectedBuildSynergy
        } : generated;
        const plannerWhy = orderedWhy.get(id);
        // Keep the slot explanation intact; add only a concise, named ability link when verified.
        const abilityEvidence = generated.mechanicsEvidence.find(row => row.abilityName);
        const mechanicNote = abilityEvidence ? (language === 'en'
          ? `Uses the published ${abilityEvidence.stat || 'mechanic'} on ${abilityEvidence.abilityName}.`
          : `Aprovecha el ${abilityEvidence.stat || 'efecto'} publicado de ${abilityEvidence.abilityName}.`) : '';
        const whyFits = plannerWhy ? { ...plannerWhy, text: shortReason([mechanicNote, plannerWhy.text].filter(Boolean).join(' '), 520) } : explanation.whyFits || { title: language === 'en' ? 'Why it fits' : 'Por qué encaja', text: explanation.fit };
        const compact = { ...explanation, whyFits, fit: whyFits.text };
        delete compact.what;
        delete compact.sacrifice;
        return [id, compact];
      }));
      for(const step of option.purchaseOrder||[]){const fit=option.itemExplanations[String(step.finalItemId||step.itemId)]?.whyFits;if(fit){step.whyFits=fit;if(!step.transform)step.guidance=fit.text;}}
      option.items = (option.items || ids.map(id => ({ id, name: itemCatalog[id]?.name || id }))).map(row => ({ ...row, education: option.itemExplanations[String(row.id)] || generatedExplanations[String(row.id)] || row.education || null }));
      option.mechanicsEvaluation = evaluateChampionBuildSynergy({ itemIds: ids, itemCatalog, mechanics: input.championMechanics || null, language, buildId: option.id, role, validation: option.validation, purchaseOrder: option.purchaseOrder || [] });
      option.mechanicalCompatibility = evaluateBuildCompatibility({ itemIds: ids, itemCatalog, champion: championDefinitions[championId] || {}, mechanics: input.championMechanics || null, activationRules: itemActivationRules, mode: 'ranked', patch });
      return option;
    };
    const evaluateContinuation = (itemIds, validation) => {
      const compatibility = evaluateBuildCompatibility({ itemIds, itemCatalog, champion: championDefinitions[championId] || {}, mechanics: input.championMechanics || null, activationRules: itemActivationRules, mode: 'ranked', patch });
      if (compatibility.rejectedItemIds.length) return { eligible: false, compatibility, score: -1000, reasons: compatibility.rows.flatMap(row => row.issues.map(issue => issue.code)) };
      const synergy = evaluateChampionBuildSynergy({ itemIds, itemCatalog, mechanics: input.championMechanics || null, language, role, validation, purchaseOrder: [] });
      const evidenceScore = synergy.rows.reduce((sum, row) => sum + (row.evidenceLevel === 'documented' ? 2 : row.evidenceLevel === 'editorial-reviewed' ? 1 : 0), 0);
      const actionableNeeds = (composition.needs || []).filter(need => !need.mitigatedByAllies).map(need => typeof need === 'string' ? need : need.id);
      const contextTags = new Set(itemIds.flatMap(id => itemCatalog[id]?.tags || []));
      const contextMatches = actionableNeeds.filter(need => need === 'anti-heal' && contextTags.has('anti-heal') || need === 'anti-tank-damage' && ['armorpenetration','armor-penetration','magicpenetration','magic-penetration','attack-speed','critical-strike'].some(tag => contextTags.has(tag)) || need === 'survive-burst' && ['health','armor','spellblock','magic-resistance','shield'].some(tag => contextTags.has(tag)) || need === 'anti-shield' && ['shield-reduction','anti-shield'].some(tag => contextTags.has(tag)));
      const knowledge = knowledgeFor(championId, role);
      const editorialAffinity = itemIds.map(id => editorialStatFit(itemCatalog[id], knowledge));
      const contextScore = contextMatches.length * 5 + editorialAffinity.reduce((sum, row) => sum + row.score, 0);
      return { eligible: true, compatibility, synergyStatus: synergy.status, score: evidenceScore + contextScore, reasons: [...(evidenceScore ? ['champion-item-evidence'] : ['published-slot-evidence-only']), ...contextMatches.map(id => `confirmed-composition-need:${id}`)], contextMatches };
    };
    const filterMechanicalItems = (rows = []) => rows.filter(row => {
      const itemId = String(row.itemId || '');
      const compatibility = evaluateBuildCompatibility({ itemIds: [itemId], itemCatalog, champion: championDefinitions[championId] || {}, mechanics: input.championMechanics || null, activationRules: itemActivationRules, mode: 'ranked', patch });
      if (!compatibility.rejectedItemIds.length) return true;
      rejectedCandidates.push({ id: `matchup-item-${itemId}`, codes: compatibility.rows.flatMap(item => item.issues.map(issue => issue.code)), itemIds: [itemId] });
      return false;
    });
    let observedCore = null;
    const validCoreCandidates = [];
    const queryContext = input.publishedData?.queryContext || {};
    const sourceChampion = published?.champion || queryContext.championId || '';
    const sourcePosition = published?.position || queryContext.position || '';
    const championContextMatches = !sourceChampion || String(sourceChampion).replace(/[^a-z0-9]/gi, '').toLowerCase() === championId.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const roleContextMatches = !sourcePosition || canonicalRole(sourcePosition) === canonicalRole(role);
    const sourceContextCompatible = championContextMatches && roleContextMatches;
    if (publishedRows.length) {
      const starter = new Set((exclusiveGroups?.groups?.Starter || []).map(String));
      let bestRejectedCore = null;
      publishedRows.forEach((raw, index) => {
        const rawIds = raw.ids.map(String);
        const removeRecipeComponents = new Set();
        const collectRecipe = (id, seen = new Set()) => {
          if (seen.has(id)) return;
          seen.add(id);
          const transformationBase = exclusiveGroups?.transformations?.[id]?.fromItemId;
          const directComponents = itemCatalog[id]?.from;
          const recipeComponents = Array.isArray(directComponents) && directComponents.length ? directComponents : transformationBase ? [transformationBase] : [];
          for (const component of recipeComponents) { removeRecipeComponents.add(String(component)); collectRecipe(String(component), seen); }
        };
        rawIds.forEach(id => collectRecipe(id));
        // Keep unknown IDs in validation input so bad source records cannot become valid by truncation.
        const coreIds = [...new Set(rawIds.filter(id => !removeRecipeComponents.has(id) && !starter.has(id)))];
        const coreValidation = !publishedPatchCompatible ? { valid: false, errors: ['statistics-patch-mismatch'], conflictingItemIds: coreIds }
          : !championContextMatches ? { valid: false, errors: ['source-champion-mismatch'], conflictingItemIds: coreIds }
            : !roleContextMatches ? { valid: false, errors: ['source-role-mismatch'], conflictingItemIds: coreIds }
              : validateCoreItems(coreIds, itemCatalog, { patch, exclusiveGroups, championId, role });
        const candidateCore = { itemIds: coreIds, rawItemIds: rawIds, source: input.publishedData?.source || 'OP.GG MCP', patch: publishedVersion, games: Number(raw.play) || 0, pickRate: Number(raw.pick_rate) || 0, state: coreValidation.valid ? coreIds.length === 6 ? 'observed-combination' : 'partial-core' : 'incompatible-data', validation: coreValidation, sourceAge: input.publishedData?.cachedAt || input.publishedData?.meta?.cachedAt || '', sourceIndex: index };
        if (!coreValidation.valid) {
          rejectedCandidates.push({ id: `published-core-${index + 1}`, codes: coreValidation.errors, itemIds: coreValidation.conflictingItemIds });
          bestRejectedCore ||= candidateCore;
          return;
        }
        observedCore ||= candidateCore;
        if (coreIds.length > 0 && coreIds.length < 6) validCoreCandidates.push(candidateCore);
        if (coreIds.length === 6) {
          const finalValidation = validateBuildItems(coreIds, itemCatalog, { patch, exclusiveGroups, championId, role });
          if (finalValidation.valid) fullOptions.push({ id: `observed-opgg-${index + 1}`, label: language === 'en' ? 'Observed published combination' : 'Combinación publicada observada', style: 'observed', itemIds: coreIds, items: coreIds.map(id => ({ id, name: itemCatalog[id]?.name || id, cost: itemCatalog[id]?.gold || 0 })), finalSlots: coreIds, purchaseOrder: planPurchasePath(coreIds, itemCatalog, { exclusiveGroups, sourceKind: 'observed', language, orderIds: rawIds.filter(id => coreIds.includes(id)), championId, role, composition }), reasons: [language === 'en' ? `OP.GG published this six-item set for ${role}; it is not a guaranteed optimal choice.` : `OP.GG publicó este conjunto de seis objetos para ${role}; no garantiza que sea la opción óptima.`], tradeoffs: [], score: 100 - index, buildType: 'observed', sourceKind: 'observed_sequence', buildStatus: 'build-ready', source: candidateCore.source, patch: publishedVersion, validation: finalValidation, observedCore: candidateCore });
          else rejectedCandidates.push({ id: `observed-opgg-${index + 1}`, codes: finalValidation.errors, itemIds: finalValidation.conflictingItemIds });
        }
      });
      observedCore ||= bestRejectedCore;
    }

    if (!champion || !profileRows.length) {
      const seedRow = (archetypeSeed?.champions?.[championId]?.candidateProfiles || []).find(row => canonicalRole(row.role) === canonicalRole(role)) || null;
      const core = observedCore?.validation?.valid && observedCore.itemIds.length > 0 && observedCore.itemIds.length < 6 ? observedCore : null;
      const publishedSlotAlternatives = [];
      const coreCompletionDiagnostics = [];
      let coreCompletionPlans = [];
      let sourceCompletion = null;
      // A generic editorial seed is not required when the source itself gives this exact champion,
      // role and current patch: a validated core plus enough slot-stage evidence is sufficient.
      // The seed may enrich the label/archetype, but can never be the only evidence for six slots.
      if (core && championDefinitions[championId] && publishedPatchCompatible && sourceContextCompatible) {
        if (core.itemIds.length === 3) {
          const joint = rankPublishedCoreCompletions({
            coreIds: core.itemIds,
            published,
            itemCatalog,
            validate: itemIds => validateBuildItems(itemIds, itemCatalog, { patch, exclusiveGroups, championId, role }),
            evaluateCombination: evaluateContinuation,
            maxCandidatesPerSlot: 8,
            limit: 3
          });
          coreCompletionDiagnostics.push({ coreItemIds: core.itemIds, ...joint.diagnostics });
          publishedSlotAlternatives.push(...joint.slots.map(stage => ({ ...stage, items: stage.items.map(item => ({ id: item.itemId, name: item.name, play: item.play, pickRate: item.pickRate, stage: item.stage, position: item.position })) })));
          coreCompletionPlans = joint.combinations.map((plan, index) => {
            const ids = plan.itemIds;
            const profile = { style: seedRow?.primaryArchetype || 'published-source', when: [], tradeoffs: [] };
            const itemExplanations = Object.fromEntries(ids.map(id => [id, explainItem(id, profile, championId, language, [], [], [], input.championMechanics, ids)]));
            const slotEvidence = plan.slots.map(slot => ({ itemId: slot.itemId, stage: slot.stage, play: slot.play, pickRate: slot.pickRate }));
            const option = {
              id: `generated-source-${championId}-${role}-${index + 1}`,
              label: language === 'en' ? `${championId} · educational completion ${index + 1}` : `${championDefinitions[championId]?.name || championId} · complemento educativo ${index + 1}`,
              style: profile.style, itemIds: ids, items: ids.map(id => ({ id, name: itemCatalog[id]?.name || id, cost: itemCatalog[id]?.gold || 0, education: itemExplanations[id], sourceEvidence: slotEvidence.find(row => row.itemId === id) || null })), itemExplanations, finalSlots: ids,
              purchaseOrder: planPurchasePath(ids, itemCatalog, { exclusiveGroups, sourceKind: 'published-core-completion', language, orderIds: [...(core.rawItemIds || core.itemIds), ...plan.slots.map(row => row.itemId)], championId, role, archetype: profile.style, composition }),
              reasons: [language === 'en' ? `Preserves the three-item published core. Slots 4–6 use separate current-patch champion/role stage samples, then are validated together.` : `Conserva el núcleo publicado de tres objetos. Los espacios 4–6 usan muestras separadas de compra para este campeón/rol y luego se validan como conjunto.`],
              tradeoffs: [language === 'en' ? 'OP.GG published the core and item-stage distributions separately, not this six-item combination; no result rate is attributed to it.' : 'OP.GG publicó por separado el núcleo y las distribuciones por etapa, no esta combinación de seis; no se le atribuyen estadísticas de resultado.'],
              score: plan.score, buildType: 'generated', sourceKind: 'published_core_plus_slot_candidates', buildStatus: 'build-ready', source: input.publishedData?.source || 'OP.GG · published core and purchase stages', patch: publishedVersion, observedCore: core, validation: plan.validation, confidence: 'limited', slotEvidence
            };
            decorateMechanics(option);
            return { ...plan, option };
          });
          if (!sourceCompletion && coreCompletionPlans.length) sourceCompletion = { itemIds: coreCompletionPlans[0].itemIds, validation: coreCompletionPlans[0].validation, extensions: coreCompletionPlans[0].slots.map(row => ({ id: row.itemId, row: { play: row.play, pick_rate: row.pickRate, stage: row.stage }, stage: row.stage })), joint: true };
        }
        const excludedCore = new Set(core.itemIds);
        const bootCandidates = sourceSlotRows(published, 'boots', itemCatalog, excludedCore).filter(({ id }) => itemCatalog[id]?.tags?.some(tag => /boots|boot|botas/i.test(String(tag))));
        const selectedBoot = bootCandidates[0] || null;
        if (selectedBoot && !coreCompletionPlans.length) {
          const fixedIds = [...core.itemIds, selectedBoot.id];
          const fixedSet = new Set(fixedIds);
          const stages = ['fourth_items', 'fifth_items', 'sixth_items'];
          const chosenExtensions = [];
          for (const stage of stages) {
            const candidates = sourceSlotRows(published, stage, itemCatalog, fixedSet);
            const options = candidates.slice(0, 3).map(({ id, row }) => ({ id, name: itemCatalog[id]?.name || id, play: Number(row.play) || 0, pickRate: Number(row.pick_rate) || 0, stage }));
            if (options.length) publishedSlotAlternatives.push({ stage, label: ({ fourth_items: '4.º objeto', fifth_items: '5.º objeto', sixth_items: '6.º objeto' })[stage], items: options });
            const selected = candidates.find(candidate => !fixedSet.has(candidate.id) && !chosenExtensions.some(entry => entry.id === candidate.id));
            if (selected) { chosenExtensions.push({ id: selected.id, row: selected.row, stage }); fixedSet.add(selected.id); }
            if (fixedIds.length + chosenExtensions.length >= 6) break;
          }
          const itemIds = [...fixedIds, ...chosenExtensions.map(entry => entry.id)];
          const validation = itemIds.length === 6 ? validateBuildItems(itemIds, itemCatalog, { patch, exclusiveGroups, championId, role }) : null;
          if (validation?.valid) sourceCompletion = { itemIds, validation, boot: selectedBoot, extensions: chosenExtensions };
          else if (itemIds.length === 6) rejectedCandidates.push({ id: 'published-slot-continuation', codes: validation.errors, itemIds: validation.conflictingItemIds });
        }
      }
      if (sourceCompletion && !coreCompletionPlans.length) {
        const style = seedRow?.primaryArchetype || 'published-source';
        const profile = { style, when: [], tradeoffs: [] };
        const ids = sourceCompletion.itemIds;
        const itemExplanations = Object.fromEntries(ids.map(id => [id, explainItem(id, profile, championId, language, [], [], [], input.championMechanics, ids)]));
        const itemEvidence = new Map([[sourceCompletion.boot.id, sourceCompletion.boot.row], ...sourceCompletion.extensions.map(entry => [entry.id, entry.row])]);
        fullOptions.push({
          id: `generated-source-${championId}-${role}`, label: language === 'en' ? `${championId} · source-guided proposal` : `${championDefinitions[championId]?.name || championId} · propuesta guiada por fuente`,
          style, itemIds: ids, items: ids.map(id => ({ id, name: itemCatalog[id]?.name || id, cost: itemCatalog[id]?.gold || 0, education: itemExplanations[id], sourceEvidence: itemEvidence.has(id) ? { stage: itemEvidence.get(id).stage || 'boots', play: Number(itemEvidence.get(id).play) || 0, pickRate: Number(itemEvidence.get(id).pick_rate) || 0 } : null })), itemExplanations, finalSlots: ids,
          purchaseOrder: planPurchasePath(ids, itemCatalog, { exclusiveGroups, sourceKind: 'published-slot-completion', language, orderIds: ids, championId, role, archetype: style, composition }),
          reasons: [language === 'en' ? `Keeps the ${core.itemIds.length}-item published core. The boot and later slots come from this champion-role’s published purchase-stage distributions.` : `Conserva el núcleo publicado de ${core.itemIds.length} objetos. Las botas y los espacios posteriores proceden de distribuciones publicadas de compras para este campeón y rol.`, language === 'en' ? 'These items were published in separate stage samples; OP.GG did not publish this exact six-item combination.' : 'Los objetos se publicaron en muestras separadas por etapa; OP.GG no publicó esta combinación exacta de seis objetos.'],
          tradeoffs: [language === 'en' ? 'No win rate is attributed to this assembled set; later-slot samples may be smaller than the core sample.' : 'No se atribuye win rate al conjunto ensamblado; las muestras de espacios tardíos pueden ser menores que la del núcleo.'],
          score: 60, buildType: 'generated', sourceKind: 'published_core_plus_slot_candidates', buildStatus: 'build-ready', source: input.publishedData?.source || 'OP.GG MCP · published item stages', patch: publishedVersion, observedCore: core, validation: sourceCompletion.validation, confidence: 'limited', slotEvidence: sourceCompletion.extensions.map(entry => ({ itemId: entry.id, stage: entry.stage, play: Number(entry.row.play) || 0, pickRate: Number(entry.row.pick_rate) || 0 }))
        });
      }
      if (coreCompletionPlans.length) fullOptions.push(...coreCompletionPlans.map(plan => plan.option));
      for (const [index, partialCore] of validCoreCandidates.entries()) fullOptions.push({
        id: index === 0 ? 'published-core-partial' : `published-core-partial-${index + 1}`, label: language === 'en' ? `Published ${partialCore.itemIds.length}-item core · partial${index ? ` ${index + 1}` : ''}` : `Núcleo publicado de ${partialCore.itemIds.length} objetos · parcial${index ? ` ${index + 1}` : ''}`,
        style: 'published-core', itemIds: partialCore.itemIds, items: partialCore.itemIds.map(id => ({ id, name: itemCatalog[id]?.name || id, cost: itemCatalog[id]?.gold || 0 })), finalSlots: partialCore.itemIds,
        purchaseOrder: planPurchasePath(partialCore.itemIds, itemCatalog, { exclusiveGroups, sourceKind: 'observed-core', language, orderIds: partialCore.rawItemIds?.filter(id => partialCore.itemIds.includes(String(id))), championId, role, composition }),
        reasons: [language === 'en' ? 'This is a source-published core only. The app does not invent the remaining slots without a compatible reviewed profile.' : 'Este es un núcleo publicado separado; solo se completa cuando existe evidencia compatible suficiente.'],
        tradeoffs: [language === 'en' ? 'The six-item combination has no measured win rate and remains incomplete.' : 'La combinación está incompleta y no tiene win rate medido.'],
        score: index ? -index : 0, buildType: 'partial-core', sourceKind: 'published_core_only', buildStatus: 'partial-core', source: partialCore.source, patch: publishedVersion, validation: partialCore.validation, observedCore: partialCore, publishedSlotAlternatives: index === 0 ? publishedSlotAlternatives : []
      });
      fullOptions.forEach(decorateMechanics);
      for (let index = fullOptions.length - 1; index >= 0; index--) {
        const option = fullOptions[index];
        if (option.mechanicalCompatibility?.rejectedItemIds?.length) {
          rejectedCandidates.push({ id: option.id, codes: option.mechanicalCompatibility.rows.flatMap(row => row.issues.map(issue => issue.code)), itemIds: option.mechanicalCompatibility.rejectedItemIds });
          fullOptions.splice(index, 1);
        }
      }
      const optimizerResult = optimizeEvidenceBackedVariants({
        options: fullOptions, published, itemCatalog, itemAdvice, itemPurposeCatalog, candidateItems: matchupItemsFor(championId, threats, language),
        boughtItemIds: input.boughtItemIds || [], explicitLockedItemIds: input.lockedItemIds || [], composition,
        championId, role, champion: championDefinitions[championId] || {}, mechanics: input.championMechanics || null,
        activationRules: itemActivationRules, patch, exclusiveGroups, language,
        validateBuild: ids => validateBuildItems(ids, itemCatalog, { patch, exclusiveGroups, championId, role }),
        decorate: decorateMechanics
      });
      fullOptions.push(...optimizerResult.variants);
      const optionRank = type => ({ observed: 0, generated: 1, editorial: 2, 'partial-core': 3 }[type] ?? 4);
      fullOptions.sort((a, b) => optionRank(a.buildType) - optionRank(b.buildType) || (Number(b.score) || 0) - (Number(a.score) || 0) || a.id.localeCompare(b.id));
      const buildComparison = compareChampionBuilds({ builds: fullOptions, itemCatalog, mechanics: input.championMechanics || null, language, condition: compositionSummary.recommendation, confirmedThreats: threats });
      const stagePlans = planRankedStages({ options: fullOptions, enemies: threats, laneOpponentChampionId: input.laneOpponentChampionId || input.enemyChampionId || '', composition, language, boughtItemIds: input.boughtItemIds || [] });
      const status = validationUnavailable || (observedCore && !observedCore.validation?.valid) ? 'incompatible-data' : fullOptions.some(option => option.buildType === 'observed' || option.buildType === 'generated') ? 'build-ready' : core ? 'partial-core' : input.sourceError ? 'source-error' : 'no-profile';
      const notice = validationUnavailable
        ? (language === 'en' ? 'The current item-group matrix is not verified; no build can be offered.' : 'La matriz de exclusividad del parche no está verificada; no se ofrece una build.')
        : observedCore && !observedCore.validation?.valid ? (language === 'en' ? `Published data from patch ${publishedVersion || 'unknown'} is incompatible with the current item catalog ${patch}; no route was generated.` : `Los datos publicados del parche ${publishedVersion || 'desconocido'} no son compatibles con el catálogo actual ${patch}; no se generó una ruta.`)
        : fullOptions.some(option => option.buildType === 'observed') ? (language === 'en' ? 'A complete six-item combination was published for this champion and role.' : 'La fuente publicó una combinación completa de seis objetos para este campeón y rol.')
          : fullOptions.some(option => option.buildType === 'generated') ? (language === 'en' ? 'A six-item educational proposal was assembled from a published core and separate item-slot evidence; the combination has no measured result.' : 'Se armó una propuesta educativa de seis objetos con un núcleo publicado y datos de objetos por etapa; la combinación no tiene resultado medido.')
            : core ? (language === 'en' ? 'Only the current-patch published core is complete enough to recommend; published later-slot alternatives are shown separately.' : 'Solo el núcleo publicado del parche tiene evidencia suficiente; las alternativas de espacios posteriores se muestran por separado.')
          : seedRow ? (language === 'en' ? `Editorial seed: ${seedRow.primaryArchetype}. It describes a candidate role, not a verified build; use published data when available.` : `Seed editorial: ${seedRow.primaryArchetype}. Describe el arquetipo candidato, no una build verificada; usa datos publicados cuando estén disponibles.`)
            : (language === 'en' ? `No reviewed ${String(role || 'selected role').toUpperCase()} profile exists for this champion yet.` : `Aún no existe un perfil piloto de ${String(role || 'el rol seleccionado').toUpperCase()} para este campeón.`);
      const sourceState = publishedRows.length ? observedCore?.validation?.valid ? 'published-core-available' : 'published-data-rejected' : published ? 'queried-no-builds' : input.sourceError ? 'source-error' : input.publishedData ? 'queried-no-builds' : 'not-queried';
      const diagnostics = { championId, role, catalogPatch: patch, statisticsPatch: publishedVersion || '', source: input.publishedData?.source || (input.sourceError ? 'source-error' : 'local-profile'), sourceState, sourceQueried: !!input.publishedData || input.sourceError === true, statisticsRows: publishedRows.length, publishedCoreState: observedCore?.state || 'no-source', profileCandidates: 0, acceptedBuilds: fullOptions.length, rejectedCandidates: rejectedCandidates.map(row => ({ id: row.id, codes: row.codes, itemIds: row.itemIds })), publishedSlotAlternatives: publishedSlotAlternatives.reduce((sum, stage) => sum + stage.items.length, 0), seedStatus: seedRow ? 'editorial-only' : 'no-seed-role', seedArchetype: seedRow?.primaryArchetype || '', composition: compositionSummary, optimizer: { coreCompletion: coreCompletionDiagnostics, substitutions: optimizerResult.diagnostics, candidateCount: optimizerResult.candidateCount, summary: optimizerResult.rejectionSummary, searchScope: 'bounded; not a proof of global optimum' } };
      diagnostics.mechanicsProfile = input.championMechanics ? { status: input.championMechanics.status, coverage: input.championMechanics.coverage, warningCount: input.championMechanics.warnings?.length || 0 } : { status: 'insufficient-data' };
      return { championId, role, options: fullOptions, stagePlans, buildComparison, observedCore, publishedSlotAlternatives, coreCompletionPlans, rejectedCandidates, championMechanics: input.championMechanics || null, matchupItems: filterMechanicalItems(matchupItemsFor(championId, threats, language)), composition: compositionSummary, status: fullOptions.some(option => option.buildType !== 'partial-core') ? status : core ? 'partial-core' : status, notice, seedProfile: seedRow ? { role: seedRow.role, archetype: seedRow.primaryArchetype, reviewStatus: seedRow.reviewStatus, functionGoals: seedRow.editorialFunctionGoals || [] } : null, diagnostics, optimizerDiagnostics: diagnostics.optimizer, substitutionVariants: optimizerResult.variants.map(option => ({ id: option.id, baseOptionId: option.substitution.baseOptionId, itemIds: option.finalSlots, changes: option.substitution.changes, reasons: option.substitution.reasons, tradeoff: option.substitution.tradeoff })), provenance: { ...provenance, sourceKind: fullOptions.some(x => x.buildType === 'observed' && x.sourceKind !== 'strategic-substitution') ? 'observed_sequence' : fullOptions.some(x => x.buildType === 'generated' && x.sourceKind !== 'strategic-substitution') ? 'published_core_plus_slot_candidates' : fullOptions.length ? 'published_core_only' : 'no_data', statisticsPatch: publishedVersion || null, source: input.publishedData?.source || null, winRatesShown: false } };
    }

    for (const profile of profileRows) {
      const score = scoreBuild(profile, threats, composition);
      // Keep matchup variants out of the selectable build list until their
      // stated threat is confirmed and not already covered by allies.
      if ((profile.when || []).length && score === 0) continue;
      const profileIds = profile.itemIds.map(String), finalValidation = validateBuildItems(profileIds, itemCatalog, { patch, exclusiveGroups, championId, role });
      if (!finalValidation.valid) { rejectedCandidates.push({ id: profile.id, codes: finalValidation.errors, itemIds: finalValidation.conflictingItemIds }); continue; }
      const snapshotCoreIds = profile.publishedCoreIds || [];
      const coreMatchesProfile = ids => ids?.length > 0 && ids.every(id => profileIds.includes(String(id)));
      let completionCore = null;
      if (observedCore?.validation?.valid && publishedPatchCompatible && coreMatchesProfile(observedCore.itemIds)) completionCore = observedCore;
      else if (coreMatchesProfile(snapshotCoreIds) && profile.patch && patchLine(profile.patch) === patchLine(patch)) {
        const check = validateCoreItems(snapshotCoreIds, itemCatalog, { patch, exclusiveGroups, championId, role });
        if (check.valid) completionCore = { itemIds: snapshotCoreIds.map(String), rawItemIds: snapshotCoreIds.map(String), source: profile.evidence?.source || profile.source, patch: profile.evidence?.snapshotPatch || profile.patch, games: Number(profile.evidence?.games) || 0, pickRate: 0, state: 'partial-core', validation: check, sourceAge: profile.evidence?.collectedAt || '' };
      }
      const explanation = explainBuild(profile, composition, threats, language);
      const threatChampions = [...new Set((profile.when || []).flatMap(condition => enemiesForCondition(condition, threats).map(enemy => enemy.championId)))];
      const generated = !!completionCore;
      const buildType = generated ? 'generated' : 'editorial';
      const label = language === 'en' ? profile.label : profile.label_es;
      const reasons = [...explanation.reasons];
      if (generated) reasons.unshift(language === 'en' ? `Keeps the ${completionCore.itemIds.length}-item published core and adds editorial completion items; the final six-item set has no attributed win rate.` : `Conserva el núcleo publicado de ${completionCore.itemIds.length} objetos y añade complemento editorial; la build final no hereda win rate.`);
      if (!reasons.length) reasons.push(language === 'en' ? 'Editorial pilot profile selected for this champion and role.' : 'Perfil piloto editorial para el campeón y rol seleccionados.');
      const itemExplanations = Object.fromEntries(profileIds.map(id => [id, explainItem(id, profile, championId, language, reasons, explanation.tradeoffs, threatChampions, input.championMechanics, profileIds)]));
      fullOptions.push({
        id: generated ? `generated-${profile.id}` : profile.id, label: generated ? `${label} · ${language === 'en' ? 'educational proposal' : 'propuesta educativa'}` : `${label} · ${language === 'en' ? 'editorial' : 'editorial'}`,
        style: profile.style, itemIds: profileIds, items: profileIds.map(id => ({ id, name: itemCatalog[id]?.name || id, cost: itemCatalog[id]?.gold || 0, education: itemExplanations[id] })), itemExplanations, finalSlots: profileIds,
        purchaseOrder: planPurchasePath(profileIds, itemCatalog, { exclusiveGroups, sourceKind: generated ? 'editorial-completion' : 'editorial', language, orderIds: profile.purchaseOrderIds, championId, role, archetype: profile.style, composition }),
        reasons, threatChampions, tradeoffs: [...profile.tradeoffs, ...(completionCore?.itemIds?.length ? [language === 'en' ? 'The published core and editorial completion are separate evidence; do not treat the combined six items as a measured set.' : 'El núcleo publicado y el complemento editorial son evidencias distintas; el conjunto de seis no está medido como combinación.'] : [])],
        score: score + (generated ? 20 : 0), buildType, sourceKind: profile.provenanceKind === 'prior_engine_proposal' ? 'prior_engine_proposal' : generated ? 'published_core_plus_editorial' : profile.confidence === 'rules' ? 'curated_item_rule' : 'curated_kit',
        buildStatus: profile.patch && patchLine(profile.patch) === patchLine(patch) ? 'build-ready' : 'provisional-curated-stale', source: profile.source, patch: profile.patch || patch,
        observedCore: completionCore, validation: finalValidation, confidence: generated ? 'limited' : 'editorial', profileConditions: profile.when || [], profileAvoidWhenAllies: profile.avoidWhenAllies || []
      });
    }

    let coreCompletionPlans = [], publishedSlotAlternatives = [];
    if (observedCore?.validation?.valid && observedCore.itemIds.length === 3 && publishedPatchCompatible && sourceContextCompatible && championDefinitions[championId]) {
      const joint = rankPublishedCoreCompletions({ coreIds: observedCore.itemIds, published, itemCatalog, validate: itemIds => validateBuildItems(itemIds, itemCatalog, { patch, exclusiveGroups, championId, role }), evaluateCombination: evaluateContinuation, maxCandidatesPerSlot: 8, limit: 3 });
      publishedSlotAlternatives = joint.slots.map(stage => ({ ...stage, items: stage.items.map(item => ({ id: item.itemId, name: item.name, play: item.play, pickRate: item.pickRate, stage: item.stage, position: item.position })) }));
      coreCompletionPlans = joint.combinations.map((plan, index) => {
        const ids = plan.itemIds, style = champions[championId]?.roles?.[role]?.[0]?.primaryArchetype || 'published-source';
        const itemExplanations = Object.fromEntries(ids.map(id => [id, explainItem(id, { style, when: [], tradeoffs: [] }, championId, language, [], [], [], input.championMechanics, ids)]));
        const slotEvidence = plan.slots.map(slot => ({ itemId: slot.itemId, stage: slot.stage, play: slot.play, pickRate: slot.pickRate }));
        const option = {
          id: `generated-source-${championId}-${role}-${index + 1}`,
          label: language === 'en' ? `${championId} · educational completion ${index + 1}` : `${championDefinitions[championId]?.name || championId} · complemento educativo ${index + 1}`,
          style, itemIds: ids, items: ids.map(id => ({ id, name: itemCatalog[id]?.name || id, cost: itemCatalog[id]?.gold || 0, education: itemExplanations[id], sourceEvidence: slotEvidence.find(row => row.itemId === id) || null })), itemExplanations, finalSlots: ids,
          purchaseOrder: planPurchasePath(ids, itemCatalog, { exclusiveGroups, sourceKind: 'published-core-completion', language, orderIds: [...(observedCore.rawItemIds || observedCore.itemIds), ...plan.slots.map(row => row.itemId)], championId, role, archetype: style, composition }),
          reasons: [language === 'en' ? 'Preserves the three-item published core. Slots 4–6 use separate current-patch champion/role stage samples and were validated jointly.' : 'Conserva el núcleo publicado de tres objetos. Los espacios 4–6 usan muestras separadas de compra para este campeón/rol y se validaron como conjunto.'],
          tradeoffs: [language === 'en' ? 'The source published the core and item-stage samples separately, not this six-item combination; no outcome rate is attributed to it.' : 'La fuente publicó por separado el núcleo y las muestras por etapa, no esta combinación de seis; no se le atribuyen estadísticas de resultado.'],
          score: plan.score, buildType: 'generated', sourceKind: 'published_core_plus_slot_candidates', buildStatus: 'build-ready', source: input.publishedData?.source || 'OP.GG · published core and purchase stages', patch: publishedVersion, observedCore, validation: plan.validation, confidence: 'limited', slotEvidence
        };
        decorateMechanics(option);
        return { ...plan, option };
      });
      fullOptions.push(...coreCompletionPlans.map(plan => plan.option));
    }

    if (observedCore?.validation?.valid && observedCore.itemIds.length > 0 && observedCore.itemIds.length < 6 && profileRows.length) {
      const hasCoreOption = fullOptions.some(option => option.buildType === 'partial-core' && option.finalSlots.join('|') === observedCore.itemIds.join('|'));
      if (!hasCoreOption) fullOptions.push({
        id: 'published-core-partial',
        label: language === 'en' ? `Published ${observedCore.itemIds.length}-item core · partial` : `Núcleo publicado de ${observedCore.itemIds.length} objetos · parcial`,
        style: 'published-core', itemIds: observedCore.itemIds, items: observedCore.itemIds.map(id => ({ id, name: itemCatalog[id]?.name || id, cost: itemCatalog[id]?.gold || 0 })), finalSlots: observedCore.itemIds,
        purchaseOrder: planPurchasePath(observedCore.itemIds, itemCatalog, { exclusiveGroups, sourceKind: 'observed-core', language, orderIds: observedCore.rawItemIds?.filter(id => observedCore.itemIds.includes(String(id))), championId, role, composition }),
        reasons: [language === 'en' ? 'This source-published core stays separate from full proposals; remaining slots are not filled with unrelated item statistics.' : 'Este núcleo publicado se mantiene separado de las propuestas completas; los espacios no se rellenan con estadísticas sueltas de otros objetos.'],
        tradeoffs: [language === 'en' ? 'The core is incomplete and has no six-item result rate.' : 'El núcleo está incompleto y no tiene win rate de una build de seis objetos.'],
        score: 0, buildType: 'partial-core', sourceKind: 'published_core_only', buildStatus: 'partial-core', source: observedCore.source, patch: publishedVersion, validation: observedCore.validation, observedCore
      });
    }

    fullOptions.forEach(decorateMechanics);
    for (let index = fullOptions.length - 1; index >= 0; index--) {
      const option = fullOptions[index];
      if (option.mechanicalCompatibility?.rejectedItemIds?.length) {
        rejectedCandidates.push({ id: option.id, codes: option.mechanicalCompatibility.rows.flatMap(row => row.issues.map(issue => issue.code)), itemIds: option.mechanicalCompatibility.rejectedItemIds });
        fullOptions.splice(index, 1);
      }
    }
    const optimizerResult = optimizeEvidenceBackedVariants({
      options: fullOptions, published, itemCatalog, itemAdvice, itemPurposeCatalog, candidateItems: matchupItemsFor(championId, threats, language),
      boughtItemIds: input.boughtItemIds || [], explicitLockedItemIds: input.lockedItemIds || [], composition,
      championId, role, champion: championDefinitions[championId] || {}, mechanics: input.championMechanics || null,
      activationRules: itemActivationRules, patch, exclusiveGroups, language,
      validateBuild: ids => validateBuildItems(ids, itemCatalog, { patch, exclusiveGroups, championId, role }),
      decorate: decorateMechanics
    });
    const substitutionVariants = optimizerResult.variants;
    const substitutionSearchDiagnostics = optimizerResult.diagnostics;
    fullOptions.push(...substitutionVariants);
    const buildComparison = compareChampionBuilds({ builds: fullOptions, itemCatalog, mechanics: input.championMechanics || null, language, condition: compositionSummary.recommendation, confirmedThreats: threats });
    const rank = option => option.sourceKind === 'strategic-substitution' ? 2.5 : ({ observed: 0, generated: 1, editorial: 2, 'partial-core': 3 }[option.buildType] ?? 4);
    const sortedOptions = [...fullOptions].sort((a, b) => rank(a) - rank(b) || b.score - a.score || a.id.localeCompare(b.id));
    const seenItemSets = new Set();
    const options = sortedOptions.filter(option => {
      const key = [...(option.finalSlots || option.itemIds || [])].map(String).sort().join('|');
      if (!key || seenItemSets.has(key)) return false;
      seenItemSets.add(key); return true;
    }).slice(0, 6);
    const stagePlans = planRankedStages({ options, enemies: threats, laneOpponentChampionId: input.laneOpponentChampionId || input.enemyChampionId || '', composition, language, boughtItemIds: input.boughtItemIds || [] });
    const matchupItems = filterMechanicalItems(matchupItemsFor(championId, threats, language));
    const staleNotice = publishedRows.length && !publishedPatchCompatible ? (language === 'en' ? `OP.GG data is from patch ${publishedVersion || 'unknown'}; the current catalog is ${patch}. Stale stats are not used to construct the route.` : `OP.GG corresponde al parche ${publishedVersion || 'desconocido'}; el catálogo actual es ${patch}. No se usa esa estadística antigua para crear la ruta.`) : '';
    const status = options.some(option => option.buildType !== 'partial-core') ? 'build-ready' : options.some(option => option.buildType === 'partial-core') || observedCore ? 'partial-core' : published ? 'no-profile' : input.sourceError ? 'source-error' : 'no-source';
    const notice = [staleNotice, composition.incomplete && threats.length ? (language === 'en' ? 'Only confirmed visible enemies are considered; unknown picks are not inferred.' : 'Solo se consideran enemigos confirmados y visibles; no se infieren picks desconocidos.') : '', !options.length && observedCore?.validation?.valid ? (language === 'en' ? 'A compatible reviewed profile is still needed to complete this core.' : 'Falta un perfil compatible revisado para completar este núcleo.') : ''].filter(Boolean).join(' ');
    const sourceState = publishedRows.length ? observedCore?.validation?.valid ? 'published-core-available' : 'published-data-rejected' : published ? 'queried-no-builds' : input.sourceError ? 'source-error' : input.publishedData ? 'queried-no-builds' : 'not-queried';
    const diagnostics = { championId, role, catalogPatch: patch, statisticsPatch: publishedVersion || '', source: input.publishedData?.source || (input.sourceError ? 'source-error' : 'local-profile'), sourceState, sourceQueried: !!input.publishedData, sourceAge: input.publishedData?.cachedAt || '', statisticsRows: publishedRows.length, publishedCoreState: observedCore?.state || 'no-source', profileCandidates: profileRows.length, acceptedBuilds: options.length, rejectedCandidates: rejectedCandidates.map(row => ({ id: row.id, codes: row.codes, itemIds: row.itemIds })), composition: compositionSummary, mechanicsProfile: input.championMechanics ? { status: input.championMechanics.status, coverage: input.championMechanics.coverage, warningCount: input.championMechanics.warnings?.length || 0 } : { status: 'insufficient-data' }, optimizer: { substitutions: substitutionSearchDiagnostics, candidateCount: optimizerResult.candidateCount, summary: optimizerResult.rejectionSummary, searchScope: 'bounded; not a proof of global optimum' } };
    return { championId, role, patch, archetype: champion.archetypes, options, stagePlans, buildComparison, observedCore, publishedSlotAlternatives, coreCompletionPlans, substitutionVariants: substitutionVariants.map(option => ({ id: option.id, baseOptionId: option.substitution.baseOptionId, itemIds: option.finalSlots, changes: option.substitution.changes, reasons: option.substitution.reasons, tradeoff: option.substitution.tradeoff })), rejectedCandidates, championMechanics: input.championMechanics || null, matchupItems, composition: compositionSummary, status, notice, diagnostics, optimizerDiagnostics: diagnostics.optimizer, provenance: { ...provenance, sourceKind: options.some(x => x.buildType === 'observed' && x.sourceKind !== 'strategic-substitution') ? 'observed_sequence' : options.some(x => x.buildType === 'generated' && x.sourceKind !== 'strategic-substitution') ? 'published_core_plus_editorial' : options.length ? 'editorial' : 'no_data', statisticsPatch: publishedVersion || null, source: input.publishedData?.source || null, sourceAge: input.publishedData?.cachedAt || '' } };
  };
}

function recommendArchetypes({ input, language, championId, role, itemCatalog, itemPurposeCatalog, championDefinitions, exclusiveGroups, patch, profileChampion, itemActivationRules }) {
  const en = language === 'en', profile = archetypeCandidates.champions[championId], knowledge = knowledgeFor(championId, role);
  const reviewed = archetypeCandidates.items, capabilities = new Set(profile.capabilities),localizedItems=itemPurposeCatalog?.patch===patch?itemPurposeCatalog:(fallbackItemPurposeCatalog.patch===patch?fallbackItemPurposeCatalog:{items:{}});
  const allEnemies = (input.roster?.enemies || input.enemies || []).filter(row => row.championId && row.confirmed === true && row.visible === true).slice(0,5);
  const laneId = input.laneOpponentChampionId || input.enemyChampionId || '';
  const lane = allEnemies.find(row => row.championId === laneId) || (laneId ? {championId:laneId,confirmed:true,visible:true} : null);
  const specs = [{id:'standard',enemies:[]}];
  if(lane)specs.push({id:'lane',enemies:[lane]});
  if(allEnemies.length)specs.push({id:'team',enemies:allEnemies});
  const published = input.publishedData?.data?.summary ? input.publishedData.data : input.publishedData?.summary ? input.publishedData : null;
  const query = input.publishedData?.queryContext;
  const compatibleSource = published && patchLine(sourcePatch(published)) === patchLine(patch) && (!published.champion || String(published.champion).toLowerCase() === championId.toLowerCase()) && (!published.position || canonicalRole(published.position) === canonicalRole(role)) && (!query?.championId || query.championId === championId) && (!query?.position || canonicalRole(query.position) === canonicalRole(role));
  const cores = compatibleSource ? rows(published.core_items).filter(row => Array.isArray(row.ids) && row.ids.length >= 2 && row.ids.length <= 10).map(row => {
    const rawItemIds=row.ids.map(String),consumed=new Set(rawItemIds.flatMap(id=>getConsumedItemIds(id,itemCatalog,exclusiveGroups,{patch,mapId:'11'}).consumedItemIds||[]));
    const itemIds=[...new Set(rawItemIds.filter(id=>!consumed.has(id)))];
    return {itemIds,rawItemIds,support:Math.min(1,Number(row.pick_rate)||0),games:Number(row.play)||0,row,validation:validateCoreItems(itemIds,itemCatalog,{patch,exclusiveGroups,championId,role})};
  }).filter(row => row.validation.valid) : [];
  const popularity={};
  if(compatibleSource)for(const key of ['core_items','boots','fourth_items','fifth_items','sixth_items','last_items'])for(const row of rows(published[key]))for(const id of row.ids||[])popularity[String(id)]=Math.max(popularity[String(id)]||0,Math.min(1,Number(row.pick_rate)||0)*(Number(row.play)||0)/((Number(row.play)||0)+100));
  const fixed=[...new Set([...(input.boughtItemIds||[]),...(input.lockedItemIds||[]),...(input.requiredItemIds||[]),...(profile.requiredItemId?[profile.requiredItemId]:[])].map(String))];
  const scenarios={},rejectedCandidates=[];
  const threatAliases={physical:'physical-damage','physical-heavy':'physical-damage','physical-burst':'physical-burst','physical-aoe':'physical-aoe','magic-heavy':'magic-damage',magic:'magic-damage','magic-burst':'magic-burst','magic-aoe':'magic-aoe','single-target-dive':'single-target-dive','true-damage':'true-damage',tank:'tank','durable-frontline':'tank',healing:'healing',sustain:'healing',shielding:'shielding',control:'cc',cc:'cc',crit:'crit','attack-speed':'basic-attacks','sustained-damage':'basic-attacks'};
  for(const spec of specs){
    const composition=analyzeComposition({roster:{player:input.player,enemies:spec.enemies,allies:input.roster?.allies||input.allies||[]},profileChampion,championProfiles:{}});
    const threats=[...new Set((composition.enemies||[]).flatMap(row=>row.tags||[]).map(tag=>threatAliases[tag]||tag))];
    if(threats.includes('physical-burst')||threats.includes('magic-burst'))threats.push('burst');
    const threatStrength={};
    for(const enemy of composition.enemies||[])for(const tag of new Set((enemy.tags||[]).map(tag=>threatAliases[tag]||tag)))threatStrength[tag]=(threatStrength[tag]||0)+1;
    for(const tag of Object.keys(threatStrength))threatStrength[tag]=1+Math.log2(threatStrength[tag]);
    // Only explicit verified coverage can discount counters. Ally champion identity
    // alone is not evidence that this team already purchased anti-heal.
    if((input.alliedCoverage||[]).some(row=>row.verified===true&&row.tag==='healing'))threatStrength.healing=(threatStrength.healing||1)*.4;
    const candidates=[],runs=[];
    for(const arch of profile.archetypes){
      const errors=[];
      const pool=Object.entries(reviewed).filter(([id,review])=>{
        const item=itemCatalog[id];
        if(!item||review.patch!==patch)return false;
        const sourceCandidate=cores.some(core=>core.itemIds.includes(id));
        if(!review.identities.includes(arch.identity)&&!review.identities.includes('boots')&&!fixed.includes(id)&&!sourceCandidate)return false;
        // Published role evidence may introduce an unusual reviewed item, but
        // never replace an archetype's main damage with useless secondary stats.
        if(sourceCandidate&&!review.identities.includes(arch.identity)&&!review.identities.includes('boots')){
          const stats=item.stats||{};
          if(['assassin','bruiser'].includes(arch.identity)&&(stats.FlatMagicDamageMod||0)>0&&!(stats.FlatPhysicalDamageMod>0))return false;
          if(['burst','sustained'].includes(arch.identity)&&stats.FlatPhysicalDamageMod>0&&!stats.FlatMagicDamageMod)return false;
        }
        if((review.activation||[]).some(cap=>!capabilities.has(cap))){errors.push({id,reason:'reviewed-activation-unavailable'});return false;}
        if(review.conditional&&!review.counters?.some(tag=>threats.includes(tag))&&!fixed.includes(id))return false;
        const legal=validateCoreItems([id],itemCatalog,{patch,exclusiveGroups,championId,role});
        if(!legal.valid){errors.push({id,reason:legal.errors.join(',')});return false;}
        const compatibility=evaluateBuildCompatibility({itemIds:[id],itemCatalog,champion:championDefinitions[championId],mechanics:input.championMechanics,activationRules:itemActivationRules,patch});
        // Ally triggers use the explicitly reviewed capability, never generic self healing.
        if(compatibility.rejectedItemIds.length&&!((review.activation||[]).includes('ally_heal')&&capabilities.has('ally_heal'))){errors.push({id,reason:'activation-incompatible'});return false;}
        if(review.identities.includes('boots')){
          if(input.roleQuestCompleted===true&&input.questBootsItemId)return false;
          const useful={tank:['3047','3111','3009'],bruiser:['3047','3111','3158'],assassin:['3158','3111','3047'],burst:['3020','3158'],sustained:['3020','3158'],crit:['3006'],onhit:['3006'],enchanter:['3158','3009']};
          if(!useful[arch.identity]?.includes(id))return false;
        }
        return true;
      }).map(([id])=>({itemId:id,score:popularity[id]||0,source:reviewed[id].source,evidence:{kind:'editorial-reviewed-item-candidate',status:'qualitative-not-statistical',patch}}));
      const score = (ids,weights=V4_WEIGHTS)=>{
        const result=scoreArchetypeSet({ids,catalog:itemCatalog,reviewed,archetype:arch,knowledge,popularity,cores,threats,threatStrength,weights});
        const baseline=scenarios.standard?.variants.find(row=>row.archetypeId===arch.id);
        if(baseline){const substitutions=ids.filter(id=>!baseline.itemIds.includes(id)).length;result.score-=Math.max(0,substitutions-1)*(spec.id==='lane'?.9:.45);}
        const exact=cores.find(row=>row.itemIds.length===6&&ids.length===6&&row.itemIds.every(id=>ids.includes(id)));
        const base=published?.summary?.average_stats,n=Number(base?.play),w=Number(base?.win),matches=exact?.games,wins=Number(exact?.row?.win);
        if(exact&&n>0&&w>=0&&w<=n&&matches>0&&wins>=0&&wins<=matches){
          const baseline=w/n,posterior=(wins+200*baseline)/(matches+200);
          result.score+=Math.max(-.75,Math.min(.75,(posterior-baseline)*6));
          result.exactEvidence={source:input.publishedData?.source||'OP.GG',patch:sourcePatch(published),games:matches,method:'exact-set-only-editorial-alpha-200'};
        }
        return result;
      };
      pool.sort((a,b)=>score([b.itemId]).score-score([a.itemId]).score||a.itemId.localeCompare(b.itemId));
      const validate=ids=>{
        const result=validateBuildItems(ids,itemCatalog,{patch,exclusiveGroups,championId,role,roleQuestCompleted:input.roleQuestCompleted,questBootsItemId:input.questBootsItemId});
        if(!fixed.every(id=>ids.includes(id)))return {...result,valid:false,errors:[...result.errors,'drops-locked-item']};
        for(const id of ids){
          if((reviewed[id]?.activation||[]).some(cap=>!capabilities.has(cap)))return {...result,valid:false,errors:[...result.errors,'activation-incompatible']};
          for(const rule of itemActivationRules.rules||[])if(String(rule.itemId)===id)for(const requirement of rule.requires||[]){
            if(requirement==='mana-resource'&&knowledge.resource!=='mana'||requirement==='ally-heal-or-shield'&&!capabilities.has('ally_heal')&&!capabilities.has('ally_shield'))return {...result,valid:false,errors:[...result.errors,'activation-incompatible']};
          }
        }
        if(!ids.some(id=>reviewed[id]?.identities.includes('boots'))&&championId!=='Cassiopeia'&&!input.questBootsItemId)return {...result,valid:false,errors:[...result.errors,'boots-required']};
        if(arch.identity==='bruiser'&&ids.filter(id=>(itemCatalog[id]?.stats?.FlatPhysicalDamageMod||0)>0).length<3)return {...result,valid:false,errors:[...result.errors,'offtank-insufficient-ad-identity']};
        return result;
      };
      const search=seed=>optimizeItemBuilds({coreIds:seed,candidateSlots:Array.from({length:Math.max(0,6-seed.length)},()=>pool),itemCatalog,validate,validatePartial:ids=>validateCoreItems(ids,itemCatalog,{patch,exclusiveGroups,championId,role}),evaluateCombination:ids=>score(ids),unorderedSets:true,setScoring:true,beamWidth:64,maxCandidatesPerSlot:45,maxExpandedStates:50000,maxDurationMs:3500,limit:3,minDifferences:1});
      const seeds=[fixed];
      const supported=cores.find(core=>core.itemIds.length<6&&core.itemIds.every(id=>pool.some(row=>row.itemId===id)));
      if(supported)seeds.push([...new Set([...fixed,...supported.itemIds])]);
      for(const seed of seeds){
        if(seed.length>6)continue;
        const run=search(seed);runs.push({archetypeId:arch.id,...run.diagnostics,rejectedItems:errors});
        for(const row of run.combinations)candidates.push({...row,arch,quality:score(row.itemIds),evaluate:weights=>score(row.itemIds,weights)});
      }
      for(const core of cores.filter(core=>core.itemIds.length===6&&core.itemIds.every(id=>pool.some(row=>row.itemId===id))&&fixed.every(id=>core.itemIds.includes(id))))if(validate(core.itemIds).valid)candidates.push({itemIds:core.itemIds,score:score(core.itemIds).score,quality:score(core.itemIds),validation:validate(core.itemIds),arch,evaluate:weights=>score(core.itemIds,weights)});
      // Always compare the original standard strategy, even when a bounded
      // context beam prunes it. Context never erases the option to keep it.
      for(const baseline of scenarios.standard?.variants||[])if(spec.id!=='standard'&&baseline.archetypeId===arch.id&&validate(baseline.itemIds).valid)candidates.push({itemIds:baseline.itemIds,score:score(baseline.itemIds).score,quality:score(baseline.itemIds),validation:validate(baseline.itemIds),arch,evaluate:weights=>score(baseline.itemIds,weights)});
    }
    const slotEvidence=compatibleSource?publishedSlotEvidence(published,input.publishedData?.source||'OP.GG'):[];
    for(const candidate of candidates){
      const exactPublished=cores.find(core=>core.itemIds.length===6&&candidate.itemIds.length===6&&core.itemIds.every(id=>candidate.itemIds.includes(id)));
      const priorCore=cores.find(core=>core.itemIds.every(id=>candidate.itemIds.includes(id)));
      candidate.purchasePlan=planPurchaseOrder(candidate.itemIds,itemCatalog,{
        exclusiveGroups,sourceKind:exactPublished?'observed':'generated',language,orderIds:exactPublished?.rawItemIds||priorCore?.rawItemIds||[],slotEvidence,
        championId,role,archetype:candidate.arch.identity,composition,enemies:composition.enemies,
        profile:{resource:knowledge.resource,supportSubtype:candidate.arch.supportSubtype||(role==='support'&&candidate.arch.identity==='tank'?'engage':candidate.arch.identity)},
        goldState:input.goldState||'unknown',goldStateEvidence:input.goldStateEvidence||null,
        purchasedOrder:input.purchasedOrder||[],roleQuestCompleted:input.roleQuestCompleted===true,questBootsItemId:input.questBootsItemId||'',queueMode:input.queueMode,queueModeVerified:input.queueModeVerified===true
      });
      candidate.orderContribution=clamp(candidate.purchasePlan.score*.08,-1.5,1.5);
      candidate.score+=candidate.orderContribution;
    }
    candidates.sort((a,b)=>(b.score-(b.arch.experimental?3:0))-(a.score-(a.arch.experimental?3:0))||a.itemIds.join('|').localeCompare(b.itemIds.join('|')));
    // One supported alternative per identity before nearby alternatives of the same strategy.
    const selected=[],seen=new Set();
    const add=row=>{const key=[...row.itemIds].sort().join('|');if(!seen.has(key)){seen.add(key);selected.push(row);}};
    if(candidates[0])add(candidates[0]);
    for(const arch of profile.archetypes){const row=candidates.find(c=>c.arch.id===arch.id);if(row)add(row);}
    if(spec.id!=='standard')for(const baseline of scenarios.standard?.variants||[]){const row=candidates.find(row=>[...row.itemIds].sort().join('|')===[...baseline.itemIds].sort().join('|'));if(row)add(row);}
    for(const row of candidates){if(selected.length>=8)break;if(selected.every(other=>row.itemIds.filter(id=>!other.itemIds.includes(id)).length>=2))add(row);}
    const scenarioLabelCounts=new Map(),scenarioLabels=new Set();
    const options=selected.map((row,index)=>{
      const ids=row.itemIds,exact=cores.find(core=>core.itemIds.length===6&&core.itemIds.every(id=>ids.includes(id))),core=cores.find(core=>core.itemIds.every(id=>ids.includes(id)));
      const evidenceType=exact?'observed-exact':core?'educational-from-core':'educational-generated';
      const sourceKind=exact?'observed_sequence':core?'published_core_plus_editorial':'editorial';
      const purchasePlan=row.purchasePlan||planPurchaseOrder(ids,itemCatalog,{exclusiveGroups,sourceKind:exact?'observed':'generated',language,orderIds:core?.rawItemIds||core?.itemIds||[],slotEvidence,championId,role,archetype:row.arch.identity,composition,enemies:composition.enemies,economy:input.economy,profile:{resource:knowledge.resource,supportSubtype:row.arch.supportSubtype||(role==='support'&&row.arch.identity==='tank'?'engage':row.arch.identity)}});
      const order=purchasePlan.steps;
      for(const step of order)if(step.finalItemId===profile.requiredItemId){step.acquisitionKind='support-quest-reward';step.whyFits={title:en?'Why it fits':'Por qué encaja',text:en?'Start the support quest item and earn this upgrade by completing its mission; it is not purchased directly.':'Empieza la misión del objeto de soporte y obtén esta mejora al completarla; no se compra directamente.'};step.guidance=step.whyFits.text;}
      const ordered=order.map(step=>String(step.finalItemId||step.itemId)).filter(id=>ids.includes(id));
      const finalSlots=[...new Set([...ordered,...ids])];
      const archetypeLabels={burst:en?'Burst damage':'Daño explosivo',sustained:en?'Sustained damage':'Daño sostenido',tank:en?'Tank':'Tanque',bruiser:en?'AD fighter':'Luchador AD',assassin:en?'Assassin':'Asesino',crit:en?'Critical strikes':'Golpes críticos',onhit:en?'On-hit':'Al impacto',enchanter:en?'Enchanter':'Encantador',hybrid:en?'Hybrid':'Híbrido'};
      const baseLabel=archetypeLabels[row.arch.identity]||row.arch.label[en?'en':'es'];
      const priorSameArchetype=selected.slice(0,index).find(other=>other.arch.id===row.arch.id);
      const standardReference=scenarios.standard?.variants.find(other=>other.archetypeId===row.arch.id)||scenarios.standard?.recommended;
      const referenceIds=spec.id!=='standard'&&standardReference?standardReference.itemIds:(priorSameArchetype?.itemIds||ids);
      const addedFromReference=ids.filter(id=>!referenceIds.includes(id)),removedFromReference=referenceIds.filter(id=>!ids.includes(id));
      const readableItem=id=>localizedItems.items?.[String(id)]?.names?.[en?'en':'es']||itemCatalog[id]?.name||(en?`Item ${id}`:`Objeto ${id}`);
      const variantFacet=id=>{
        const purpose=localizedItems.items?.[String(id)]?.primaryFunction||'';
        const laneName=lane?.championId||'';
        if(id==='3157'&&laneName.toLowerCase()==='zed')return en?'Defense against Zed':'Defensa contra Zed';
        const labels={
          'active-stasis-defense':en?'Situational defense':'Defensa situacional',
          'percent-magic-penetration':en?'Magic penetration':'Penetración mágica',
          'armor-penetration':en?'Armor penetration':'Penetración de armadura',
          'anti-heal':en?'Anti-healing':'Contra curaciones',
          'team-shield':en?'Team protection':'Protección del equipo',
          'team-heal':en?'Team healing':'Curación de equipo',
          'crit-amplifier':en?'Critical damage':'Daño crítico',
          'on-hit':en?'On-hit damage':'Daño al impacto',
          'mana-defense':en?'Mana and defense':'Maná y defensa'
        };
        return labels[purpose]|| (en?'Alternative utility':'Utilidad alternativa');
      };
      let label=baseLabel;
      if(addedFromReference.length){
        const marker=variantFacet(addedFromReference[0]);
        label=`${baseLabel} · ${marker}`;
      }else if(priorSameArchetype){
        label=`${baseLabel} · ${en?'alternative':'alternativa'}`;
      }
      let count=scenarioLabelCounts.get(baseLabel)||0;scenarioLabelCounts.set(baseLabel,count+1);
      while(scenarioLabels.has(label))label=`${label} · ${en?'option':'opción'} ${++count}`;
      scenarioLabels.add(label);
      const readableNeeds={
        'physical-burst':en?'physical burst': 'daño físico explosivo',
        'magic-burst':en?'magic burst':'daño mágico explosivo',
        'single-target-dive':en?'single-target dive':'entrada sobre un objetivo',
        'magic-aoe':en?'area magic damage':'daño mágico en área',
        'physical-aoe':en?'area physical damage':'daño físico en área',
        'healing':en?'enemy healing':'curaciones enemigas',
        'high-armor':en?'confirmed high armor':'armadura alta confirmada',
        'high-mr':en?'confirmed high magic resistance':'resistencia mágica alta confirmada',
        'control':en?'crowd control':'control de masas'
      };
      const knownNeeds=row.quality.coveredNeeds.map(need=>readableNeeds[need]).filter(Boolean);
      const reasons=[
        en?`${label} is a ${row.arch.identity} proposal for ${championId}; the final six-item set is generated, not an observed statistical combination.`:`${label} es una propuesta ${row.arch.identity} para ${championId}; el conjunto final de seis objetos es generado, no una combinación observada en estadísticas.`,
        knownNeeds.length?(en?`Its situational choices address confirmed ${knownNeeds.join(', ')}.`:`Sus opciones situacionales se orientan a ${knownNeeds.join(', ')}, según las amenazas confirmadas.`):(en?'No confirmed threat justifies forcing a replacement for the standard set.':'Ninguna amenaza confirmada justifica forzar un cambio respecto al conjunto estándar.')
      ];
      const effects={
        'heal-chain':['Extiende una cura o escudo a otro aliado.','Chains a heal or shield to another ally.'],
        'healing-amplification':['Refuerza las curas y escudos de una build con regeneración de maná.','Strengthens healing and shielding in a mana-regeneration build.'],
        'team-heal':['Ofrece una cura de área para una pelea de equipo.','Offers an area heal for a team fight.'],
        'ally-attack-buff':['Potencia los ataques del aliado al que curas.','Empowers the attacks of the ally you heal.'],
        'support-quest':['Mejora de misión: protege al aliado al que curas.','Quest upgrade: protects the ally you heal.'],
        'ally-cleanse':['Permite liberar a un aliado de controles compatibles.','Can free an ally from compatible crowd control.'],
        'team-shield':['Aporta un escudo de área para proteger al equipo.','Provides an area shield to protect the team.'],
        'team-mobility':['Ayuda al equipo a entrar, reposicionarse o retirarse.','Helps the team engage, reposition or retreat.'],
        'mana-defense':['Convierte la acumulación de maná en aguante y escudos al controlar.','Turns mana stacking into durability and shields when applying control.'],
        'ap-amplifier':['Multiplica el poder de habilidad que ya aporta el conjunto.','Amplifies the ability power provided by the rest of the set.'],
        'burn':['Añade daño persistente al acertar habilidades.','Adds persistent damage when abilities hit.'],
        'mana-engine':['Sostiene las rotaciones de habilidades con una reserva de maná.','Supports repeated spell rotations with a mana reserve.'],
        'percent-penetration':['Conserva daño cuando el rival acumula resistencias.','Preserves damage when opponents stack resistances.'],
        'stasis':['Permite evitar una ventana de daño con su activa.','Can avoid a damage window with its active.'],
        'spell-shield':['Bloquea una habilidad y reduce el riesgo de entrada.','Blocks an ability and reduces engage risk.'],
        'armor-shred':['Reduce armadura mediante daño físico repetido.','Reduces armor through repeated physical damage.'],
        'on-hit':['Añade valor a una secuencia de ataques básicos.','Adds value to a sequence of basic attacks.'],
        'crit-amplifier':['Potencia los críticos del resto de la build.','Amplifies critical strikes from the rest of the build.'],
        'anti-heal':['Reduce las curaciones del objetivo bajo las condiciones del objeto.','Reduces target healing under the item’s activation conditions.'],
        'health-stacking':['Recompensa mantener contacto con enemigos y acumular vida.','Rewards staying close to enemies and stacking health.'],
        'close-combat-sustain':['Aporta recuperación al mantenerte cerca de campeones en combate.','Provides recovery while remaining near champions in combat.'],
        'self-heal-shield-amplification':['Mejora las curas y escudos que recibes.','Improves healing and shielding received.']
      };
      const identityCopy={tank:['Aguante para permanecer en primera línea.','Durability to remain on the front line.'],bruiser:['Combina daño físico con margen para seguir peleando.','Combines physical damage with room to keep fighting.'],assassin:['Favorece la presión de una rotación de daño físico.','Supports pressure from a physical damage rotation.'],burst:['Refuerza el daño concentrado de una rotación de hechizos.','Strengthens concentrated damage from a spell rotation.'],sustained:['Favorece mantener daño durante varias rotaciones.','Supports damage across repeated spell rotations.'],crit:['Refuerza una secuencia sostenida de ataques críticos.','Strengthens sustained critical attacks.'],onhit:['Favorece ataques repetidos y sus efectos al impacto.','Supports repeated attacks and their on-hit effects.'],enchanter:['Aporta utilidad para sostener y proteger aliados.','Provides utility to sustain and protect allies.']};
      const itemExplanations=Object.fromEntries(finalSlots.map(id=>{
        const review=reviewed[id],effect=(review?.purposes||[]).map(p=>effects[p]).find(Boolean),targets=(composition.enemies||[]).filter(enemy=>(enemy.tags||[]).some(tag=>(review?.counters||[]).includes(threatAliases[tag]||tag))).map(enemy=>championDefinitions[enemy.championId]?.name||enemy.championId);
        const what=effect?.[en?1:0]||(review?.identities.includes('boots')?(en?'Mobility and the reviewed boot specialization.':'Movilidad y la especialización revisada de estas botas.'):(identityCopy[row.arch.identity]||[])[en?1:0])||(en?'Compatible item utility.':'Utilidad compatible del objeto.');
        const step=order.find(row=>String(row.finalItemId)===String(id));
        const fallback=targets.length?(en?`Against ${targets.join(', ')}, ${what.toLowerCase()} fits this ${role} ${label} build; slot ${step?.order||'?'} keeps the response before later options.`:`Frente a ${targets.join(', ')}, ${what.toLowerCase()} encaja en esta build ${label} de ${role}; el slot ${step?.order||'?'} adelanta la respuesta a las opciones tardías.`):(en?`${what} is used here for the ${label} ${role} plan; it occupies slot ${step?.order||'?'} after the confirmed core function.`:`${what} se usa aquí en el plan ${label} de ${role}; ocupa el slot ${step?.order||'?'} tras la función principal del núcleo.`);
        const plannedWhy=step?.whyFits||{title:en?'Why it fits':'Por qué encaja',text:fallback};
        const synergy=evaluateChampionItemSynergy({item:itemCatalog[id],selectedItems:finalSlots.filter(other=>other!==id).map(other=>itemCatalog[other]).filter(Boolean),mechanics:input.championMechanics||null,language});
        const abilityEvidence=synergy.mechanicsEvidence.find(row=>row.abilityName);
        const mechanicNote=abilityEvidence?(language==='en'?`Uses the published ${abilityEvidence.stat||'mechanic'} on ${abilityEvidence.abilityName}.`:`Aprovecha el ${abilityEvidence.stat||'efecto'} publicado de ${abilityEvidence.abilityName}.`):'';
        const whyFits={...plannedWhy,text:shortReason([mechanicNote,plannedWhy.text].filter(Boolean).join(' '),520)};
        return [id,{whyFits,fit:whyFits.text,source:review?.source||'Data Dragon',status:'editorial-reviewed',evidenceStatus:synergy.status,evidenceSummary:synergy.evidenceSummary||{level:'editorial-reviewed',patch,sources:[review?.source||'Data Dragon'],confidence:null},mechanicsEvidence:synergy.mechanicsEvidence||[]}];
      }));
      for(const step of order){const fit=itemExplanations[String(step.finalItemId)]?.whyFits;if(fit){step.whyFits=fit;if(!step.transform)step.guidance=fit.text;}}
      const tradeoff=addedFromReference.length? (en?`${addedFromReference.map(readableItem).join(', ')} replaces ${removedFromReference.map(readableItem).join(', ')||'no standard item'}; compare the named effects and their slot rationale before choosing this alternative.`:`${addedFromReference.map(readableItem).join(', ')} sustituye a ${removedFromReference.map(readableItem).join(', ')||'ningún objeto estándar'}; compara esos efectos y el motivo de sus slots antes de elegir la alternativa.`) : (en?'This set retains the reference items; the purchase sequence changes timing, not the build identity.':'Este conjunto conserva los objetos de referencia; cambia el momento de compra, no la identidad de la build.');
      return {id:`v4-${spec.id}-${row.arch.id}-${index}`,label,variantDifference:{added:addedFromReference.map(readableItem),removed:removedFromReference.map(readableItem),basis:spec.id==='standard'?'same-archetype-reference':'standard-same-archetype'},style:row.arch.id,archetypeId:row.arch.id,experimental:!!row.arch.experimental,evidenceType,sourceKind,buildType:exact?'observed':'generated',buildStatus:'build-ready',finalSlots,itemIds:finalSlots,finalEquippedSet:finalSlots,items:finalSlots.map(id=>({id,name:readableItem(id),cost:itemCatalog[id]?.gold||0,education:itemExplanations[id]})),purchaseOrder:order,purchaseRouteComparisons:purchasePlan.purchaseRouteComparisons||[],separateItems:purchasePlan.separateItems||[],purchasePlan:{score:purchasePlan.score,diagnostics:purchasePlan.diagnostics,limitations:purchasePlan.limitations},orderContribution:row.orderContribution||0,itemExplanations,observedCore:core?{...core,source:input.publishedData?.source||'OP.GG',patch:sourcePatch(published)}:null,reasons,tradeoffs:[tradeoff,...(row.arch.experimental?[en?'Experimental strategy; no patch/role performance claim.':'Estrategia experimental; sin evidencia de rendimiento por parche/rol.']:[])],validation:row.validation,patch,source:exact||core?input.publishedData?.source||'OP.GG':'Rift Companion · revisión editorial de Data Dragon',score:row.score,quality:row.quality,confidence:'editorial-reviewed',knowledgeStatus:'editorial-unverified',threatChampions:spec.enemies.map(row=>row.championId)};
    });
    const sensitivity=[];
    if(selected.length)for(const key of Object.keys(V4_WEIGHTS))for(const factor of [.8,1.2]){
      const ranked=selected.map(row=>({id:row.itemIds.slice().sort().join('|'),value:row.evaluate({...V4_WEIGHTS,[key]:V4_WEIGHTS[key]*factor}).score-(row.arch.experimental?3:0)})).sort((a,b)=>b.value-a.value||a.id.localeCompare(b.id));
      sensitivity.push({weight:key,factor,changed:ranked[0].id!==selected[0].itemIds.slice().sort().join('|')});
    }
    scenarios[spec.id]={label:spec.id==='standard'?(en?'Standard':'Estándar'):spec.id==='lane'?(en?'Vs opponent':'Vs rival'):(en?'Vs team':'Vs equipo'),recommended:options[0]||null,variants:options,partial:options.length?null:{itemIds:cores[0]?.itemIds||[],reason:en?'Not enough reviewed, compatible final items.':'Faltan objetos finales revisados y compatibles.'},diagnostics:{runs,rankingSensitivity:{meaning:'editorial-weight-sensitivity-not-statistical-confidence',unstable:sensitivity.some(row=>row.changed),trials:sensitivity}},composition};
  }
  const standard=scenarios.standard.recommended;
  for(const [id,scenario]of Object.entries(scenarios))if(id!=='standard'&&standard&&scenario.recommended){
    const added=scenario.recommended.itemIds.filter(itemId=>!standard.itemIds.includes(itemId));
    const removed=standard.itemIds.filter(itemId=>!scenario.recommended.itemIds.includes(itemId));
    const itemNameFor=id=>itemCatalog[id]?.name||(en?`Item ${id}`:`Objeto ${id}`);
    const slotRationale=scenario.recommended.purchaseOrder.find(step=>added.includes(String(step.finalItemId)))?.whyFits?.text||'';
    scenario.deltaFromStandard={
      added,removed,unchanged:!added.length,
      reason:added.length
        ?(en?`${added.map(itemNameFor).join(', ')} replaces ${removed.map(itemNameFor).join(', ')||'no standard item'}. ${slotRationale}`:`${added.map(itemNameFor).join(', ')} sustituye a ${removed.map(itemNameFor).join(', ')||'ningún objeto estándar'}. ${slotRationale}`)
        :(en?'The standard six items remain appropriate; no confirmed threat produced a sufficiently supported replacement.':'Se mantienen los seis objetos estándar: ninguna amenaza confirmada justificó una sustitución con sustento suficiente.')
    };
  }
  return {schemaVersion:'4.0',championId,role,patch,scenarios,observedCore:cores[0]||null,options:scenarios.standard.variants,stagePlans:{},substitutionVariants:[],rejectedCandidates,matchupItems:[],composition:scenarios.team?.composition||scenarios.lane?.composition||scenarios.standard.composition,status:standard?'build-ready':'partial-core',notice:en?'Educational strategy review; generated combinations have no observed win rate.':'Revisión estratégica educativa; las combinaciones generadas no tienen win rate observado.',diagnostics:{sourceState:compatibleSource?'published-data-available':input.publishedData?'source-incompatible':'not-queried',sourceQueried:!!input.publishedData,acceptedBuilds:scenarios.standard.variants.length,statisticsPatch:sourcePatch(published),optimizer:{searchScope:'bounded-beam-no-global-optimum-proof'}},provenance:{method:'v4-shared-archetype-search',patch,winRatesShown:false,sourceKind:standard?.sourceKind||'no_data'}};
}

module.exports = { createBuildAdvisor };
