const TEAMS = ['ally', 'enemy'];
const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];
const PHASES = ['idle', 'draft', 'ready', 'in_game', 'ended'];
const STATUSES = ['unknown', 'hover', 'selected', 'revealed', 'locked', 'confirmed'];

function normalizeRoster(input = {}) {
  const normalizeSide = (side, team) => Array.from({ length: 5 }, (_, index) => {
    const source = (Array.isArray(side) ? side : []).find(row => Number(row?.slot) === index) || {};
    const status = STATUSES.includes(source.status) ? source.status : source.championId ? (source.confirmed ? 'confirmed' : 'revealed') : 'unknown';
    const confirmed = status === 'confirmed' || status === 'locked' || (source.confirmed === true && !['hover', 'selected'].includes(status));
    return {
      slot: index,
      team,
      championId: source.visible === true || confirmed || status === 'revealed' ? String(source.championId || '') : '',
      role: ROLES.includes(source.role) ? source.role : null,
      status: source.championId ? status : 'unknown',
      visible: source.visible === true,
      confirmed,
      source: ['manual', 'lcu', 'live-client'].includes(source.source) ? source.source : 'manual'
    };
  });
  const allies = normalizeSide(input.allies, 'ally');
  const enemies = normalizeSide(input.enemies, 'enemy');
  const player = input.player && typeof input.player === 'object' ? {
    championId: String(input.player.championId || ''),
    role: ROLES.includes(input.player.role) ? input.player.role : null,
    identityConfirmed: input.player.identityConfirmed === true
  } : { championId: '', role: null, identityConfirmed: false };
  const knownAllies = allies.filter(row => row.championId).length;
  const knownEnemies = enemies.filter(row => row.championId).length;
  return {
    schemaVersion: 3,
    mode: input.mode === 'aram-mayhem' ? 'aram-mayhem' : 'ranked',
    phase: PHASES.includes(input.phase) ? input.phase : 'idle',
    player,
    allies,
    enemies,
    laneOpponentChampionId: String(input.laneOpponentChampionId || ''),
    patch: input.patch && typeof input.patch === 'object' ? { gamePatch: String(input.patch.gamePatch || ''), dataDragonVersion: String(input.patch.dataDragonVersion || ''), collectedAt: String(input.patch.collectedAt || '') } : { gamePatch: '', dataDragonVersion: '', collectedAt: '' },
    input: { source: ['manual', 'lcu', 'live-client'].includes(input.input?.source) ? input.input.source : 'manual', collectedAt: String(input.input?.collectedAt || '') },
    certainty: { knownAllies, knownEnemies },
    isComplete: knownAllies === 5 && knownEnemies === 5 && allies.every(row => row.confirmed) && enemies.every(row => row.confirmed)
  };
}

function validateRoster(roster, championIds) {
  const state = normalizeRoster(roster);
  const valid = new Set((championIds || []).map(String));
  const errors = [];
  const all = [...state.allies, ...state.enemies].filter(row => row.championId);
  if (all.some(row => !valid.has(row.championId))) errors.push('unknown-champion');
  const ids = all.map(row => row.championId);
  if (new Set(ids).size !== ids.length) errors.push('duplicate-champion');
  if (state.player.championId && (!state.allies.some(row => row.championId === state.player.championId) || !state.player.identityConfirmed)) errors.push('player-identity');
  if (state.laneOpponentChampionId && !state.enemies.some(row => row.championId === state.laneOpponentChampionId && row.confirmed)) errors.push('lane-opponent');
  if (state.allies.length !== 5 || state.enemies.length !== 5) errors.push('slots');
  if (state.allies.some(row => row.team !== 'ally') || state.enemies.some(row => row.team !== 'enemy')) errors.push('team');
  return { valid: errors.length === 0, errors, roster: state };
}

module.exports = { TEAMS, ROLES, PHASES, STATUSES, normalizeRoster, validateRoster };
