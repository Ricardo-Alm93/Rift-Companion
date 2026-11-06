const test = require('node:test');
const assert = require('node:assert/strict');
const { createItemSet, importItemSet, BLOCK_TYPES } = require('../src/services/item-set-format.cjs');
const { evaluateAugments } = require('../src/engine/aram-augment-evaluator.cjs');
const { ENDPOINTS, normalizeLiveClientSnapshot } = require('../src/adapters/live-client-data-adapter.js');
const { LiveClientDataClient, requestLiveClient } = require('../src/services/live-client-data-client.js');
const AramOverlayViewModel = require('../src/aram-overlay-view-model.js');
const { ENDPOINTS: LCU_ENDPOINTS, ENABLED, queueInfoFromGameflow } = require('../src/adapters/lcu-champ-select-adapter.js');
const { LcuDraftClient, readLockfile, requestLcu } = require('../src/services/lcu-draft-client.js');
const { preferenceFile, readLcuEnabled, writeLcuEnabled } = require('../src/services/lcu-preferences.cjs');
const fs = require('node:fs/promises');
const { parseOpggClassRepr } = require('../src/provider-core.cjs');
const OverlayRoster = require('../src/overlay-roster.js');
const { visibleEnemyRows } = OverlayRoster;

const itemCatalog = {
  '1001': { maps: { '11': true, '12': true }, gold: { purchasable: true } },
  '3001': { maps: { '11': true, '12': false }, gold: { purchasable: true } }
};

test('Item Set JSON has four named blocks and imports without changing source data', () => {
  const set = createItemSet({ champion: 'Ahri', championId: '103', mode: 'ranked', blocks: BLOCK_TYPES.map((type, i) => ({ type, items: i === 0 ? ['1001'] : [] })), itemCatalog });
  assert.deepEqual(set.blocks.map(x => x.type), BLOCK_TYPES);
  assert.equal(set.associatedChampions[0], '103');
  const imported = importItemSet(set, itemCatalog, '11');
  assert.equal(imported.blocks[0].items[0].id, '1001');
  assert.equal(set.blocks[0].items[0].count, 1);
});

test('Item Set builder rejects wrong-map or unknown items', () => {
  assert.throws(() => createItemSet({ champion: 'Ahri', championId: '103', mode: 'aram', blocks: BLOCK_TYPES.map((type, i) => ({ type, items: i === 0 ? ['3001'] : [] })), itemCatalog }), /Objeto no válido/);
  assert.throws(() => importItemSet({ blocks: [{ type: 'Core', items: [{ id: '9999' }] }] }, itemCatalog), /no existe/);
});

test('Item Set exports transformed finals while preserving the final in the exported inventory', () => {
  const patch = '16.22.1', transformations = { '3121': { fromItemId: '3119', status: 'verified', patch }, '3040': { fromItemId: '3003', status: 'verified', patch }, '3042': { fromItemId: '3004', status: 'verified', patch } };
  const raw = {
    '3119': { maps: { 11: true }, gold: { purchasable: true }, from: ['3070'] },
    '3121': { maps: { 11: true }, inStore: false, gold: { purchasable: false } },
    '3070': { maps: { 11: true }, gold: { purchasable: true } }
  };
  const set = createItemSet({ champion: 'Poppy', championId: '78', mode: 'ranked', patch, exclusiveGroups: { patch, mapId: '11', transformations }, blocks: BLOCK_TYPES.map((type, i) => ({ type, items: i === 1 ? ['3121'] : [] })), itemCatalog: raw });
  assert.deepEqual(set.blocks[1].items, [{ id: '3121', count: 1 }]);
  assert.deepEqual(importItemSet(set, raw, '11').blocks[1].items, [{ id: '3121', count: 1 }]);
  assert.throws(() => createItemSet({ champion: 'Poppy', championId: '78', mode: 'ranked', patch, exclusiveGroups: { patch, mapId: '11', transformations: {} }, blocks: BLOCK_TYPES.map((type, i) => ({ type, items: i === 1 ? ['3121'] : [] })), itemCatalog: raw }), /Objeto no válido/);
});

