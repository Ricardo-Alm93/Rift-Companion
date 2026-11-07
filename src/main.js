const {parseMcp,parseOpggClassRepr,allowedExternal,cacheMeta,cacheState}=require('./provider-core.cjs');
const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadLocalEnv } = require('./services/env-config.cjs');
const { RiotWebClient } = require('./services/riot-web-client.js');
const { buildItemCatalog } = require('./engine/item-eligibility.js');
const { createThreatProfiler } = require('./engine/champion-threat-profiler.js');
const { createBuildAdvisor } = require('./engine/build-candidate-generator.js');
const { normalizeRoster, validateRoster } = require('./domain/roster.js');
const { createItemSet, importItemSet } = require('./services/item-set-format.cjs');
const { evaluateAugments } = require('./engine/aram-augment-evaluator.cjs');
const { adaptMayhemBuild } = require('./engine/aram-build-adapter.cjs');
const { loadMayhemCatalog, availableAugments } = require('./engine/aram-mayhem-catalog.cjs');
const { validateMayhemBuild } = require('./engine/aram-mayhem-item-validator.cjs');
const { ChampionAbilityCache, championAbilityResource } = require('./services/champion-ability-cache.cjs');
const { createMerakiAdapter } = require('./services/champion-knowledge-adapters.cjs');
const { mergeAbilityEvidence } = require('./domain/champion-knowledge-sources');
const { createChampionMechanicsProfile } = require('./engine/champion-mechanics-profiler');
const { comparePatchVersions } = require('./domain/patch-compatibility');
const { LcuDraftClient } = require('./services/lcu-draft-client.js');
const { LiveClientDataClient } = require('./services/live-client-data-client.js');
const { preferenceFile, readLcuEnabled, writeLcuEnabled } = require('./services/lcu-preferences.cjs');
let DATA_DRAGON_PATCH = '16.22.1';

// Isolate live LCU diagnostics from the installed profile when explicitly requested.
if (process.env.RIFT_COMPANION_LCU_DIAGNOSTIC === '1') app.setPath('userData', path.join(__dirname, '..', 'work', 'lcu-diagnostic-profile'));

