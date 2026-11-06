const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.join(__dirname, '..');
const optionalJson = file => fs.existsSync(file) ? require(file) : null;
const testUnit = process.env.RIFT_OPGG_INTEGRATION === '1' ? () => {} : test;
const testOpggIntegration = process.env.RIFT_OPGG_INTEGRATION === '1' ? test : () => {};
const patch = '16.22.1';
const itemData = require(path.join(root, 'data/dragon/cdn', patch, 'data/en_US/item.json'));
const championData = require(path.join(root, 'data/dragon/cdn', patch, 'data/en_US/champion.json')).data;
const taxonomy = require(path.join(root, 'data/item-taxonomy.json'));
const matrix = require(path.join(root, 'data/ranked', `item-groups-${patch}.json`));
const pilotProfiles = require('./fixtures/ranked-pilot-fixtures.cjs');
const pilots = pilotProfiles;
const seed = require(path.join(root, 'data/ranked', 'champion-role-seed-16.21.1.json'));
const liveAudit = optionalJson(path.join(root, 'data/ranked/opgg-live-audit-2026-11-04.json'));
const liveAuditBatch = optionalJson(path.join(root, 'data/ranked/opgg-live-audit-batch-2026-11-04.json'));
const expansionAuditBatch = optionalJson(path.join(root, 'data/ranked/opgg-live-audit-batch-2026-11-04-expansion.json'));
const baseProfiles = require(path.join(root, 'data/champion-build-profiles.json'));
const threatProfiles = require(path.join(root, 'data/champion-threat-profiles.json'));
const matchupAdvice = require(path.join(root, 'data/champion-matchup-item-advice.json'));
const itemAdvice = require(path.join(root, 'data/item-advice.json'));
const { buildItemCatalog, validateBuildItems, validateCoreItems } = require('../src/engine/item-eligibility');
const { resolveItemAcquisition } = require('../src/engine/ranked/item-transformation');
const { createBuildAdvisor } = require('../src/engine/build-candidate-generator');
const { createThreatProfiler } = require('../src/engine/champion-threat-profiler');
const { analyzeComposition } = require('../src/engine/team-composition-analyzer');
const { planPurchasePath } = require('../src/engine/purchase-path-planner');
const catalog = buildItemCatalog({ itemData, taxonomy, patch, exclusiveGroups: matrix });
const advisor = createBuildAdvisor({ buildProfiles: { ...baseProfiles, champions: { ...baseProfiles.champions, ...pilots.champions } }, threatProfiles, matchupAdvice, itemAdvice, itemCatalog: catalog, championDefinitions: championData, profileChampion: createThreatProfiler({ champions: championData, threatProfiles }), patch, exclusiveGroups: matrix });
const roles = { Ahri: 'mid', Ryze: 'mid', Cassiopeia: 'mid', Azir: 'mid', Jinx: 'adc', Kaisa: 'adc', Ornn: 'top', Soraka: 'support' };
const against = (championId, role, enemies = []) => advisor({ player: { championId, role }, allies: [], enemies: enemies.map((id, slot) => ({ slot, championId: id, team: 'enemy', role: null, status: 'confirmed', confirmed: true, visible: true })) }, 'es');

testUnit('R4: all eight pilot champion-role profiles return legal six-item builds offline', () => {
  for (const [championId, role] of Object.entries(roles)) {
    const profile = pilots.champions[championId].roles[role][0];
    const result = advisor({ player: { championId, role } }, 'es');
    const generated = result.options.find(option => option.buildType === 'generated');
    assert.ok(generated, `${championId}/${role}: no generated build option`);
    assert.equal(generated.finalSlots.length, 6, `${championId}/${role}: not six slots`);
    assert.equal(generated.validation.valid, true, `${championId}/${role}: validator rejected pilot`);
    assert.ok(profile.publishedCoreIds.length >= 3, `${championId}/${role}: missing published core evidence`);
    assert.equal(generated.winRate, undefined, `${championId}/${role}: generated set must not carry win rate`);
    for (const option of result.options) {
      assert.equal(option.validation.valid, true, `${championId}/${role}/${option.id}: invalid six slots`);
      assert.equal(option.finalSlots.length, 6);
      assert.equal(option.purchaseOrder.length, 6);
      assert.deepEqual(option.purchaseOrder.map(step => step.order), [1, 2, 3, 4, 5, 6]);
      assert.ok(option.purchaseOrder.every(step => catalog[step.purchaseItemId]?.purchasable === true), `${championId}/${role}/${option.id}: invalid purchase base`);
      assert.ok(option.items.every(item => item.education?.whyFits?.title && item.education?.whyFits?.text && !('what' in item.education) && !('sacrifice' in item.education)), `${championId}/${role}/${option.id}: missing compact per-item fit explanation`);
      assert.deepEqual([...option.purchaseOrder.map(step => step.finalItemId)].sort(), [...option.finalSlots].sort(), `${championId}/${role}/${option.id}: purchase path must cover the selected six-item set`);
    }
  }
});

testUnit('R4: generated completion keeps a synthetic published core separate and does not inherit observed win rate', () => {
  const core = pilots.champions.Ahri.roles.mid[0].publishedCoreIds;
  const result = advisor({ player: { championId: 'Ahri', role: 'mid' }, publishedData: pilotProfiles.publishedCore('Ahri', 'mid') }, 'es');
  const generated = result.options.find(option => option.buildType === 'generated');
  assert.ok(generated);
  assert.deepEqual(result.observedCore.itemIds, core);
  assert.equal(result.observedCore.games, 500);
  assert.equal(generated.winRate, undefined);
  assert.equal(generated.finalSlots.length, 6);
});

