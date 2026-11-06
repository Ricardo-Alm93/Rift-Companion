'use strict';

const catalogue = require('../../data/ranked/champion-knowledge-v3.json');
const aliases = { bot: 'ADC', adc: 'ADC', jungle: 'JUNGLE', support: 'SUPPORT', top: 'TOP', mid: 'MID' };
const statNames = { FlatMagicDamageMod: 'ap', FlatPhysicalDamageMod: 'ad', FlatHPPoolMod: 'health', FlatMPPoolMod: 'mana', FlatArmorMod: 'armor', FlatSpellBlockMod: 'mr', PercentAttackSpeedMod: 'attackSpeed', FlatCritChanceMod: 'crit', FlatMovementSpeedMod: 'movement', PercentMovementSpeedMod: 'movement' };

function knowledgeFor(championId, role) {
  const profile = catalogue.profiles.find(row => row.championId === championId);
  if (!profile || !profile.candidateRoles.includes(aliases[String(role).toLowerCase()] || String(role).toUpperCase())) return null;
  return { ...profile, provenance: { source: catalogue.meta.source, patch: catalogue.meta.patch, status: 'editorial-unverified', statisticalEvidence: false } };
}

// Reference V3's logarithmic stat affinity, kept as a soft editorial preference.
// It neither proves an ability scaling nor permits a previously rejected item.
function editorialStatFit(item, knowledge, archetype = {}) {
  if (!knowledge) return { score: 0, status: 'unknown', source: null };
  const affinity = { ...knowledge.statAffinity, ...archetype.statAffinity };
  let useful = 0, total = 0;
  for (const [raw, amount] of Object.entries(item?.stats || {})) {
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = statNames[raw] || raw;
    const contribution = Math.log2(1 + amount);
    total += contribution;
    useful += contribution * Math.max(0, Math.min(1, Number(affinity[key]) || 0));
  }
  return { score: total ? useful / total : 0, status: 'editorial-unverified', source: knowledge.provenance };
}

module.exports = { knowledgeFor, editorialStatFit };
