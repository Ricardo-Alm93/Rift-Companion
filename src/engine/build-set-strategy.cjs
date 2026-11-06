'use strict';

const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const TAGS_BY_NEED = Object.freeze({
  'anti-heal': ['antiheal', 'grievouswounds'],
  'anti-tank-damage': ['armorpenetration', 'magicpenetration', 'damagehighhealth', 'attackspeed'],
  'survive-burst': ['health', 'armor', 'spellblock', 'magicresistance', 'shield'],
  'reduce-shields': ['antishield', 'shieldreduction'],
  'ally-utility': ['teamheal', 'allybuff', 'healshield']
});

/** Whole-set review is an explainable heuristic layer, never an outcome statistic. */
function evaluateCompleteBuildSet({ itemIds = [], itemCatalog = {}, itemSynergy = null, composition = {}, profile = {}, boughtItemIds = [], language = 'es' } = {}) {
  const en = language === 'en', ids = itemIds.map(String), items = ids.map(id => itemCatalog[id]).filter(Boolean);
  const tagRows = items.map(item => new Set((item.tags || []).map(norm)));
  const needs = (composition.needs || []).filter(row => !row?.mitigatedByAllies).map(row => typeof row === 'string' ? row : row.id).filter(Boolean);
  const coveredNeeds = needs.filter(need => {
    const required = TAGS_BY_NEED[need] || [];
    return required.some(tag => tagRows.some(tags => tags.has(tag)));
  });
  const repeated = [];
  const common = ['abilityhaste', 'mana', 'manaregen', 'health', 'armor', 'spellblock', 'attackdamage', 'spelldamage', 'attackspeed', 'criticalstrike'];
  for (const tag of common) {
    const count = tagRows.filter(tags => tags.has(tag)).length;
    if (count >= 4) repeated.push({ tag, count });
  }
  const exactDuplicates = ids.length - new Set(ids).size;
  const bought = new Set(boughtItemIds.map(String));
  const droppedBought = [...bought].filter(id => !ids.includes(id));
  const evidencePoints = Number(itemSynergy?.weightedEvidencePoints || 0);
  const evidenceCoverage = Number(itemSynergy?.evidenceCoverage || 0);
  const score = evidencePoints + coveredNeeds.length * 5 - repeated.length * 2 - exactDuplicates * 100 - droppedBought.length * 100;
  const flags = [];
  if (exactDuplicates) flags.push({ code: 'duplicate-item', severity: 'hard', count: exactDuplicates });
  if (droppedBought.length) flags.push({ code: 'drops-confirmed-purchase', severity: 'hard', itemIds: droppedBought });
  if (repeated.length) flags.push({ code: 'possible-stat-redundancy', severity: 'review', repeated });
  const reasons = [];
  if (coveredNeeds.length) reasons.push(en ? `Covers confirmed composition needs: ${coveredNeeds.join(', ')}.` : `Cubre necesidades confirmadas de composición: ${coveredNeeds.join(', ')}.`);
  if (repeated.length) reasons.push(en ? 'Several slots share a high number of the same stat tags; inspect whether the passives remain distinct.' : 'Varios espacios repiten etiquetas de estadísticas; revisa si las pasivas siguen siendo distintas.');
  if (!coveredNeeds.length && needs.length) reasons.push(en ? 'No uncovered composition need has verified item-tag coverage; keeping the baseline avoids a forced change.' : 'No hay cobertura verificada de objetos para una necesidad pendiente; conservar la base evita un cambio forzado.');
  if (!reasons.length) reasons.push(en ? 'No full-set evidence justifies a forced substitution.' : 'La evidencia del conjunto no justifica forzar una sustitución.');
  return { status: flags.some(row => row.severity === 'hard') ? 'invalid-set' : evidenceCoverage > 0 ? 'evidence-weighted-review' : 'heuristic-review-limited', score, scoreMeaning: 'heuristic-weight-not-winrate', coveredNeeds, unmetNeeds: needs.filter(need => !coveredNeeds.includes(need)), repeatedStats: repeated, opportunityCost: { status: 'qualitative-review-required', note: en ? 'A replacement gives up the displaced item’s distinct effect and may delay its power spike.' : 'Cada sustitución pierde el efecto propio del objeto desplazado y puede retrasar su pico de poder.' }, reasons, flags, evidenceCoverage, profile: profile.archetype || profile.style || '' };
}