testUnit('R3: purchase order uses a real purchasable base for transformed Muramana', () => {
  const [step] = planPurchasePath(['3042'], catalog, { exclusiveGroups: matrix, language: 'es' });
  assert.equal(step.finalItemId, '3042');
  assert.equal(step.purchaseItemId, '3004');
  assert.match(step.guidance, /Manamune/);
  assert.ok(step.components.some(component => component.itemId === '3070'));
});

testUnit('R0: Poppy published core normalizes Tear into Winter’s Approach and keeps Fimbulwinter as the final slot', () => {
  const result = advisor({ player: { championId: 'Poppy', role: 'top' }, publishedData: { source: 'Synthetic adapter fixture', queryContext: { championId: 'Poppy', position: 'top' }, data: { patch: '16.22', summary: {}, core_items: [{ ids: ['3070', '6610', '3121', '3075'], play: 31, pick_rate: 0.09 }] } } }, 'es');
  assert.equal(result.observedCore.validation.valid, true);
  assert.deepEqual(result.observedCore.rawItemIds, ['3070', '6610', '3121', '3075']);
  assert.deepEqual(result.observedCore.itemIds, ['6610', '3121', '3075']);
  assert.ok(result.options.some(option => option.finalSlots.length === 6));
  const [step] = planPurchasePath(['3121'], catalog, { exclusiveGroups: matrix, language: 'es' });
  assert.equal(step.finalItemId, '3121');
  assert.equal(step.purchaseItemId, '3119');
  assert.equal(step.purchaseItemName, "Winter's Approach");
  assert.deepEqual(step.transform.path.map(row => row.itemId), ['3121', '3119']);
  assert.match(step.transform.condition, /360/);
  assert.ok(step.components.some(row => row.itemId === '3070'));
});

