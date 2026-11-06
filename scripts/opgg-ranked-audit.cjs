const fs = require('node:fs/promises');
const path = require('node:path');
const { parseOpggClassRepr } = require('../src/provider-core.cjs');

const ENDPOINT = 'https://mcp-api.op.gg/mcp';
const OUTPUT = path.resolve(__dirname, '..', 'data', 'ranked', 'opgg-live-audit-batch-2026-11-04-expansion.json');
const PAIRS = [
  ['Annie', 'MID', 'burst-mage'], ['LeBlanc', 'MID', 'burst-mage-assassin'], ['Veigar', 'MID', 'scaling-burst-mage'],
  ['Viktor', 'MID', 'dps-mage'], ['Cassiopeia', 'MID', 'dps-mage'], ['Brand', 'MID', 'dot-mage'], ['Vex', 'MID', 'burst-mage'],
  ['Fizz', 'MID', 'ap-assassin'], ['Akali', 'MID', 'ap-assassin'], ['Evelynn', 'JUNGLE', 'ap-assassin'], ['Diana', 'JUNGLE', 'ap-assassin-engage'],
  ['KhaZix', 'JUNGLE', 'ad-assassin'], ['Talon', 'MID', 'ad-assassin'], ['Qiyana', 'MID', 'ad-assassin'], ['Naafiri', 'MID', 'ad-assassin'],
  ['Darius', 'TOP', 'bruiser'], ['Sett', 'TOP', 'bruiser'], ['Riven', 'TOP', 'ad-bruiser'], ['Fiora', 'TOP', 'duelist-bruiser'], ['Gwen', 'TOP', 'ap-bruiser'],
  ['Sion', 'TOP', 'tank'], ['Zac', 'JUNGLE', 'tank-engage'], ['Sejuani', 'JUNGLE', 'tank-engage'], ['Poppy', 'TOP', 'tank-counter-engage'],
  ['Alistar', 'SUPPORT', 'engage-support'], ['Rell', 'SUPPORT', 'engage-support'], ['Nautilus', 'SUPPORT', 'engage-support'], ['Rakan', 'SUPPORT', 'engage-support'],
  ['Janna', 'SUPPORT', 'enchanter'], ['Lulu', 'SUPPORT', 'enchanter'], ['Nami', 'SUPPORT', 'enchanter'], ['Milio', 'SUPPORT', 'enchanter'],
  ['Ashe', 'ADC', 'crit-utility-carry'], ['Tristana', 'ADC', 'crit-carry'], ['Aphelios', 'ADC', 'crit-carry'], ['Xayah', 'ADC', 'crit-carry'], ['Jhin', 'ADC', 'crit-caster'],
  ['Vayne', 'ADC', 'on-hit-carry'], ['KogMaw', 'ADC', 'on-hit-carry'], ['Varus', 'ADC', 'on-hit-hybrid-carry'], ['KaiSa', 'ADC', 'hybrid-on-hit-carry'], ['Kayle', 'TOP', 'scaling-on-hit-hybrid'],
  ['Shyvana', 'JUNGLE', 'hybrid-scaling-fighter'], ['Twitch', 'ADC', 'on-hit-ap-hybrid-carry'], ['Gangplank', 'TOP', 'barrel-crit-special'], ['Draven', 'ADC', 'axe-catcher-special'],
  ['Singed', 'TOP', 'poison-movement-special'], ['Ivern', 'JUNGLE', 'support-jungle-special'], ['Kalista', 'ADC', 'on-hit-mobility-special'], ['Gnar', 'TOP', 'transforming-bruiser-special']
];
const FIELDS = [
  'champion', 'position', 'data.trends.win[].{version}',
  'data.summary.average_stats.{play,pick_rate,kda}', 'data.summary.positions[].{name,stats.{play}}',
  'data.core_items.{ids[],ids_names[],pick_rate,play}', 'data.boots.{ids[],ids_names[],pick_rate,play}',
  'data.starter_items.{ids[],ids_names[],pick_rate,play}', 'data.last_items[].{ids[],ids_names[],pick_rate,play}',
  'data.fourth_items[].{ids[],ids_names[],pick_rate,play}', 'data.fifth_items[].{ids[],ids_names[],pick_rate,play}',
  'data.sixth_items[].{ids[],ids_names[],pick_rate,play}', 'data.combination_items[].{ids[],ids_names[],pick_rate,play}',
  'data.single_items[].{ids[],ids_names[],pick_rate,play}', 'data.summoner_spells.{ids[],ids_names[],pick_rate,play}',
  'data.skill_masteries.builds[].{order[],pick_rate,play}'
];