// V4 integration: one complete-set evaluator for the existing bounded search.
// Reference scales and weights are editorial, never probabilities.
const V4_WEIGHTS = Object.freeze({ stats: 2, identity: 1.65, frequency: 1.15, context: 1.7, core: .6, cost: .23 });
function scoreArchetypeSet({ ids, catalog, reviewed, archetype, knowledge, popularity = {}, cores = [], threats = [], threatStrength = {}, weights = V4_WEIGHTS }) {
  const references = { FlatPhysicalDamageMod: 60, FlatMagicDamageMod: 100, FlatHPPoolMod: 400, FlatArmorMod: 60, FlatSpellBlockMod: 60, FlatMPPoolMod: 400, PercentAttackSpeedMod: .4, FlatCritChanceMod: .25, PercentLifeStealMod: .15, FlatMovementSpeedMod: 45, PercentMovementSpeedMod: .05 };
  const names = { FlatPhysicalDamageMod:'ad',FlatMagicDamageMod:'ap',FlatHPPoolMod:'health',FlatArmorMod:'armor',FlatSpellBlockMod:'mr',FlatMPPoolMod:'mana',PercentAttackSpeedMod:'attackSpeed',FlatCritChanceMod:'crit',PercentLifeStealMod:'lifeSteal',FlatMovementSpeedMod:'movement',PercentMovementSpeedMod:'movement' };
  const overrides = {tank:{health:1,armor:1,mr:1,ad:.15,ap:0},bruiser:{ad:1,health:.9,armor:.7,mr:.7,ap:0},assassin:{ad:1,health:.35,armor:.3,mr:.3,ap:0,crit:.05},onhit:{ad:.8,attackSpeed:1,crit:.25,ap:.15,health:.2,mr:.4},sustained:{ap:1,mana:.55,health:.55},enchanter:{ap:.5,health:.5,armor:.5,mr:.5,mana:.15},crit:{ad:1,crit:1,attackSpeed:.9,ap:0}};
  const affinity = {...knowledge.statAffinity,...overrides[archetype.identity]};
  let stats=0, identity=0, frequency=0, context=0, cost=0;
  const covered=new Set(), purposes=new Set();
  for(const id of ids){
    const item=catalog[id], review=reviewed[id];
    let total=0,useful=0;
    for(const [stat,value] of Object.entries({...item.stats,...review?.reviewedStatBlock})){
      if(!Number.isFinite(value)||value<=0)continue;
      const amount=Math.min(1.5,Math.sqrt(value/(references[stat]||({haste:20,magicPen:25,armorPen:35,lethality:16,healPower:15,manaRegen:100}[stat])||100)));
      total+=amount;useful+=amount*Math.max(0,Math.min(1,affinity[names[stat]||stat]||0));
    }
    stats+=total?useful/total:0;
    identity+=review?.identities.includes(archetype.identity)?1:review?.identities.includes('boots')?.35:0;
    frequency+=popularity[id]||0;
    for(const p of review?.purposes||[])purposes.add(p);
    for(const counter of review?.counters||[])if(threats.includes(counter))covered.add(counter);
    cost+=item.gold||0;
  }
  context=[...covered].reduce((sum,tag)=>sum+(threatStrength[tag]||1),0);
  const core=cores.reduce((best,row)=>row.itemIds.every(id=>ids.includes(id))?Math.max(best,row.support||0):best,0);
  const manaEngines=ids.filter(id=>reviewed[id]?.purposes?.includes('mana-engine')).length;
  const healthOnly=ids.filter(id=>reviewed[id]?.purposes?.includes('health-stacking')).length;
  const penalty=Math.max(0,manaEngines-1)*3+Math.max(0,healthOnly-1)*2+(['burst','sustained'].includes(archetype.identity)&&!manaEngines?2:0);
  const effectCoverage=archetype.identity==='enchanter'?['heal-chain','healing-amplification','team-heal','ally-attack-buff','ally-cleanse','team-shield'].filter(p=>purposes.has(p)).length*.35+(purposes.has('heal-chain')?.65:0):0;
  // Qualitative complementarities from reviewed item effects, not damage formulas.
  const totalAP=ids.reduce((sum,id)=>sum+(catalog[id]?.stats?.FlatMagicDamageMod||0),0);
  const passiveCohesion=(purposes.has('ap-amplifier')&&totalAP>=250?1.2:0)+(purposes.has('burn')&&purposes.has('percent-penetration')?.5:0)+(purposes.has('crit-amplifier')&&ids.reduce((sum,id)=>sum+(catalog[id]?.stats?.FlatCritChanceMod||0),0)>=.5?.5:0);
  const breakdown={stats,identity,frequency,context,core,effectCoverage,passiveCohesion,cost:Math.max(0,(cost-14000)/6000),penalty};
  const score=stats*weights.stats+identity*weights.identity+frequency*weights.frequency+context*weights.context+core*weights.core+effectCoverage+passiveCohesion-breakdown.cost*weights.cost-penalty;
  return {eligible:true,score,breakdown,coveredNeeds:[...covered],purposes:[...purposes],scoreMeaning:'editorial-relative-heuristic-not-win-rate'};
}

module.exports = { evaluateCompleteBuildSet, scoreArchetypeSet, V4_WEIGHTS };