testUnit('R0: an evolved mana item cannot occupy another slot with any consumed recipe or transformation item', () => {
  const six = ['3121', '3070', '6610', '3075', '3047', '3065'];
  const result = validateBuildItems(six, catalog, { patch, exclusiveGroups: matrix, championId: 'Poppy', role: 'top' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('component-and-upgrade-conflict'));
  const twoTearUpgrades = validateBuildItems(['3121', '3042', '6610', '3075', '3047', '3065'], catalog, { patch, exclusiveGroups: matrix, championId: 'Poppy', role: 'top' });
  assert.ok(twoTearUpgrades.errors.includes('unique-group-conflict'));
  for (const [finalId, buyId] of [['3121', '3119'], ['3040', '3003'], ['3042', '3004']]) {
    const acquisition = resolveItemAcquisition(finalId, catalog, matrix, { patch, mapId: '11' });
    assert.equal(acquisition.valid, true, `${finalId} acquisition chain`);
    assert.equal(acquisition.purchaseItemId, buyId);
  }
  for (const retiredBoot of ['3010', '3013', '3176']) assert.equal(catalog[retiredBoot], undefined, `retired non-purchasable boot ${retiredBoot} must not become a valid chain`);
});

testUnit('R0: unverified, cyclic, patch-mismatched, and non-shop transformation chains are rejected', () => {
  const fakeCatalog = { A: { id: 'A', purchasable: false, inStore: false, maps: { 11: true } }, B: { id: 'B', purchasable: false, inStore: false, maps: { 11: true } }, C: { id: 'C', purchasable: true, inStore: true, maps: { 11: true } } };
  const baseMatrix = { status: 'verified', patch, mapId: '11', transformations: { A: { fromItemId: 'B', status: 'verified', patch }, B: { fromItemId: 'A', status: 'verified', patch } } };
  assert.equal(resolveItemAcquisition('A', fakeCatalog, baseMatrix, { patch, mapId: '11' }).reason, 'transformation-cycle');
  assert.equal(resolveItemAcquisition('A', fakeCatalog, { ...baseMatrix, transformations: { A: { fromItemId: 'C', status: 'pending', patch } } }, { patch, mapId: '11' }).valid, false);
  assert.equal(resolveItemAcquisition('A', fakeCatalog, { ...baseMatrix, transformations: { A: { fromItemId: 'C', status: 'verified', patch: '16.21.1' } } }, { patch, mapId: '11' }).reason, 'transformation-patch-mismatch');
  assert.equal(resolveItemAcquisition('A', fakeCatalog, { ...baseMatrix, transformations: { A: { fromItemId: 'missing', status: 'verified', patch } } }, { patch, mapId: '11' }).reason, 'transformation-item-missing');
});

testUnit('R5: purchase planner does not force boots into second place', () => {
  const sequence = ['3118', '3100', '3089', '3020', '4645', '3157'];
  const purchase = planPurchasePath(sequence, catalog, { exclusiveGroups: matrix, sourceKind: 'observed', role: 'mid' });
  assert.deepEqual(purchase.map(step => step.finalItemId), sequence);
  assert.equal(purchase[3].finalItemId, '3020');
  assert.ok(purchase[3].guidance.includes('publicado'));
});

testUnit('R4: irrelevant revealed enemies do not replace Ahri’s core proposal', () => {
  const general = against('Ahri', 'mid'), againstZed = against('Ahri', 'mid', ['Zed']);
  assert.deepEqual(againstZed.options[0].finalSlots, general.options[0].finalSlots);
  assert.equal(againstZed.options[0].threatChampions.length, 0);
});

testUnit('R4: anti-tank Ahri proposal activates only for a confirmed durable frontline and explains the tradeoff', () => {
  const ordinary=against('Ahri','mid',['Zed']),frontline=against('Ahri','mid',['Ornn','Rammus']);
  const sustained=frontline.scenarios.team.variants.find(option=>option.archetypeId==='sustained'&&option.itemIds.includes('6653'));
  assert.ok(sustained);assert.ok(sustained.itemIds.includes('6653'));assert.ok(sustained.itemIds.includes('3089'));assert.ok(sustained.itemIds.includes('3135'));
  assert.equal(sustained.validation.valid,true);assert.ok(sustained.tradeoffs.length);assert.deepEqual(ordinary.scenarios.standard.recommended.itemIds,frontline.scenarios.standard.recommended.itemIds);
});

testUnit('R4: healing composition activates Jinx anti-heal and states the damage tradeoff', () => {
  const ordinary=against('Jinx','adc'),healing=against('Jinx','adc',['Soraka']);
  assert.equal(ordinary.options.some(option=>option.itemIds.includes('3033')),false);
  const option=healing.scenarios.team.variants.find(option=>option.itemIds.includes('3033'));assert.ok(option);assert.ok(option.itemExplanations['3033'].fit);assert.ok(option.tradeoffs.length);assert.equal(option.winRate,undefined);
});

testUnit('R4: physical burst selects Ryze armor and magic burst selects Cassiopeia anti-engage defense', () => {
  const ryze = against('Ryze', 'mid', ['Zed']).options.find(option => option.id === 'generated-mana-survival');
  const cass = against('Cassiopeia', 'mid', ['Syndra']).options.find(option => option.id === 'generated-anti-burst-magic');
  assert.ok(ryze); assert.ok(ryze.finalSlots.includes('3110')); assert.deepEqual(ryze.threatChampions, ['Zed']);
  assert.ok(cass); assert.ok(cass.finalSlots.includes('3102')); assert.deepEqual(cass.threatChampions, ['Syndra']);
  assert.ok(ryze.reasons.some(reason => /Zed|física|amenaza/i.test(reason)));
  assert.ok(cass.reasons.some(reason => /Syndra|mágica|amenaza/i.test(reason)));
});

testUnit('R4: defensive enchanter and tank alternatives require the matching confirmed threat', () => {
  const result=against('Soraka','support',['Zed']);const soraka=result.scenarios.team.variants.find(option=>option.itemIds.includes('3190'));
  const ornn=against('Ornn','top',['Syndra']).options.find(option=>option.id==='generated-tank-magic-resistance');
  assert.ok(soraka);assert.ok(soraka.itemIds.includes('3870'));assert.ok(ornn);assert.ok(ornn.finalSlots.includes('2504'));
});

testUnit('R4: alternatives with identical six-item sets collapse instead of appearing as distinct builds', () => {
  const result = against('Soraka', 'support', ['Zed', 'Syndra']);
  const completeSets = result.options.filter(option => option.finalSlots?.length === 6).map(option => [...option.finalSlots].sort().join('|'));
  assert.equal(new Set(completeSets).size, completeSets.length);
});

testUnit('R4: seed roles expose only a compatible published core when no reviewed completion exists', () => {
  const seedOnly = createBuildAdvisor({ archetypeSeed: seed, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const core = ['6655', '3089', '3157'];
  const published = { source: 'Synthetic adapter fixture', data: { patch, summary: {}, core_items: [{ ids: core, play: 220, pick_rate: 9, win: 120 }] } };
  const partial = seedOnly({ player: { championId: 'Aatrox', role: 'top' }, publishedData: published }, 'es');
  assert.equal(partial.status, 'partial-core');
  assert.equal(partial.options[0].buildType, 'partial-core');
  assert.deepEqual(partial.options[0].finalSlots, core);
  assert.equal(partial.options[0].finalSlots.length, 3);
  assert.equal(partial.options[0].winRate, undefined);
  assert.match(partial.notice, /núcleo publicado/i);
  const withoutSource = seedOnly({ player: { championId: 'Aatrox', role: 'top' }, sourceError: true }, 'es');
  assert.equal(withoutSource.options.length, 0);
  assert.equal(withoutSource.seedProfile.archetype, 'ad_spell_fighter');
  assert.match(withoutSource.notice, /no una build verificada/i);
});

testUnit('R4: item tooltips expose one compact fit explanation and keep technical details separate', () => {
  const result=advisor({player:{championId:'Soraka',role:'support'},allies:[],enemies:[]},'es');
  const option=result.options[0];assert.ok(option);for(const id of option.itemIds){const info=option.itemExplanations[id];assert.equal(info.whyFits.title,'Por qué encaja');assert.ok(info.whyFits.text);assert.equal(info.fit,info.whyFits.text);assert.equal(info.what,undefined);assert.equal(info.sacrifice,undefined);}
});

testUnit('R5: an unprofiled seed champion gets an exact-patch observed six-item build without inheriting its rate', () => {
  const unprofiledAdvisor = createBuildAdvisor({ archetypeSeed: seed, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const ids = ['6692', '6610', '3053', '3047', '6333', '3065'];
  const result = unprofiledAdvisor({ player: { championId: 'Aatrox', role: 'top' }, publishedData: { source: 'Synthetic adapter fixture', cachedAt: '2026-11-04T12:00:00Z', data: { patch: '16.22', summary: {}, core_items: [{ ids, play: 1200, pick_rate: 22.5, win: 650 }] } } }, 'es');
  assert.equal(result.status, 'build-ready');
  assert.equal(result.seedProfile.archetype, 'ad_spell_fighter');
  assert.equal(result.options[0].buildType, 'observed');
  assert.deepEqual(result.options[0].finalSlots, ids);
  assert.deepEqual(result.options[0].purchaseOrder.map(step => step.finalItemId), ids);
  assert.equal(result.options[0].winRate, undefined);
  assert.equal(result.options[0].observedCore.games, 1200);
  assert.equal(result.diagnostics.statisticsPatch, '16.22');
});

testUnit('R5: an unprofiled champion with only a published core stays partial and keeps its source order', () => {
  const unprofiledAdvisor = createBuildAdvisor({ archetypeSeed: seed, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const ids = ['6692', '6610', '3053'];
  const result = unprofiledAdvisor({ player: { championId: 'Aatrox', role: 'top' }, publishedData: { source: 'Synthetic adapter fixture', data: { patch: '16.22', summary: {}, core_items: [{ ids, play: 600, pick_rate: 18, win: 320 }] } } }, 'es');
  assert.equal(result.status, 'partial-core');
  assert.equal(result.options[0].buildType, 'partial-core');
  assert.deepEqual(result.options[0].finalSlots, ids);
  assert.deepEqual(result.options[0].purchaseOrder.map(step => step.finalItemId), ids);
  assert.equal(result.options[0].winRate, undefined);
  assert.match(result.notice, /Solo el núcleo publicado/);
});

testOpggIntegration('R5: real OP.GG responses produce source-backed builds, retain Ahri/Jinx profiles and accept valid Stormsurge', () => {
  const unprofiledAdvisor = createBuildAdvisor({ archetypeSeed: seed, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const ids = { LUX: 'Lux', SYNDRA: 'Syndra', GAREN: 'Garen', VIEGO: 'Viego', CAITLYN: 'Caitlyn', LEONA: 'Leona', AHRI: 'Ahri', JINX: 'Jinx' };
  const rolesByPosition = { MID: 'mid', TOP: 'top', JUNGLE: 'jungle', ADC: 'adc', SUPPORT: 'support' };
  const toData = query => ({ champion: query.champion, position: query.returnedPosition, patch: query.patch, summary: { average_stats: { play: query.sample.play, pick_rate: query.sample.pickRate, kda: query.sample.kda }, positions: query.positions.map(position => ({ name: position.name, stats: { play: position.play } })) }, core_items: query.coreItems, boots: query.boots, starter_items: query.starterItems, last_items: query.lastItems, fourth_items: query.fourthItems, fifth_items: query.fifthItems, sixth_items: query.sixthItems, summoner_spells: query.summonerSpells, skill_masteries: query.skillOrders.length ? [{ builds: query.skillOrders }] : [], trends: { win: [{ version: query.patch }] } });
  const results = new Map();
  for (const query of liveAudit.queries) {
    assert.equal(query.sourceStatus, 'success', `${query.champion}: live query did not succeed`);
    const championId = ids[query.champion];
    const role = rolesByPosition[query.returnedPosition];
    const result = unprofiledAdvisor({ player: { championId, role }, publishedData: { source: liveAudit.source, sourceQueried: true, queryContext: { championId, position: role }, data: toData(query) } }, 'es');
    assert.equal(result.diagnostics.statisticsPatch, '16.22', `${championId}: source patch missing`);
    assert.equal(result.diagnostics.sourceQueried, true);
    results.set(championId, result);
    for (const plan of result.coreCompletionPlans || []) {
      assert.equal(plan.option.finalSlots.length, 6, `${championId}: completion plan is not six slots`);
      assert.equal(plan.option.validation.valid, true, `${championId}: a jointly invalid completion reached the UI payload`);
      assert.equal(plan.option.winRate, undefined, `${championId}: assembled build inherited an outcome rate`);
      assert.deepEqual(plan.option.finalSlots.slice(0, 3), result.observedCore.itemIds, `${championId}: published core was changed`);
    }
    assert.ok((result.coreCompletionPlans || []).length <= 3, `${championId}: more than two alternative complete routes`);
  }
  const luxBuild = results.get('Lux').options.find(option => option.buildType === 'generated');
  assert.ok(luxBuild, 'Lux should get an educational continuation after the GoldPer false positive is corrected');
  assert.ok(luxBuild.finalSlots.includes('4646'));
  assert.equal(luxBuild.validation.valid, true);
  assert.equal(luxBuild.winRate, undefined);
  for (const championId of ['Syndra', 'Garen', 'Viego', 'Caitlyn', 'Ahri', 'Jinx']) {
    const result = results.get(championId), build = result.options.find(option => option.buildType === 'generated');
    assert.ok(build, `${championId}: no generated option from real published source fields`);
    assert.equal(build.finalSlots.length, 6);
    assert.equal(build.validation.valid, true);
    assert.equal(build.winRate, undefined);
    assert.ok(build.reasons.some(reason => /muestras separadas|separate stage samples/i.test(reason)));
  }
  const jinxPlan = results.get('Jinx').coreCompletionPlans[0];
  assert.ok(jinxPlan.option.finalSlots.includes('3006'), 'Jinx completion must account for OP.GG-published boots when the core has none');
  assert.equal(jinxPlan.slots[0].stage, 'boots', 'published boots occupy an inventory slot in the completed build');
  assert.equal(jinxPlan.option.finalSlots.filter(id => catalog[id]?.tags?.some(tag => ['boots', 'boot', 'botas'].includes(String(tag).toLowerCase()))).length, 1, 'completed Jinx build must contain one boot item');
  const leona = results.get('Leona');
  assert.equal(leona.status, 'partial-core');
  assert.equal(leona.options[0].buildType, 'partial-core');
  assert.equal(leona.options[0].finalSlots.length, 3);
  assert.ok(leona.publishedSlotAlternatives.some(stage => stage.stage === 'fourth_items'));
  assert.equal(leona.options[0].winRate, undefined);
});

testOpggIntegration('R5: 20 real OP.GG pairs resolve through source, patch, item and full-build validation', () => {
  assert.equal(liveAuditBatch.queries.length, 20);
  const unprofiledAdvisor = createBuildAdvisor({ archetypeSeed: seed, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const roleByPosition = { TOP: 'top', JUNGLE: 'jungle', MID: 'mid', ADC: 'adc', BOT: 'adc', SUPPORT: 'support' };
  const results = new Map();
  for (const query of liveAuditBatch.queries) {
    assert.equal(query.sourceStatus, 'success', `${query.champion}/${query.requestedPosition}: source query failed (${query.error || ''})`);
    assert.equal(query.patch, '16.22', `${query.champion}: unexpected data patch`);
    const championId = Object.keys(championData).find(id => id.toUpperCase() === query.champion);
    const role = roleByPosition[query.returnedPosition] || roleByPosition[query.requestedPosition];
    assert.ok(championId && role, `${query.champion}: no static champion/role mapping`);
    const data = {
      champion: query.champion, position: query.returnedPosition, patch: query.patch, summary: { average_stats: { play: query.sample.play, pick_rate: query.sample.pickRate, kda: query.sample.kda }, positions: query.positions.map(row => ({ name: row.name, stats: { play: row.play } })) },
      core_items: query.coreItems, boots: query.boots, starter_items: query.starterItems, last_items: query.lastItems,
      fourth_items: query.fourthItems, fifth_items: query.fifthItems, sixth_items: query.sixthItems,
      combination_items: query.combinationItems, single_items: query.singleItems
    };
    const result = unprofiledAdvisor({ player: { championId, role }, publishedData: { source: liveAuditBatch.source, sourceQueried: true, queryContext: { championId, position: role }, data } }, 'es');
    assert.equal(result.diagnostics.statisticsPatch, '16.22');
    for (const option of result.options.filter(option => option.finalSlots.length === 6)) {
      assert.equal(option.validation.valid, true, `${championId}/${role}/${option.id}: six items failed validation`);
      assert.equal(option.winRate, undefined, `${championId}/${role}: assembled/observed option got an unsupported win rate`);
      assert.equal(option.purchaseOrder.length, 6);
      assert.equal(new Set(option.finalSlots).size, 6);
      assert.deepEqual([...new Set(option.purchaseOrder.map(step => String(step.finalItemId)))].sort(), [...option.finalSlots].sort());
      assert.ok(option.finalSlots.filter(id => (matrix.groups.Boots || []).map(String).includes(String(id))).length <= 1);
    }
    results.set(championId, result);
  }
  assert.equal(results.get('Lux').options.find(option => option.buildType === 'generated').finalSlots.includes('4646'), true);
  const ezreal = results.get('Ezreal');
  const ezrealBuild = ezreal.options.find(option => option.buildType === 'generated');
  assert.ok(ezrealBuild, 'Transformation normalization should allow Ezreal continuation from the valid core');
  assert.ok(ezrealBuild.finalSlots.includes('3042'));
  assert.equal(ezrealBuild.finalSlots.includes('3070'), false, 'Tear must not coexist as a final slot with Muramana');
  assert.ok(ezrealBuild.validation.valid);
});

testUnit('R5: Data Dragon Stormsurge fields and GoldPer tag do not make it a non-slot item', () => {
  const raw = itemData.data['4646'];
  assert.equal(raw.maps['11'], true);
  assert.equal(raw.gold.purchasable, true);
  assert.equal(raw.inStore, undefined, 'Data Dragon omits inStore; normalization defaults it to available');
  assert.equal(catalog['4646'].purchasable, true);
  assert.equal(catalog['4646'].inStore, true);
  assert.equal(catalog['4646'].maps['11'], true);
  assert.ok(catalog['4646'].tags.includes('goldper'));
  const luxItems = ['6655', '4646', '4645', '3089', '3157', '3020'];
  assert.equal(validateBuildItems(luxItems, catalog, { patch, exclusiveGroups: matrix, championId: 'Lux', role: 'mid' }).valid, true);
  const starterIds = new Set((matrix.groups.Starter || []).map(String));
  for (const [id, rawItem] of Object.entries(itemData.data)) {
    if (!(rawItem.tags || []).some(tag => String(tag).toLowerCase() === 'goldper') || !rawItem.maps?.['11'] || rawItem.gold?.purchasable !== true) continue;
    assert.ok(catalog[id], `${id} is included in the mode catalog based on Data Dragon availability`);
    if (starterIds.has(id)) {
      const invalid = validateBuildItems([id, '6655', '3089', '3157', '4645', '3020'], catalog, { patch, exclusiveGroups: matrix, championId: 'Lux', role: 'mid' });
      assert.ok(invalid.errors.includes('non-build-slot-item'), `${id} remains excluded by its verified Starter classification`);
    }
  }
});

testUnit('R5: Umbral Glaive Vision tag is not a slot restriction, while real consumables and trinkets remain excluded', () => {
  const raw = itemData.data['3179'];
  assert.equal(raw.name, 'Umbral Glaive');
  assert.equal(raw.maps['11'], true);
  assert.equal(raw.gold.purchasable, true);
  assert.notEqual(raw.inStore, false);
  assert.ok(raw.tags.includes('Vision'));
  assert.equal(catalog['3179'].purchasable, true);
  const khazixCore = ['3179', '6699', '3814', '3158', '3026', '3036'];
  assert.equal(validateBuildItems(khazixCore, catalog, { patch, exclusiveGroups: matrix, championId: 'Khazix', role: 'jungle' }).valid, true);
  for (const id of ['2003', '3340', '3364']) {
    const invalid = validateBuildItems([id, '6699', '3814', '3158', '3026', '3036'], catalog, { patch, exclusiveGroups: matrix, championId: 'Khazix', role: 'jungle' });
    assert.equal(invalid.valid, false, `${itemData.data[id].name} stays excluded`);
  }
});

testOpggIntegration('R5: 50-pair real OP.GG expansion retains archetype labels and audits normalizable builds', () => {
  assert.equal(expansionAuditBatch.queries.length, 50);
  assert.equal(expansionAuditBatch.batch, '50 representative champion-role pairs');
  assert.equal(new Set(expansionAuditBatch.queries.map(row => `${row.champion}/${row.returnedPosition}`)).size, 50);
  const unprofiledAdvisor = createBuildAdvisor({ archetypeSeed: seed, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const roleByPosition = { TOP: 'top', JUNGLE: 'jungle', MID: 'mid', ADC: 'adc', BOT: 'adc', SUPPORT: 'support' };
  for (const query of expansionAuditBatch.queries) {
    assert.equal(query.sourceStatus, 'success', `${query.champion}: source query failed`);
    assert.equal(query.patch, '16.22', `${query.champion}: patch not captured`);
    assert.ok(query.auditArchetype, `${query.champion}: audit sampling category missing`);
    const championId = Object.keys(championData).find(id => id.toUpperCase() === query.champion);
    const role = roleByPosition[query.returnedPosition];
    assert.ok(championId && role, `${query.champion}: champion or role normalization failed`);
    for (const row of [...query.coreItems, ...query.boots, ...query.fourthItems, ...query.fifthItems, ...query.sixthItems]) {
      assert.ok(row.ids.every(id => typeof id === 'string'), `${query.champion}: item IDs must be normalized strings`);
    }
    const data = { champion: query.champion, position: query.returnedPosition, patch: query.patch, summary: { average_stats: { play: query.sample.play }, positions: query.positions.map(row => ({ name: row.name, stats: { play: row.play } })) }, core_items: query.coreItems, boots: query.boots, fourth_items: query.fourthItems, fifth_items: query.fifthItems, sixth_items: query.sixthItems, last_items: query.lastItems, combination_items: query.combinationItems };
    const result = unprofiledAdvisor({ player: { championId, role }, publishedData: { source: expansionAuditBatch.source, sourceQueried: true, queryContext: { championId, position: role }, data } }, 'es');
    for (const option of result.options.filter(row => row.finalSlots?.length === 6)) {
      assert.equal(option.validation.valid, true, `${championId}/${role}: invalid complete build`);
      assert.equal(new Set(option.finalSlots).size, 6);
      assert.equal(option.winRate, undefined);
      assert.equal(option.purchaseOrder.length, 6);
    }
  }
});

testOpggIntegration('R5: exact-patch champion-role stage evidence can complete a build without any editorial seed', () => {
  const query = liveAuditBatch.queries.find(row => row.champion === 'AATROX');
  const sourceOnlyAdvisor = createBuildAdvisor({ archetypeSeed: { champions: {} }, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const result = sourceOnlyAdvisor({ player: { championId: 'Aatrox', role: 'top' }, publishedData: { source: liveAuditBatch.source, sourceQueried: true, queryContext: { championId: 'Aatrox', position: 'top' }, data: { champion: 'AATROX', position: 'TOP', patch: query.patch, summary: {}, core_items: query.coreItems, boots: query.boots, fourth_items: query.fourthItems, fifth_items: query.fifthItems, sixth_items: query.sixthItems } } }, 'es');
  const complete = result.options.find(option => option.buildType === 'generated');
  assert.ok(complete, 'exact champion/role/patch source evidence should be sufficient without the generic seed');
  assert.equal(complete.sourceKind, 'published_core_plus_slot_candidates');
  assert.equal(complete.style, 'published-source');
  assert.equal(complete.finalSlots.length, 6);
  assert.equal(complete.validation.valid, true);
  assert.equal(complete.winRate, undefined);
  assert.equal(result.seedProfile, null);
});

testOpggIntegration('R5: confirming a lane threat adds matchup advice without silently changing the source build', () => {
  const query = liveAuditBatch.queries.find(row => row.champion === 'JINX');
  const unprofiledAdvisor = createBuildAdvisor({ archetypeSeed: seed, threatProfiles, matchupAdvice, itemAdvice, itemCatalog: catalog, championDefinitions: championData, profileChampion: createThreatProfiler({ champions: championData, threatProfiles }), patch, exclusiveGroups: matrix });
  const payload = enemies => ({ player: { championId: 'Jinx', role: 'adc' }, enemies, publishedData: { source: liveAuditBatch.source, sourceQueried: true, queryContext: { championId: 'Jinx', position: 'adc' }, data: { champion: 'JINX', position: 'ADC', patch: query.patch, summary: {}, core_items: query.coreItems, boots: query.boots, fourth_items: query.fourthItems, fifth_items: query.fifthItems, sixth_items: query.sixthItems, last_items: query.lastItems } } });
  const base = unprofiledAdvisor(payload([]), 'es');
  const vsYi = unprofiledAdvisor(payload([{ championId: 'MasterYi', status: 'confirmed', confirmed: true, visible: true, team: 'enemy' }]), 'es');
  const baseBuild = base.options.find(option => option.buildType === 'generated');
  const enemyBuild = vsYi.options.find(option => option.buildType === 'generated');
  assert.deepEqual(enemyBuild.finalSlots, baseBuild.finalSlots, 'one enemy does not rewrite an evidence-backed core without a justified alternative');
  assert.ok(vsYi.matchupItems.some(item => item.enemyChampionId === 'MasterYi' && item.reason));
  assert.ok(Array.isArray(vsYi.matchupItems), 'matchup-specific advice remains a separate section from the selected build');
});

testUnit('R5: invalid top source combination does not hide an independent valid combination', () => {
  const rows = [
    { ids: ['6655', '4646', '4645', 'not-a-real-item', '3157', '3020'], play: 900, pick_rate: 60 },
    { ids: ['6655', '4646', '4645', '3089', '3157', '3020'], play: 450, pick_rate: 30 }
  ];
  const result = advisor({ player: { championId: 'Lux', role: 'mid' }, publishedData: { source: 'Synthetic adapter fixture', queryContext: { championId: 'Lux', position: 'mid' }, data: { champion: 'LUX', position: 'MID', patch: '16.22', summary: {}, core_items: rows } } }, 'es');
  assert.equal(result.options[0].buildType, 'observed');
  assert.deepEqual(result.options[0].finalSlots, rows[1].ids);
  assert.ok(result.options[0].validation.valid);
  assert.ok(result.rejectedCandidates.some(candidate => candidate.id === 'published-core-1' && candidate.codes.includes('item-not-available-in-mode')));
});

testUnit('R5: all valid partial source cores remain available after the top-ranked core is rejected', () => {
  const rows = [
    { ids: ['6655', 'not-a-real-item', '4645'], play: 900, pick_rate: 60 },
    { ids: ['6655', '3089', '3157'], play: 450, pick_rate: 30 },
    { ids: ['6655', '4646', '3157'], play: 300, pick_rate: 20 }
  ];
  const result = advisor({ player: { championId: 'Lux', role: 'mid' }, publishedData: { source: 'Synthetic adapter fixture', queryContext: { championId: 'Lux', position: 'mid' }, data: { champion: 'LUX', position: 'MID', patch: '16.22', summary: {}, core_items: rows } } }, 'es');
  const partials = result.options.filter(option => option.buildType === 'partial-core');
  assert.equal(partials.length, 2);
  assert.deepEqual(partials.map(option => option.finalSlots), [rows[1].ids, rows[2].ids]);
  assert.ok(result.rejectedCandidates.some(candidate => candidate.id === 'published-core-1'));
});

testUnit('R5: a successful OP.GG response without build rows is distinct from a source that was not queried', () => {
  const unprofiledAdvisor = createBuildAdvisor({ archetypeSeed: seed, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const queriedEmpty = unprofiledAdvisor({ player: { championId: 'Caitlyn', role: 'adc' }, publishedData: { source: 'Synthetic adapter fixture', sourceQueried: true, data: { champion: 'CAITLYN', position: 'ADC', patch: '16.22', summary: { average_stats: { play: 100 } }, core_items: [] } } }, 'es');
  const notQueried = unprofiledAdvisor({ player: { championId: 'Caitlyn', role: 'adc' } }, 'es');
  assert.equal(queriedEmpty.diagnostics.sourceState, 'queried-no-builds');
  assert.equal(queriedEmpty.diagnostics.sourceQueried, true);
  assert.equal(notQueried.diagnostics.sourceState, 'not-queried');
  assert.equal(notQueried.diagnostics.sourceQueried, false);
});

testUnit('R5: source champion and role mismatches are rejected and diagnosed instead of reused', () => {
  const unprofiledAdvisor = createBuildAdvisor({ archetypeSeed: seed, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const base = { patch: '16.22', summary: {}, core_items: [{ ids: ['6655', '4645', '3089'], play: 500, pick_rate: 12 }] };
  const wrongChampion = unprofiledAdvisor({ player: { championId: 'Caitlyn', role: 'adc' }, publishedData: { source: 'Synthetic adapter fixture', queryContext: { championId: 'Jinx', position: 'adc' }, data: { ...base, champion: 'JINX', position: 'ADC' } } }, 'es');
  const wrongRole = unprofiledAdvisor({ player: { championId: 'Caitlyn', role: 'adc' }, publishedData: { source: 'Synthetic adapter fixture', queryContext: { championId: 'Caitlyn', position: 'mid' }, data: { ...base, champion: 'CAITLYN', position: 'MID' } } }, 'es');
  assert.equal(wrongChampion.status, 'incompatible-data');
  assert.ok(wrongChampion.observedCore.validation.errors.includes('source-champion-mismatch'));
  assert.equal(wrongRole.status, 'incompatible-data');
  assert.ok(wrongRole.observedCore.validation.errors.includes('source-role-mismatch'));
  assert.equal(wrongChampion.options.length, 0);
  assert.equal(wrongRole.options.length, 0);
});

testUnit('R5: published data from an older patch is rejected instead of completing an unprofiled champion build', () => {
  const unprofiledAdvisor = createBuildAdvisor({ archetypeSeed: seed, itemCatalog: catalog, championDefinitions: championData, patch, exclusiveGroups: matrix });
  const ids = ['6692', '6610', '3053', '3047', '6333', '3065'];
  const result = unprofiledAdvisor({ player: { championId: 'Aatrox', role: 'top' }, publishedData: { source: 'Synthetic adapter fixture', data: { patch: '16.21', summary: {}, core_items: [{ ids, play: 1200, pick_rate: 22.5, win: 650 }] } } }, 'es');
  assert.equal(result.options.length, 0);
  assert.equal(result.status, 'incompatible-data');
  assert.equal(result.observedCore.state, 'incompatible-data');
  assert.ok(result.observedCore.validation.errors.includes('statistics-patch-mismatch'));
  assert.equal(result.provenance.winRatesShown, false);
});

testUnit('R5: full confirmed enemy composition contributes multiple threat dimensions and allied coverage', () => {
  const roster = {
    player: { championId: 'Jinx' },
    allies: ['Soraka', 'Ornn', 'Ahri', 'Lux', 'Jinx'].map((championId, slot) => ({ championId, slot, confirmed: true, visible: true })),
    enemies: ['Zed', 'Talon', 'Soraka', 'Ornn', 'Syndra'].map((championId, slot) => ({ championId, slot, confirmed: true, visible: true }))
  };
  const composition = analyzeComposition({ roster, profileChampion: createThreatProfiler({ champions: championData, threatProfiles }), championProfiles: pilots.champions });
  assert.equal(composition.knownEnemies, 5);
  assert.equal(composition.enemyProfilesKnown, 5);
  assert.equal(composition.enemyCounts.burst, 3);
  assert.equal(composition.enemyCounts.durableFrontline, 1);
  assert.equal(composition.enemyCounts.healing, 1);
  assert.ok(composition.tags.includes('physical-burst'));
  assert.ok(composition.tags.includes('magic-burst'));
  assert.ok(composition.allyCoverage.includes('team-sustain'));
});

testUnit('R0: composition needs aggregate five enemies and four allies without forcing purchase changes', () => {
  const roster = {
    player: { championId: 'Jinx' },
    allies: ['Jinx', 'Ornn', 'Ahri', 'Lux', 'Soraka'].map((championId, slot) => ({ championId, slot, confirmed: true, visible: true })),
    enemies: ['Zed', 'Talon', 'Soraka', 'Ornn', 'Rammus'].map((championId, slot) => ({ championId, slot, confirmed: true, visible: true }))
  };
  const composition = analyzeComposition({ roster, profileChampion: createThreatProfiler({ champions: championData, threatProfiles }), championProfiles: pilots.champions });
  assert.equal(composition.knownEnemies, 5);
  assert.equal(composition.knownAllies, 4);
  assert.ok(composition.needs.some(need => need.id === 'anti-tank-damage' && need.enemyCount === 2));
  assert.ok(composition.needs.some(need => need.id === 'survive-burst' && need.enemyCount >= 2));
  assert.ok(composition.needs.some(need => need.id === 'anti-heal' && need.enemyCount === 1));
  assert.ok(composition.needs.some(need => need.id === 'cc-protection'));
  assert.equal(composition.needs.find(need => need.id === 'anti-tank-damage').confidence, 'full-roster');
  const partial = analyzeComposition({ roster: { ...roster, enemies: roster.enemies.slice(0, 2) }, profileChampion: createThreatProfiler({ champions: championData, threatProfiles }), championProfiles: pilots.champions });
  assert.ok(partial.needs.every(need => need.confidence === 'partial-roster'));
});

testUnit('R5: explicit ally coverage can suppress a redundant situational profile', () => {
  const copied = structuredClone({ ...baseProfiles, champions: { ...baseProfiles.champions, ...pilots.champions } });
  const antiHealProfile = copied.champions.Jinx.roles.adc.find(profile => profile.id === 'anti-heal-crit');
  assert.ok(antiHealProfile);
  antiHealProfile.avoidWhenAllies = ['anti-heal'];
  const withAllyCoverage = createBuildAdvisor({ buildProfiles: copied, threatProfiles, matchupAdvice, itemAdvice, itemCatalog: catalog, championDefinitions: championData, profileChampion: id => id === 'Soraka' ? { championId: id, known: true, tags: ['magic', 'healing'], confidence: 'curated' } : id === 'Lux' ? { championId: id, known: true, tags: ['magic', 'anti-heal'], confidence: 'curated' } : createThreatProfiler({ champions: championData, threatProfiles })(id), patch, exclusiveGroups: matrix });
  const result = withAllyCoverage({ player: { championId: 'Jinx', role: 'adc' }, allies: [{ championId: 'Lux', confirmed: true, visible: true }], enemies: [{ championId: 'Soraka', confirmed: true, visible: true }] }, 'es');
  assert.ok(result.composition.allyCoverage.includes('anti-heal'));
  assert.equal(result.options.some(option => option.id === 'generated-anti-heal-crit'), false);
});