let sessionId = '';
let requestId = 1;
function decodeResponse(body, id, isSse) {
  if (!isSse) return JSON.parse(body);
  const events = body.split(/\r?\n\r?\n/).flatMap(block => {
    const lines = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
    if (!lines.length) return [];
    try { return [JSON.parse(lines.join('\n'))]; } catch { return []; }
  });
  const result = events.find(event => event.id === id);
  if (!result) throw new Error('OP.GG MCP devolvió un evento sin respuesta');
  return result;
}
async function call(method, params = {}) {
  const id = method.startsWith('notifications/') ? undefined : requestId++;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const payload = { jsonrpc: '2.0', method, params };
  if (id !== undefined) payload.id = id;
  const response = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  sessionId = response.headers.get('mcp-session-id') || sessionId;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  return response.status === 202 ? null : decodeResponse(body, id, response.headers.get('content-type')?.includes('text/event-stream'));
}
function list(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function normalizeQuery(pair, parsed, sourceStatus = 'success', error = '') {
  const [champion, requestedPosition, archetype] = pair;
  const data = parsed?.data?.data?.summary ? parsed.data.data : parsed?.data?.summary ? parsed.data : parsed?.summary ? parsed : null;
  if (!data) return { champion: champion.toUpperCase(), requestedPosition, auditArchetype: archetype, returnedPosition: parsed?.position || '', sourceStatus: 'error', error: error || 'OP.GG respondió sin datos de análisis' };
  const summary = data.summary?.average_stats || {};
  const convert = key => list(data[key]).map(row => ({ ids: (row.ids || []).map(String), names: row.ids_names || [], play: Number(row.play) || 0, pick_rate: Number(row.pick_rate) || 0 }));
  const trends = list(data.trends?.win);
  return {
    champion: champion.toUpperCase(), requestedPosition, auditArchetype: archetype, returnedPosition: String(parsed.position || data.position || requestedPosition), sourceStatus,
    patch: String(trends[0]?.version || data.patch || ''), sample: { play: Number(summary.play) || 0, pickRate: Number(summary.pick_rate) || 0, kda: Number(summary.kda) || 0 },
    positions: list(data.summary?.positions).map(row => ({ name: row.name, play: Number(row.stats?.play) || 0 })),
    coreItems: convert('core_items'), boots: convert('boots'), starterItems: convert('starter_items'), lastItems: convert('last_items'),
    fourthItems: convert('fourth_items'), fifthItems: convert('fifth_items'), sixthItems: convert('sixth_items'),
    combinationItems: convert('combination_items'), singleItems: convert('single_items'),
    summonerSpells: convert('summoner_spells'), skillOrders: list(data.skill_masteries).flatMap(row => list(row.builds)).map(row => ({ order: row.order || [], play: Number(row.play) || 0, pick_rate: Number(row.pick_rate) || 0 }))
  };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const initialized = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rift-companion-ranked-audit', version: '1.0.0' } });
  if (initialized?.error || initialized?.result?.protocolVersion) await call('notifications/initialized');
  const queries = [];
  for (let index = 0; index < PAIRS.length; index++) {
    const [champion, position] = PAIRS[index];
    try {
      const response = await call('tools/call', { name: 'lol_get_champion_analysis', arguments: { game_mode: 'ranked', champion: champion.toUpperCase(), position, lang: 'en_US', desired_output_fields: FIELDS } });
      if (response?.error) throw new Error('OP.GG MCP rechazó la consulta');
      if (response?.result?.isError) throw new Error('OP.GG MCP devolvió una consulta fallida');
      const content = response?.result?.content?.find(row => row.type === 'text')?.text;
      if (!content) throw new Error('OP.GG no devolvió contenido de análisis');
      let parsed;
      try { parsed = JSON.parse(content); } catch { parsed = parseOpggClassRepr(content); }
      queries.push(normalizeQuery(PAIRS[index], parsed));
    } catch (error) {
      queries.push(normalizeQuery(PAIRS[index], null, 'error', String(error?.message || 'Error de consulta').slice(0, 120)));
    }
    console.log(`${index + 1}/${PAIRS.length} ${champion} ${position}: ${queries.at(-1).sourceStatus}`);
    if (index < PAIRS.length - 1) await sleep(900);
  }
  const audit = { auditAt: new Date().toISOString(), source: 'OP.GG MCP · lol_get_champion_analysis', mode: 'ranked', batch: `${PAIRS.length} representative champion-role pairs`, queries };
  await fs.writeFile(OUTPUT, JSON.stringify(audit, null, 2) + '\n', 'utf8');
  console.log(`Saved sanitized audit snapshot: ${path.relative(process.cwd(), OUTPUT)}`);
}
main().catch(error => { console.error(`OP.GG audit could not start: ${String(error?.message || error)}`); process.exitCode = 1; });
