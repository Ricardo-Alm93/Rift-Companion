'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const patch = '16.22.1';
const itemData = require(`../data/dragon/cdn/${patch}/data/en_US/item.json`);
const taxonomy = require('../data/item-taxonomy.json');
const exclusiveGroups = require(`../data/ranked/item-groups-${patch}.json`);
const { buildItemCatalog } = require('../src/engine/item-eligibility');
const { planPurchaseOrder } = require('../src/engine/purchase-path-planner');
const itemCatalog = buildItemCatalog({ itemData, taxonomy, patch, exclusiveGroups });
const championDefinitions = require(`../data/dragon/cdn/${patch}/data/en_US/champion.json`).data;
const pilotProfiles = require('./fixtures/ranked-pilot-fixtures.cjs');
const baseProfiles = require('../data/champion-build-profiles.json');
const threatProfiles = require('../data/champion-threat-profiles.json');
const { createBuildAdvisor } = require('../src/engine/build-candidate-generator');
const { createThreatProfiler } = require('../src/engine/champion-threat-profiler');
const advisor = createBuildAdvisor({
  buildProfiles: { ...baseProfiles, champions: { ...baseProfiles.champions, ...pilotProfiles.champions } },
  threatProfiles,
  matchupAdvice: require('../data/champion-matchup-item-advice.json'),
  itemAdvice: require('../data/item-advice.json'),
  itemPurposeCatalog: require(`../data/ranked/item-purposes-${patch}.json`),
  itemCatalog,
  championDefinitions,
  profileChampion: createThreatProfiler({ champions: championDefinitions, threatProfiles }),
  patch,
  exclusiveGroups
});
const rosterEnemy = (championId, slot) => ({ championId, slot, team: 'enemy', confirmed: true, visible: true });

const ahriSix = ['3118', '3089', '3157', '3020', '4645', '3135'];
const supportSix = ['3870', '3109', '3190', '3222', '3107', '3158'];
const plan = (ids, options) => planPurchaseOrder(ids, itemCatalog, { exclusiveGroups, language: 'es', ...options });

test('V4.1 planifica el mejor de los 720 órdenes en vez de dejar la primera permutación', () => {
  const result = plan(ahriSix, { championId: 'Ahri', role: 'mid', archetype: 'burst', enemies: [{ championId: 'Zed', tags: ['physical-burst', 'single-target-dive'] }] });
  assert.equal(result.diagnostics.permutationsEvaluated, 720);
  assert.equal(result.orderedItemIds[1], '3157', 'Zhonya segundo responde al burst físico de Zed');
  assert.match(result.steps[1].whyFits.text, /burst físico/i);
  assert.match(result.steps[1].whyFits.text, /estasis/i);
  assert.match(result.steps[1].whyFits.text, /amenaza estimada, no evidencia/i);
  assert.match(result.steps[1].whyFits.text, /slot 2.*priorizan sobrevivir antes que comprar más daño/i);
});

test('V4.1 adelanta Llama Sombría solo con ventaja y MR baja explícitas', () => {
  const confirmed = plan(ahriSix, { championId: 'Ahri', role: 'mid', archetype: 'burst', goldState: 'ahead', goldStateEvidence: 'user-confirmed', enemies: [{ tags: [], verifiedTags: ['low-mr'] }] });
  assert.equal(confirmed.orderedItemIds[1], '4645');
  assert.match(confirmed.steps[1].whyFits.text, /resistencia mágica baja observada/i);
  const unknownMr = plan(ahriSix, { championId: 'Ahri', role: 'mid', archetype: 'burst', goldState: 'ahead', goldStateEvidence: 'user-confirmed', enemies: [{ tags: [] }] });
  assert.notEqual(unknownMr.orderedItemIds[1], '4645', 'MR desconocida no se debe describir como baja');
  assert.match(unknownMr.steps.find(row => row.finalItemId === '4645').whyFits.text, /no es conocida/i);
});

test('V4.1 lleva penetración porcentual al cuarto puesto ante MR alta confirmada', () => {
  const result = plan(ahriSix, { championId: 'Ahri', role: 'mid', archetype: 'burst', enemies: [{ resistances: { magic: { level: 'high', evidence: 'observed' } }, tags: [] }] });
  assert.equal(result.orderedItemIds[3], '3135');
  assert.match(result.steps[3].whyFits.text, /resistencia mágica alta está observada/i);
  const ordinary = plan(ahriSix, { championId: 'Ahri', role: 'mid', archetype: 'burst' });
  assert.ok(ordinary.orderedItemIds.indexOf('3135') >= 3, 'sin prueba de MR alta no se fuerza penetración al núcleo temprano');
});