test('augment evaluator does not infer synergy from tag overlap and leaves unknowns unknown', () => {
  const profiles = {
    selected: { name: 'Selected', synergyTags: ['spell-chain'] },
    candidate: { name: 'Candidate', championTags: ['mage'], buildTags: ['spelldamage'], synergyWith: ['spell-chain'], tradeoffs: ['Tradeoff'] }
  };
  const [result] = evaluateAugments({ championTags: ['Mage'], buildTags: ['SpellDamage'], selectedAugments: ['selected'], candidateAugments: [{ slug: 'candidate' }], profiles });
  assert.equal(result.level, 'unknown'); assert.equal(result.evidenceLevel, 'unknown'); assert.equal(result.provenance.status, 'unknown');
  const [unknown] = evaluateAugments({ candidateAugments: [{ slug: 'missing' }] });
  assert.equal(unknown.level, 'unknown'); assert.equal(unknown.score, undefined);
});

test('LCU and Live Client Data use separate documented read-only endpoints', () => {
  assert.equal(ENABLED, false); assert.equal(LCU_ENDPOINTS.phase, '/lol-gameflow/v1/gameflow-phase'); assert.equal(LCU_ENDPOINTS.gameflowSession, '/lol-gameflow/v1/session'); assert.equal(LCU_ENDPOINTS.session, '/lol-champ-select/v1/session');
  assert.deepEqual(ENDPOINTS, { activePlayerName: '/liveclientdata/activeplayername', playerList: '/liveclientdata/playerlist', gameStats: '/liveclientdata/gamestats' });
});

test('queue classification only calls known ranked queues Ranked and leaves other or missing queues generic', () => {
  assert.deepEqual(queueInfoFromGameflow({ gameData: { queue: { queueId: 420 } } }), { queueId: 420, mode: 'ranked', modeVerified: true });
  assert.deepEqual(queueInfoFromGameflow({ gameData: { queue: { queueId: 3140 } } }), { queueId: 3140, mode: 'other', modeVerified: true });
  assert.deepEqual(queueInfoFromGameflow({ gameData: { queue: { queueId: 400 } } }), { queueId: 400, mode: 'other', modeVerified: true });
  assert.deepEqual(queueInfoFromGameflow({ gameData: { queue: {} } }), { queueId: null, mode: 'unknown', modeVerified: false });
});

test('Live Client Data maps active identity and ORDER/CHAOS without assuming the first participant', () => {
  const players=[{summonerName:'Ally A',championName:'Ahri',team:'ORDER',position:'MIDDLE'},{summonerName:'Me',championName:'Sona',team:'ORDER',position:'UTILITY'},{summonerName:'Enemy',championName:'Zed',team:'CHAOS',position:'MIDDLE'}];
  const dto=normalizeLiveClientSnapshot({activePlayerName:'Me',players},{championByName:{ahri:'Ahri',sona:'Sona',zed:'Zed'},sessionId:'match-1'});
  assert.equal(dto.status,'ready');assert.equal(dto.player.championId,'Sona');assert.equal(dto.player.cellId,1);assert.equal(dto.allies.find(x=>x.championId==='Sona').slot,1);assert.equal(dto.enemies[0].championId,'Zed');assert.equal(dto.modeVerified,false);assert.equal(dto.draftSessionId,'match-1');
});

test('Live Client Data does not guess identity/team and allows an explicit participant choice', () => {
  const players=[{summonerName:'A',championName:'Ahri',team:'ORDER'},{summonerName:'B',championName:'Zed',team:'CHAOS'}],opts={championByName:{ahri:'Ahri',zed:'Zed'},sessionId:'match-2'};
  const unresolved=normalizeLiveClientSnapshot({activePlayerName:'Unknown',players},opts);assert.equal(unresolved.status,'identity_unresolved');assert.equal(unresolved.player,null);assert.deepEqual(unresolved.allies,[]);assert.equal(unresolved.participants.length,2);
  const selected=normalizeLiveClientSnapshot({activePlayerName:'Unknown',players},{...opts,manualPlayerIndex:1});assert.equal(selected.player.championId,'Zed');assert.equal(selected.allies[0].championId,'Zed');assert.equal(selected.enemies[0].championId,'Ahri');
  assert.throws(()=>normalizeLiveClientSnapshot({activePlayerName:'Unknown',players},{...opts,manualPlayerIndex:9}),/identity/);
});

