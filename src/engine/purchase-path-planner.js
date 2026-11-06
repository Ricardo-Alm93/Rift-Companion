'use strict';

const { resolveItemAcquisition } = require('./ranked/item-transformation');
const reviewedCatalog = require('../../data/ranked/archetype-candidates-16.22.1.json');
const localizedPurposeCatalog = require('../../data/ranked/item-purposes-16.22.1.json');

const asId = value => String(typeof value === 'object' ? value.finalItemId ?? value.itemId ?? value.id ?? '' : value ?? '');
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const names = (catalog, ids, language = 'es') => ids.map(id => {
  const localized = localizedPurposeCatalog.patch === catalog.patch ? localizedPurposeCatalog.items?.[String(id)]?.names : null;
  return language === 'en' ? (localized?.en || catalog[id]?.name || id) : (localized?.es || catalog[id]?.name || id);
});

function permutations(ids, prefix = []) {
  const output = [], fixed = [...prefix], fixedSet = new Set(fixed);
  if (fixed.length > ids.length || fixedSet.size !== fixed.length || fixed.some(id => !ids.includes(id))) return output;
  function visit(path, remaining) {
    if (!remaining.length) { output.push(path); return; }
    for (let index = 0; index < remaining.length; index++) {
      const id = remaining[index];
      visit([...path, id], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
    }
  }
  visit(fixed, ids.filter(id => !fixedSet.has(id)));
  return output;
}

function uniqueRows(rows = []) {
  const seen = new Set();
  return rows.filter(Boolean).filter(row => {
    const key = row.championId ? String(row.championId) : JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function contextSignals({ composition = null, enemies = [], allies = [], goldState = 'unknown', goldStateEvidence = null } = {}) {
  const rows = uniqueRows([...(composition?.enemies || []), ...enemies]);
  const allyRows = uniqueRows([...(composition?.allies || []), ...allies]);
  const tags = new Set(rows.flatMap(row => row.tags || []).map(String));
  const physicalBurstEnemy = rows.find(row => (row.tags || []).includes('physical-burst'));
  const physicalBurstEnemyName = String(physicalBurstEnemy?.name || physicalBurstEnemy?.championId || '');
  const verifiedTags = new Set(rows.flatMap(row => (row.verifiedTags || []).map(String)));
  const cleansePolicy = reviewedCatalog.patch === '16.22.1' ? reviewedCatalog.items?.['3222']?.cleansePolicy : null;
  const controlEffects = rows.flatMap(row => (row.controlEffects || []).filter(effect => effect?.patch === reviewedCatalog.patch && effect?.evidence === 'editorial-reviewed' && effect?.source && effect?.controlType).map(effect => ({ ...effect, enemyChampionId: row.championId || '' })));
  const excludedCleanseTypes = new Set(cleansePolicy?.excludes || []);
  const removableControls = cleansePolicy?.evidence === 'documented-in-item-description'
    ? controlEffects.filter(effect => !excludedCleanseTypes.has(String(effect.controlType).toLowerCase())) : [];
  const observedHighMR = rows.some(row => ['observed', 'user-estimate'].includes(row.resistances?.magic?.evidence) && row.resistances?.magic?.level === 'high');
  const observedLowMR = rows.some(row => ['observed', 'user-estimate'].includes(row.resistances?.magic?.evidence) && row.resistances?.magic?.level === 'low');
  const observedHighArmor = rows.some(row => ['observed', 'user-estimate'].includes(row.resistances?.physical?.evidence) && row.resistances?.physical?.level === 'high');
  const validatedGold = ['ahead', 'behind'].includes(goldState) && ['observed', 'user-confirmed', 'simulation'].includes(goldStateEvidence);
  const byTag = wanted => rows.filter(row => (row.tags || []).some(tag => wanted.includes(tag)));
  const alliedCarry = allyRows.find(row => ['adc', 'bot', 'bottom'].includes(String(row.role || '').toLowerCase()) || (row.tags || []).some(tag => ['marksman', 'carry'].includes(tag)));
  const signals = {
    physicalBurst: byTag(['physical-burst']).length > 0 || tags.has('physical-burst'),
    physicalBurstEnemyName,
    magicBurst: byTag(['magic-burst']).length > 0 || tags.has('magic-burst'),
    singleTargetDive: byTag(['single-target-dive', 'dive']).length > 0 || tags.has('single-target-dive'),
    alliedCarryKnown: !!alliedCarry,
    alliedCarryName: String(alliedCarry?.name || alliedCarry?.championId || ''),
    magicAoe: byTag(['magic-aoe', 'magic-area', 'aoe-magic']).length > 0 || tags.has('magic-aoe'),
    physicalAoe: byTag(['physical-aoe', 'physical-area', 'aoe-physical']).length > 0 || tags.has('physical-aoe'),
    trueDamage: byTag(['true-damage']).length > 0 || tags.has('true-damage'),
    healing: byTag(['healing', 'sustain']).length > 0 || tags.has('healing'),
    cc: byTag(['control', 'cc']).length > 0 || tags.has('control'),
    removableControls,
    excludedControls: controlEffects.filter(effect => excludedCleanseTypes.has(String(effect.controlType).toLowerCase())),
    highMR: observedHighMR || verifiedTags.has('high-mr'),
    lowMR: observedLowMR || verifiedTags.has('low-mr'),
    highArmor: observedHighArmor || verifiedTags.has('high-armor'),
    goldState: validatedGold ? goldState : 'unknown',
    damageEvidence: rows.flatMap(row => row.damageEvidence || []).filter(row => ['observed', 'user-estimate', 'editorial-reviewed'].includes(row.level))
  };
  return { rows, tags, signals, limits: [
    ...(!signals.highMR && !signals.lowMR ? ['opponent-magic-resistance-unknown'] : []),
    ...(!signals.highArmor ? ['opponent-armor-unknown'] : []),
    ...(!validatedGold ? ['gold-state-unknown'] : []),
    ...(rows.length ? [] : ['no-confirmed-threats'])
  ] };
}

function itemReview(id, catalog) {
  const review = reviewedCatalog.patch === catalog.patch ? reviewedCatalog.items[String(id)] : null;
  const localized = localizedPurposeCatalog.patch === catalog.patch ? localizedPurposeCatalog.items[String(id)] : null;
  const item = catalog[String(id)] || {};
  const tags = new Set((item.tags || []).map(normalize));
  const purposes = new Set(review?.purposes || []);
  return { review, localized, item, displayName: localized?.names?.es || item.name || String(id), tags, purposes, identities: new Set(review?.identities || []) };
}

function compareAhriPurchaseRoutes(itemIds = [], catalog = {}, options = {}, context = contextSignals(options)) {
  const ids = [...new Set(itemIds.map(String))];
  const boots = ids.find(id => itemReview(id, catalog).identities.has('boots'));
  const hasCore = ids.includes('3118') && ids.includes('3157') && !!boots;
  const confirmedEnemyIds = context.rows.map(row => String(row.championId || row.id || '').toLowerCase());
  if (String(options.championId || '') !== 'Ahri' || !confirmedEnemyIds.includes('zed') || !hasCore) return [];
  const offense = ids.filter(id => !['3118', '3157', boots].includes(id) && Number(catalog[id]?.stats?.FlatMagicDamageMod) > 0)
    .sort((a, b) => Number(itemReview(a, catalog).localized?.primaryFunction === 'percent-magic-penetration') - Number(itemReview(b, catalog).localized?.primaryFunction === 'percent-magic-penetration') || Number(catalog[a]?.gold || 0) - Number(catalog[b]?.gold || 0) || a.localeCompare(b))[0];
  if (!offense) return [];
  const zhonya = catalog['3157'] || {}, gold = options.economy || {};
  const economyObserved = ['observed', 'user-confirmed'].includes(gold.evidence) && Number.isFinite(Number(gold.currentGold));
  const inventoryKnown = ['observed', 'user-confirmed'].includes(gold.inventoryEvidence) && Array.isArray(gold.ownedItemIds);
  const owned = new Set((inventoryKnown ? gold.ownedItemIds : []).map(String));
  const componentIds = (zhonya.from || []).map(String);
  const ownedComponents = componentIds.filter(id => owned.has(id));
  const ownedComponent = ownedComponents.length > 0;
  const totalCost = Number(zhonya.gold) || 0;
  const remainingCost = ownedComponent ? Math.max(0, totalCost - ownedComponents.reduce((sum, id) => sum + Number(catalog[id]?.gold || 0), 0)) : totalCost;
  const canCompleteSoon = economyObserved && inventoryKnown && totalCost > 0 && Number(gold.currentGold) >= remainingCost;
  const matchup = options.matchupState || {};
  const matchupObserved = ['observed', 'user-confirmed'].includes(matchup.evidence);
  const levelKnown = Number.isFinite(Number(matchup.enemyLevel)) && Number(matchup.enemyLevel) >= 1 && Number(matchup.enemyLevel) <= 18;
  const lanePressure = ['high', 'low'].includes(String(matchup.lanePressure || '').toLowerCase()) ? String(matchup.lanePressure).toLowerCase() : '';
  const completeMatchupState = matchupObserved && levelKnown && !!lanePressure;
  const knownKitThreat = context.signals.physicalBurst || context.signals.singleTargetDive;
  const enoughEvidenceToPrefer = knownKitThreat && completeMatchupState && economyObserved && inventoryKnown;
  const preferred = enoughEvidenceToPrefer
    ? lanePressure === 'high' ? (canCompleteSoon ? 'A' : 'B') : lanePressure === 'low' ? 'C' : ''
    : '';
  const language = options.language === 'en' ? 'en' : 'es';
  const name = id => {
    const row = itemReview(id, catalog);
    return language === 'en' ? (row.localized?.names?.en || row.item.name || id) : row.displayName;
  };
  const routes = [
    { id: 'A', ids: ['3118', '3157', boots] },
    { id: 'B', ids: ['3118', boots, '3157'] },
    { id: 'C', ids: ['3118', boots, offense, '3157'] }
  ].map(route => {
    const order = [...route.ids, ...ids.filter(id => !route.ids.includes(id))];
    const title = language === 'en'
      ? `${route.id}. ${order.slice(0, 3).map(name).join(' → ')}`
      : `${route.id}. ${order.slice(0, 3).map(name).join(' → ')}`;
    const missing = [
      ...(!matchupObserved ? [language === 'en' ? 'observed lane pressure' : 'presión de línea observada'] : []),
      ...(!levelKnown ? [language === 'en' ? 'enemy level' : 'nivel enemigo'] : []),
      ...(!economyObserved ? [language === 'en' ? 'current gold' : 'oro actual'] : []),
      ...(!inventoryKnown ? [language === 'en' ? 'owned components' : 'componentes en inventario'] : [])
    ];
    const rationale = route.id === 'A'
      ? (language === 'en'
        ? `Consider Zhonya second if observed lane pressure is high, Zed's level makes his known burst/dive relevant, and gold plus owned components cover the remaining cost. This trades a second damage spike for survival; the kit alone does not show that Zed is winning lane.${missing.length ? ` Unknown: ${missing.join(', ')}.` : ''}`
        : `Considera Zhonya segundo si la presión observada es alta, el nivel de Zed vuelve relevante su burst/dive conocido y el oro más tus componentes cubren el coste restante. Cambia el segundo pico de daño por supervivencia; el kit por sí solo no demuestra que Zed vaya ganando la línea.${missing.length ? ` Falta conocer: ${missing.join(', ')}.` : ''}`)
      : route.id === 'B'
        ? (language === 'en'
          ? `Prefer boots before Zhonya when movement to dodge or reposition matters now, lane pressure is high, but available gold/components cannot finish stasis yet. You gain mobility sooner and delay both the defensive completion and the next damage item.${missing.length ? ` Unknown: ${missing.join(', ')}.` : ''}`
          : `Prioriza botas antes de Zhonya si ahora importa esquivar o reposicionarte, la presión de línea observada es alta, pero el oro/componentes no alcanzan para terminar estasis. Ganas movilidad antes y retrasas tanto la defensa completa como el siguiente objeto de daño.${missing.length ? ` Falta conocer: ${missing.join(', ')}.` : ''}`)
        : (language === 'en'
          ? `Consider Shadowflame second when observed lane pressure is low or another defense already covers the kill threat; it preserves offense while postponing stasis. Zed's kit is a potential threat, not proof of a winning lane. ${missing.length ? `This is not ranked above A/B without ${missing.join(', ')}.` : 'It is supported only by the observed low-pressure state, not by win-rate data.'}`
          : `Considera Llama Sombría segundo si la presión observada es baja o ya tienes otra defensa que cubre el riesgo de asesinato; mantienes daño, pero aplazas estasis. El kit de Zed supone una amenaza potencial, no demuestra que esté ganando la línea. ${missing.length ? `No se ordena sobre A/B sin conocer ${missing.join(', ')}.` : 'La condición observada no equivale a una comparación de win rate.'}`);
    const evidence = { kit: knownKitThreat ? 'known-mechanics' : 'unknown', lane: matchupObserved ? 'observed' : 'unknown', enemyLevel: levelKnown ? 'observed' : 'unknown', economy: economyObserved ? 'observed' : 'unknown', inventory: inventoryKnown ? 'observed' : 'unknown' };
    return { id: route.id, title, orderedItemIds: order, rationale, evidence, preferred: route.id === preferred, conditional: route.id !== preferred, projection: true };
  });
  return routes;
}

function itemRoleValue(row, { role, archetype, slot, profile, context }) {
  const { item, review, purposes, identities, tags } = row;
  const purposeList = [...purposes], identity = String(archetype || '').toLowerCase();
  const support = ['support', 'utility'].includes(String(role || '').toLowerCase());
  const enchanter = support && (identity.includes('enchanter') || profile?.supportSubtype === 'enchanter');
  const engage = support && (identity.includes('engage') || identity.includes('tank') || profile?.supportSubtype === 'engage');
  const mageSupport = support && (identity.includes('mage') || profile?.supportSubtype === 'mage');
  const isQuest = purposeList.includes('support-quest') || tags.has('supportquest');
  const isBoot = identities.has('boots') || tags.has('boots');
  const position = slot + 1;
  let value = 0, reasons = [];
  const add = (score, text) => { value += score; if (score >= .5 && text) reasons.push(text); };
  const isMagic = [...tags].some(tag => /spelldamage|magicpenetration|magicresistance/.test(tag)) || Number(item.stats?.FlatMagicDamageMod) > 0;
  const isArmor = Number(item.stats?.FlatArmorMod) > 0 || tags.has('armor');
  const isMR = Number(item.stats?.FlatSpellBlockMod) > 0 || tags.has('spellblock');
  const hasHealth = Number(item.stats?.FlatHPPoolMod) > 0 || tags.has('health');
  const enemyNameFor = wanted => context.rows.find(enemy => (enemy.tags || []).some(tag => wanted.includes(tag)))?.name || context.rows.find(enemy => (enemy.tags || []).some(tag => wanted.includes(tag)))?.championId || '';

  if (support) {
    if (isQuest) add(position === 1 ? 7 : -4, position === 1 ? 'La misión de soporte empieza la ruta y aporta su economía desde temprano.' : 'El objeto de misión debe empezar la ruta de soporte.');
    if (enchanter) {
      if (isBoot) add(position === 2 ? 2.5 : position === 3 ? 1.1 : 0, 'Las botas tempranas permiten reposicionarse para curar y proteger al equipo.');
      if (context.signals.singleTargetDive && (purposes.has('protect-carry') || review?.counters?.includes('single-target-dive'))) {
        const redirectedDamageRisk = review?.riskToUser?.kind === 'redirected-ally-damage';
        // An enchanter's own survival sustains repeated heals. The link is a
        // situational protection tool, not an automatic second purchase into
        // every assassin/dive profile.
        const earlyScore = redirectedDamageRisk ? (position === 2 ? 0 : position === 3 ? .8 : position === 4 ? 3 : position === 5 ? 2 : 0) : (position === 2 ? 4.2 : position === 3 ? 4.4 : position === 4 ? 2 : 0);
        add(earlyScore, redirectedDamageRisk
          ? `El dive confirmado amenaza a ${context.signals.alliedCarryKnown ? 'un carry aliado' : 'un aliado'}; ${row.displayName || 'El objeto'} puede desviar parte del daño hacia ti. Para ${profile?.supportSubtype === 'enchanter' ? 'Soraka y otros enchanters, conservar la supervivencia mantiene disponibles las curas repetidas' : 'este soporte, el vínculo también añade exposición propia'}, así que se retrasa tras movilidad y protección inmediata.`
          : context.signals.alliedCarryKnown ? `El kit de ${enemyNameFor(['single-target-dive','dive']) || 'un rival'} permite dive a un objetivo; es una amenaza potencial, no un registro de ventaja en línea. Hay un carry aliado conocido, así que se adelanta la protección vinculada.` : `El perfil mecánico indica dive a un objetivo como amenaza potencial; no confirma que el rival vaya ganando. Se adelanta la protección individual para cubrir al aliado más expuesto.`);
      }
      if (context.signals.magicAoe && purposes.has('team-shield')) add(position === 2 ? 4 : position === 3 ? 5 : position === 4 ? 2.2 : 0, `El kit de ${enemyNameFor(['magic-aoe','magic-area','aoe-magic']) || 'un rival'} incluye daño mágico en área, una amenaza potencial para varios aliados; el escudo grupal se adelanta a una mejora personal, sin asumir que ya conectó.`);
      if (context.signals.magicAoe && purposes.has('team-heal')) add(position === 2 ? 2.6 : position === 3 ? 3.8 : position === 4 ? 2.8 : position === 5 ? 1.5 : 0, `El perfil mecánico de ${enemyNameFor(['magic-aoe','magic-area','aoe-magic']) || 'un rival'} permite daño mágico en área; la cura grupal recupera vida tras una entrada si afecta a varios aliados.`);
      if (context.signals.physicalAoe && purposes.has('team-shield')) add(position === 2 ? 4 : position === 3 ? 4.5 : position === 4 ? 2 : 0, `El kit de ${enemyNameFor(['physical-aoe','physical-area','aoe-physical']) || 'un rival'} permite burst físico en área, una amenaza potencial para varios aliados; el escudo grupal puede ir antes que la mejora personal.`);
      if (purposes.has('heal-chain') || purposes.has('healing-amplification')) add(position === 2 ? 2.7 : position === 3 ? 3.3 : position === 4 ? 2 : 0, 'La mejora de curación multiplica el valor de tus habilidades de apoyo; se coloca tras la misión y la protección urgente.');
      if (purposes.has('team-heal')) add(position === 3 ? 2.2 : position === 4 ? 2.6 : position === 5 ? 1.4 : 0, 'La curación grupal gana valor cuando empiezan las peleas con varios aliados afectados.');
      if (purposes.has('ally-cleanse') && context.signals.removableControls?.length) {
        const control = context.signals.removableControls[0];
        const label = `${control.enemyChampionId} ${control.abilityKey} · ${control.abilityName} (${control.controlType}${control.condition ? `, ${control.condition}` : ''})`;
        const ally=context.signals.alliedCarryName||'aliado protegido';
        const excluded=context.signals.excludedControls?.[0];
        const excludedNote=excluded?` No elimina el ${excluded.controlType} de ${excluded.enemyChampionId} ${excluded.abilityKey} · ${excluded.abilityName}.`:'';
        add(position === 2 ? 3 : position === 3 ? 3.8 : position === 4 ? 2 : 0, `La activa puede limpiar el ${control.controlType} de ${label} según el efecto del objeto; se adelanta para poder proteger a ${ally} si recibe ese control.${excludedNote}`);
      }
      if (purposes.has('team-mobility')) add(position === 2 ? 2 : position === 3 ? 2.4 : position === 4 ? 1.6 : 0, 'La velocidad de equipo crea una ventana de entrada o retirada; se valora antes de las mejoras tardías.');
    } else if (engage) {
      if (isBoot) add(position === 2 ? 3 : position === 3 ? 1.4 : 0, 'Las botas tempranas ayudan a alcanzar el rango de iniciación y salir después del control.');
      if (context.signals.singleTargetDive && purposes.has('protect-carry')) add(position === 2 ? 3.3 : position === 3 ? 4.4 : position === 4 ? 2.4 : 0, `El kit de ${enemyNameFor(['single-target-dive','dive']) || 'un rival'} puede entrar sobre un objetivo; es amenaza potencial, no prueba de ventaja. El vínculo protege al carry pero desvía daño hacia ti, así que va después de tu primera herramienta de entrada y resistencia.`);
      if (isArmor && context.signals.physicalBurst || isMR && context.signals.magicBurst) add(position === 2 ? 4 : position === 3 ? 3.2 : position === 4 ? 1.3 : 0, `La resistencia coincide con daño explosivo potencial del kit de ${enemyNameFor([...(isArmor?['physical-burst']:[]),...(isMR?['magic-burst']:[])]) || 'un rival'}; se adelanta si la entrada ya amenaza tu iniciación, no porque el perfil pruebe que haya conectado.`);
      if (purposes.has('team-mobility') || purposes.has('team-shield')) add(position === 2 ? 2.4 : position === 3 ? 3.1 : position === 4 ? 1.5 : 0, 'La utilidad grupal ayuda a convertir la iniciación en una entrada coordinada.');
      if (hasHealth) add(position === 1 ? 2.2 : position === 3 ? 2.2 : position === 4 ? 1 : 0, 'La vida permite soportar la respuesta inicial al entrar; se intercambia contra más daño personal.');
    } else if (mageSupport) {
      if (isMagic) add(position === 1 ? 2.6 : position === 2 ? 2.2 : position === 3 ? 1.6 : 0, 'El daño mágico prolonga el valor del poke y el control de zona antes de las compras defensivas.');
      if (isBoot) add(position === 2 ? 2 : position === 3 ? 1 : 0, 'Las botas tempranas ayudan a mantener distancia y ángulos de hostigamiento.');
    }
  } else {
    if (isBoot) add(position === 2 ? 1.25 : position === 3 ? .65 : 0, context.signals.physicalBurst ? `Las botas en el slot ${position} aportan movilidad para esquivar o reposicionarse frente al burst físico potencial del kit de ${context.signals.physicalBurstEnemyName || 'un rival'}; adelántalas si esa movilidad importa más ahora que completar el siguiente pico de daño o defensa.` : context.signals.magicAoe ? `Las botas en el slot ${position} permiten cambiar de ángulo ante el daño mágico en área potencial del kit rival; adelántalas si necesitas esquivar ahora, aceptando retrasar el siguiente objeto de poder.` : `Las botas en el slot ${position} facilitan el reposicionamiento; comprarlas aquí conserva el núcleo anterior y retrasa la movilidad, que puede adelantarse si la línea exige esquivas o alcance.`);
    if (purposes.has('ultimate-damage')) add(position === 1 ? 4.4 : position === 2 ? 2 : position === 3 ? 1 : 0, 'La aceleración de definitiva y el efecto que se activa al dañar con ella encajan con una rotación cuyo pico empieza al usar la R; se prioriza para habilitar ese patrón temprano.');
    if (purposes.has('mana-engine') && profile?.resource === 'mana') add(position === 1 ? 4.5 : position === 2 ? 1.1 : 0, 'El campeón usa maná; adelantar esta reserva permite sostener sus rotaciones de habilidades.');
    if (purposes.has('stasis') && context.signals.physicalBurst) add(position === 2 ? 5 : position === 3 ? 3.1 : position === 4 ? 1 : 0, `El kit de ${context.signals.physicalBurstEnemyName || 'un rival'} permite burst físico y acceso a un objetivo: es una amenaza estimada, no evidencia de que vaya ganando la línea. En el slot ${position}, armadura y estasis priorizan sobrevivir antes que comprar más daño; adelántalo solo si ese riesgo pesa ahora.`);
    if (purposes.has('flat-magic-penetration') && context.signals.highMR === false) {
      if (context.signals.goldState === 'ahead' && context.signals.lowMR) add(position === 2 ? 5.2 : position === 3 ? 2.8 : position === 4 ? .7 : 0, 'Con ventaja de oro declarada y resistencia mágica baja observada, la penetración plana puede convertir el primer pico de poder en presión explosiva.');
      else if (context.signals.goldState === 'ahead') add(position === 3 ? 2.1 : position === 4 ? 1.3 : 0, 'La ventaja de oro está confirmada, pero la resistencia mágica rival no es conocida; se retrasa la penetración plana hasta tener más información.');
      else add(position === 3 ? 1.2 : position === 4 ? 1.6 : 0, 'La penetración plana acompaña al daño mágico, pero no se adelanta por una ventaja de oro que no está confirmada.');
    }
    if (purposes.has('percent-penetration')) add(context.signals.highMR ? (position === 4 ? 5 : position === 5 ? 3.8 : position === 6 ? 1.4 : 0) : (position === 5 ? 3 : position === 6 ? 1.7 : 0), context.signals.highMR ? 'La resistencia mágica alta está observada; adelantar penetración porcentual ayuda a conservar el daño del resto del conjunto.' : 'La penetración porcentual se reserva normalmente para que el rival tenga oportunidad de acumular resistencias; la MR concreta sigue desconocida.');
    if (purposes.has('anti-heal') && context.signals.healing) add(position === 3 ? 2.3 : position === 4 ? 3.2 : position === 5 ? 2.7 : 0, `El kit de ${enemyNameFor(['healing','sustain']) || 'un rival'} incluye curación o sustain potencial; las heridas valen cuando esa curación se usa en peleas, no solo por estar el campeón seleccionado. El slot ${position} la mantiene detrás del núcleo temprano.`);
    if (purposes.has('team-shield') && (context.signals.physicalBurst || context.signals.magicBurst)) add(position === 2 ? 2.8 : position === 3 ? 3.4 : position === 4 ? 2 : 0, `El escudo grupal puede responder al burst potencial del kit rival si alcanza a varios aliados; el slot ${position} lo adelanta solo cuando esa cobertura vale más que acelerar daño.`);
    if ((isArmor && context.signals.physicalBurst) || (isMR && context.signals.magicBurst)) add(position === 2 ? 2.8 : position === 3 ? 2.7 : position === 4 ? 1.4 : 0, `La resistencia coincide con daño explosivo potencial del kit rival; el slot ${position} cambia aceleración de daño por supervivencia si la amenaza actual lo exige, sin inferir que el rival ya conectó.`);
  }

  const sourcePurpose = purposeList[0] || (isBoot ? 'mobility' : 'stat-fit');
  if (review?.purchaseTiming?.model === 'long-term-stacking') {
    const timing = position <= 3 ? 1.8 : position === 4 ? .7 : position === 5 ? -.7 : -1.8;
    add(timing, timing > 0 ? 'Su pasiva acumula vida permanente durante el combate; adelantarla deja más tiempo de partida para obtener esas acumulaciones.' : 'La pasiva necesita tiempo de combate para acumular vida; como sexta compra deja poco margen para aprovecharla y conviene adelantarla o elegir utilidad inmediata.');
  }
  return { value, reasons, sourcePurpose, isQuest, isBoot, review };
}

function createSteps(order, catalog, options, context) {
  const { exclusiveGroups = null, sourceKind = 'editorial', language = 'es', championId = '', role = '', archetype = '', composition = null } = options;
  const en = language === 'en';
  return order.map((finalItemId, index) => {
    const finalItem = catalog[finalItemId] || {}, transformation = exclusiveGroups?.transformations?.[finalItemId];
    const acquisition = resolveItemAcquisition(finalItemId, catalog, exclusiveGroups, { patch: catalog.patch || exclusiveGroups?.patch || '', mapId: catalog.mapId || exclusiveGroups?.mapId || '11' });
    const purchaseId = acquisition.valid ? acquisition.purchaseItemId : finalItemId, purchaseItem = catalog[purchaseId] || finalItem;
    const components = [...(purchaseItem.from || [])].map(String).map(id => ({ itemId: id, name: catalog[id]?.name || id, cost: Number(catalog[id]?.gold || 0) })).sort((a,b)=>a.cost-b.cost||a.itemId.localeCompare(b.itemId));
    const itemContext = itemRoleValue(itemReview(finalItemId, catalog), { role, archetype, slot:index, profile:options.profile, context });
    const name = finalItem.name || finalItemId, position = index + 1;
    const priorIds=order.slice(0,index),priorAp=priorIds.filter(id=>Number(catalog[id]?.stats?.FlatMagicDamageMod)>0),itemPurposes=new Set(itemContext.review?.purposes||[]);
    let why = itemContext.reasons[0];
    if (!why && context.signals.trueDamage && itemContext.isArmor) why = en ? 'The enemy profile includes true damage, which armor does not reduce; its other stats may fit, but this is not a true-damage counter.' : 'El perfil enemigo incluye daño verdadero, que la armadura no reduce; sus otras estadísticas pueden encajar, pero no es una respuesta al daño verdadero.';
    if (!why && itemPurposes.has('ally-cleanse') && context.signals.excludedControls?.length) {
      const blocked = context.signals.excludedControls[0];
      why = en ? `${name}'s active excludes ${blocked.controlType}; it does not answer ${blocked.enemyChampionId}'s ${blocked.abilityKey} (${blocked.abilityName}). Keep it only for another removable control, not as a counter to this airborne effect.` : `La activa de ${name} excluye el control de tipo ${blocked.controlType}; no responde a ${blocked.abilityKey} (${blocked.abilityName}) de ${blocked.enemyChampionId}. Consérvalo solo si otro control limpiable lo justifica, no como respuesta a este levantamiento.`;
    }
    if (!why && itemContext.isQuest) why = en ? 'Start the support quest early for its mission progression and income; the final upgrade is earned, not bought directly.' : 'Empieza pronto la misión de soporte para avanzar y generar ingresos; la mejora final se obtiene al completar la misión, no se compra directamente.';
    if(itemPurposes.has('ap-amplifier')&&priorAp.length>=2)why=en?`${name}'s passive multiplies the ability power already bought in ${names(catalog,priorAp).slice(-2).join(' and ')}; placing it in slot ${position} waits until that AP base exists.`:`La pasiva de ${name} multiplica el poder de habilidad ya comprado en ${names(catalog,priorAp).slice(-2).join(' y ')}; el slot ${position} espera a que exista esa base de AP.`;
    if(itemContext.review?.purchaseTiming?.model==='long-term-stacking')why=position<=3?(en?`${name}'s passive stacks health through combat; slot ${position} buys it early enough to gain value over the remaining game, at the cost of delaying immediate team utility.`:`La pasiva de ${name} acumula vida durante el combate; el slot ${position} permite aprovecharla durante más partida, a cambio de retrasar utilidad inmediata para el equipo.`):(en?`${name}'s passive needs time in combat to stack. At slot ${position} it starts late, so consider moving it earlier only if its durability is more valuable than the immediate team utility already bought.`:`La pasiva de ${name} necesita tiempo de combate para acumular. En el slot ${position} empieza tarde; adelántalo solo si su aguante vale más que la utilidad inmediata ya comprada.`);
    if(itemContext.review?.riskToUser?.kind==='redirected-ally-damage'&&context.signals.singleTargetDive)why=en?`The confirmed dive threatens ${context.signals.alliedCarryKnown?'a known allied carry':'one ally'}, and ${name} redirects some damage to you. For an enchanter, staying alive preserves repeated healing; slot ${position} delays the link until after mobility and immediate team protection.`:`El dive confirmado amenaza ${context.signals.alliedCarryKnown?'a un carry aliado conocido':'a un aliado'}, y ${name} desvía parte del daño hacia ti. Para un encantador, seguir con vida mantiene las curas repetidas; el slot ${position} retrasa el vínculo hasta después de movilidad y protección grupal inmediata.`;
    if (!why) {
      if(itemContext.review?.purchaseTiming?.model==='long-term-stacking')why=position<=3?(en?`${name}'s health passive needs combat time to stack; slot ${position} leaves more of the game to gain value than a late purchase.`:`La pasiva de vida de ${name} necesita tiempo de combate para acumular; el slot ${position} deja más partida para aprovecharla que una compra tardía.`):(en?`${name}'s health passive needs combat time to stack; slot ${position} is a late investment, so compare it with the immediate utility this slot could provide.`:`La pasiva de vida de ${name} necesita tiempo de combate para acumular; el slot ${position} es una inversión tardía, compárala con la utilidad inmediata que podría ocupar este espacio.`);
      const purposeLabel = {
        'ap-amplifier': en?'ability-power amplifier':'amplificador de poder de habilidad',
        'percent-penetration':en?'percentage magic penetration':'penetración mágica porcentual',
        'mana-engine':en?'mana for repeated ability casts':'maná para repetir rotaciones de habilidades',
        'heal-chain':en?'chain healing or shielding':'encadenar curaciones o escudos',
        'healing-amplification':en?'healing and shielding power':'potencia de curaciones y escudos',
        'team-heal':en?'team-wide healing':'curación grupal',
        'team-shield':en?'a team-wide shield':'un escudo grupal',
        'stasis':en?'armor and an active stasis window':'armadura y una ventana activa de estasis',
        'burst':en?'magic burst':'daño mágico explosivo',
        'protect-carry':en?'protection for a bound carry':'protección para el aliado vinculado',
        'team-mobility':en?'team movement speed':'velocidad de movimiento para el equipo',
        'support-quest':en?'support quest progression':'progresión de la misión de soporte',
        'ally-cleanse':en?'cleansing a documented removable crowd-control effect':'limpiar un efecto de control que la activa sí puede retirar',
        'health-stacking':en?'health accumulated through combat':'vida máxima que se acumula durante el combate'
      }[itemContext.sourcePurpose] || (itemContext.isBoot ? (en?'movement for safer positioning':'movilidad para reposicionarte con seguridad') : (en?'its reviewed stats and role':'sus estadísticas revisadas y su función'));
      why = en ? `${name} provides ${purposeLabel}; slot ${position} keeps that function in the ${role||'selected'} ${archetype||'build'} route. No specific enemy stat is confirmed for this purchase.` : `${name} aporta ${purposeLabel}; el slot ${position} mantiene esa función en la ruta ${archetype||'del rol '+(role||'seleccionado')}. No hay una estadística enemiga concreta confirmada para adelantarlo.`;
    }
    const nextId = order[index + 1], previousId = order[index - 1];
    const previousName = previousId ? itemReview(previousId, catalog).displayName : '';
    const nextName = nextId ? itemReview(nextId, catalog).displayName : '';
    const purposeForSlot = {
      'ap-amplifier': en?'amplify the AP base already built':'amplificar el AP ya reunido',
      'percent-penetration': en?'answer magic resistance after the core':'responder a resistencia mágica tras el núcleo',
      'flat-magic-penetration': en?'increase early damage against low resistance':'subir el daño temprano contra poca resistencia',
      'mana-engine': en?'sustain repeated spell rotations':'sostener rotaciones repetidas de habilidades',
      'heal-chain': en?'strengthen chained healing or shields':'reforzar curaciones o escudos encadenados',
      'healing-amplification': en?'increase healing and shielding':'aumentar curaciones y escudos',
      'team-heal': en?'restore the team after a fight':'recuperar al equipo tras una pelea',
      'team-shield': en?'cover allies during the enemy entry':'cubrir aliados durante la entrada rival',
      'stasis': en?'trade damage for an emergency survival window':'cambiar daño por una ventana de supervivencia',
      'burst': en?'increase the next ability damage spike':'aumentar el siguiente pico de daño de habilidades',
      'protect-carry': en?'protect the linked carry':'proteger al carry vinculado',
      'team-mobility': en?'create a team engage or retreat window':'abrir una ventana de entrada o retirada grupal',
      'support-quest': en?'start the support quest and its income':'iniciar la misión de soporte y sus ingresos',
      'ally-cleanse': en?'remove a documented, removable control effect':'retirar un control que la activa puede limpiar',
      'health-stacking': en?'start accumulating health early':'empezar a acumular vida temprano',
      'anti-heal': en?'reduce healing when the enemy uses it':'reducir curación cuando el rival la use'
    }[itemContext.sourcePurpose] || (itemContext.isBoot ? (en?'gain movement for positioning':'ganar movilidad para reposicionarse') : (en?'add its reviewed role function':'aportar su función revisada'));
    const slotTiming = position === 1
      ? (en ? `Slot 1 opens the route with ${purposeForSlot}; delaying it postpones that first benefit.` : `El slot 1 abre la ruta con ${purposeForSlot}; comprarlo después retrasa ese primer beneficio.`)
      : position === 6
        ? (en ? `Slot 6 closes after ${previousName || 'the five core purchases'}; advancing it would delay those earlier power spikes.` : `El slot 6 cierra tras ${previousName || 'los cinco objetos previos'}; adelantarlo retrasaría esos picos.`)
        : (en ? `In slot ${position}, between ${previousName || 'the core'} and ${nextName || 'the last slot'}, it serves to ${purposeForSlot}; moving it changes which payoff arrives first.` : `En el slot ${position}, entre ${previousName || 'el núcleo'} y ${nextName || 'el último slot'}, sirve para ${purposeForSlot}; moverlo cambia qué beneficio llega antes.`);
    why = `${why} ${slotTiming}`;
    if (['observed','observed-sequence','observed_sequence'].includes(sourceKind)) {
      why = en ? `The source publishes this champion/role order and it is preserved here. ${why}` : `Se conserva el orden publicado para este campeón y rol. ${why}`;
    }
    const slotWhy = { title: en?'Why it fits':'Por qué encaja', text: why };
    const guidance = acquisition.valid && acquisition.transformationPath?.length
      ? (en ? `Buy ${purchaseItem.name||purchaseId}; it transforms into ${name} after its listed condition. ${why}` : `Compra ${purchaseItem.name||purchaseId}; se transforma en ${name} al cumplir la condición indicada. ${why}`)
      : why;
    return {
      order:position, stage:index<2?'early':index<4?'mid':'late', finalItemId, finalItemName:name,
      purchaseItemId:purchaseId,purchaseItemName:purchaseItem.name||purchaseId,totalCost:Number(purchaseItem.gold||finalItem.gold||0),components,
      transform:acquisition.valid&&acquisition.transformationPath?.length?{kind:transformation?.kind||exclusiveGroups?.transformations?.[acquisition.transformationPath[1]]?.kind||'verified-evolution',note:transformation?.purchaseNote||'',condition:transformation?.condition||'',path:acquisition.transformationPath.map(id=>({itemId:id,name:catalog[id]?.name||id})),purchaseItemId:acquisition.purchaseItemId}:null,
      sourceKind,guidance,whyFits:slotWhy,orderingEvidence:sourceKind==='observed'?'published-sequence':'editorial-slot-plan',role,archetype,compositionTags:composition?.tags||[], slotScore:itemContext.value
    };
  });
}

function planPurchaseOrder(itemIds = [], catalog = {}, options = {}) {
  const finalIds = [...new Set(itemIds.map(String))];
  if (!finalIds.length) return { steps:[], score:0, diagnostics:{status:'empty',permutationsEvaluated:0}, limitations:['no-items'] };
  const context = contextSignals({ composition:options.composition, enemies:options.enemies, allies:options.allies, goldState:options.goldState, goldStateEvidence:options.goldStateEvidence });
  const observedSource = ['observed','observed-sequence','observed_sequence'].includes(options.sourceKind);
  const candidateOrder = (options.orderIds || (observedSource ? finalIds : [])).map(asId).filter(id=>finalIds.includes(id));
  const sameSet = candidateOrder.length===finalIds.length && new Set(candidateOrder).size===finalIds.length;
  const publishedExact = sameSet && observedSource;
  const purchased = (options.purchasedOrder || []).map(asId);
  const prefixValid = purchased.length <= finalIds.length && new Set(purchased).size===purchased.length && purchased.every(id=>finalIds.includes(id));
  const prefix = prefixValid ? purchased : [];
  const sequences = publishedExact ? [candidateOrder] : permutations(finalIds,prefix);
  const evidenceBySlot = new Map();
  for(const row of options.slotEvidence||[]) {
    const id=asId(row); const slot=Number(row.slot||row.position||String(row.stage||'').match(/[456]/)?.[0]);
    if(!id||!Number.isInteger(slot)||slot<1||slot>6)continue;
    const confidence=clamp((Number(row.play)||0)/((Number(row.play)||0)+200),0,1);
    const rows=evidenceBySlot.get(slot)||new Map();rows.set(id,{confidence,pickRate:Number(row.pickRate||row.pick_rate)||0,play:Number(row.play)||0,source:row.source||''});evidenceBySlot.set(slot,rows);
  }
  const scoreSequence = sequence => {
    let score=0;const slotRows=[];
    for(let index=0;index<sequence.length;index++) {
      const id=sequence[index], row=itemRoleValue(itemReview(id,catalog),{role:options.role,archetype:options.archetype,slot:index,profile:options.profile,context});
      score+=row.value; slotRows.push(row);
      const review=row.review, cost=Number(catalog[id]?.gold)||0, position=index+1;
      // Early completed-item timing softly favors accessible power spikes.
      // This is not a gold-availability claim; explicit purchased prefixes remain fixed.
      if(!publishedExact&&position<=3&&!row.isBoot&&!row.isQuest) {
        const costValue=clamp((3000-cost)/1200,-.65,1.1);
        const economyWeight = context.signals.goldState === 'ahead' ? 0.45 : context.signals.goldState === 'behind' ? 1.2 : 0.8;
        score+=costValue*economyWeight;
      }
      if(!publishedExact&&review?.purposes?.includes('ap-amplifier')) {
        const priorAp=sequence.slice(0,index).filter(previous=>Number(catalog[previous]?.stats?.FlatMagicDamageMod)>0).length;
        score+=priorAp>=2?(position>=4?1.35:.35):position>=4?.15:0;
      }
      if(!publishedExact&&row.purposes?.has('healing-amplification')&&sequence.slice(0,index).some(previous=>itemReview(previous,catalog).purposes.has('support-quest')))score+=.55;
      const evidence=evidenceBySlot.get(index+1)?.get(id);
      if(evidence)score+=clamp(evidence.pickRate,0,1)*evidence.confidence*2.6;
    }
    if(candidateOrder.length>1 && !publishedExact) {
      let matched=0,observed=0;
      for(let i=0;i<candidateOrder.length-1;i++) {const next=sequence.indexOf(candidateOrder[i+1]),prev=sequence.indexOf(candidateOrder[i]);if(prev<next)matched++;observed++;}
      if(observed)score+=matched/observed*.45;
    }
    if(publishedExact)score+=20;
    // A confirmed prior purchase is immutable. Statistical source order is soft.
    return {score:score+(prefix.length?20:0),slotRows};
  };
  let winner=null;
  for(const sequence of sequences){const evaluation=scoreSequence(sequence),key=sequence.join('|');if(!winner||evaluation.score>winner.evaluation.score+1e-9||Math.abs(evaluation.score-winner.evaluation.score)<=1e-9&&key<winner.key)winner={sequence,evaluation,key};}
  const steps=createSteps(winner.sequence,catalog,options,context);
  const separateQuestBoot = options.roleQuestCompleted===true && ['bot','adc'].includes(String(options.role||'').toLowerCase()) && options.queueModeVerified===true && options.queueMode==='ranked' && options.questBootsItemId ? String(options.questBootsItemId) : '';
  const separateItems=separateQuestBoot?[{itemId:separateQuestBoot,name:catalog[separateQuestBoot]?.name||separateQuestBoot,slot:'bot-quest-boots',source:'explicit-ranked-bot-quest-state'}]:[];
  const diagnostics={status:'planned',permutationsEvaluated:sequences.length,search:'exhaustive-permutation-six-items',sourceOrder:publishedExact?'observed-exact-sequence':candidateOrder.length?'soft-prior-order':'none',prefixCount:prefix.length,slotEvidenceCount:(options.slotEvidence||[]).length,scoreMeaning:'bounded-editorial-slot-priority-not-win-rate',contextEvidence:{magicResistance:context.signals.highMR?'confirmed-high':'unknown',armor:context.signals.highArmor?'confirmed-high':'unknown',gold:context.signals.goldState,threatCount:context.rows.length}};
  const limitations=[...context.limits];
  if(!prefixValid&&purchased.length)limitations.push('purchased-order-prefix-invalid-ignored');
  const purchaseRouteComparisons = compareAhriPurchaseRoutes(finalIds, catalog, { ...options, language: options.language || 'es' }, context);
  return {steps,score:winner.evaluation.score,diagnostics,limitations, separateItems, buildItemIds:[...finalIds], orderedItemIds:[...winner.sequence], purchaseRouteComparisons};
}

function planPurchasePath(itemIds = [], catalog = {}, options = {}) {
  return planPurchaseOrder(itemIds,catalog,options).steps;
}

module.exports = { planPurchasePath, planPurchaseOrder, contextSignals, compareAhriPurchaseRoutes };
