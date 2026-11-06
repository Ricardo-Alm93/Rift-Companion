'use strict';

const MECHANIC_MAP = Object.freeze({
  healing: 'healing', shielding: 'shielding', 'physical-damage': 'physical-damage', 'magic-damage': 'magic-damage', 'true-damage': 'true-damage'
});
const PATTERNS = Object.freeze({
  burst: /\b(burst|instantly|single strike|massive damage|execute|detonat)\b/i,
  dps: /\b(per second|each second|over time|repeatedly|every .+ seconds?)\b/i,
  poke: /\b(range|ranged|projectile|long range|distance)\b/i,
  persistent: /\b(remains|persist|zone|area for|over \d+(?:\.\d+)? seconds?)\b/i,
  crowdControl: /\b(stun|root|silence|knock.?up|knock.?back|suppress|immobiliz|slow)\b/i,
  mobility: /\b(dash|blink|leap|teleport|dashes|reposition)\b/i,
  attacks: /\b(basic attacks?|next attack|attack speed|critical strike|on.?hit)\b/i,
  attackSpeed: /\b(attack speed|attacks? faster)\b/i,
  criticalStrike: /\b(critical strike|critically strike)\b/i,
  onHitMention: /\bon.?hit\b/i,
  resource: /\b(mana|energy|health|rage|heat|flow)\b/i,
  periodic: /\b(per second|each second|every second|over \d+(?:\.\d+)? seconds?)\b/i,
  evolution: /\b(evolv|upgrade|upgrades|evolved)\b/i,
  transformation: /\b(transform|transforms|transformation|form)\b/i
});

