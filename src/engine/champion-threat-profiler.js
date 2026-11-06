function createThreatProfiler({ champions = {}, threatProfiles = {} } = {}) {
  const catalog = threatProfiles.champions || threatProfiles;
  return function profileChampion(championId) {
    if (!championId || !champions[championId] || !catalog[championId]) return { championId: String(championId || ''), tags: [], source: '', confidence: 'unknown', known: false };
    const row = catalog[championId];
    return {
      championId,
      tags: [...new Set((row.tags || []).map(String))],
      source: String(row.source || ''),
      sourcePatch: String(row.sourcePatch || threatProfiles.patch || ''),
      abilityKeys: [...new Set((row.abilityKeys || []).map(String))],
      damageTypes: [...new Set((row.damageTypes || []).map(String))],
      targetPatterns: [...new Set((row.targetPatterns || []).map(String))],
      controlEffects: (row.controlEffects || []).filter(effect => effect && effect.patch === (row.sourcePatch || threatProfiles.patch) && effect.evidence === 'editorial-reviewed' && effect.source).map(effect => ({
        abilityKey: String(effect.abilityKey || ''),
        abilityName: String(effect.abilityName || ''),
        controlType: String(effect.controlType || ''),
        condition: String(effect.condition || ''),
        evidence: effect.evidence,
        source: String(effect.source),
        patch: String(effect.patch)
      })),
      confidence: row.confidence === 'curated' ? 'curated' : 'low',
      known: true
    };
  };
}

module.exports = { createThreatProfiler };
