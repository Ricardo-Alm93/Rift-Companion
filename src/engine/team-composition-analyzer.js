function analyzeComposition({ roster, profileChampion = () => ({ tags: [], known: false }), championProfiles = {} } = {}) {
  const confirmed = (side = []) => side.filter(row => row?.championId && row.confirmed && row.visible);
  const playerChampionId = String(roster?.player?.championId || '');
  const enemies = confirmed(roster?.enemies).slice(0, 5).map(row => ({ ...profileChampion(row.championId), role: row.role || null }));
  const allies = confirmed(roster?.allies).filter(row => !playerChampionId || String(row.championId) !== playerChampionId).slice(0, 4).map(row => ({ ...profileChampion(row.championId), role: row.role || null }));
  const enemyTags = enemies.flatMap(row => row.tags || []), allyTags = allies.flatMap(row => row.tags || []);
  const count = tag => enemyTags.filter(x => x === tag).length;
  const championCount = (...wanted) => enemies.filter(row => wanted.some(tag => (row.tags || []).includes(tag))).length;
  const tags = new Set();
  const physical = championCount('physical', 'physical-heavy'), magic = championCount('magic'), mixed = championCount('mixed');
  if (physical >= 3 || count('physical-burst') >= 2 || count('physical-heavy') >= 2) tags.add('physical-heavy');
  if (magic >= 3 || count('magic-burst') >= 1) tags.add('magic-heavy');
  if (count('physical-burst')) tags.add('physical-burst');
  if (count('magic-burst')) tags.add('magic-burst');
  if (count('durable-frontline') >= 2) tags.add('durable-frontline');
  if (count('healing') || count('sustain')) tags.add('healing');
  if (count('engage') >= 2) tags.add('engage');
  if (count('control') >= 2) tags.add('control-heavy');
  if (count('range') >= 3) tags.add('range-heavy');
  if (count('mobility') >= 2 || count('dive') >= 2) tags.add('backline-access');
  if (count('sustained-damage') >= 2 || count('true-damage') >= 2) tags.add('sustained-threat');
  if (count('shielding') || count('shield')) tags.add('shielding');
  if (physical >= 3 && magic >= 2) tags.add('mixed-threat-profile');
  const allyCoverage = new Set();
  if (allyTags.some(tag => ['healing', 'shielding', 'shield'].includes(tag))) allyCoverage.add('team-sustain');
  if (allyTags.some(tag => ['anti-heal', 'grievous-wounds'].includes(tag))) allyCoverage.add('anti-heal');
  if (allyTags.some(tag => ['peel', 'disengage', 'control'].includes(tag))) allyCoverage.add('peel');
  if (allyTags.includes('durable-frontline')) allyCoverage.add('frontline');
  if (allyTags.includes('engage')) allyCoverage.add('engage');
  if (allyTags.includes('control')) allyCoverage.add('control');
  if (allyTags.includes('physical')) allyCoverage.add('physical-damage');
  if (allyTags.includes('magic')) allyCoverage.add('magic-damage');
  const knownAllies = allies.length, knownEnemies = enemies.length;
  const champion = championProfiles[roster?.player?.championId];
  if (knownAllies >= 2 && champion?.archetypes?.includes('enchanter') && allyTags.includes('engage')) tags.add('ally-engage');
  const countKnown = side => side.filter(row => row.known).length;
  const enemyCounts = {
    physical, magic, mixed,
    burst: championCount('physical-burst', 'magic-burst'),
    sustained: championCount('sustained-damage', 'true-damage'),
    durableFrontline: championCount('durable-frontline'),
    healing: championCount('healing', 'sustain'),
    shielding: championCount('shielding', 'shield'),
    crowdControl: championCount('control'),
    range: championCount('range'),
    mobility: championCount('mobility', 'dive'),
    engage: championCount('engage')
  };
  // Composition needs are based on the combined visible roster, not on one lane
  // opponent. These are educational flags; they do not force a purchase.
  const needs = [];
  const addNeed = (id, relevant, threshold, coverage, reason) => {
    if (!relevant) return;
    needs.push({ id, severity: relevant >= threshold + 1 ? 'high' : 'situational', confidence: knownEnemies === 5 ? 'full-roster' : 'partial-roster', enemyCount: relevant, mitigatedByAllies: !!coverage && allyCoverage.has(coverage), reason });
  };
  addNeed('anti-tank-damage', enemyCounts.durableFrontline, 2, '', 'Dos o más rivales resistentes pueden justificar daño sostenido o penetración; primero revisa si el campeón escala con ello.');
  addNeed('survive-burst', enemyCounts.burst, 2, 'peel', 'Varias amenazas de burst pueden justificar defensa o herramientas de supervivencia si el daño llega a tu campeón.');
  addNeed('anti-heal', enemyCounts.healing, 1, 'anti-heal', 'La curación rival puede justificar Heridas Graves cuando el equipo no aplica ya suficiente reducción.');
  addNeed('cc-protection', enemyCounts.crowdControl, 2, 'peel', 'El control de masas repetido puede justificar tenacidad, limpieza o protección; depende de la fuente y duración del control.');
  addNeed('sustained-damage', enemyCounts.durableFrontline, 2, '', 'Una frontline durable favorece daño sostenido frente a una rotación de burst que no la atraviese.');
  if (enemyCounts.shielding >= 2) addNeed('anti-shield', enemyCounts.shielding, 2, '', 'Los escudos frecuentes pueden justificar una respuesta específica si el campeón puede activarla de forma fiable.');
  const actionableNeeds = needs.filter(need => !need.mitigatedByAllies);
  const compositionAdvice = actionableNeeds.length
    ? { action: 'review-situational-options', needs: actionableNeeds.map(need => need.id), summary: 'Hay necesidades de composición confirmadas para revisar en espacios situacionales; no se cambia automáticamente el núcleo estándar.' }
    : { action: 'preserve-standard-core', needs: [], summary: needs.length ? 'Las necesidades restantes ya tienen respuestas aliadas conocidas; conserva el núcleo y revisa solo huecos de respuesta.' : 'No hay umbrales de amenaza conjunta confirmados que justifiquen cambiar el núcleo estándar.' };
  return {
    tags: [...tags].sort(), enemies, allies, enemyCounts, allyCoverage: [...allyCoverage].sort(), needs, compositionAdvice,
    knownAllies, knownEnemies,
    enemySlotsKnown: Math.min(5, confirmed(roster?.enemies).length),
    allySlotsKnown: allies.length,
    enemyProfilesKnown: countKnown(enemies),
    allyProfilesKnown: countKnown(allies),
    incomplete: knownAllies < 4 || knownEnemies < 5 || countKnown(enemies) < knownEnemies,
    dataLimits: [...(knownEnemies < 5 ? ['Hay enemigos no confirmados; no se usan para justificar amenazas.'] : []), ...(knownAllies < 4 ? ['Hay aliados no confirmados; no se atribuye al equipo una respuesta que no está identificada.'] : []), ...(enemies.some(x => !x.known) ? ['Algunos campeones enemigos están confirmados, pero carecen de perfil táctico revisado y no disparan contra-builds.'] : [])]
  };
}

module.exports = { analyzeComposition };