test('Live Client Data rejects oversized rosters and maps localized/static aliases', () => {
  const dto=normalizeLiveClientSnapshot({activePlayerName:'Player',players:[{summonerName:'Player',championName:'game_character_displayname_ahri',team:'ORDER'}]},{championByName:{ahri:'Ahri'}});assert.equal(dto.player.championId,'Ahri');
  assert.throws(()=>normalizeLiveClientSnapshot({activePlayerName:'Player',players:Array.from({length:11},()=>({team:'ORDER'}))}),/snapshot/);
});

test('Live Client Data requests only loopback GET with TLS verification and an endpoint allowlist', async () => {
  let options;const fake=(opts,cb)=>{options=opts;const req={on(){return this},end(){const res={statusCode:200,on(name,fn){if(name==='data')queueMicrotask(()=>fn(Buffer.from('"Me"')));if(name==='end')queueMicrotask(fn)}};cb(res)},destroy(){}};return req};
  assert.equal(await requestLiveClient({endpoint:ENDPOINTS.activePlayerName,ca:'RIOT_CA',requestImpl:fake}),'Me');assert.equal(options.hostname,'127.0.0.1');assert.equal(options.port,2999);assert.equal(options.method,'GET');assert.equal(options.rejectUnauthorized,true);assert.equal(options.ca,'RIOT_CA');
  await assert.rejects(requestLiveClient({endpoint:'/liveclientdata/activeplayername?x=1',requestImpl:fake}));
});

test('Live Client Data client reads active identity and player roster as one bounded snapshot', async () => {
  const calls=[];const client=new LiveClientDataClient({ca:'ca',request:async({endpoint})=>{calls.push(endpoint);if(endpoint===ENDPOINTS.activePlayerName)return 'Me';if(endpoint===ENDPOINTS.playerList)return [{summonerName:'Me',championName:'Ahri',team:'ORDER'}];return {gameMode:'CLASSIC',mapNumber:11}},now:()=> '2026-11-04T12:00:00.000Z'});
  const dto=await client.read({championByName:{ahri:'Ahri'}});assert.equal(dto.player.championId,'Ahri');assert.equal(dto.mode,'unknown');assert.equal(dto.modeVerified,false);assert.deepEqual(calls.sort(),Object.values(ENDPOINTS).sort());
});

test('ARAM overlay view model preserves shared items, skills, augment profiles, synergies and sources', () => {
  const model=AramOverlayViewModel.create({title:'Ahri',items:[{id:'1'}],situationalItems:[{id:'2'}],skills:Array.from({length:18},(_,i)=>i===15?'R':''),abilities:[{key:'Q',icon:'q.png'}],augmentRecommendations:[{slug:'a',rarity:'gold',description:'text'}],selectedAugments:['selected'],synergies:[{title:'combo',augmentIds:['a','b']}],source:'fixture'});
  assert.equal(model.items[0].id,'1');assert.equal(model.situationalItems[0].id,'2');assert.equal(model.skills.length,18);assert.equal(model.skills[15],'R');assert.equal(model.abilities[0].key,'Q');assert.equal(model.augmentRecommendations[0].description,'text');assert.deepEqual(model.selectedAugments,['selected']);assert.equal(model.synergies[0].augmentIds.length,2);assert.equal(model.source,'fixture');
});

function lcuSession({ ownCompleted = false, enemyOneCompleted = true } = {}) {
  return { localPlayerCellId: 2, myTeam: [{ cellId: 0, championId: 222, assignedPosition: 'BOTTOM' }, { cellId: 1, championId: 0 }, { cellId: 2, championId: 103, assignedPosition: 'MIDDLE' }, { cellId: 3, championId: 0 }, { cellId: 4, championId: 0 }], theirTeam: [{ cellId: 5, championId: 238 }, { cellId: 6, championId: 0 }, { cellId: 7, championId: 0 }, { cellId: 8, championId: 0 }, { cellId: 9, championId: 0 }], actions: [[{ actorCellId: 0, type: 'pick', completed: true }], [{ actorCellId: 2, type: 'pick', completed: ownCompleted }], [{ actorCellId: 5, type: 'pick', completed: enemyOneCompleted }]] };
}

