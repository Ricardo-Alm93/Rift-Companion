function normalizeChampionProfile(championId, raw = {}) {
  const roles = {};
  for (const [role, styles] of Object.entries(raw.roles || {})) {
    roles[role] = (Array.isArray(styles) ? styles : []).map(style => ({
      id: String(style.id || ''), label: String(style.label || style.id || ''), label_es: String(style.label_es || style.label || style.id || ''), style: String(style.style || style.id || 'standard'),
      itemIds: [...new Set((style.itemIds || style.items || []).map(String))], publishedCoreIds: [...new Set((style.publishedCoreIds || []).map(String))], purchaseOrderIds: [...new Set((style.purchaseOrderIds || []).map(String))], when: Array.isArray(style.when) ? style.when.map(String) : [], avoidWhenAllies: Array.isArray(style.avoidWhenAllies) ? style.avoidWhenAllies.map(String) : [], reasons: style.reasons && typeof style.reasons === 'object' && !Array.isArray(style.reasons) ? { es: String(style.reasons.es || ''), en: String(style.reasons.en || '') } : Array.isArray(style.reasons) ? style.reasons.map(String) : [], tradeoffs: Array.isArray(style.tradeoffs) ? style.tradeoffs.map(String) : [], patch: String(style.patch || raw.patch || ''), reviewStatus: String(style.reviewStatus || raw.reviewStatus || ''), evidence: style.evidence || raw.evidence || null,
      mode: ['ranked', 'aram', 'arena', 'mayhem'].includes(style.mode) ? style.mode : (/\b(?:ARAM|Mayhem|Arena)\b/i.test(String(style.source || raw.source || '')) ? 'aram' : 'ranked'),
      source: String(style.source || raw.source || ''), confidence: ['curated', 'rules', 'low', 'prior-engine-proposal', 'user-provided-baseline'].includes(style.confidence) ? style.confidence : 'curated',
      provenanceKind: String(style.provenanceKind || '')
    }));
  }
  return { championId: String(championId), archetypes: Array.isArray(raw.archetypes) ? raw.archetypes.map(String) : [], damageProfile: raw.damageProfile || 'unknown', roles, source: String(raw.source || ''), patch: String(raw.patch || '') };
}

function loadChampionProfiles(data = {}) {
  const entries = data.champions || {};
  return Object.fromEntries(Object.entries(entries).map(([id, profile]) => [id, normalizeChampionProfile(id, profile)]));
}

module.exports = { normalizeChampionProfile, loadChampionProfiles };
