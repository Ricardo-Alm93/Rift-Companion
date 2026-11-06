function explainBuild(profile, composition, threatProfiles, language = 'es') {
  const en = language === 'en', tags = new Set(composition?.tags || []), conditions = profile.when || [], reasons = [];
  const authoredReasons = Array.isArray(profile.reasons) ? profile.reasons : profile.reasons?.[en ? 'en' : 'es'] ? [profile.reasons[en ? 'en' : 'es']] : [];
  reasons.push(...authoredReasons);
  if (profile.id === 'standard' || profile.style === 'standard') reasons.push(en ? 'General option for the selected champion and role.' : 'Opción general para el campeón y rol seleccionados.');
  for (const condition of conditions) {
    if (!tags.has(condition)) continue;
    const matching = (threatProfiles || []).filter(enemy => enemy.known && enemy.tags.includes(condition));
    if (matching.length) reasons.push(en ? `Conditional defense/utility for confirmed enemies (${matching.map(row => row.championId).join(', ')}).` : `Defensa/utilidad condicional ante enemigos confirmados (${matching.map(row => row.championId).join(', ')}).`);
    else reasons.push(en ? 'Composition rule matches a confirmed threat category.' : 'La regla de composición coincide con una categoría de amenaza confirmada.');
  }
  if (!conditions.length && profile.style !== 'standard' && !authoredReasons.length) reasons.push(en ? 'Curated style option; review it against the actual match.' : 'Variante editorial; revísala según la partida real.');
  const tradeoffs = (profile.tradeoffs || []).map(String);
  if (composition?.incomplete) tradeoffs.push(en ? 'Some enemies/allies are unknown; this option does not account for them.' : 'Hay aliados o enemigos sin confirmar; esta opción no los toma en cuenta.');
  if (!composition?.knownEnemies) tradeoffs.push(en ? 'No confirmed enemy data; no threat-specific counter is claimed.' : 'No hay enemigos confirmados; no se atribuye un counter específico.');
  return { reasons, tradeoffs };
}

module.exports = { explainBuild };