test('LCU adapter matches own champion by cell ID, resolves numeric Data Dragon keys and hides enemy until lock', () => {
  const { fromSession } = require('../src/adapters/lcu-champ-select-adapter.js');
  const dto = fromSession({ session: lcuSession(), championByKey: { 103: 'Ahri', 222: 'Jinx', 238: 'Zed' }, draftSessionId: 'ephemeral', version: 3 });
  assert.deepEqual(dto.player, { cellId: 2, championId: 'Ahri', status: 'hovered', role: 'mid' });
  assert.equal(dto.allies[0].championId, 'Jinx'); assert.equal(dto.allies[0].status, 'locked');
  assert.equal(dto.enemies[0].championId, 'Zed'); assert.equal(dto.enemies[1].championId, '');
  assert.equal(dto.confirmed, false); assert.equal(JSON.stringify(dto).includes('summonerId'), false); assert.equal(JSON.stringify(dto).includes('riotId'), false);
});

test('LCU adapter changes own pick from provisional to locked without changing team assignment', () => {
  const { fromSession } = require('../src/adapters/lcu-champ-select-adapter.js');
  const dto = fromSession({ session: lcuSession({ ownCompleted: true, enemyOneCompleted: false }), championByKey: { 103: 'Ahri', 222: 'Jinx', 238: 'Zed' } });
  assert.deepEqual(dto.player, { cellId: 2, championId: 'Ahri', status: 'locked', role: 'mid' });
  assert.equal(dto.allies[0].championId, 'Jinx'); assert.equal(dto.enemies[0].championId, '');
  assert.equal(dto.enemies[0].visible, false); assert.equal(dto.confirmed, false);
});

test('LCU adapter tracks selection hover, intent, cancellation and lock as distinct states', () => {
  const { fromSession } = require('../src/adapters/lcu-champ-select-adapter.js'), session = lcuSession({ ownCompleted: false });
  const map = { 103: 'Ahri', 222: 'Jinx', 238: 'Zed' }, read = () => fromSession({ session, championByKey: map }).player.status;
  assert.equal(read(), 'hovered'); session.myTeam[2].championId = 0; session.myTeam[2].championPickIntent = 103; assert.equal(read(), 'intent');
  session.myTeam[2].championPickIntent = 0; assert.equal(read(), 'unknown'); session.myTeam[2].championId = 103; session.actions[1][0].completed = true; assert.equal(read(), 'locked');
});

test('LCU adapter distinguishes own pick intent from hover and rejects malformed cell IDs', () => {
  const { fromSession } = require('../src/adapters/lcu-champ-select-adapter.js'), session = lcuSession();
  session.myTeam[2].championId = 0; session.myTeam[2].championPickIntent = 103; session.actions[1][0].completed = false;
  const dto = fromSession({ session, championByKey: { 103: 'Ahri', 222: 'Jinx', 238: 'Zed' } });
  assert.deepEqual(dto.player, { cellId: 2, championId: 'Ahri', status: 'intent', role: 'mid' });
  assert.equal(dto.allies[2].visible, true); assert.equal(dto.allies[2].confirmed, false);
  const malformed = lcuSession(); malformed.theirTeam[0].cellId = malformed.myTeam[0].cellId;
  assert.throws(() => fromSession({ session: malformed, championByKey: { 103: 'Ahri' } }), /cell IDs/);
});

test('LCU adapter ignores enemy intent and hidden candidate fields', () => {
  const { fromSession } = require('../src/adapters/lcu-champ-select-adapter.js'), session = lcuSession();
  session.theirTeam[0].championPickIntent = 238; session.theirTeam[0].futureChampionId = 238; session.theirTeam[0].hiddenChampionId = 238; session.actions[2][0].completed = false;
  const dto = fromSession({ session, championByKey: { 103: 'Ahri', 222: 'Jinx', 238: 'Zed' } });
  assert.equal(dto.enemies[0].championId, ''); assert.equal(dto.enemies[0].status, 'hidden');
  assert.equal(JSON.stringify(dto).includes('futureChampionId'), false); assert.equal(JSON.stringify(dto).includes('hiddenChampionId'), false);
});