test('V4.1 Soraka cambia prioridad de protección contra dive único frente a daño de área', () => {
  const lane = plan(supportSix, { championId: 'Soraka', role: 'support', archetype: 'enchanter', profile: { supportSubtype: 'enchanter', resource: 'mana' }, enemies: [{ tags: ['single-target-dive'] }], allies: [{ championId: 'Jinx', role: 'adc' }] });
  const team = plan(supportSix, { championId: 'Soraka', role: 'support', archetype: 'enchanter', profile: { supportSubtype: 'enchanter', resource: 'mana' }, enemies: [{ tags: ['magic-aoe'] }, { tags: ['physical-aoe'] }] });
  assert.equal(lane.orderedItemIds[1], '3158', 'Soraka conserva movilidad para posicionarse antes de vincularse al carry');
  const vowStep=lane.steps.find(step=>step.finalItemId==='3109');
  assert.ok(vowStep.order>=4, 'Knight’s Vow is delayed because redirected damage can compromise Soraka’s repeated healing');
  assert.match(vowStep.whyFits.text, /desvía parte del daño hacia ti/i);
  assert.match(vowStep.whyFits.text, /curas repetidas/i);
  assert.equal(team.orderedItemIds[2], '3190', 'Locket se adelanta cuando la amenaza confirmada golpea a varios aliados');
  assert.match(team.steps[2].whyFits.text, /daño mágico en área, una amenaza potencial/i);
  assert.match(team.steps[2].whyFits.text, /slot 3/);
  assert.notDeepEqual(lane.orderedItemIds, team.orderedItemIds);
});

test('V4.1 un soporte de iniciación usa ponderaciones distintas a Soraka', () => {
  const leona = plan(['3869', '3047', '3190', '3109', '3111', '2065'], { championId: 'Leona', role: 'support', archetype: 'tank', profile: { supportSubtype: 'engage' }, enemies: [{ tags: ['physical-burst'] }] });
  const soraka = plan(supportSix, { championId: 'Soraka', role: 'support', archetype: 'enchanter', profile: { supportSubtype: 'enchanter', resource: 'mana' }, enemies: [{ tags: ['physical-burst'] }] });
  assert.equal(leona.orderedItemIds[0], '3869', 'la misión y su objeto defensivo abren la ruta de iniciación');
  assert.equal(leona.orderedItemIds[1], '3047', 'la movilidad/resistencia temprana facilita alcanzar rango de engage');
  assert.notDeepEqual(leona.orderedItemIds, soraka.orderedItemIds);
  assert.match(leona.steps[1].whyFits.text, /rango de iniciación/i);
});

test('V4.1 conserva compras confirmadas y no interpreta el orden estadístico como win rate', () => {
  const locked = plan(ahriSix, { championId: 'Ahri', role: 'mid', archetype: 'burst', purchasedOrder: ['4645'] });
  assert.equal(locked.orderedItemIds[0], '4645');
  assert.equal(locked.diagnostics.scoreMeaning, 'bounded-editorial-slot-priority-not-win-rate');
  assert.equal(locked.winRate, undefined);
});

test('V4.1 genera una secuencia V4 completa Ahri vs Zed y conserva la misma explicación para ambos consumidores', () => {
  const result = advisor({ player: { championId: 'Ahri', role: 'mid' }, laneOpponentChampionId: 'Zed', enemies: [rosterEnemy('Zed', 0)] }, 'es');
  const option = result.scenarios.lane.recommended;
  assert.equal(option.itemIds.length, 6);
  assert.equal(option.validation.valid, true);
  assert.equal(option.purchaseOrder[1].finalItemId, '3157');
  assert.match(option.purchaseOrder[1].whyFits.text, /burst físico/i);
  assert.deepEqual(option.items.map(row => row.education.whyFits.text), option.purchaseOrder.map(row => row.whyFits.text));
  assert.equal(option.winRate, undefined);
});

