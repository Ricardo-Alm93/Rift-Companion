'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {advisor}=require('../tests/fixtures/ranked-v4-real-catalog.cjs');
const {roster}=require('../tests/fixtures/ranked-v4-real-catalog.cjs');
const patch='16.22.1',items=require('../data/dragon/cdn/16.22.1/data/es_ES/item.json').data;
const result=advisor({player:{championId:'Poppy',role:'top'},laneOpponentChampionId:'Zed',enemies:roster(['Zed','Ornn','Soraka','Jinx','Rammus'])},'es');
const details=id=>({id,name:items[id]?.name||'Objeto #'+id,icon:`https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${id}.png`});
let state={scenario:'standard',variantId:result.scenarios.standard.recommended.id},win;
const snapshot=()=>{const group=result.scenarios[state.scenario],option=group.variants.find(row=>row.id===state.variantId)||group.recommended;return {language:'es',sections:{ranked:{championId:'Poppy',title:'Poppy',enemy:'Zed',role:'Top',portrait:`https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/Poppy.png`,selectedBuild:option.label,selectedBuildId:option.id,items:option.itemIds.map(details),scenarioSelection:state.scenario,scenarioChoices:Object.entries(result.scenarios).map(([id,row])=>({id,label:row.label})),variantChoices:group.variants.map(row=>({id:row.id,label:row.label,selected:row.id===option.id})),scenarioComparison:group.deltaFromStandard||null,purchaseOrder:option.purchaseOrder.map(row=>({...row,item:details(row.purchaseItemId),purchaseItemName:items[row.purchaseItemId]?.name,finalItemName:items[row.finalItemId]?.name})),buildScope:'Propuesta educativa editorial; sin estadística observada para esta combinación.',skills:[],tips:[],situationalItems:[],source:option.source}}};};
ipcMain.on('overlay:build-choice',(event,choice)=>{if(event.sender!==win?.webContents||!result.scenarios[choice.scenario])return;const group=result.scenarios[choice.scenario];state={scenario:choice.scenario,variantId:group.variants.some(row=>row.id===choice.variantId)?choice.variantId:group.recommended.id};win.webContents.send('overlay:data',snapshot());});
async function waitFor(condition){for(let i=0;i<60;i++){if(await win.webContents.executeJavaScript(condition))return;await new Promise(r=>setTimeout(r,25));}throw Error('UI readiness condition not reached: '+condition);}
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({show:false,width:640,height:880,webPreferences:{preload:path.resolve('src/preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});await win.loadFile(path.resolve('src/overlay.html'));await win.webContents.executeJavaScript(`render(${JSON.stringify(snapshot())})`);
 await waitFor("document.querySelectorAll('.overlay-scenario-tabs button').length===3 && document.querySelectorAll('.overlay-ranked-pane:not([hidden]) .overlay-item').length===6");
 assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.overlay-ranked-stages').length"),0);
 const off=result.scenarios.standard.variants.find(row=>row.archetypeId==='offtank');
 await win.webContents.executeJavaScript(`document.querySelector('[data-ranked-variant="${off.id}"]').click()`);
 await waitFor(`snapshot.sections.ranked.selectedBuildId===${JSON.stringify(off.id)}`);
 assert.deepEqual(await win.webContents.executeJavaScript('snapshot.sections.ranked.items.map(row=>row.id)'),off.itemIds);
 await win.webContents.executeJavaScript("document.querySelector('[data-ranked-scenario=lane]').click()");await waitFor("snapshot.sections.ranked.scenarioSelection==='lane'");
 assert.deepEqual(await win.webContents.executeJavaScript('snapshot.sections.ranked.items.map(row=>row.id)'),result.scenarios.lane.recommended.itemIds);
 await win.webContents.executeJavaScript("document.querySelector('[data-ranked-scenario=standard]').click()");await waitFor("snapshot.sections.ranked.scenarioSelection==='standard'");
 await waitFor("[...document.querySelectorAll('.overlay-ranked-pane:not([hidden]) .overlay-item img')].every(img=>img.complete&&img.naturalWidth>0)");
 const bad=await win.webContents.executeJavaScript("/(?:\\bundefined\\b|\\bNaN\\b|\\bnull\\b)/.test(document.getElementById('overlay-inner').innerText)");assert.equal(bad,false);
 const output=path.resolve('docs/assets/screenshots/ranked-overlay-build.png');fs.writeFileSync(output,(await win.webContents.capturePage()).toPNG());console.log(JSON.stringify({passed:true,output,source:'production-advisor-real-catalog',scenarioCount:3,stageCards:0,variantClick:true,sharedIds:true}));win.destroy();app.exit(0);
 }catch(error){console.error(error);win?.destroy();app.exit(1)}});