test('LCU client checks phase before session, then emits only changed sanitized DTOs', async () => {
  const calls = [], events = []; let enemyOneCompleted = false; const client = new LcuDraftClient({ platform: 'win32', caPath: require('node:path').join(__dirname, '../src/adapters/riotgames.pem'), championByKey: { 103: 'Ahri', 222: 'Jinx', 238: 'Zed' }, pollMs: 100000, discover: async () => 'C:\\LeagueClientUx.exe', readCredential: async () => ({ pid: 12, port: 1234, password: 'private-token' }), request: async req => { calls.push(req.endpoint); return req.endpoint === LCU_ENDPOINTS.phase ? { phase: 'Lobby' } : req.endpoint === LCU_ENDPOINTS.gameflowSession ? { gameData: { queue: { queueId: 420 } } } : lcuSession({ enemyOneCompleted }); } });
  client.on('state', state => events.push(state)); client.setEnabled(true); clearTimeout(client.timer); client.timer = null; client.schedule = () => {}; await client.poll();
  assert.deepEqual(calls, [LCU_ENDPOINTS.phase]); assert.equal(client.getState().status, 'client_connected'); assert.equal(client.getState().diagnostics.clientDetected, true); assert.equal(client.getState().diagnostics.lcuConnected, true); assert.equal(client.getState().diagnostics.phase, 'Lobby'); assert.ok(client.getState().diagnostics.lastUpdatedAt); assert.equal(JSON.stringify(client.getState()).includes('private-token'), false);
  calls.length = 0; client.request = async req => { calls.push(req.endpoint); return req.endpoint === LCU_ENDPOINTS.phase ? { phase: 'ChampSelect' } : req.endpoint === LCU_ENDPOINTS.gameflowSession ? { gameData: { queue: { queueId: 420 } } } : lcuSession({ enemyOneCompleted }); };
  await client.poll(); const first = client.getState(); enemyOneCompleted = true; await client.poll(); const updated = client.getState(); await client.poll();
  assert.deepEqual(calls, [LCU_ENDPOINTS.phase, LCU_ENDPOINTS.gameflowSession, LCU_ENDPOINTS.session, LCU_ENDPOINTS.phase, LCU_ENDPOINTS.session, LCU_ENDPOINTS.phase, LCU_ENDPOINTS.session]);
  assert.equal(first.roster.mode,'ranked'); assert.equal(first.roster.modeVerified,true); assert.equal(first.roster.player.championId, 'Ahri'); assert.equal(first.roster.player.cellId, 2); assert.equal(first.diagnostics.alliesConfirmed, 1); assert.equal(first.diagnostics.enemiesVisibleConfirmed, 0); assert.equal(updated.diagnostics.enemiesVisibleConfirmed, 1); assert.ok(updated.roster.version > first.roster.version); assert.equal(events.at(-1).roster.player.cellId, 2); assert.ok(events.length <= 6);
  client.discover = async () => ''; await client.poll(); assert.equal(client.getState().status, 'client_not_found'); assert.equal(client.getState().roster, null); assert.equal(client.getState().diagnostics.clientDetected, false); assert.equal(client.getState().diagnostics.enemiesVisibleConfirmed, 0);
  client.setEnabled(false); assert.equal(client.getState().status, 'integration_disabled');
});

