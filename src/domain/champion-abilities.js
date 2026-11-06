'use strict';

const ABILITY_KEYS = ['P', 'Q', 'W', 'E', 'R'];
const SCALING_LINKS = new Map([
  ['spelldamage', 'ap'], ['ap', 'ap'], ['attackdamage', 'ad'], ['bonusattackdamage', 'bonus-ad'],
  ['totalattackdamage', 'total-ad'], ['maxhealth', 'max-health'], ['bonushealth', 'bonus-health'],
  ['health', 'health'], ['mana', 'mana'], ['bonusmana', 'bonus-mana'], ['armor', 'armor'],
  ['bonusarmor', 'bonus-armor'], ['spellblock', 'magic-resistance'], ['bonusspellblock', 'bonus-magic-resistance'],
  ['attackspeed', 'attack-speed'], ['crit', 'critical-strike'], ['criticalstrike', 'critical-strike']
]);
const stripHtml = value => String(value || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\{\{\s*([^}]+)\s*\}\}/g, '[$1]').replace(/\s+/g, ' ').trim();
const numericValues = value => (Array.isArray(value) ? value : [value]).filter(item => item != null && Number.isFinite(Number(item))).map(Number);

function normalizeAbility(raw = {}, key, kind) {
  const vars = Array.isArray(raw.vars) ? raw.vars : [];
  const scalings = vars.flatMap(variable => {
    const link = String(variable?.link || '').replace(/[^a-z]/gi, '').toLowerCase();
    const stat = SCALING_LINKS.get(link);
    const values = numericValues(variable?.coeff);
    return stat && values.length ? [{ stat, values, source: 'Data Dragon vars', verified: true, rawLink: String(variable.link), key: String(variable.key || '') }] : [];
  });
  const html = [raw.description, raw.tooltip].filter(Boolean).join(' ');
  const formulaTokens = [...new Set([...html.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(match => match[1].trim()))];
  const tagNames = [...html.matchAll(/<([a-zA-Z][\w-]*)>/g)].map(match => match[1].toLowerCase());
  const exactSignals = new Set();
  if (tagNames.some(tag => ['physicaldamage', 'physicaldamagetotal'].includes(tag))) exactSignals.add('physical-damage');
  if (tagNames.some(tag => ['magicdamage', 'magicdamagetotal'].includes(tag))) exactSignals.add('magic-damage');
  if (tagNames.some(tag => ['truedamage', 'truedamagetotal'].includes(tag))) exactSignals.add('true-damage');
  if (tagNames.includes('healing')) exactSignals.add('healing');
  if (tagNames.includes('shield')) exactSignals.add('shielding');
  const text = stripHtml(html).toLowerCase();
  const inferredSignals = [];
  for (const [signal, pattern] of [
    ['crowd-control', /\b(stun|root|silence|knock.?up|knock.?back|suppress|immobiliz|slows?)\b/i],
    ['mobility', /\b(dash|blink|leap|teleport|moves? quickly)\b/i],
    ['attack-speed-interaction', /\b(attack speed|attacks? faster)\b/i],
    ['critical-strike-interaction', /\bcritical strike|critically strike/i],
    ['on-hit-interaction', /\bon.?hit\b/i],
    ['sustained-or-dot', /\b(per second|over \d+(?:\.\d+)? seconds?|each second|damage over time)\b/i],
    ['resource-cost', /\b(mana|energy|health|rage|heat|flow)\b/i]
  ]) if (pattern.test(text)) inferredSignals.push({ id: signal, confidence: 'heuristic-text-signal', verified: false, evidenceText: stripHtml(html).slice(0, 240) });
  const exactMechanicEvidence = [...exactSignals].map(id => ({ id, type: 'explicit-datadragon-markup', abilityKey: key, verified: true }));
  const sourcePatch = String(raw.version || '');
  return {
    key, kind, id: String(raw.id || ''), name: String(raw.name || ''),
    descriptionHtml: String(raw.description || ''), description: stripHtml(raw.description),
    tooltipHtml: String(raw.tooltip || ''), tooltip: stripHtml(raw.tooltip),
    image: raw.image?.full ? String(raw.image.full) : '',
    maxRank: Number(raw.maxrank || 0), range: numericValues(raw.range), cooldown: numericValues(raw.cooldown), cost: numericValues(raw.cost),
    effectValues: (Array.isArray(raw.effect) ? raw.effect : []).map((values, index) => ({ index, values: numericValues(values), displayValues: raw.effectBurn?.[index] == null ? [] : [String(raw.effectBurn[index])] })),
    formulaTokens,
    resource: String(raw.resource || ''), variables: vars.map(variable => ({ key: String(variable?.key || ''), link: String(variable?.link || ''), coeff: numericValues(variable?.coeff) })),
    scalings, exactSignals: [...exactSignals], exactMechanicEvidence, inferredSignals,
    sourcePatch, provenance: { source: 'Riot Data Dragon', sourcePatch, sourceDate: '', verificationStatus: raw.name || raw.description || raw.tooltip ? 'official-published-field' : 'missing-field' },
    dataStatus: raw.name || raw.description || raw.tooltip ? 'data-dragon-verified-text' : 'insufficient-data'
  };
}

function normalizeChampionAbilityProfile(response, { championId = '', version = '', locale = '', retrievedAt = '' } = {}) {
  const data = response?.data || response;
  const raw = data?.[String(championId)];
  if (!raw || String(raw.id) !== String(championId)) throw new Error('Champion detail is missing or does not match the requested ID');
  const abilities = [
    normalizeAbility(raw.passive || {}, 'P', 'passive'),
    ...['Q', 'W', 'E', 'R'].map((key, index) => normalizeAbility(raw.spells?.[index] || {}, key, 'active'))
  ];
  const sourceRetrievedAt = String(retrievedAt || response?.meta?.fetchedAt || '');
  const statAliases = { hp: 'health', mp: 'mana', spellblock: 'magicResistance', hpregen: 'healthRegen', mpregen: 'manaRegen', attackrange: 'attackRange', attackspeed: 'attackSpeed' };
  const statRows = Object.entries(raw.stats || {}).filter(([key]) => !/perlevel$/i.test(key));
  const baseStats = Object.fromEntries(statRows.flatMap(([rawKey, rawValue]) => {
    const objectShape = rawValue && typeof rawValue === 'object';
    const flat = objectShape ? Number(rawValue.flat) : Number(rawValue);
    if (!Number.isFinite(flat)) return [];
    const perLevelValue = objectShape ? rawValue.perLevel : raw.stats?.[`${rawKey}perlevel`];
    const key = statAliases[rawKey.toLowerCase()] || rawKey;
    return [[key, { flat, perLevel: Number.isFinite(Number(perLevelValue)) ? Number(perLevelValue) : null,
      source: 'Riot Data Dragon champion detail', sourcePatch: String(version || response?.version || ''), sourceDate: sourceRetrievedAt || null, verified: true }]];
  }));
  for (const ability of abilities) {
    ability.sourcePatch = String(version || response?.version || '');
    ability.provenance.sourcePatch = ability.sourcePatch;
    ability.provenance.sourceDate = sourceRetrievedAt || null;
    for (const scaling of ability.scalings) { scaling.sourcePatch = ability.sourcePatch; scaling.sourceDate = sourceRetrievedAt || null; }
  }
  const allExact = new Set(abilities.flatMap(ability => ability.exactSignals));
  const allScalings = [...new Map(abilities.flatMap(ability => ability.scalings).map(entry => [entry.stat, entry])).values()];
  return {
    schemaVersion: 1, championId: String(championId), championName: String(raw.name || championId),
    version: String(version || response?.version || raw.version || ''), locale: String(locale || ''),
    resource: String(raw.partype || ''), baseStats, riotTags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    abilities, verifiedMechanics: [...allExact], verifiedScalings: allScalings,
    inferredMechanics: [...new Map(abilities.flatMap(ability => ability.inferredSignals).map(signal => [signal.id, signal])).values()],
    editorialArchetypes: [], editorialStatus: 'not-reviewed',
    coverage: { abilityCount: abilities.filter(ability => ability.dataStatus === 'data-dragon-verified-text').length, expectedAbilityCount: 5, scalingCount: abilities.reduce((count, ability) => count + ability.scalings.length, 0), exactMechanicCount: allExact.size },
    provenance: { source: 'Riot Data Dragon champion detail', version: String(version || response?.version || raw.version || ''), sourceDate: sourceRetrievedAt || null, locale: String(locale || ''), championId: String(championId), verifiedFields: ['name', 'passive', 'Q', 'W', 'E', 'R', 'vars', 'range', 'cooldown', 'cost', 'partype', 'tags', 'base stats'] }
  };
}

module.exports = { ABILITY_KEYS, stripHtml, normalizeAbility, normalizeChampionAbilityProfile };
