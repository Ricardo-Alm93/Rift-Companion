'use strict';

// Shape-only adapter. Network access lives in services/lcu-draft-client.js.
const ENABLED = false;
const ENDPOINTS = Object.freeze({ phase: '/lol-gameflow/v1/gameflow-phase', gameflowSession: '/lol-gameflow/v1/session', session: '/lol-champ-select/v1/session' });
const POSITIONS = Object.freeze({ TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'adc', UTILITY: 'support' });
const RANKED_QUEUE_IDS = new Set([420, 440]);
// ARAM: Mayhem is a separate queue. Keep it explicit so unknown queues never
// trigger ARAM builds by guesswork.
const ARAM_MAYHEM_QUEUE_IDS = new Set([2400]);

function queueInfoFromGameflow(session) {
  const raw = session?.gameData?.queue?.queueId ?? session?.gameData?.queue?.id ?? session?.queue?.queueId ?? session?.queue?.id;
  const queueId = Number(raw);
  if (!Number.isSafeInteger(queueId) || queueId <= 0) return { queueId: null, mode: 'unknown', modeVerified: false };
  const mode = RANKED_QUEUE_IDS.has(queueId) ? 'ranked' : ARAM_MAYHEM_QUEUE_IDS.has(queueId) ? 'aram-mayhem' : 'other';
  return { queueId, mode, modeVerified: true };
}

function championIdFrom(value, championByKey) {
  const raw = Number(value);
  if (!Number.isSafeInteger(raw) || raw <= 0 || !championByKey) return '';
  return String(championByKey[String(raw)] || '');
}
function fromSession({ phase = 'ChampSelect', session, championByKey = {}, draftSessionId = '', version = 1, updatedAt = new Date().toISOString(), queueInfo = { queueId: null, mode: 'unknown', modeVerified: false } } = {}) {
  if (phase !== 'ChampSelect' || !session || !Array.isArray(session.myTeam) || !Array.isArray(session.theirTeam)) throw new Error('Invalid champ-select session');
  if (session.myTeam.length > 5 || session.theirTeam.length > 5) throw new Error('Invalid champ-select team size');
  const localCellId = Number(session.localPlayerCellId);
  if (!Number.isInteger(localCellId) || localCellId < 0) throw new Error('Invalid local player cell');
  const allRows = [...session.myTeam, ...session.theirTeam];
  const cellIds = allRows.map(row => row?.cellId);
  if (cellIds.some(id => id == null || !Number.isSafeInteger(Number(id)) || Number(id) < 0) || new Set(cellIds.map(Number)).size !== cellIds.length) throw new Error('Invalid champ-select cell IDs');
  const local = session.myTeam.find(row => Number(row.cellId) === localCellId);
  if (!local) throw new Error('Local player is missing from myTeam');
  const pickAction = cellId => (session.actions || []).flat().find(action => Number(action.actorCellId) === Number(cellId) && String(action.type).toLowerCase() === 'pick');
  const normalizeSide = (rows, team) => Array.from({ length: 5 }, (_, slot) => {
    const row = (rows || [])[slot] || {};
    const selectedId = championIdFrom(row.championId, championByKey), intentId = team === 'ally' ? championIdFrom(row.championPickIntent, championByKey) : '', action = pickAction(row.cellId);
    const locked = action?.completed === true && selectedId !== '';
    const id = selectedId || intentId;
    const visible = team === 'ally' ? id !== '' : locked && selectedId !== '';
    const status = !visible ? (team === 'enemy' ? 'hidden' : 'unknown') : locked ? 'locked' : selectedId ? 'hovered' : 'intent';
    return { slot, cellId: Number.isInteger(Number(row.cellId)) ? Number(row.cellId) : null, championId: visible ? id : '', status, visible, confirmed: locked, role: team === 'ally' && Number(row.cellId) === localCellId ? (POSITIONS[String(row.assignedPosition || '').toUpperCase()] || null) : null, source: 'lcu' };
  });
  // LCU team arrays preserve cell IDs but not an app slot property; stable order is only UI placement, never enemy role inference.
  const myRows = [...session.myTeam].sort((a, b) => Number(a.cellId) - Number(b.cellId));
  const enemyRows = [...session.theirTeam].sort((a, b) => Number(a.cellId) - Number(b.cellId));
  const allies = normalizeSide(myRows, 'ally'), enemies = normalizeSide(enemyRows, 'enemy');
  const own = allies.find(row => row.cellId === localCellId);
  const playerId = own?.championId || '';
  const playerStatus = playerId ? own.status : 'unknown';
  return {
    schemaVersion: 1, source: 'lcu', phase: 'champSelect', draftSessionId: String(draftSessionId), version: Math.max(1, Number(version) || 1), queueId: queueInfo.queueId || null, mode: queueInfo.mode || 'unknown', modeVerified: queueInfo.modeVerified === true,
    player: { cellId: localCellId, championId: playerId, status: playerStatus, role: own?.role || null },
    allies, enemies, laneOpponent: null, confirmed: !!playerId && playerStatus === 'locked' && allies.every(x => x.confirmed) && enemies.every(x => x.confirmed), updatedAt: String(updatedAt)
  };
}

function fromFixture(session) {
  const mapped = { myTeam: (session?.myTeam || []).map((r, slot) => ({ ...r, slot, cellId: r.cellId ?? slot })), theirTeam: (session?.theirTeam || []).map((r, slot) => ({ ...r, slot, cellId: r.cellId ?? slot + 5 })), localPlayerCellId: session?.localPlayerCellId ?? 0, actions: session?.actions || [] };
  return fromSession({ session: mapped, championByKey: session?.championByKey || {}, draftSessionId: session?.sessionId || 'fixture', version: session?.version || 1 });
}

module.exports = { ENABLED, ENDPOINTS, POSITIONS, RANKED_QUEUE_IDS, ARAM_MAYHEM_QUEUE_IDS, championIdFrom, queueInfoFromGameflow, fromSession, fromFixture };