test('LCU client retains only completed guide after ChampSelect and clears it at a new draft', async () => {
  const keys = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), `Champion${i + 1}`]));
  const complete = { localPlayerCellId: 3, myTeam: Array.from({ length: 5 }, (_, cellId) => ({ cellId, championId: cellId + 1, assignedPosition: cellId === 3 ? 'UTILITY' : '' })), theirTeam: Array.from({ length: 5 }, (_, i) => ({ cellId: i + 5, championId: i + 6 })), actions: Array.from({ length: 10 }, (_, actorCellId) => [{ actorCellId, type: 'pick', completed: true }]) };
  let phase = 'Lobby', session = complete; const calls = [];
  const client = new LcuDraftClient({ platform: 'win32', championByKey: keys, pollMs: 100000, discover: async () => 'C:\\LeagueClientUx.exe', readCredential: async () => ({ pid: 10, port: 2999, password: 'never-log-this' }), request: async request => { calls.push(request.endpoint); return request.endpoint === LCU_ENDPOINTS.phase ? { phase } : session; } });
  client.setEnabled(true); clearTimeout(client.timer); client.timer = null; client.schedule = () => {};
  await client.poll(); assert.equal(client.getState().status, 'client_connected'); assert.equal(calls.includes(LCU_ENDPOINTS.session), false);
  phase = 'ChampSelect'; await client.poll(); const completedState = client.getState(); assert.equal(completedState.roster.confirmed, true); assert.equal(completedState.diagnostics.alliesConfirmed, 5); assert.equal(completedState.diagnostics.enemiesVisibleConfirmed, 5);
  phase = 'InProgress'; calls.length = 0; await client.poll(); const inGame = client.getState(); assert.equal(inGame.roster, null); assert.equal(inGame.retainedRoster.confirmed, true); assert.deepEqual(calls, [LCU_ENDPOINTS.phase, LCU_ENDPOINTS.gameflowSession]);
  phase = 'Lobby'; await client.poll(); assert.equal(client.getState().retainedRoster.confirmed, true);
  phase = 'ChampSelect'; session = lcuSession({ ownCompleted: false, enemyOneCompleted: false }); await client.poll(); const nextDraft = client.getState(); assert.equal(nextDraft.retainedRoster, null); assert.equal(nextDraft.roster.player.championId, ''); assert.equal(nextDraft.roster.allies[0].championId, '');
  phase = 'Lobby'; await client.poll(); assert.equal(client.getState().retainedRoster, null); assert.ok(client.getState().diagnostics.log.some(x => x.event === 'phase_transition' && x.from === 'ChampSelect' && x.to === 'InProgress')); assert.ok(client.getState().diagnostics.log.some(x => x.event === 'roster_changed')); assert.equal(JSON.stringify(client.getState().diagnostics.log).includes('never-log-this'), false); assert.equal(JSON.stringify(client.getState().diagnostics.log).includes('Champion1'), false);
  client.setEnabled(false);
});

test('LCU stops reading ChampSelect and takes one Live Client Data snapshot on InProgress', async () => {
  const keys=Object.fromEntries(Array.from({length:10},(_,i)=>[String(101+i),`Champion${i+1}`]));keys['103']='Ahri';const calls=[],liveCalls=[];let phase='ChampSelect';const session={localPlayerCellId:2,myTeam:Array.from({length:5},(_,cellId)=>({cellId,championId:101+cellId,assignedPosition:cellId===2?'MIDDLE':''})),theirTeam:Array.from({length:5},(_,i)=>({cellId:i+5,championId:106+i})),actions:Array.from({length:10},(_,actorCellId)=>[{actorCellId,type:'pick',completed:true}])};const live={read:async opts=>{liveCalls.push(opts);return normalizeLiveClientSnapshot({activePlayerName:'Me',players:[{summonerName:'Me',championName:'Ahri',team:'ORDER',position:'MIDDLE'},{summonerName:'Ally',championName:'Jinx',team:'ORDER',position:'BOTTOM'},{summonerName:'Enemy',championName:'Zed',team:'CHAOS',position:'MIDDLE'}]},{championByName:{ahri:'Ahri',jinx:'Jinx',zed:'Zed'},sessionId:opts.sessionId,revision:opts.revision})}};const client=new LcuDraftClient({platform:'win32',caPath:require('node:path').join(__dirname,'../src/adapters/riotgames.pem'),championByKey:keys,liveClient:live,pollMs:100000,discover:async()=> 'C:\\LeagueClientUx.exe',readCredential:async()=>({pid:22,port:2999,password:'private'}),request:async req=>{calls.push(req.endpoint);return req.endpoint===LCU_ENDPOINTS.phase?{phase}:req.endpoint===LCU_ENDPOINTS.gameflowSession?{gameData:{queue:{queueId:420}}}:session}});client.setEnabled(true);clearTimeout(client.timer);client.timer=null;client.schedule=()=>{};await client.poll();assert.equal(client.getState().roster.player.championId,'Ahri');phase='InProgress';calls.length=0;await client.poll();let state=client.getState();assert.equal(liveCalls.length,1);assert.equal(state.status,'live_snapshot');assert.equal(state.roster.source,'live-client');assert.equal(state.roster.player.championId,'Ahri');assert.equal(state.roster.allies.find(x=>x.championId==='Ahri').slot,0);assert.equal(state.roster.enemies[0].championId,'Zed');assert.equal(state.retainedRoster.confirmed,true);assert.deepEqual(calls,[LCU_ENDPOINTS.phase,LCU_ENDPOINTS.gameflowSession]);assert.equal(state.roster.mode,'ranked');assert.equal(state.roster.modeVerified,true);await client.poll();assert.equal(liveCalls.length,1);phase='Lobby';await client.poll();assert.equal(client.getState().liveRoster,null);client.setEnabled(false);
});

