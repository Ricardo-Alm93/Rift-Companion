'use strict';

const { requestLiveClient } = require('../../services/live-client-data-client.js');
const { ENDPOINTS } = require('../../adapters/live-client-data-adapter.js');
const { MAYHEM_QUEUE_ID } = require('./mayhem-runtime.cjs');

const cleanGameName = value => String(value || '').toLowerCase().replace(/[^a-z]/g, '');
const identityKey = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function collectInitialUpdates(snapshot) {
  const root = snapshot?.info && typeof snapshot.info === 'object' ? snapshot.info : snapshot;
  const result = [];
  for (const feature of ['matchState', 'augments']) {
    const group = root?.[feature];
    if (!group || typeof group !== 'object') continue;
    const leaves = (value, depth = 0) => {
      if (depth > 3 || !value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry) result.push({ feature, key, value: entry.value, gameId: snapshot.gameId });
        else if (entry && typeof entry === 'object' && !Array.isArray(entry)) leaves(entry, depth + 1);
        else result.push({ feature, key, value: entry, gameId: snapshot.gameId });
      }
    };
    leaves(group);
  }
  const order = { queueId: 0, matchId: 1, matchStarted: 2, augments: 3, picked_augment: 4 };
  return result.sort((a, b) => (order[a.key] ?? 10) - (order[b.key] ?? 10));
}

async function readOwnLiveItems({ ca, request = requestLiveClient, championByName = {} } = {}) {
  const [activeName, players] = await Promise.all([
    request({ endpoint: ENDPOINTS.activePlayerName, ca }),
    request({ endpoint: ENDPOINTS.playerList, ca })
  ]);
  if (typeof activeName !== 'string' || !Array.isArray(players)) return { status: 'invalid-live-client-response', championId: '', boughtItemIds: [] };
  const active = identityKey(activeName);
  const matches = players.filter(player => [player?.riotId, player?.summonerName, player?.riotIdGameName].filter(Boolean).some(name => identityKey(name) === active));
  if (matches.length !== 1) return { status: 'live-player-identity-unresolved', championId: '', boughtItemIds: [] };
  const own = matches[0];
  const championId = championByName[identityKey(own.championName)] || championByName[identityKey(own.rawChampionName)] || '';
  const boughtItemIds = (Array.isArray(own.items) ? own.items : []).map(item => Number(item?.itemID)).filter(id => Number.isInteger(id) && id > 0).slice(0, 7).map(String);
  return { status: championId ? 'live-player-items-read' : 'live-player-champion-unresolved', championId: String(championId), boughtItemIds };
}

