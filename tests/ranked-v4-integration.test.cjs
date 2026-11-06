'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {advisor,itemCatalog,exclusiveGroups,patch,roster}=require('./fixtures/ranked-v4-real-catalog.cjs');
const {validateBuildItems}=require('../src/engine/item-eligibility');
for(const [championId,role,strategies]of [['Poppy','top',['tank','offtank','lethality']],['Zed','mid',['assassin','bruiser']],['Ahri','mid',['burst','sustained']],['Jinx','adc',['crit','onhit']],['Soraka','support',['enchanter']]])test(`V4 real catalog: ${championId}/${role} completes each reviewed archetype without six-item presets`,()=>{
 const result=advisor({player:{championId,role}},'es');assert.equal(result.schemaVersion,'4.0');
 for(const strategy of strategies){const option=result.scenarios.standard.variants.find(row=>row.archetypeId===strategy);assert.ok(option,strategy);assert.equal(new Set(option.itemIds).size,6);assert.equal(validateBuildItems(option.itemIds,itemCatalog,{patch,exclusiveGroups,championId,role}).valid,true);assert.deepEqual(option.purchaseOrder.map(s=>s.finalItemId),option.itemIds);assert.equal(option.evidenceType,'educational-generated');assert.equal(option.winRate,undefined);}
 if(championId==='Poppy')assert.equal(result.scenarios.standard.variants.find(row=>row.archetypeId==='lethality').experimental,true);
 if(championId==='Jinx')assert.equal(result.scenarios.standard.variants.find(row=>row.archetypeId==='onhit').experimental,true);
 if(championId==='Soraka'){assert.ok(result.options[0].itemIds.includes('3870'));assert.ok(result.options[0].itemIds.includes('6617'));}
 assert.deepEqual(result.stagePlans,{});
});
test('V4 scenario context never contaminates standard and records exact deltas',()=>{
 const baseline=advisor({player:{championId:'Ahri',role:'mid'}},'es');
 const result=advisor({player:{championId:'Ahri',role:'mid'},enemies:roster(['Zed','Ornn','Rammus','Soraka','Jinx']),laneOpponentChampionId:'Zed'},'es');
 assert.deepEqual(result.scenarios.standard.recommended.itemIds,baseline.scenarios.standard.recommended.itemIds);
 assert.deepEqual(Object.keys(result.scenarios),['standard','lane','team']);
 for(const scenario of [result.scenarios.lane,result.scenarios.team]){const delta=scenario.deltaFromStandard;assert.ok(delta.reason);assert.deepEqual(delta.added,scenario.recommended.itemIds.filter(id=>!baseline.options[0].itemIds.includes(id)));assert.equal(scenario.recommended.validation.valid,true);}
 const sustained=result.scenarios.team.variants.find(row=>row.archetypeId==='sustained'&&row.itemIds.includes('3089')&&row.itemIds.includes('6653'));assert.ok(sustained);assert.ok(sustained.itemIds.includes('6653'));
});
test('V4 activation, slots, role and locked item restrictions remain authoritative',()=>{
 const result=advisor({player:{championId:'Zed',role:'mid'}},'es');for(const row of result.options)assert.ok(!row.itemIds.includes('2522')&&!row.itemIds.includes('3504'));
 const locked=advisor({player:{championId:'Zed',role:'mid'},lockedItemIds:['2522']},'es');assert.equal(locked.options.length,0);
 const noQuest=validateBuildItems(['3870','6617','3107','3504','6621','3158'],itemCatalog,{patch,exclusiveGroups,championId:'Zed',role:'mid'});assert.equal(noQuest.valid,false);
 const pinned=advisor({player:{championId:'Ahri',role:'mid'},lockedItemIds:['3157']},'es');assert.ok(pinned.options.length);assert.ok(pinned.options.every(row=>row.itemIds.includes('3157')));
});
test('V4 anti-heal candidates need confirmed healing; hidden picks and guessed allied purchases do not count',()=>{
 const base={player:{championId:'Jinx',role:'adc'}};
 const plain=advisor(base,'es');assert.ok(plain.options.every(row=>!row.itemIds.includes('3033')));
 const hidden=advisor({...base,enemies:[{championId:'Soraka',confirmed:false,visible:false}]},'es');assert.equal(hidden.scenarios.team,undefined);
 const healing=advisor({...base,enemies:roster(['Soraka'])},'es');assert.ok(healing.scenarios.team.variants.some(row=>row.itemIds.includes('3033')));
 assert.ok(healing.scenarios.team.variants.every(row=>row.evidenceType!=='observed-exact'));
});
test('V4 exact observed set provenance never transfers to a modified combination',()=>{
 const ids=advisor({player:{championId:'Ahri',role:'mid'}},'es').options[0].itemIds;
 const publishedData={source:'Unit test cohort, not production statistics',queryContext:{championId:'Ahri',position:'mid'},data:{champion:'Ahri',position:'MID',patch:'16.22',summary:{average_stats:{play:1000,win:510}},core_items:[{ids,play:200,win:110,pick_rate:.2}]}};
 const output=advisor({player:{championId:'Ahri',role:'mid'},publishedData},'es');
 assert.ok(output.options.some(row=>row.evidenceType==='observed-exact'));
 for(const row of output.options){assert.equal(row.winRate,undefined);if([...row.itemIds].sort().join('|')!==[...ids].sort().join('|'))assert.notEqual(row.evidenceType,'observed-exact');}
 const stale=advisor({player:{championId:'Ahri',role:'mid'},publishedData:{...publishedData,data:{...publishedData.data,patch:'16.21'}}},'es');assert.ok(stale.options.every(row=>row.evidenceType==='educational-generated'));
});
test('V4 budget, deterministic sensitivity and unknown knowledge are explicit',()=>{
 const input={player:{championId:'Poppy',role:'top'}};const a=advisor(input,'es'),b=advisor(input,'es');
 assert.deepEqual(a.options.map(row=>row.itemIds),b.options.map(row=>row.itemIds));
 assert.deepEqual(a.scenarios.standard.diagnostics.rankingSensitivity,b.scenarios.standard.diagnostics.rankingSensitivity);
 for(const run of a.scenarios.standard.diagnostics.runs){assert.ok(run.expandedStates<=50000);assert.ok(run.maxDurationMs);assert.ok(run.elapsedMs>=0);}
 assert.ok(a.options.every(row=>row.knowledgeStatus==='editorial-unverified'));
});