try { loadLocalEnv({ appDir: path.resolve(__dirname, '..'), packaged: app.isPackaged }); }
catch { console.error('Local environment configuration could not be read.'); }
const riotWebClient = new RiotWebClient();
let advisorPromise;
let lcuDraftClientPromise;
let merakiKnowledgeAdapter;
function getMerakiKnowledgeAdapter() {
  if (merakiKnowledgeAdapter) return merakiKnowledgeAdapter;
  const cacheFile = path.join(app.getPath('userData'), 'database', 'knowledge', 'meraki-latest.json');
  merakiKnowledgeAdapter = createMerakiAdapter({ timeoutMs: 5000,
    readCache: async key => { if (key !== '__dataset__') return null; try { return JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { return null; } },
    writeCache: async (key, value) => { if (key !== '__dataset__') return; await fs.mkdir(path.dirname(cacheFile), { recursive: true }); const temp = `${cacheFile}.tmp`; await fs.writeFile(temp, JSON.stringify(value), 'utf8'); await fs.rename(temp, cacheFile); }
  });
  return merakiKnowledgeAdapter;
}
const lcuPreferencePath = preferenceFile(app.getPath('appData'), app.getName());
async function getLcuDraftClient() {
  if (!lcuDraftClientPromise) lcuDraftClientPromise = (async () => {
    const root = path.join(__dirname, '..', 'data', 'dragon', 'cdn', DATA_DRAGON_PATCH, 'data');
    const [en, es, ca] = await Promise.all([fs.readFile(path.join(root, 'en_US', 'champion.json'), 'utf8').then(x => JSON.parse(x).data), fs.readFile(path.join(root, 'es_ES', 'champion.json'), 'utf8').then(x => JSON.parse(x).data), fs.readFile(path.join(__dirname, 'adapters', 'riotgames.pem'))]);
    const championByKey = Object.fromEntries(Object.values(en).map(champion => [String(champion.key), champion.id])), championByName = {};
    for (const champ of Object.values(en)) for (const name of [champ.id, champ.name, es[champ.id]?.name]) if (name) championByName[String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')] = champ.id;
    const liveClient = new LiveClientDataClient({ ca });
    const client = new LcuDraftClient({ championByKey, championByName, liveClient });
    client.on('state', state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lcu:state', state); });
    // Preferences live in appData so an isolated diagnostic userData profile
    // cannot make a previous user opt-in appear to have silently disappeared.
    client.setEnabled(await readLcuEnabled(lcuPreferencePath));
    return client;
  })();
  return lcuDraftClientPromise;
}
async function getAdvisor() {
  if (!advisorPromise) advisorPromise = (async () => {
    const root = path.resolve(__dirname, '..');
    const versions = await fetchDragonJson('api/versions.json');
    const latestPatch = String(versions?.[0] || DATA_DRAGON_PATCH);
    if (!/^\d+\.\d+\.\d+$/.test(latestPatch)) throw new Error('Data Dragon entregó una versión inválida');
    DATA_DRAGON_PATCH = latestPatch;
    const [baseBuildProfiles, pilotBuildProfiles, threatProfiles, matchupAdvice, archetypeSeed, itemAdvice, taxonomy, activationRules, itemPurposeCatalog, itemsResponse, championsResponse] = await Promise.all([
      fs.readFile(path.join(root, 'data', 'champion-build-profiles.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(root, 'data', 'ranked', `pilot-build-profiles-${latestPatch}.json`), 'utf8').then(JSON.parse).catch(() => ({ patch: '', champions: {} })),
      fs.readFile(path.join(root, 'data', 'champion-threat-profiles.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(root, 'data', 'champion-matchup-item-advice.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(root, 'data', 'ranked', 'champion-role-seed-16.21.1.json'), 'utf8').then(JSON.parse).catch(() => ({ champions: {} })),
      fs.readFile(path.join(root, 'data', 'item-advice.json'), 'utf8').then(JSON.parse).catch(() => ({ items: [], rules: [] })),
      fs.readFile(path.join(root, 'data', 'item-taxonomy.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(root, 'data', 'ranked', `item-activation-rules-${latestPatch}.json`), 'utf8').then(JSON.parse).catch(() => ({ patch: latestPatch, rules: [] })),
      fs.readFile(path.join(root, 'data', 'ranked', `item-purposes-${latestPatch}.json`), 'utf8').then(JSON.parse).catch(() => ({ patch: latestPatch, items: {} })),
      fetchDragonJson(`cdn/${latestPatch}/data/en_US/item.json`),
      fetchDragonJson(`cdn/${latestPatch}/data/en_US/champion.json`)
    ]);
    const buildProfiles = { ...baseBuildProfiles, champions: { ...(baseBuildProfiles.champions || {}), ...(pilotBuildProfiles.patch === latestPatch ? pilotBuildProfiles.champions || {} : {}) } };
    const groupsPath = path.join(root, 'data', 'ranked', `item-groups-${latestPatch}.json`);
    const exclusiveGroups = await fs.readFile(groupsPath, 'utf8').then(JSON.parse).catch(() => ({ patch: latestPatch, mapId: '11', status: 'unverified', groups: {} }));
    const itemCatalog = buildItemCatalog({ itemData: itemsResponse.data || itemsResponse, taxonomy, mapId: '11', patch: latestPatch, exclusiveGroups });
    const champions = championsResponse.data || championsResponse;
    const profileChampion = createThreatProfiler({ champions, threatProfiles });
    return { recommend: createBuildAdvisor({ buildProfiles, threatProfiles, matchupAdvice, itemAdvice, itemPurposeCatalog, archetypeSeed, itemCatalog, championDefinitions: champions, itemActivationRules: activationRules, profileChampion, patch: latestPatch, exclusiveGroups }), champions: Object.keys(champions), itemCatalog, exclusiveGroups, buildProfiles, championDefinitions: champions, patch: latestPatch };
  })();
  return advisorPromise;
}

let mainWindow;
let overlayWindow;
// Keep the overlay usable by default. Ctrl+Alt+I enables click-through when the
// player wants to use League controls underneath it.
let overlayInteractive=true;
let launcherWindow;
let tooltipWindow;
let pendingTooltipHtml='';
let tooltipRequestId=0;
let tooltipActive=false;
let tooltipMinSize={width:320,height:320};
let tooltipHideTimer=null;
const TOOLTIP_HIDE_DELAY_MS=700;
function hideTooltip(){if(tooltipHideTimer){clearTimeout(tooltipHideTimer);tooltipHideTimer=null}tooltipActive=false;tooltipRequestId++;tooltipWindow?.hide()}
function scheduleTooltipHide(){if(tooltipHideTimer)clearTimeout(tooltipHideTimer);tooltipHideTimer=setTimeout(()=>{tooltipHideTimer=null;hideTooltip()},TOOLTIP_HIDE_DELAY_MS)}
let tooltipCursor={x:0,y:0};
app.on('web-contents-created',(_event,contents)=>{contents.on('will-navigate',(event,url)=>{event.preventDefault()});contents.setWindowOpenHandler(()=>({action:'deny'}));contents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false))});
const hasSingleInstanceLock=app.requestSingleInstanceLock();
if(!hasSingleInstanceLock)app.quit();
else app.on('second-instance',()=>{if(!mainWindow||mainWindow.isDestroyed()){createMain();return}if(mainWindow.isMinimized())mainWindow.restore();if(!mainWindow.isVisible())mainWindow.show();mainWindow.focus()});
app.on('before-quit',()=>{lcuDraftClientPromise?.then(client=>client.stop()).catch(()=>{})});
let opggSessionId;
let opggRequestId = 1;
const dragonCache = new Map();
const aramAugmentImageCache = new Map();
const opggPresetCache = new Map();
const opggAnalysisCache = new Map();
async function fetchDragonJson(resource) {
  const allowed = resource === 'api/versions.json' || /^cdn\/[\d.]+\/data\/(?:es_ES|en_US)\/(?:champion|item|runesReforged)\.json$/.test(String(resource || '')) || /^cdn\/[\d.]+\/data\/(?:es_ES|en_US)\/champion\/[A-Za-z][A-Za-z0-9_-]{0,31}\.json$/.test(String(resource || ''));
  if (!allowed) throw new Error('Recurso Data Dragon no permitido');
  if (dragonCache.has(resource)) return dragonCache.get(resource);
  const segments=String(resource).split('/');
  const userFile=path.join(app.getPath('userData'),'database','data-dragon',...segments);
  const bundledFile=path.join(__dirname,'..','data','dragon',...segments);
  for(const file of [userFile,bundledFile]) {
    try {const data=JSON.parse(await fs.readFile(file,'utf8'));if(data&&(resource!=='api/versions.json'||Array.isArray(data))){dragonCache.set(resource,data);return data;}}
    catch {}
  }
  let lastError;
  for (let attempt=0;attempt<2;attempt++) {
    try {
      const response=await fetch(`https://ddragon.leagueoflegends.com/${resource}`,{signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error(`Data Dragon respondió ${response.status} (${resource})`);
      const data=await response.json();
      if(!data||(resource==='api/versions.json'&&!Array.isArray(data)))throw new Error(`Respuesta inválida de Data Dragon (${resource})`);
      dragonCache.set(resource,data);
      fs.mkdir(path.dirname(userFile),{recursive:true}).then(()=>fs.writeFile(userFile,JSON.stringify(data),'utf8')).catch(()=>{});
      return data;
    } catch(error) {lastError=error;if(attempt===0)await new Promise(resolve=>setTimeout(resolve,500));}
  }
  for(const file of [userFile,bundledFile]) {
    try {const data=JSON.parse(await fs.readFile(file,'utf8'));if(data&&(resource!=='api/versions.json'||Array.isArray(data))){dragonCache.set(resource,data);return data;}}
    catch {}
  }
  throw new Error(`${lastError?.message||'No se pudo conectar con Data Dragon'}; no hay una copia local disponible para ${resource}`);
}
const championAbilityCache = new ChampionAbilityCache({
  fetchJson: fetchDragonJson,
  readCache: async ({ version, locale, championId }) => JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'database', 'champion-abilities', version, locale, `${championId}.json`), 'utf8')),
  writeCache: async ({ version, locale, championId }, profile) => {
    const file = path.join(app.getPath('userData'), 'database', 'champion-abilities', version, locale, `${championId}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(profile), 'utf8');
  }
});
async function getChampionDetails(championId, locale, version = DATA_DRAGON_PATCH) {
  const resource = championAbilityResource({ championId, locale, version });
  const [profile, response] = await Promise.all([championAbilityCache.get({ championId, locale, version }), fetchDragonJson(resource)]);
  const raw = response?.data?.[championId];
  if (!raw || String(raw.id) !== String(championId) || String(response.version || version) !== String(version)) throw new Error('Data Dragon champion detail does not match the requested version or champion');
  return { ...raw, mechanicsProfile: profile };
}
async function postOpgg(payload) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (opggSessionId) headers['mcp-session-id'] = opggSessionId;
  const response = await fetch('https://mcp-api.op.gg/mcp', { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`OP.GG respondió ${response.status}`);
  const sessionId = response.headers.get('mcp-session-id');
  if (sessionId) opggSessionId = sessionId;
  if (response.status === 202 || payload.method?.startsWith('notifications/')) return null;
  const body = await response.text();
  return parseMcp(body,payload.id,response.headers.get('content-type')?.includes('text/event-stream'));
}
async function initOpgg() {
  if (opggSessionId) return;
  const result = await postOpgg({ jsonrpc: '2.0', id: opggRequestId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rift-companion', version: app.getVersion() } } });
  if (result.error) throw new Error(result.error.message || 'No se pudo iniciar la conexión con OP.GG');
  if (result.result?.protocolVersion) await postOpgg({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
async function fetchOpggMatchup(params) {
  await initOpgg();
  const result = await postOpgg({ jsonrpc: '2.0', id: opggRequestId++, method: 'tools/call', params: { name: 'lol_get_lane_matchup_guide', arguments: params } });
  if (result.error) throw new Error(result.error.message || 'OP.GG no devolvió datos');
  if (result.result?.isError) throw new Error(result.result.content?.map(item => item.text).filter(Boolean).join(' ') || 'OP.GG devolvió un error');
  const content = result.result?.content?.find(item => item.type === 'text')?.text;
  if (!content) throw new Error('La fuente no devolvió contenido');
  const parsed = JSON.parse(content);
  const data = parsed?.data?.summary ? parsed.data : parsed?.summary ? parsed : null;
  if (!data) throw new Error('OP.GG respondió sin estadísticas de campeón; no se guardará una respuesta vacía.');
  return data;
}
async function fetchOpggChampionAnalysis(params) {
  const catalog = await getAdvisor();
  const patchLine = value => String(value || '').match(/^(\d+\.\d+)/)?.[1] || '';
  const key = `${params.my_champion}:${params.position}:${params.lang}:${patchLine(catalog.patch)}`;
  const fresh = value => Date.now() - Date.parse(value?.cachedAt || '') <= 6 * 60 * 60 * 1000 && patchLine(value?.data?.patch) === patchLine(catalog.patch);
  if (opggAnalysisCache.has(key)) {
    const cached = opggAnalysisCache.get(key);
    if (fresh(cached)) return cached;
    opggAnalysisCache.delete(key);
  }
  const file = path.join(app.getPath('userData'), 'database', 'opgg', 'champion-analysis', `${params.my_champion.toLowerCase()}-${params.position}-${params.lang}-${patchLine(catalog.patch)}.json`);
  try {
    await initOpgg();
    const desired_output_fields = [
      'champion','position','data.core_items.{ids[],ids_names[],pick_rate,play,win}','data.boots.{ids[],ids_names[],pick_rate,play,win}',
      'data.starter_items.{ids[],ids_names[],pick_rate,play,win}','data.last_items[].{ids[],ids_names[],pick_rate,play,win}',
      'data.fourth_items[].{ids[],ids_names[],pick_rate,play,win}','data.fifth_items[].{ids[],ids_names[],pick_rate,play,win}','data.sixth_items[].{ids[],ids_names[],pick_rate,play,win}',
      'data.summoner_spells.{ids[],ids_names[],pick_rate,play,win}','data.runes.{id,pick_rate,play,primary_page_id,primary_page_name,primary_rune_ids[],primary_rune_names[],secondary_page_id,secondary_page_name,secondary_rune_ids[],secondary_rune_names[],stat_mod_ids[],stat_mod_names[],win}',
      'data.skill_masteries.builds[].{order[],pick_rate,play,win}','data.skill_masteries.{ids[],pick_rate,play,win}',
      'data.summary.average_stats.{ban_rate,kda,pick_rate,play,win_rate}','data.summary.positions[].{name,stats.{play,win_rate}}','data.trends.win[].{version}'
    ];
    const result = await postOpgg({ jsonrpc:'2.0', id:opggRequestId++, method:'tools/call', params:{ name:'lol_get_champion_analysis', arguments:{ game_mode:'ranked', champion:params.my_champion.toUpperCase(), position:params.position, lang:params.lang, desired_output_fields } } });
    if (result.error) throw new Error(result.error.message || 'OP.GG no devolvió análisis');
    if (result.result?.isError) throw new Error(result.result.content?.map(item=>item.text).filter(Boolean).join(' ') || 'OP.GG devolvió un error');
    const content = result.result?.content?.find(item=>item.type==='text')?.text;
    if (!content) throw new Error('OP.GG no devolvió contenido de análisis');
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = parseOpggClassRepr(content); }
    const raw = parsed?.data || parsed?.result?.data || parsed;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('OP.GG respondió sin un objeto de análisis válido');
    const normalizePosition = value => String(value || '').toLowerCase() === 'bot' ? 'adc' : String(value || '').toLowerCase();
    const normalizedChampion = value => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const returnedChampion = parsed?.champion || '';
    const returnedPosition = parsed?.position || '';
    const contextValid = (!returnedChampion || normalizedChampion(returnedChampion) === normalizedChampion(params.my_champion)) && (!returnedPosition || normalizePosition(returnedPosition) === normalizePosition(params.position));
    if (!contextValid) throw new Error('OP.GG devolvió datos para otro campeón o rol');
    const list = value => Array.isArray(value) ? value : value ? [value] : [];
    const data = { ...raw, champion: returnedChampion || params.my_champion, position: returnedPosition || params.position.toUpperCase(), core_items:list(raw.core_items), boots:list(raw.boots), starter_items:list(raw.starter_items), last_items:list(raw.last_items), fourth_items:list(raw.fourth_items), fifth_items:list(raw.fifth_items), sixth_items:list(raw.sixth_items), combination_items:list(raw.combination_items), single_items:list(raw.single_items), summoner_spells:list(raw.summoner_spells), rune_pages:list(raw.runes), skill_masteries:list(raw.skill_masteries), patch:list(raw.trends?.win)[0]?.version || '' };
    const queryState = data.core_items.some(row => row?.ids?.length) ? 'queried-with-build-data' : 'queried-no-builds';
    const response = { data, source:'OP.GG MCP · lol_get_champion_analysis', sourceStatus:queryState, sourceQueried:true, queryContext:{championId:params.my_champion,position:params.position,requestedAt:new Date().toISOString()}, cachedAt:new Date().toISOString(), championAnalysis:true, offline:false };
    await fs.mkdir(path.dirname(file), { recursive:true }); await fs.writeFile(file, JSON.stringify(response,null,2),'utf8');
    opggAnalysisCache.set(key,response); return response;
  } catch (error) {
    try { const cached=JSON.parse(await fs.readFile(file,'utf8')); const response={...cached,offline:true,error:error.message,sourceQueried:false,sourceStatus:fresh(cached)?cached.sourceStatus:'stale-cache'}; opggAnalysisCache.set(key,response); return response; }
    catch { throw error; }
  }
}
function opggChampionSlug(champion) {
  const raw = String(champion || '').trim();
  const slug = raw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return ({ aurelionsol: 'aurelion-sol', belveth: 'bel-veth', drmundo: 'dr-mundo', chogath: 'cho-gath', kogmaw: 'kog-maw', khazix: 'kha-zix', reksai: 'rek-sai', jarvaniv: 'jarvan-iv', leesin: 'lee-sin', masteryi: 'master-yi', missfortune: 'miss-fortune', nunu: 'nunu-willump', monkeyking: 'wukong', ksante: 'k-sante', tahmkench: 'tahm-kench', twistedfate: 'twisted-fate', xinzhao: 'xin-zhao' })[slug.replace(/-/g, '')] || slug;
}
async function fetchOpggBuildPresets(champion, position) {
  const slug = opggChampionSlug(champion);
  if (!slug) return null;
  const cacheKey = `${slug}:${position || 'all'}`;
  if (opggPresetCache.has(cacheKey)) return opggPresetCache.get(cacheKey);
  const file = path.join(app.getPath('userData'), 'database', 'opgg', 'presets', `${slug}-${position || 'all'}.json`);
  try {
    const url = `https://opgg.gg/en/champions/${encodeURIComponent(slug)}/ranked${position ? `?position=${encodeURIComponent(position)}` : ''}`;
    const response = await fetch(url, { headers: { 'user-agent': `RiftCompanion/${app.getVersion()}` }, signal: AbortSignal.timeout(9000) });
    if (!response.ok) throw new Error(`OP.GG build presets responded ${response.status}`);
    const html = await response.text();
    const presets = [...html.matchAll(/<button\b[^>]*data-preset="([^"]+)"[^>]*>([\s\S]*?)<\/button>/gi)].map(([, key, markup]) => {
      const label = decodeHtml(markup.match(/class="preset__label"[^>]*>([\s\S]*?)<\/span>/i)?.[1]?.replace(/<[^>]*>/g, '') || '');
      const meta = plainHtml(markup.match(/class="preset__meta[^\"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
      const rate = meta.match(/([\d.]+)\s*%\s*WR/i), games = meta.match(/([\d,]+)\s*games?/i);
      const itemIds = [...markup.matchAll(/<img\b[^>]*data-tooltip-id="(\d+)"[^>]*data-tooltip-type="item"[^>]*>/gi)].map(match => match[1]);
      return { key: key.toLowerCase(), label, win_rate: rate ? Number(rate[1]) / 100 : null, games: games ? Number(games[1].replace(/,/g, '')) : 0, item_ids: itemIds };
    }).filter(preset => preset.label && preset.key !== 'recommended');
    const patch = html.match(/Patch\s+([\d.]+)/i)?.[1] || '';
    if (!presets.length) throw new Error('OP.GG did not publish build-type presets for this champion');
    const result = { source: url, patch, presets, cachedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(result, null, 2), 'utf8');
    opggPresetCache.set(cacheKey, result);
    return result;
  } catch {
    try {
      const cached = JSON.parse(await fs.readFile(file, 'utf8'));
      opggPresetCache.set(cacheKey, cached);
      return cached;
    } catch { return null; }
  }
}
function cacheFile(params) {
  const safe = [params.my_champion, params.position, params.opponent_champion, params.lang === 'en_US' ? 'en_US' : 'es_ES'].map(value => String(value).replace(/[^a-z0-9_-]/gi, '').toLowerCase()).join('-');
  return path.join(app.getPath('userData'), 'database', 'opgg', `${safe}.json`);
}
function createMain() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1040, minHeight: 720,
    backgroundColor: '#0b1118', title: 'Rift Companion',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox:true }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed',()=>{mainWindow=null;app.quit()});
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}
function createOverlay() {
  overlayWindow = new BrowserWindow({
    width: 430, height: 620, minWidth: 360, minHeight: 420, resizable: true, useContentSize: true,
    show: false, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true,
    backgroundColor: '#0b1118', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox:true }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setFocusable(overlayInteractive);
  overlayWindow.setIgnoreMouseEvents(!overlayInteractive,{forward:true});
  overlayWindow.on('blur', () => { if (overlayWindow?.isVisible()) overlayWindow.setAlwaysOnTop(true, 'screen-saver'); });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.webContents.on('did-finish-load',()=>overlayWindow?.webContents.send('overlay:interaction-state',overlayInteractive));
  overlayWindow.on('closed', () => { overlayWindow = null; });
}
function createTooltipWindow(){
  if(tooltipWindow&&!tooltipWindow.isDestroyed())return tooltipWindow;
  tooltipWindow=new BrowserWindow({width:460,height:700,show:false,frame:false,resizable:false,focusable:true,skipTaskbar:true,alwaysOnTop:true,hasShadow:true,backgroundColor:'#0b1118',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  tooltipWindow.setAlwaysOnTop(true,'screen-saver');tooltipWindow.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  tooltipWindow.webContents.on('did-finish-load',()=>{if(tooltipActive&&pendingTooltipHtml&&overlayWindow?.isVisible())tooltipWindow?.webContents.send('tooltip:content',{html:pendingTooltipHtml,requestId:tooltipRequestId})});
  tooltipWindow.loadFile(path.join(__dirname,'tooltip.html'));
  tooltipWindow.on('closed',()=>{tooltipWindow=null});return tooltipWindow;
}
function positionTooltipAtCursor(requestedWidth=380,requestedHeight=480){
  if(!tooltipWindow||tooltipWindow.isDestroyed())return;const area=screen.getDisplayNearestPoint(tooltipCursor).workArea,width=Math.max(1,Math.min(Math.ceil(requestedWidth)||380,area.width)),height=Math.max(1,Math.min(Math.ceil(requestedHeight)||480,area.height)),gap=18,right=tooltipCursor.x+gap,left=tooltipCursor.x-width-gap,x=right+width<=area.x+area.width?right:left,y=Math.max(area.y,Math.min(tooltipCursor.y-height-gap,area.y+area.height-height));
  tooltipWindow.setBounds({x:Math.round(Math.max(area.x,Math.min(x,area.x+area.width-width))),y:Math.round(y),width,height});tooltipWindow.setAlwaysOnTop(true,'screen-saver');
}
function createLauncher(){
  if(launcherWindow&&!launcherWindow.isDestroyed())return launcherWindow;
  const area=screen.getPrimaryDisplay().workArea;
  launcherWindow=new BrowserWindow({width:62,height:54,x:area.x+16,y:area.y+area.height-70,frame:false,transparent:true,resizable:false,skipTaskbar:true,alwaysOnTop:true,hasShadow:false,webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  launcherWindow.setAlwaysOnTop(true,'screen-saver');launcherWindow.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});launcherWindow.loadFile(path.join(__dirname,'launcher.html'));launcherWindow.on('closed',()=>launcherWindow=null);return launcherWindow;
}
app.whenReady().then(() => {
  if(!hasSingleInstanceLock)return;
  createMain(); createOverlay(); createTooltipWindow();

  createLauncher();
  globalShortcut.register('Control+Alt+Space', () => {
    if(!launcherWindow||launcherWindow.isDestroyed())createLauncher();
    if(launcherWindow.isVisible())launcherWindow.hide();else launcherWindow.showInactive();
  });
  globalShortcut.register('Control+Shift+Space', () => {
    if (!overlayWindow) createOverlay();
    if (overlayWindow.isVisible()) { overlayWindow.hide(); hideTooltip(); }
    else { overlayWindow.showInactive(); overlayWindow.setIgnoreMouseEvents(!overlayInteractive,{forward:true}); }
  });
  globalShortcut.register('Control+Alt+I',()=>setOverlayInteractive(!overlayInteractive));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMain(); });
});
const originalHandle=ipcMain.handle.bind(ipcMain),originalOn=ipcMain.on.bind(ipcMain);
function trustedSender(channel,event){if(event.sender.isDestroyed())return false;const overlayChannels=['overlay:move','overlay:drag-start','overlay:resize','overlay:tooltip-show','overlay:tooltip-hide','overlay:champion-select','overlay:build-stage-select','overlay:build-choice','overlay:augment-toggle'];if(overlayChannels.includes(channel))return event.sender===overlayWindow?.webContents;if(channel==='tooltip:measure'||channel==='tooltip:pointer-state')return event.sender===tooltipWindow?.webContents;if(channel.startsWith('launcher:'))return event.sender===launcherWindow?.webContents||event.sender===mainWindow?.webContents;if(channel==='overlay:toggle'||channel==='overlay:hide')return event.sender===mainWindow?.webContents||event.sender===overlayWindow?.webContents;return event.sender===mainWindow?.webContents}
ipcMain.handle=(channel,fn)=>originalHandle(channel,(event,...args)=>{if(!trustedSender(channel,event))throw new Error('Untrusted IPC sender');return fn(event,...args)});
ipcMain.on=(channel,fn)=>originalOn(channel,(event,...args)=>{if(trustedSender(channel,event))fn(event,...args)});
ipcMain.on('overlay:toggle', () => {
  if (!overlayWindow) createOverlay();
  if (overlayWindow.isVisible()) { overlayWindow.hide(); hideTooltip(); } else { overlayWindow.showInactive(); overlayWindow.setIgnoreMouseEvents(!overlayInteractive,{forward:true}); }
});
function setOverlayInteractive(active){
  overlayInteractive=active===true;
  if(overlayWindow&&!overlayWindow.isDestroyed()){
    overlayWindow.setIgnoreMouseEvents(!overlayInteractive,{forward:true});
    overlayWindow.setFocusable(overlayInteractive);
    overlayWindow.webContents.send('overlay:interaction-state',overlayInteractive);
    if(overlayInteractive)overlayWindow.focus();else overlayWindow.blur();
  }
  if(!overlayInteractive)hideTooltip();
}
ipcMain.on('overlay:hide', () => { overlayWindow?.hide(); hideTooltip(); });
ipcMain.on('overlay:move', (_event, position) => {
  if (!overlayWindow || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
  const bounds = overlayWindow.getBounds();
  overlayWindow.setBounds({ x: Math.round(position.x), y: Math.round(position.y), width: bounds.width, height: bounds.height });
});
ipcMain.handle('overlay:drag-start', () => overlayWindow?.getBounds() || null);
ipcMain.on('overlay:resize', (_event, size) => {
  if (!overlayWindow || !Number.isFinite(size?.width) || !Number.isFinite(size?.height)) return;
  const bounds = overlayWindow.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  overlayWindow.setBounds({ ...bounds, width: Math.max(360, Math.min(Math.round(size.width), area.width)), height: Math.max(420, Math.min(Math.round(size.height), area.height)) });
});
ipcMain.on('overlay:update', (_event, snapshot) => overlayWindow?.webContents.send('overlay:data', snapshot));
ipcMain.on('overlay:tooltip-show',(event,data)=>{
  if(!overlayWindow||event.sender!==overlayWindow.webContents||typeof data?.html!=='string'||data.html.length>150000)return;
  if(tooltipHideTimer){clearTimeout(tooltipHideTimer);tooltipHideTimer=null}
  pendingTooltipHtml=data.html;tooltipActive=true;tooltipRequestId++;const isItemTooltip=/class=["'][^"']*build-item-tooltip/.test(data.html);tooltipMinSize=isItemTooltip?{width:480,height:520}:{width:360,height:320};
  tooltipWindow?.hide();const win=createTooltipWindow(),bounds=overlayWindow.getBounds();tooltipCursor={x:bounds.x+Math.round(Number(data.cursor?.x)||0),y:bounds.y+Math.round(Number(data.cursor?.y)||0)};
  positionTooltipAtCursor(tooltipMinSize.width,tooltipMinSize.height);
  if(!win.webContents.isLoading())win.webContents.send('tooltip:content',{html:pendingTooltipHtml,requestId:tooltipRequestId});
});
ipcMain.on('tooltip:measure',(event,size)=>{
  if(event.sender!==tooltipWindow?.webContents||!overlayWindow?.isVisible()||!tooltipActive||size?.requestId!==tooltipRequestId)return;
  positionTooltipAtCursor(Math.max(tooltipMinSize.width,Number(size?.width)||0),Math.max(tooltipMinSize.height,Number(size?.height)||0));tooltipWindow.showInactive();
});
ipcMain.on('tooltip:pointer-state',(event,inside)=>{if(event.sender!==tooltipWindow?.webContents)return;if(inside===true){if(tooltipHideTimer){clearTimeout(tooltipHideTimer);tooltipHideTimer=null}}else scheduleTooltipHide()});
ipcMain.on('overlay:tooltip-hide',(event)=>{if(event.sender===overlayWindow?.webContents)scheduleTooltipHide()});
ipcMain.on('overlay:champion-select',(event,data)=>{const validSlot=data?.mode==='aram'?data?.slot==='aram':['my','enemy'].includes(data?.slot);if(event.sender===overlayWindow?.webContents&&validSlot&&typeof data.id==='string')mainWindow?.webContents.send('overlay:champion-select',data)});
ipcMain.on('overlay:build-stage-select',(event,stage)=>{if(event.sender===overlayWindow?.webContents&&['early','mid','late'].includes(stage))mainWindow?.webContents.send('overlay:build-stage-select',stage)});
ipcMain.on('overlay:build-choice',(event,choice)=>{if(event.sender!==overlayWindow?.webContents||!choice||typeof choice!=='object')return;if(typeof choice.itemId==='string'&&/^\d{1,10}$/.test(choice.itemId)){mainWindow?.webContents.send('overlay:build-choice',{itemId:choice.itemId});return}if(!['standard','lane','team'].includes(choice.scenario)||typeof choice.variantId!=='string'||choice.variantId.length>160)return;mainWindow?.webContents.send('overlay:build-choice',{scenario:choice.scenario,variantId:choice.variantId})});
ipcMain.on('overlay:augment-toggle',(event,augmentId)=>{if(event.sender!==overlayWindow?.webContents||typeof augmentId!=='string'||!/^[-a-z0-9]{1,96}$/i.test(augmentId))return;mainWindow?.webContents.send('overlay:augment-toggle',augmentId)});
ipcMain.on('overlay:return-live',(event)=>{if(event.sender===overlayWindow?.webContents)mainWindow?.webContents.send('overlay:return-live')});
ipcMain.on('launcher:toggle-guide',()=>{if(!overlayWindow)createOverlay();if(overlayWindow.isVisible()){overlayWindow.hide();hideTooltip()}else{overlayWindow.showInactive();overlayWindow.setIgnoreMouseEvents(!overlayInteractive,{forward:true})}});
ipcMain.handle('data:aram', async () => {
  const dir = path.join(__dirname, '..', 'data', 'aram-mayhem');
  const names = ['champions', 'augments', 'combos', 'items'];
  const data = {};
  for (const name of names) data[name] = JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), 'utf8'));
  data.synergyProfiles = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'aram-augment-synergy-profiles.json'), 'utf8'));
  data.catalog26 = loadMayhemCatalog(path.resolve(__dirname, '..'));
  data.interactionEvidence = JSON.parse(await fs.readFile(path.join(dir, 'interaction-evidence.json'), 'utf8'));
  data.itemRules = JSON.parse(await fs.readFile(path.join(dir, 'item-rules.json'), 'utf8'));
  data.transformations = JSON.parse(await fs.readFile(path.join(dir, 'transformations.json'), 'utf8'));
  return data;
});
ipcMain.handle('data:dragon', (_event, resource) => fetchDragonJson(resource));
ipcMain.handle('data:patch-compatibility', async (_event, request = {}) => {
  const { patch } = await getAdvisor();
  const relations = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'ranked', 'patch-relations.json'), 'utf8')).relations || [];
  const relation = relations.find(row => String(row.dataDragonVersion) === String(patch));
  return comparePatchVersions({
    publishedGamePatch: relation?.publishedGamePatch || '', dataDragonVersion: patch,
    statisticsPatch: typeof request.statisticsPatch === 'string' ? request.statisticsPatch.slice(0, 24) : '',
    regionalServerVersion: typeof request.regionalServerVersion === 'string' ? request.regionalServerVersion.slice(0, 32) : '',
    relations
  });
});
ipcMain.handle('data:champion-abilities', async (_event, request) => {
  if (!request || typeof request.championId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(request.championId)) throw new Error('Invalid champion ID');
  const { patch } = await getAdvisor(), version = String(request.version || patch), locale = String(request.locale || 'en_US');
  if (version !== patch || !['en_US', 'es_ES'].includes(locale)) throw new Error('Unsupported champion ability cache version or locale');
  return championAbilityCache.get({ championId: request.championId, locale, version });
});
ipcMain.handle('data:champion-details', async (_event, request) => {
  if (!request || typeof request.championId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(request.championId)) throw new Error('Invalid champion ID');
  const { patch } = await getAdvisor(), version = String(request.version || patch), locale = String(request.locale || 'en_US');
  if (version !== patch || !['en_US', 'es_ES'].includes(locale)) throw new Error('Unsupported champion detail version or locale');
  return getChampionDetails(request.championId, locale, version);
});
ipcMain.handle('data:item-advice', async () => JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'item-advice.json'), 'utf8')));
ipcMain.handle('data:item-taxonomy', async () => JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'item-taxonomy.json'), 'utf8')));
ipcMain.handle('data:ranked-item-purposes', async () => JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'ranked', `item-purposes-${DATA_DRAGON_PATCH}.json`), 'utf8')));
ipcMain.handle('data:champion-build-profiles', async () => JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'champion-build-profiles.json'), 'utf8')));
ipcMain.handle('data:ranked-item-groups', async () => (await getAdvisor()).exclusiveGroups);
ipcMain.handle('build:recommend', async (_event, payload) => {
  if (!payload || !['es', 'en'].includes(payload.language)) throw new Error('Invalid build request');
  const { recommend, champions, buildProfiles, patch } = await getAdvisor();
  const roster = normalizeRoster(payload.roster || {}), checked = validateRoster(roster, champions);
  if (!checked.valid) return { options: [], status: 'invalid-roster', errors: checked.errors };
  const player = checked.roster.player || {}, championId = String(player.championId || ''), role = String(player.role || '');
  let championMechanics;
  try {
    const locale = payload.language === 'en' ? 'en_US' : 'es_ES';
    const abilityProfile = await championAbilityCache.get({ championId, locale, version: patch });
    const editorialProfiles = buildProfiles.champions?.[championId]?.roles?.[role] || buildProfiles.champions?.[championId]?.roles?.[role === 'adc' ? 'bot' : role] || [];
    let merakiProfile = null;
    try { merakiProfile = await getMerakiKnowledgeAdapter().getChampion({ championId, expectedPatch: patch }); } catch {}
    const mergedKnowledge = mergeAbilityEvidence(abilityProfile, merakiProfile ? [merakiProfile] : []);
    championMechanics = createChampionMechanicsProfile(abilityProfile, { role, editorialProfiles: Array.isArray(editorialProfiles) ? editorialProfiles : [editorialProfiles], supplementalRecords: mergedKnowledge.supplementalRecords });
    championMechanics.knowledgeSources = {
      official: { status: abilityProfile.status, patch: abilityProfile.version, retrievedAt: abilityProfile.provenance?.sourceDate || '' },
      meraki: { status: merakiProfile?.status || 'not-queried', sourcePatch: merakiProfile?.sourcePatch || '', ignored: mergedKnowledge.ignoredSources.length > 0 },
      communityDragon: 'blocked-license-unverified'
    };
    if (mergedKnowledge.ignoredSources.length) championMechanics.warnings.push('La fuente complementaria no se integró (sin respuesta o parche incompatible); se mantiene Data Dragon.');
  } catch (error) {
    championMechanics = { championId, championName: championId, role, patch, status: 'insufficient-data', damageTypes: [], scalings: [], mechanics: [], buildArchetypes: [], coverage: { abilityCount: 0, expectedAbilityCount: 5, scalingCount: 0 }, warnings: [String(error?.message || 'Champion ability data unavailable').slice(0, 180)] };
  }
  const result = recommend({ ...checked.roster, championMechanics, publishedData: payload.publishedData || null, sourceError: payload.sourceError === true }, payload.language);
  if (!app.isPackaged || process.env.RIFT_DEBUG_RANKED === '1') {
    const diagnostic = result?.diagnostics;
    if (diagnostic) console.info('[RankedBuild]', JSON.stringify(diagnostic));
  }
  return result;
});
ipcMain.handle('riot:diagnostics', async () => ({ ...riotWebClient.diagnostics(), dataDragonVersion: DATA_DRAGON_PATCH, rosterSources: ['manual', 'lcu', 'live_client'], riotWebApi: 'separate-from-client-apis', lcu: 'experimental-read-only', liveClientData: 'experimental-read-only' }));
ipcMain.handle('lcu:state', async (event) => {
  if (event.sender !== mainWindow?.webContents) return { status: 'integration_disabled', source: 'lcu', roster: null };
  return (await getLcuDraftClient()).getState();
});
ipcMain.handle('lcu:set-enabled', async (event, enabled) => {
  if (event.sender !== mainWindow?.webContents) return { ok: false, status: 'untrusted-sender' };
  if (typeof enabled !== 'boolean') return { ok: false, status: 'invalid-preference' };
  try {
    await writeLcuEnabled(lcuPreferencePath, enabled);
    const client = await getLcuDraftClient();
    const state = client.setEnabled(enabled);
    return { ok: true, enabled, state };
  } catch {
    return { ok: false, enabled: !enabled, status: 'preference-save-failed' };
  }
});
ipcMain.handle('live:refresh', async event => {
  if (event.sender !== mainWindow?.webContents) return { status: 'untrusted-sender' };
  return (await getLcuDraftClient()).refreshLiveSnapshot();
});
ipcMain.handle('live:select-player', async (event, participantIndex) => {
  if (event.sender !== mainWindow?.webContents || !Number.isInteger(participantIndex) || participantIndex < 0 || participantIndex > 9) return { status: 'invalid-selection' };
  return (await getLcuDraftClient()).refreshLiveSnapshot({ manualPlayerIndex: participantIndex });
});
ipcMain.handle('riot:test-connection', async (_event, platform) => {
  if (typeof platform !== 'string' || !/^(br1|eun1|euw1|jp1|kr|la1|la2|na1|oc1|ph2|sg2|th2|tw2|vn2|tr1|ru)$/.test(platform)) throw new Error('Invalid platform');
  try { await riotWebClient.platformStatus(platform); return { ok: true, status: 'available' }; }
  catch (error) { return { ok: false, status: error.code || 'unavailable', message: error.message, retryAfterMs: error.retryAfterMs || 0 }; }
});
ipcMain.handle('riot:own-recent-matches', async (_event, input) => {
  const name = String(input?.gameName || '').trim(), tag = String(input?.tagLine || '').trim(), platform = input?.platform;
  if (!name || !tag || name.length > 64 || tag.length > 16 || typeof platform !== 'string' || !/^(br1|eun1|euw1|jp1|kr|la1|la2|na1|oc1|ph2|sg2|th2|tw2|vn2|tr1|ru)$/.test(platform)) throw new Error('Riot ID or platform is invalid');
  try {
    const account = await riotWebClient.accountByRiotId(name, tag, platform);
    const ids = await riotWebClient.matchIds(account.puuid, platform, { count: 5 });
    const matches = await Promise.all((ids || []).slice(0, 5).map(id => riotWebClient.match(id, platform)));
    return { ok: true, matches: matches.map(match => {
      const info = match?.info, own = info?.participants?.find(player => player.puuid === account.puuid);
      if (!own) return null;
      return { championId: String(own.championId || ''), championName: String(own.championName || ''), role: String(own.teamPosition || ''), queueId: Number(info.queueId || 0), gameMode: String(info.gameMode || ''), gameDuration: Math.max(0, Number(info.gameDuration || 0)), gameCreation: Math.max(0, Number(info.gameCreation || 0)), items: [own.item0, own.item1, own.item2, own.item3, own.item4, own.item5].map(Number).filter(Boolean) };
    }).filter(Boolean) };
  } catch (error) { return { ok: false, status: error.code || 'unavailable', message: error.message, retryAfterMs: error.retryAfterMs || 0 }; }
});
ipcMain.handle('item-set:export', async (_event, payload) => {
  if (!payload || !['ranked', 'aram'].includes(payload.mode)) throw new Error('Modo de Item Set inválido');
  const { itemCatalog, exclusiveGroups, patch } = await getAdvisor();
  const root = path.resolve(__dirname, '..'), catalog = (await fetchDragonJson(`cdn/${patch}/data/en_US/champion.json`)).data;
  const champ = Object.values(catalog).find(c => c.id === payload.championId);
  if (!champ) throw new Error('Campeón desconocido');
  const itemData = (await fetchDragonJson(`cdn/${patch}/data/en_US/item.json`)).data;
  const itemSet = createItemSet({ champion: champ.name, championId: champ.key, title: payload.title, mode: payload.mode, blocks: payload.blocks, itemCatalog: itemData, exclusiveGroups, patch });
  const result = await dialog.showSaveDialog(mainWindow, { title: 'Exportar Item Set', defaultPath: `Rift Companion - ${champ.name}.json`, filters: [{ name: 'Item Set JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  const handle = await fs.open(result.filePath, 'wx');
  try { await handle.writeFile(JSON.stringify(itemSet, null, 2), 'utf8'); } finally { await handle.close(); }
  return { canceled: false, filePath: result.filePath };
});
ipcMain.handle('item-set:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Importar Item Set', properties: ['openFile'], filters: [{ name: 'Item Set JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const stat = await fs.stat(result.filePaths[0]); if (stat.size > 2_000_000) throw new Error('El archivo supera el límite de 2 MB');
  const root = path.resolve(__dirname, '..'), source = await fs.readFile(result.filePaths[0], 'utf8'), parsed = JSON.parse(source);
  const currentPatch = (await getAdvisor()).patch;
  const itemData = (await fetchDragonJson(`cdn/${currentPatch}/data/en_US/item.json`)).data;
  const imported = importItemSet(parsed, itemData, parsed.map === 'HA' ? '12' : '11');
  return { canceled: false, imported };
});
ipcMain.handle('aram:evaluate-augments', async (_event, payload) => {
  if (!payload || !Array.isArray(payload.candidates) || payload.candidates.length > 80 || !Array.isArray(payload.selected) || payload.selected.length > 12 || !Array.isArray(payload.itemIds || []) || (payload.itemIds || []).length > 6 || !Array.isArray(payload.boughtItemIds || []) || (payload.boughtItemIds || []).length > 6 || !Array.isArray(payload.enemyIds || []) || (payload.enemyIds || []).length > 5) throw new Error('Selección de aumentos inválida');
  const root = path.resolve(__dirname, '..'), [catalog, champions, items, evidence] = await Promise.all([
    Promise.resolve(loadMayhemCatalog(root)),
    fs.readFile(path.join(root, 'data', 'dragon', 'cdn', DATA_DRAGON_PATCH, 'data', 'en_US', 'champion.json'), 'utf8').then(x => JSON.parse(x).data),
    fs.readFile(path.join(root, 'data', 'dragon', 'cdn', DATA_DRAGON_PATCH, 'data', 'en_US', 'item.json'), 'utf8').then(x => JSON.parse(x).data),
    fs.readFile(path.join(root, 'data', 'aram-mayhem', 'interaction-evidence.json'), 'utf8').then(JSON.parse)
  ]);
  const champ = Object.values(champions).find(c => c.id === payload.championId); if (!champ) throw new Error('Campeón inválido');
  const augmentBySlug = new Map(availableAugments(catalog).map(a => [a.slug, a]));
  const candidates = payload.candidates.map(id => augmentBySlug.get(String(id))).filter(Boolean);
  if (candidates.length !== payload.candidates.length) throw new Error('Aumento desconocido o retirado');
  const selected = payload.selected.map(id => { if (!augmentBySlug.has(String(id))) throw new Error('Aumento previo desconocido'); return String(id); });
  const [mayhemItems, transformations] = await Promise.all([
    fs.readFile(path.join(root, 'data', 'aram-mayhem', 'items.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'data', 'aram-mayhem', 'transformations.json'), 'utf8').then(JSON.parse)
  ]);
  const itemValidation = payload.itemIds?.length ? validateMayhemBuild({ itemIds: payload.itemIds, itemData: items, mayhemItems: mayhemItems.rows, transformations: transformations.transformations }) : null;
  const results = evaluateAugments({ championId: champ.id, headlinerId: String(payload.headliner || ''), selectedAugments: selected, candidateAugments: candidates, evidence, language: payload.language === 'en' ? 'en' : 'es' });
  const buildAdaptation = adaptMayhemBuild({ itemIds: payload.itemIds || [], selectedAugments: selected, boughtItemIds: payload.boughtItemIds || [], interactions: evidence.interactions || [], conversionRules: evidence.conversionRules || [], baseStats: {}, patch: catalog.patch, language: payload.language === 'en' ? 'en' : 'es' });
  const enemyIds = [...new Set((payload.enemyIds || []).map(String).filter(id => Object.values(champions).some(row => row.id === id)))].slice(0, 5);
  const enemyContext = { status: enemyIds.length ? 'recorded-no-reviewed-counter-rule' : 'not-provided', ids: enemyIds, explanation: enemyIds.length ? (payload.language === 'en' ? 'Enemy champions are recorded, but no Mayhem-specific augment counter rule is verified for this composition; no item swap is inferred.' : 'Se registraron los enemigos, pero no hay una regla de contraataque de aumentos específica de Mayhem verificada para esta composición; no se infiere un cambio de objetos.') : (payload.language === 'en' ? 'No enemy champions entered.' : 'No se ingresaron campeones enemigos.') };
  return { results, buildAdaptation, itemValidation, enemyContext, patch: catalog.patch, statsPatch: catalog.basePatch, source: payload.language === 'en' ? 'official patch evidence + reviewed local champion interactions; no outcome statistics' : 'evidencia oficial del parche + interacciones de campeón revisadas; sin estadísticas de resultados', headliner: catalog.headliners.rows.find(row => row.id === payload.headliner) || null, enemyIds };
});
function decodeHtml(value) {
  return String(value || '').replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&nbsp;/g, ' ');
}
function plainHtml(value) { return decodeHtml(String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function tagBlock(html, tag, start) {
  const re = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'); re.lastIndex = start; let depth = 0, match;
  while ((match = re.exec(html))) { if (match[0][1] === '/') depth--; else if (!/\/>$/.test(match[0])) depth++; if (depth === 0) return html.slice(start, re.lastIndex); }
  return '';
}
function aramSection(html, heading) {
  const needle = `>${heading}</div>`, at = html.indexOf(needle);
  if (at < 0) return '';
  const start = html.lastIndexOf('<section', at);
  return start < 0 ? '' : tagBlock(html, 'section', start);
}
function aramBuildRows(html, heading, limit = 3) {
  const section = aramSection(html, heading), rows = [], marker = '<div class="flex flex-col gap-2 rounded-md border border-border/30 bg-background/50 p-2 sm:flex-row sm:items-center"';
  let from = 0, at;
  while ((at = section.indexOf(marker, from)) >= 0) {
    const block = tagBlock(section, 'div', at);
    if (!block) break;
    const names = [...block.matchAll(/<a\b[^>]*title="([^"]+)"/gi)].map(m => decodeHtml(m[1]));
    const text = plainHtml(block), rates = text.match(/Pick Rate\s+([\d.]+%)\s+Win Rate\s+([\d.]+%)/i);
    if (names.length) rows.push({ items: names, pickRate: rates?.[1] || '', winRate: rates?.[2] || '' });
    from = at + block.length;
  }
  return rows.sort((a,b) => Number(b.pickRate.replace('%','')) - Number(a.pickRate.replace('%',''))).slice(0, limit);
}
function aramBestAugments(html) {
  const headings = [...html.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi)], startHeading = headings.find(match => /^Best Augments for\b/i.test(plainHtml(match[0])));
  if (!startHeading) return [];
  const after = headings.find(match => match.index > startHeading.index && /^Augment Combos for\b/i.test(plainHtml(match[0])));
  const section = html.slice(startHeading.index + startHeading[0].length, after?.index ?? html.length), rows = [];
  for (const match of section.matchAll(/<a\b[^>]*href="\/augments\/([^/"?#]+)\/?(?:[?#][^"]*)?"[^>]*>/gi)) {
    const block = tagBlock(section, 'a', match.index);
    if (!block) continue;
    const name = decodeHtml(block.match(/\btitle="([^"]+)"/i)?.[1] || block.match(/<img\b[^>]*alt="([^"]+)"/i)?.[1] || ''), text = plainHtml(block);
    const appearanceRate = Number(text.match(/Appearance rate\s*:\s*([\d.]+)\s*%/i)?.[1]);
    const rankText = plainHtml(block.match(/data-recommendation-rank="rarity"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''), sourceTier = rankText.match(/\b(S\+?|A\+?|B\+?|C|D|F)(?:\s|·|$)/i)?.[1] || '';
    if (!name || !Number.isFinite(appearanceRate)) continue;
    const position = rows.length + 1;
    rows.push({ name, url: `https://arammayhem.com/augments/${match[1]}/`, slug: match[1], position, rarity: position <= 6 ? 'prismatic' : position <= 12 ? 'gold' : 'silver', appearanceRate, sourceTier, source: 'champion' });
  }
  return rows.slice(0, 18);
}
function aramComboRows(html, championSlug) {
  const marker = 'data-combo-card', at = html.indexOf(marker);
  if (at < 0) return [];
  const sectionStart = html.lastIndexOf('<section', at), section = sectionStart >= 0 ? tagBlock(html, 'section', sectionStart) : '';
  const cards = [], markers = [...section.matchAll(/<(article|div)\b[^>]*data-combo-card[^>]*>/gi)];
  for (const match of markers) {
    const tag = match[1].toLowerCase(), block = tagBlock(section, tag, match.index);
    if (!block) continue;
    const title = decodeHtml(block.match(/<span class="font-medium"[^>]*>([\s\S]*?)<\/span>/i)?.[1]?.replace(/<[^>]*>/g,'')) || decodeHtml(block.match(/title="([^"]+)"/i)?.[1]);
    const description = plainHtml(block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    const href = block.match(/href="(\/combo\/[^"]+)"/i)?.[1], tier = decodeHtml(block.match(/data-slot="badge"[^>]*>([A-Z][+-]?)<\/span>/i)?.[1]);
    const augmentIds = [...block.matchAll(/href="\/augments\/([^/"?#]+)\/?(?:[?#][^"]*)?"/gi)].map(item => item[1]);
    if (title) cards.push({ title, description, tier: tier || '', augmentIds, url: href ? `https://arammayhem.com${href}` : `https://arammayhem.com/build/${championSlug}/` });
  }
  return cards.slice(0, 5);
}
function aramggSummonerSpells(html) {
  const at=html.indexOf('Summoner Spells');
  if(at<0)return [];
  const start=html.lastIndexOf('<section',at),section=start>=0?tagBlock(html,'section',start):'';
  if(!section)return [];
  return [...section.matchAll(/<article\b[^>]*>/gi)].map(match=>{
    const block=tagBlock(section,'article',match.index);if(!block)return null;
    const ids=[...block.matchAll(/summoner-spell-icons\/(\d+)\.png/gi)].map(x=>Number(x[1]));
    const names=[...block.matchAll(/<img\b[^>]*alt="([^"]+)"/gi)].map(x=>decodeHtml(x[1]));
    if(ids.length<2||names.length<2)return null;
    const stats=plainHtml(block),pickRate=stats.match(/Pick Rate:\s*([\d.]+%)/i)?.[1]||'',winRate=stats.match(/Win Rate:\s*([\d.]+%)/i)?.[1]||'',games=stats.match(/Games:\s*([\d,]+)/i)?.[1]||'';
    return {ids:ids.slice(0,2),names:names.slice(0,2),icons:[...block.matchAll(/<img\b[^>]*src="([^"]*summoner-spell-icons\/\d+\.png)"/gi)].map(x=>x[1]).slice(0,2),pickRate,winRate,games};
  }).filter(Boolean).slice(0,4);
}
async function fetchAramggSummonerSpells(championKey) {
  if(!/^\d+$/.test(String(championKey||'')))return [];
  try{
    const response=await fetch(`https://aramgg.com/en/champion-stats/${championKey}`,{signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error(`ARAM.GG respondió ${response.status}`);
    return aramggSummonerSpells(await response.text());
  }catch{return []}
}
async function fetchAramChampion(slug, championKey) {
  if (!/^[a-z0-9-]+$/i.test(String(slug || ''))) throw new Error('Campeón ARAM no válido');
  const cachePath = path.join(app.getPath('userData'), 'database', 'aram-mayhem', `${slug.toLowerCase()}.json`);
  try {
    const response = await fetch(`https://arammayhem.com/build/${encodeURIComponent(slug)}/`, { headers: { 'user-agent': `RiftCompanion/${app.getVersion()}` }, signal:AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`ARAM Mayhem respondió ${response.status}`);
    const html = await response.text();
    const summary = plainHtml(tagBlock(html, 'header', html.indexOf('<header id="champion-summary"')));
    if (!summary || !html.includes('Core Builds')) throw new Error('No se encontró la guía publicada para este campeón');
    const [summonerSpells]=await Promise.all([fetchAramggSummonerSpells(championKey)]);
    const data = { champion: slug, patch: html.match(/Patch:\s*([\d.]+)/i)?.[1] || '', statsDate: summary.match(/Data date\s+(\d{4}-\d{2}-\d{2})/i)?.[1] || '', winRate: summary.match(/Win Rate\s+([\d.]+%)/i)?.[1] || '', pickRate: summary.match(/Pick Rate\s+([\d.]+%)/i)?.[1] || '', starting: aramBuildRows(html, 'Starting Items'), boots: aramBuildRows(html, 'Boots'), builds: aramBuildRows(html, 'Core Builds'), otherItems: aramBuildRows(html, 'Other completed items', 30), augments: aramBestAugments(html), combos: aramComboRows(html, slug), summonerSpells, summonerSpellsSource:`https://aramgg.com/en/champion-stats/${championKey}`, source: `https://arammayhem.com/build/${slug}/` };
    if (!data.builds.length) throw new Error('La página no devolvió builds legibles');
    const cachedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ cachedAt, data }, null, 2), 'utf8');
    return { data, cachedAt, offline: false };
  } catch (error) {
    try { const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));if(!cached.data.summonerSpells?.length){cached.data.summonerSpells=await fetchAramggSummonerSpells(championKey);cached.data.summonerSpellsSource=`https://aramgg.com/en/champion-stats/${championKey}`;if(cached.data.summonerSpells.length)await fs.writeFile(cachePath,JSON.stringify(cached,null,2),'utf8')}return { data: cached.data, cachedAt: cached.cachedAt, offline: true, error: error.message }; }
    catch { return { data: null, error: error.message }; }
  }
}
ipcMain.handle('aram:champion', (_event, slug, championKey) => {if(typeof slug!=='string'||!/^[-a-z0-9]{1,80}$/i.test(slug)||!/^[0-9]{1,5}$/.test(String(championKey)))throw new Error('Invalid champion');return fetchAramChampion(slug,championKey)});
async function fetchAramAugmentImage(slug, locale = 'en') {
  if (!/^[a-z0-9-]+$/i.test(String(slug || ''))) return null;
  const augmentSlug = String(slug).toLowerCase(), key = `${augmentSlug}:${locale === 'es' ? 'es' : 'en'}`;
  const localAugment = loadMayhemCatalog(path.resolve(__dirname, '..')).rows.find(row => row.slug === augmentSlug);
  if (aramAugmentImageCache.has(key)) return aramAugmentImageCache.get(key);
  const detailPath = path.join(app.getPath('userData'), 'database', 'aram-mayhem', 'augment-details', `${augmentSlug}-${locale === 'es' ? 'es' : 'en'}.json`);
  let cached = null;
  try { cached = JSON.parse(await fs.readFile(detailPath, 'utf8')); if (cached?.image) { const hydrated = { ...cached, description: cached.description || localAugment?.description || '' }; aramAugmentImageCache.set(key, hydrated); return hydrated; } } catch {}
  try {
    const file = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'aram-mayhem', 'augments.json'), 'utf8'));
    const augment = file.rows.find(row => row.slug === augmentSlug) || localAugment;
    if (!augment) return null;
    const pageUrl = augment.url || `https://arammayhem.com/augments/${encodeURIComponent(augmentSlug)}/`;
    const response = await fetch(pageUrl, { headers: { 'user-agent': `RiftCompanion/${app.getVersion()}` }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`ARAM Mayhem respondió ${response.status}`);
    const html = await response.text();
    const imageCandidates = [...html.matchAll(/<img\b[^>]*>/gi)].map(match => [...match[0].matchAll(/(?:src|data-src|data-original)="([^"]+)"/gi)].map(value => value[1])).flat();
    const image = imageCandidates.find(src => /\/augments\/[^"'\s]+\.(?:png|webp|jpe?g)(?:\?[^"'\s]*)?$/i.test(src));
    const effectAt = html.indexOf('<div class="text-base md:text-lg text-muted-foreground">'), effectBlock = effectAt >= 0 ? tagBlock(html, 'div', effectAt) : '';
    let description = plainHtml(effectBlock) || decodeHtml(html.match(/<meta\s+(?:name|property)="(?:description|og:description)"\s+content="([^"]+)"/i)?.[1] || cached?.description || localAugment?.description || '');
    if (description && locale === 'es') {
      try {
        const query = new URLSearchParams({ client: 'gtx', sl: 'en', tl: 'es', dt: 't', q: description });
        const translation = await fetch(`https://translate.googleapis.com/translate_a/single?${query}`, { signal: AbortSignal.timeout(9000) });
        if (translation.ok) { const payload = await translation.json(); const translated = (payload?.[0] || []).map(part => part?.[0] || '').join('').trim(); if (translated) description = translated; }
      } catch {}
    }
    const url = image ? new URL(image, pageUrl).href : null;
    const result = { image: url, description };
    if (url || description) { aramAugmentImageCache.set(key, result); await fs.mkdir(path.dirname(detailPath), { recursive: true }); await fs.writeFile(detailPath, JSON.stringify(result), 'utf8'); }
    return result;
  } catch { return localAugment?.description ? { image: null, description: localAugment.description } : null; }
}
ipcMain.handle('aram:augment-image', (_event, slug, locale) => {if(typeof slug!=='string'||!/^[-a-z0-9]{1,120}$/i.test(slug)||!['es','en'].includes(locale))throw new Error('Invalid augment');return fetchAramAugmentImage(slug,locale)});
ipcMain.handle('opgg:matchup', async (_event, params) => {
  if(!params||!['top','jungle','mid','adc','support'].includes(params.position)||!['my_champion','opponent_champion'].every(k=>typeof params[k]==='string'&&/^[A-Za-z0-9_]{1,40}$/.test(params[k]))||!['es_ES','en_US'].includes(params.lang))throw new Error('Invalid matchup parameters');
  const cachePath = cacheFile(params);
  try {
    const [data, buildPresets] = await Promise.all([
      fetchOpggMatchup({ ...params, lang: params.lang === 'en_US' ? 'en_US' : 'es_ES' }),
      fetchOpggBuildPresets(params.my_champion, params.position)
    ]);
    if (buildPresets) data.build_presets = buildPresets;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ cachedAt: new Date().toISOString(), ...cacheMeta(params,data), data }, null, 2), 'utf8');
    return { data, cachedAt: new Date().toISOString(), offline: false };
  } catch (error) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      if(!cached.lang)cached.lang=params.lang;
      const freshness=cacheState(cached,params.lang==='en_US'?'en_US':'es_ES');
      const cachedData = cached.data?.data?.summary ? cached.data.data : cached.data;
      if (!cachedData?.summary) throw new Error('Caché de OP.GG sin estadísticas válidas');
      return { data: cachedData, cachedAt: cached.cachedAt, offline: true, ...freshness, error: error.message };
    } catch {
      return { data: null, error: error.message };
    }
  }
});
ipcMain.handle('opgg:champion-analysis', async (_event, params) => {
  if (!params || !/^[A-Za-z0-9_]{1,40}$/.test(params.champion) || !['top','jungle','mid','adc','support'].includes(params.position) || !['es_ES','en_US'].includes(params.lang)) throw new Error('Invalid champion analysis parameters');
  return fetchOpggChampionAnalysis({ my_champion:params.champion, position:params.position, lang:params.lang });
});
app.on('will-quit', () => globalShortcut.unregisterAll());
let terminating=false;app.on('before-quit',event=>{if(terminating)return;event.preventDefault();terminating=true;globalShortcut.unregisterAll();for(const win of [tooltipWindow,overlayWindow,launcherWindow])if(win&&!win.isDestroyed())win.destroy();app.quit()});
app.on('window-all-closed', () => { app.quit(); });
