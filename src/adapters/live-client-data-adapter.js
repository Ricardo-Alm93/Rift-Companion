'use strict';

// Pure DTO mapping. Network access and TLS validation live in services/live-client-data-client.js.
const ENDPOINTS = Object.freeze({ activePlayerName: '/liveclientdata/activeplayername', playerList: '/liveclientdata/playerlist', gameStats: '/liveclientdata/gamestats' });
const key = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
const position = value => ({ top: 'top', jungle: 'jungle', jg: 'jungle', middle: 'mid', mid: 'mid', bottom: 'adc', bot: 'adc', utility: 'support', support: 'support' })[key(value)] || null;

function normalizeLiveClientSnapshot(snapshot, { championByName = {}, sessionId = '', revision = 1, updatedAt = new Date().toISOString(), manualPlayerIndex = null } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.players) || snapshot.players.length < 1 || snapshot.players.length > 10) throw new Error('Invalid Live Client Data snapshot');
  const resolveChampion = player => {
    const candidates = [player?.championName, player?.rawChampionName].filter(Boolean).flatMap(value => {
      const text = String(value), tail = text.startsWith('game_character_displayname_') ? text.slice('game_character_displayname_'.length) : text;
      return [key(text), key(tail)];
    });
    for (const candidate of candidates) if (championByName[candidate]) return String(championByName[candidate]);
    return '';
  };
  const players = snapshot.players.map((player, participantIndex) => {
    const team = ['ORDER', 'CHAOS'].includes(String(player?.team || '').toUpperCase()) ? String(player.team).toUpperCase() : 'UNKNOWN';
    const championId = resolveChampion(player);
    return { participantIndex, championId, team, role: position(player?.position), confirmed: Boolean(championId), status: championId ? 'confirmed' : 'unknown', source: 'live-client' };
  });
  const activeName = key(snapshot.activePlayerName);
  if (manualPlayerIndex != null && (!Number.isInteger(manualPlayerIndex) || manualPlayerIndex < 0 || manualPlayerIndex >= players.length)) throw new Error('Invalid manual identity selection');
  let ownIndex = Number.isInteger(manualPlayerIndex) ? manualPlayerIndex : -1;
  if (ownIndex < 0 && activeName) {
    const matches = snapshot.players.map((player, index) => {
      const aliases = [player?.riotId, player?.summonerName, player?.riotIdGameName].filter(Boolean).map(key);
      return aliases.includes(activeName) ? index : -1;
    }).filter(index => index >= 0);
    if (matches.length === 1) ownIndex = matches[0];
  }
  // Live Client Data's CLASSIC/map 11 covers both Ranked and Normal; queue type
  // must come from the separate LCU gameflow session, never inferred here.
  const detectedMode = 'unknown';
  const modeVerified = false;
  if (ownIndex < 0) return { schemaVersion: 1, source: 'live-client', phase: 'InProgress', sessionId: String(sessionId), revision: Math.max(1, Number(revision) || 1), status: 'identity_unresolved', mode: detectedMode, modeVerified, player: null, allies: [], enemies: [], participants: players, confirmed: false, updatedAt: String(updatedAt) };
  const own = players[ownIndex], ownTeam = own.team;
  if (ownTeam === 'UNKNOWN') return { schemaVersion: 1, source: 'live-client', phase: 'InProgress', sessionId: String(sessionId), revision: Math.max(1, Number(revision) || 1), status: 'identity_unresolved', mode: detectedMode, modeVerified, player: null, allies: [], enemies: [], participants: players, confirmed: false, updatedAt: String(updatedAt) };
  const byTeam = team => players.filter(player => player.team === team).slice(0, 5).map((player, slot) => ({ ...player, slot, visible: Boolean(player.championId), status: player.confirmed ? 'locked' : 'unknown' }));
  const allies = byTeam(ownTeam), enemies = byTeam(ownTeam === 'ORDER' ? 'CHAOS' : 'ORDER'), ownRow = allies.find(player => player.participantIndex === ownIndex);
  return { schemaVersion: 1, source: 'live-client', phase: 'InProgress', sessionId: String(sessionId), draftSessionId: String(sessionId), revision: Math.max(1, Number(revision) || 1), status: 'ready', mode: detectedMode, modeVerified, player: { participantIndex: ownIndex, cellId: ownRow?.participantIndex, championId: ownRow?.championId || '', status: ownRow?.confirmed ? 'locked' : 'unknown', role: ownRow?.role || null }, allies: allies.map(row => ({ ...row, cellId: row.participantIndex })), enemies: enemies.map(row => ({ ...row, cellId: row.participantIndex })), participants: [], confirmed: Boolean(ownRow?.championId) && allies.every(row => row.confirmed) && enemies.every(row => row.confirmed), updatedAt: String(updatedAt) };
}

module.exports = { ENDPOINTS, normalizeLiveClientSnapshot };