function createChampionMechanicsProfile(abilityProfile, { role = '', editorialProfiles = [], supplementalRecords = [] } = {}) {
  if (!abilityProfile?.championId || !Array.isArray(abilityProfile.abilities)) return {
    championId: '', role: String(role || ''), status: 'insufficient-data', damageTypes: [], scalings: [], mechanics: [],
    abilityFacts: [], buildArchetypes: [], provenance: [], warnings: ['No hay una ficha Data Dragon de habilidades para esta selección.']
  };
  const abilities = abilityProfile.abilities;
  const exact = new Set(abilities.flatMap(ability => ability.exactSignals || []));
  const inferred = [...new Map(abilities.flatMap(ability => (ability.inferredSignals || []).map(signal => ({ ...signal, abilityKey: ability.key, abilityName: ability.name }))).map(signal => [`${signal.abilityKey}:${signal.id}`, signal])).values()];
  const scalingRows = abilities.flatMap(ability => (ability.scalings || []).map(scaling => [
    `${ability.key}:${scaling.stat}:${scaling.source || ''}`,
    { ...scaling, abilityKey: ability.key, abilityName: ability.name, sourcePatch: abilityProfile.version, verificationStatus: 'official-explicit-coefficient' }
  ]));
  const scalings = [...new Map(scalingRows).values()];
  const abilityFacts = abilities.map(ability => {
    const text = `${ability.description || ''} ${ability.tooltip || ''}`;
    const signals = Object.entries(PATTERNS).filter(([, pattern]) => pattern.test(text)).map(([id]) => ({ id, verified: false, confidence: 'text-indicator-only' }));
    const types = (ability.exactSignals || []).filter(id => ['physical-damage', 'magic-damage', 'true-damage', 'healing', 'shielding'].includes(id));
    return {
      abilityKey: ability.key, abilityName: ability.name,
      damageTypes: types.filter(id => id.endsWith('-damage')),
      effects: types.filter(id => ['healing', 'shielding'].includes(id)),
      scalings: ability.scalings || [],
      effectValues: ability.effectValues || [], formulaTokens: ability.formulaTokens || [],
      cooldown: ability.cooldown || [], cost: ability.cost || [], resource: ability.resource || abilityProfile.resource || '',
      documentedSignals: (ability.exactMechanicEvidence || []).map(row => ({ ...row, source: 'Riot Data Dragon', sourcePatch: abilityProfile.version })),
      inferredSignals: signals,
      onHit: { status: 'not-established', verified: false, reason: 'A mention of basic attacks or on-hit in prose is not sufficient to establish an item-effect interaction.' },
      attackInteractionIndicators: signals.filter(signal => ['attacks', 'attackSpeed', 'criticalStrike', 'onHitMention'].includes(signal.id)),
      source: abilityProfile.provenance?.source || 'Riot Data Dragon', sourcePatch: abilityProfile.version || '',
      sourceDate: abilityProfile.provenance?.sourceDate || '', verificationStatus: 'official-ability-description'
    };
  });
  const mechanics = [...exact].map(id => ({ id: MECHANIC_MAP[id] || id, evidenceType: 'explicit-datadragon-markup', confidence: 'source-explicit-tag', verified: true, source: 'Riot Data Dragon', sourcePatch: abilityProfile.version }));
  const roleSignals = [...new Set(inferred.map(row => row.id))];
  const classifications = Object.fromEntries(['burst', 'dps', 'poke', 'persistent', 'crowdControl', 'mobility', 'attacks', 'attackSpeed', 'criticalStrike', 'onHitMention', 'periodic', 'evolution', 'transformation'].map(id => [id, {
    status: roleSignals.includes(id) ? 'inferred-from-description' : 'insufficient-evidence', verified: false,
    abilityKeys: inferred.filter(signal => signal.id === id).map(signal => signal.abilityKey)
  }]));
  classifications.castFrequency = { status: 'cooldown-data-available-not-rotation-modelled', verified: false, abilityKeys: abilityFacts.filter(fact => fact.cooldown.length).map(fact => fact.abilityKey) };
  classifications.resources = { status: abilityProfile.resource ? 'champion-resource-published' : 'insufficient-evidence', resource: abilityProfile.resource || '', verified: !!abilityProfile.resource, abilityKeys: abilityFacts.filter(fact => fact.cost.length).map(fact => fact.abilityKey) };
  classifications.damagePattern = { status: 'qualitative-pattern-inferred-only', verified: false, labels: ['burst', 'dps', 'poke', 'periodic'].filter(id => classifications[id].status !== 'insufficient-evidence') };
  const archetypes = editorialProfiles.map(profile => ({
    id: String(profile.style || profile.id || 'candidate'), label: String(profile.label_es || profile.label || profile.style || profile.id || 'Perfil'),
    status: ['reviewed', 'verified', 'pilot-reviewed'].includes(String(profile.reviewStatus || '').toLowerCase()) ? 'editorial-reviewed' : 'editorial-candidate',
    reviewStatus: String(profile.reviewStatus || ''), source: String(profile.source || ''), sourcePatch: String(profile.patch || ''), itemIds: (profile.itemIds || []).map(String)
  }));
  const reviewedMechanics = editorialProfiles.filter(profile => ['reviewed', 'verified', 'pilot-reviewed'].includes(String(profile.reviewStatus || '').toLowerCase()))
    .flatMap(profile => (profile.mechanics || []).map(record => ({ ...record, source: record.source || profile.source || 'editorial-review', sourcePatch: record.sourcePatch || profile.patch || '', verificationStatus: 'editorial-reviewed', verified: true })))
    .filter(record => record.sourcePatch && String(record.sourcePatch) === String(abilityProfile.version || ''));
  const status = abilityProfile.coverage?.abilityCount === 5 ? 'verified-static-abilities' : 'partial-static-abilities';
  return {
    championId: abilityProfile.championId, championNumericId: abilityProfile.championNumericId || null,
    championName: abilityProfile.championName, role: String(role || ''), patch: abilityProfile.version,
    locale: abilityProfile.locale, resource: abilityProfile.resource, baseStats: abilityProfile.baseStats || {}, status,
    damageTypes: ['physical-damage', 'magic-damage', 'true-damage'].filter(signal => exact.has(signal)), scalings,
    mechanics: [...mechanics, ...inferred], inferredMechanics: inferred,
    abilityFacts, classifications,
    buildArchetypes: archetypes,
    reviewedMechanics,
    supplementalEvidence: supplementalRecords.filter(record => record.championId === abilityProfile.championId),
    coverage: abilityProfile.coverage,
    provenance: [abilityProfile.provenance, ...archetypes.map(profile => ({ source: profile.source, sourcePatch: profile.sourcePatch, status: profile.status, reviewStatus: profile.reviewStatus })).filter(row => row.source)],
    warnings: [
      ...(inferred.length ? ['Las mecánicas inferidas del texto son indicios; no prueban interacciones de objetos.'] : []),
      ...(['burst', 'dps', 'poke', 'attacks', 'periodic'].some(id => classifications[id].status !== 'insufficient-evidence') ? ['Los patrones de combate derivados del texto no son una revisión completa de la mecánica del campeón.'] : []),
      ...(archetypes.some(row => row.status === 'editorial-candidate') ? ['Los arquetipos sin revisión explícita se presentan como candidatos, no como restricciones.'] : [])]
  };
}

module.exports = { createChampionMechanicsProfile };