test('overlapping LCU polls do not issue concurrent reads; disabling discards late results', async () => {
  let release, requestStarted, count = 0, emitted = 0; const started = new Promise(resolve => { requestStarted = resolve; }); const client = new LcuDraftClient({ platform: 'win32', caPath: require('node:path').join(__dirname, '../src/adapters/riotgames.pem'), discover: async () => 'C:\\LeagueClientUx.exe', readCredential: async () => ({ pid: 1, port: 2, password: 'secret' }), request: () => { count++; requestStarted(); return new Promise(resolve => { release = resolve; }); } });
  client.on('state', () => emitted++); client.setEnabled(true); clearTimeout(client.timer); client.timer = null; client.schedule = () => {};
  const pending = client.poll(); await started; await client.poll(); assert.equal(count, 1); client.setEnabled(false); release({ phase: 'Lobby' }); await pending; assert.equal(client.getState().status, 'integration_disabled'); assert.equal(emitted, 3); assert.equal(JSON.stringify(client.getState()).includes('secret'), false);
});

test('LCU opt-in is persisted in shared appData and remains explicit across isolated Electron profiles', async () => {
  const root = await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'rift-lcu-pref-'));
  try {
    const file = preferenceFile(root, 'rift-companion');
    assert.equal(await readLcuEnabled(file), false);
    await writeLcuEnabled(file, true);
    assert.equal(await readLcuEnabled(file), true);
    await writeLcuEnabled(file, false);
    assert.equal(await readLcuEnabled(file), false);
    assert.match(file, /rift-companion[\\/]database[\\/]preferences\.json$/);
    await assert.rejects(writeLcuEnabled(file, 'yes'), /boolean/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('LCU state reports user opt-in independently from client connection state', () => {
  const client = new LcuDraftClient({ platform: 'win32' });
  assert.equal(client.getState().enabled, false);
  assert.equal(client.getState().status, 'integration_disabled');
  const enabled = client.setEnabled(true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.status, 'searching_client');
  const disabled = client.setEnabled(false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, 'integration_disabled');
});

test('lockfile parser accepts ephemeral credentials internally without exposing them in client status', async () => {
  const base = await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'rift-lcu-'));
  try { const exe = require('node:path').join(base, 'LeagueClientUx.exe'); await fs.writeFile(require('node:path').join(base, 'lockfile'), 'LeagueClientUx:44:2999:ephemeral-secret:https'); const credential = await readLockfile(exe); assert.deepEqual(credential, { pid: 44, port: 2999, password: 'ephemeral-secret' }); } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('LCU HTTPS request is loopback GET with Riot CA validation and endpoint allowlist', async () => {
  let options; const fakeRequest = (opts, callback) => { options = opts; const req = { on: () => {}, end: () => { const response = { statusCode: 200, on: (name, fn) => { if (name === 'data') queueMicrotask(() => fn(Buffer.from('{"phase":"Lobby"}'))); if (name === 'end') queueMicrotask(fn); }, }; callback(response); }, destroy: () => {} }; return req; };
  const data = await requestLcu({ port: 2999, password: 'token', endpoint: LCU_ENDPOINTS.phase, ca: 'RIOT_CA', requestImpl: fakeRequest });
  assert.equal(options.hostname, '127.0.0.1'); assert.equal(options.method, 'GET'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.ca, 'RIOT_CA'); assert.match(options.headers.Authorization, /^Basic /); assert.equal(options.path, LCU_ENDPOINTS.phase); assert.deepEqual(data, { phase: 'Lobby' });
  await assert.rejects(requestLcu({ port: 2999, password: 'token', endpoint: '/lol-gameflow/v1/gameflow-phase?x=1', ca: 'ca', requestImpl: fakeRequest }));
});

test('OP.GG champion-analysis typed response parses builds and skill order', () => {
  const text='LolGetChampionAnalysis("Ahri","MID",Data(Summary(AverageStats(100,0.51,0.1,0.02,2.5),[Position("MID",Stats(90,0.52))]),CoreItems([3118,4645,3157],["A","B","C"],20,11,0.2),CoreItems([3020],["Boots"],100,55,0.6),CoreItems([1056],["Start"],100,55,0.7),[CoreItems([3135],["Void"],30,16,0.3)],[CoreItems([3135],["Void 4"],40,22,0.22)],[CoreItems([4645],["Shadow 5"],30,17,0.21)],[CoreItems([3089],["Rabadon 6"],25,14,0.20)],CoreItems([4,14],["Flash","Ignite"],50,27,0.5),Runes(8112,8100,"Domination",[8112,8139],["Electrocute","Taste"],8200,"Sorcery",[8210],["Transcendence"],[5005,5008,5001],["AS","Adaptive","Health"],50,27,0.5),SkillMasteries(["Q","W","E"],100,55,0.9,[Build(["W","Q","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],90,50,0.8)]),Trends(Win("16.21",0.51,1,"2026-11-03"))))';
  const result=parseOpggClassRepr(text);
  assert.equal(result.champion,'Ahri');assert.equal(result.data.core_items.ids[0],3118);assert.equal(result.data.fourth_items[0].ids[0],3135);assert.equal(result.data.fifth_items[0].ids[0],4645);assert.equal(result.data.sixth_items[0].ids[0],3089);assert.equal(result.data.summoner_spells.ids[0],4);assert.equal(result.data.skill_masteries.builds[0].order.length,15);assert.equal(result.data.trends.win.version,'16.21');
});

test('overlay displays already revealed enemies regardless of queue classification', () => {
  const enemies=Array.from({length:5},(_,slot)=>({slot,championId:`Enemy${slot}`,visible:true,confirmed:true}));
  assert.equal(visibleEnemyRows({mode:'other',modeVerified:true,enemies}).length,5);
  assert.equal(visibleEnemyRows({mode:'unknown',enemies:[...enemies,{slot:5,championId:'Hidden',visible:false}]}).length,5);
  assert.equal(visibleEnemyRows({enemies:[{championId:'Hidden',visible:false}]}).length,0);
});

test('ranked lane rival is selected only from one confirmed enemy with the same known role', () => {
  const roster={phase:'InProgress',mode:'ranked',modeVerified:true,player:{role:'mid'},enemies:[{championId:'Zed',role:'mid',visible:true,confirmed:true},{championId:'Jinx',role:'adc',visible:true,confirmed:true}]};
  assert.equal(OverlayRoster.rankedLaneOpponent(roster),'Zed');
  assert.equal(OverlayRoster.rankedLaneOpponent({...roster,mode:'other'}),'');
  assert.equal(OverlayRoster.rankedLaneOpponent({...roster,enemies:[...roster.enemies,{championId:'Ahri',role:'mid',visible:true,confirmed:true}]}),'');
  assert.equal(OverlayRoster.rankedLaneOpponent({...roster,player:{role:''}}),'');
});