test('V4.1 el adaptador V4 distingue Soraka contra Zed, contra Brand/Malphite y Leona iniciadora', () => {
  const allies = [{ championId: 'Jinx', role: 'adc', confirmed: true, visible: true }];
  const single = advisor({ player: { championId: 'Soraka', role: 'support' }, allies, laneOpponentChampionId: 'Zed', enemies: [rosterEnemy('Zed', 0)] }, 'es').scenarios.team.recommended;
  const area = advisor({ player: { championId: 'Soraka', role: 'support' }, allies, enemies: [rosterEnemy('Brand', 0), rosterEnemy('Malphite', 1)] }, 'es').scenarios.team.recommended;
  const engage = advisor({ player: { championId: 'Leona', role: 'support' }, allies, enemies: [rosterEnemy('Zed', 0)] }, 'es').scenarios.team.recommended;
  assert.equal(single.purchaseOrder[1].finalItemId, '3158');
  const vow=single.purchaseOrder.find(step=>step.finalItemId==='3109');
  assert.ok(vow.order>=4);
  assert.match(vow.whyFits.text,/desvía parte del daño hacia ti/i);
  assert.equal(area.purchaseOrder[2].finalItemId, '3190');
  assert.match(area.purchaseOrder[2].whyFits.text, /daño mágico en área, una amenaza potencial/i);
  assert.match(area.purchaseOrder[2].whyFits.text, /slot 3/);
  assert.equal(engage.purchaseOrder[0].finalItemId, '3869');
  assert.match(engage.purchaseOrder[1].whyFits.text, /rango de iniciación|burst físico/i);
  assert.notDeepEqual(single.purchaseOrder.map(row => row.finalItemId), area.purchaseOrder.map(row => row.finalItemId));
  assert.notDeepEqual(engage.purchaseOrder.map(row => row.finalItemId), single.purchaseOrder.map(row => row.finalItemId));
});