function attachOverwolfMayhemBridge({ app, runtime, ca, championByName = {}, readLiveItems = readOwnLiveItems, onStatus = () => {}, pollMs = 2500 } = {}) {
  const gep = app?.overwolf?.packages?.gep;
  if (!gep?.on || !gep?.getFeatures || !gep?.setRequiredFeatures || !gep?.getInfo) {
    onStatus({ status: 'unsupported-runtime', reason: 'ow-electron-gep-unavailable' });
    return { status: 'unsupported-runtime', stop() {} };
  }
  let gameId = null, poll = null, reading = false, stopped = false;
  const listeners = [];
  const add = (name, handler) => { gep.on(name, handler); listeners.push([name, handler]); };
  const stopPolling = () => { if (poll) clearInterval(poll); poll = null; reading = false; };
  const refreshLive = async () => {
    if (stopped || reading || !gameId || runtime.snapshot().status !== 'active') return;
    reading = true;
    try {
      const live = await readLiveItems({ ca, championByName });
      if (live.status === 'live-player-items-read') await runtime.updateLiveSnapshot(live);
      else runtime.markLiveItemsStale('LIVE_CLIENT_IDENTITY_UNRESOLVED');
      onStatus({ status: live.status, boughtItemsCount: live.boughtItemIds.length });
    } catch (error) {
      const errorCode = /^LIVE_CLIENT_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'LIVE_CLIENT_READ_FAILED';
      runtime.markLiveItemsStale(errorCode);
      onStatus({ status: 'live-client-unavailable', errorCode });
    } finally { reading = false; }
  };
  const handleDetected = async (event, detectedGameId, name) => {
    if (stopped || !/league\s+of\s+legends/i.test(String(name || ''))) return;
    gameId = Number(detectedGameId);
    try {
      await event?.enable?.();
      const features = await gep.getFeatures(gameId);
      const missing = ['augments', 'matchState'].filter(feature => !features.includes(feature));
      if (missing.length) { onStatus({ status: 'gep-feature-unavailable', missing }); return; }
      await gep.setRequiredFeatures(gameId, ['augments', 'matchState']);
      onStatus({ status: 'gep-ready', gameId, features: ['augments', 'matchState'] });
      // GEP info is persistent state; it recovers the latest choice after app
      // launch/reconnect, but cannot reconstruct earlier missed choices.
      const current = await gep.getInfo(gameId);
      for (const update of collectInitialUpdates(current)) await runtime.handleInfoUpdate(update, { providerGameId: gameId, initialSnapshot: true });
      if (runtime.snapshot().status === 'active') {
        poll = setInterval(refreshLive, Math.max(1000, Math.min(10000, pollMs)));
        refreshLive();
      }
    } catch {
      onStatus({ status: 'gep-setup-failed', errorCode: 'GEP_SETUP_FAILED' });
    }
  };
  const handleInfo = async (_event, incomingGameId, data) => {
    if (stopped || Number(incomingGameId) !== gameId || !data) return;
    const feature = String(data.feature || data.category || '');
    await runtime.handleInfoUpdate(data, { providerGameId: gameId });
    if (feature === 'augments' || data.category === 'me') {
      if (runtime.snapshot().status === 'active' && !poll) { poll = setInterval(refreshLive, Math.max(1000, Math.min(10000, pollMs))); refreshLive(); }
      if (runtime.snapshot().status !== 'active') stopPolling();
    }
    const current = runtime.snapshot();
    if (current.status === 'ended' || current.status === 'waiting') stopPolling();
    onStatus({ status: current.status, selectedCount: current.selected.length, offerCount: current.offers.length });
  };
  const handleGameEvent = async (_event, incomingGameId, data) => {
    if (stopped || Number(incomingGameId) !== gameId || !data) return;
    if (String(data.name || data.key || '') === 'matchStart') {
      const queueId = Number(runtime.snapshot().queueId);
      await runtime.handleMatchStart({ providerGameId: gameId, matchId: runtime.snapshot().sessionId, queueId });
      if (runtime.snapshot().status === 'active' && !poll) { poll = setInterval(refreshLive, Math.max(1000, Math.min(10000, pollMs))); refreshLive(); }
    }
  };
  const handleExit = (_event, exitedGameId) => {
    if (Number(exitedGameId) !== gameId) return;
    stopPolling();
    gameId = null;
    runtime.handleMatchEnd({ providerGameId: exitedGameId });
    onStatus({ status: 'game-exited' });
  };
  const handleError = (_event, failedGameId) => {
    if (gameId != null && Number(failedGameId) === gameId) onStatus({ status: 'gep-error', errorCode: 'GEP_PROVIDER_ERROR' });
  };
  add('game-detected', handleDetected);
  add('new-info-update', handleInfo);
  add('new-game-event', handleGameEvent);
  add('game-exit', handleExit);
  add('elevated-privileges-required', () => onStatus({ status: 'elevation-required' }));
  add('error', handleError);
  onStatus({ status: 'waiting-for-league-game' });
  return { status: 'waiting-for-league-game', stop() { stopped = true; stopPolling(); for (const [name, listener] of listeners) gep.off?.(name, listener); listeners.length = 0; } };
}

module.exports = { attachOverwolfMayhemBridge, collectInitialUpdates, readOwnLiveItems, MAYHEM_QUEUE_ID };