test('V4.1 limita Mikael a controles limpiables y explica Brand Q frente a Malphite R', () => {
  const profileChampion=createThreatProfiler({champions:championDefinitions,threatProfiles});
  const brand=plan(supportSix,{championId:'Soraka',role:'support',archetype:'enchanter',profile:{supportSubtype:'enchanter'},enemies:[profileChampion('Brand')]});
  const malphite=plan(supportSix,{championId:'Soraka',role:'support',archetype:'enchanter',profile:{supportSubtype:'enchanter'},enemies:[profileChampion('Malphite')]});
  const mixed=plan(supportSix,{championId:'Soraka',role:'support',archetype:'enchanter',profile:{supportSubtype:'enchanter'},enemies:[profileChampion('Brand'),profileChampion('Malphite')],allies:[{championId:'Jinx',name:'Jinx',role:'adc'}]});
  const brandMikael=brand.steps.find(step=>step.finalItemId==='3222');
  const malphiteMikael=malphite.steps.find(step=>step.finalItemId==='3222');
  assert.match(brandMikael.whyFits.text,/Brand Q · Sear \(stun/i);
  assert.match(brandMikael.whyFits.text,/Ablaze/i);
  assert.match(malphiteMikael.whyFits.text,/airborne/i);
  assert.match(malphiteMikael.whyFits.text,/no responde/i);
  assert.doesNotMatch(malphiteMikael.whyFits.text,/puede limpiar el airborne/i);
  const mixedMikael=mixed.steps.find(step=>step.finalItemId==='3222');
  assert.match(mixedMikael.whyFits.text,/proteger a Jinx/i);
  assert.match(mixedMikael.whyFits.text,/No elimina el airborne de Malphite R/i);
});

test('V4.1 Heartsteel recibe valor temprano por acumulación y reconoce el coste si se compra sexto', () => {
  const ids=['3869','3084','3190','3109','3111','2065'];
  const early=plan(ids,{championId:'Leona',role:'support',archetype:'tank',profile:{supportSubtype:'engage'},enemies:[]});
  assert.ok(early.orderedItemIds.indexOf('3084')<5);
  assert.match(early.steps.find(step=>step.finalItemId==='3084').whyFits.text,/acumular/i);
  const lateOrder=['3869','3047','3190','3109','3111','3084'];
  const late=plan(lateOrder,{championId:'Leona',role:'support',archetype:'tank',profile:{supportSubtype:'engage'},sourceKind:'observed-sequence',orderIds:lateOrder});
  assert.equal(late.orderedItemIds[5],'3084','published order remains intact when its evidence is exact');
  assert.match(late.steps[5].whyFits.text,/empieza tarde/i);
});

test('V4.1 deduplica sets aunque cambie el orden y asigna etiquetas únicas a variantes',()=>{
  const result=advisor({player:{championId:'Ahri',role:'mid'},laneOpponentChampionId:'Zed',enemies:[rosterEnemy('Zed',0)]},'es');
  for(const scenario of Object.values(result.scenarios)){
    const options=scenario.variants||[];
    const keys=options.map(row=>row.itemIds.map(String).sort().join('|'));
    assert.equal(new Set(keys).size,keys.length,'purchase permutations of the same six items are not distinct builds');
    const labels=options.map(row=>row.label);
    assert.equal(new Set(labels).size,labels.length,'visible build names are unique');
    for(const row of options)assert.ok(Array.isArray(row.variantDifference?.added)&&Array.isArray(row.variantDifference?.removed));
  }
});

test('V4.1 las seis elecciones permanecen compactas y situacionales plegables en app y overlay',()=>{
  const fs=require('node:fs');const path=require('node:path');
  const styles=fs.readFileSync(path.join(__dirname,'../src/styles.css'),'utf8');
  const overlay=fs.readFileSync(path.join(__dirname,'../src/overlay-drag.css'),'utf8');
  const overlayJs=fs.readFileSync(path.join(__dirname,'../src/overlay.js'),'utf8');
  const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
  assert.match(styles,/\.engine-option \.engine-item-row\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\);gap:4px;overflow:visible/);
  assert.match(styles,/\.engine-selected-build \.engine-item-row\{display:flex;align-items:stretch;justify-content:flex-start/);
  assert.match(styles,/\.engine-selected-build \.engine-item-slot\.selected\{outline:1px solid var\(--gold2\)/);
  assert.match(styles,/\.engine-item-slot>small/);
  assert.ok(app.includes('engine-item-slot')&&app.includes('String(index+1)'),'main build row renders explicit purchase slot numbers');
  assert.match(overlay,/\.overlay-selected-build>\.overlay-items\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(overlay,/\.overlay-selected-build>\.overlay-items>\.overlay-item\.selected\{border-color:#d6b365/);
  assert.match(overlay,/\.overlay-situational-details>summary/);
  assert.match(overlayJs,/<details class="overlay-situational-details">/);
  assert.match(styles,/\.engine-more-variants/);
});


test('V4.1 compara tres órdenes de Ahri contra Zed sin atribuir superioridad sin economía confirmada', () => {
  const zed = { championId: 'Zed', tags: ['physical-burst', 'single-target-dive'] };
  const unknown = plan(ahriSix, { championId: 'Ahri', role: 'mid', enemies: [zed] });
  const routes = unknown.purchaseRouteComparisons;
  assert.equal(routes.length, 3);
  assert.deepEqual(routes.map(row => row.orderedItemIds.slice(0, 3)), [
    ['3118', '3157', '3020'],
    ['3118', '3020', '3157'],
    ['3118', '3020', '4645']
  ]);
  assert.deepEqual(routes.map(row => row.preferred), [false, false, false]);
  assert.ok(routes.every(row => row.conditional && row.projection));
  assert.ok(routes.every(row => [...row.orderedItemIds].sort().join('|') === [...ahriSix].sort().join('|')), 'route alternatives reorder the same six items; they are not new builds');
  assert.match(routes[0].rationale, /presión observada.*nivel de Zed/i);
  assert.match(routes[0].rationale, /no demuestra que Zed vaya ganando/i);
  assert.match(routes[1].rationale, /esquivar o reposicionarte.*oro\/componentes no alcanzan/i);
  assert.match(routes[2].rationale, /presión observada es baja.*mantienes daño/i);
  assert.match(routes[2].rationale, /amenaza potencial, no demuestra que esté ganando/i);
  assert.match(routes[0].title, /Malignidad → Reloj de arena de Zhonya/);
  assert.match(routes[2].title, /Llamasombría/);
  assert.doesNotMatch(routes[0].title, /Zhonya's|Sorcerer's Shoes|Shadowflame/);
});

test('V4.1 compara rutas solo con nivel y presión observados, más oro e inventario confirmados', () => {
  const zed = { championId: 'Zed', tags: ['physical-burst', 'single-target-dive'] };
  const highPressure = { evidence: 'observed', enemyLevel: 6, lanePressure: 'high' };
  const lowPressure = { evidence: 'observed', enemyLevel: 6, lanePressure: 'low' };
  const earlyZhonya = plan(ahriSix, { championId: 'Ahri', role: 'mid', enemies: [zed], matchupState: highPressure, economy: { evidence: 'observed', currentGold: 2200, inventoryEvidence: 'observed', ownedItemIds: ['1058'] } });
  assert.deepEqual(earlyZhonya.purchaseRouteComparisons.map(row => row.preferred), [true, false, false]);
  const bootsFirst = plan(ahriSix, { championId: 'Ahri', role: 'mid', enemies: [zed], matchupState: highPressure, economy: { evidence: 'observed', currentGold: 500, inventoryEvidence: 'observed', ownedItemIds: [] } });
  assert.deepEqual(bootsFirst.purchaseRouteComparisons.map(row => row.preferred), [false, true, false]);
  const offenseFirst = plan(ahriSix, { championId: 'Ahri', role: 'mid', enemies: [zed], matchupState: lowPressure, economy: { evidence: 'observed', currentGold: 2200, inventoryEvidence: 'observed', ownedItemIds: ['1058'] } });
  assert.deepEqual(offenseFirst.purchaseRouteComparisons.map(row => row.preferred), [false, false, true]);
  const unknownInventory = plan(ahriSix, { championId: 'Ahri', role: 'mid', enemies: [zed], matchupState: highPressure, economy: { evidence: 'observed', currentGold: 500 } });
  assert.ok(unknownInventory.purchaseRouteComparisons.every(row => !row.preferred), 'gold without confirmed inventory is insufficient to prioritize a route');
  const unknownLane = plan(ahriSix, { championId: 'Ahri', role: 'mid', enemies: [zed], economy: { evidence: 'observed', currentGold: 2200, inventoryEvidence: 'observed', ownedItemIds: ['1058'] } });
  assert.ok(unknownLane.purchaseRouteComparisons.every(row => !row.preferred), 'Zed kit mechanics alone do not reveal current lane danger');
  const unknownLevel = plan(ahriSix, { championId: 'Ahri', role: 'mid', enemies: [zed], matchupState: { ...highPressure, enemyLevel: null }, economy: { evidence: 'observed', currentGold: 2200, inventoryEvidence: 'observed', ownedItemIds: ['1058'] } });
  assert.ok(unknownLevel.purchaseRouteComparisons.every(row => !row.preferred), 'lane pressure without a known level does not rank a route');
});

test('V4.1 no infiere seguridad cuando el perfil enemigo carece de amenazas clasificadas', () => {
  const unknown = plan(ahriSix, { championId: 'Ahri', role: 'mid', enemies: [{ championId: 'Zed' }] });
  assert.ok(unknown.purchaseRouteComparisons.every(row => !row.preferred));
  const noEnemy = plan(ahriSix, { championId: 'Ahri', role: 'mid' });
  assert.deepEqual(noEnemy.purchaseRouteComparisons, [], 'without a selected Zed matchup there is no matchup-specific route comparison');
});

test('V4.1 cada uno de los seis slots conserva su motivo individual y los nombres de variantes siguen el idioma', () => {
  const spanish = advisor({ player: { championId: 'Ahri', role: 'mid' }, laneOpponentChampionId: 'Zed', enemies: [rosterEnemy('Zed', 0)] }, 'es').scenarios.lane.recommended;
  assert.equal(spanish.items.length, 6);
  for (const item of spanish.items) {
    const explanation = item.education?.whyFits?.text;
    assert.ok(explanation, `slot ${item.id} needs an individual explanation`);
    assert.match(explanation, /slot [1-6]|posición [1-6]/i, `slot ${item.id} explains purchase timing`);
    assert.doesNotMatch(explanation, /completa sus componentes|ajusta.*oro disponible|costes de oportunidad/i);
  }
  const zhonya = spanish.items.find(item=>String(item.id)==='3157');
  assert.match(zhonya.education.whyFits.text,/amenaza estimada, no evidencia/i);
  assert.match(zhonya.education.whyFits.text,/priorizan sobrevivir antes que comprar más daño/i);
  assert.match(zhonya.education.whyFits.text,/adelántalo solo si ese riesgo pesa ahora/i);
  assert.match(spanish.label, /Daño explosivo · Defensa contra Zed/);
  assert.doesNotMatch(spanish.label, /Zhonya's|Hourglass|Shadowflame/);
  const english = advisor({ player: { championId: 'Ahri', role: 'mid' }, laneOpponentChampionId: 'Zed', enemies: [rosterEnemy('Zed', 0)] }, 'en').scenarios.lane.recommended;
  assert.match(english.label, /Burst damage · Defense against Zed/);
  assert.doesNotMatch(english.label, /Defensa contra|Daño explosivo/);
});
