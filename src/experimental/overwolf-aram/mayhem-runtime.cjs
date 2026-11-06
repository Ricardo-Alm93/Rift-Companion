'use strict';

const { evaluateAugments } = require('../../engine/aram-augment-evaluator.cjs');
const { adaptMayhemBuild } = require('../../engine/aram-build-adapter.cjs');
const { validateMayhemBuild } = require('../../engine/aram-mayhem-item-validator.cjs');

const MAYHEM_QUEUE_ID = 2400;
const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function decode(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function updateValue(value) {
  const decoded = decode(value);
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) && decoded.info && typeof decoded.info === 'object' ? decoded.info : decoded;
}
function findField(snapshot, feature, key) {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  if (snapshot[feature]?.[key] !== undefined) return snapshot[feature][key];
  for (const group of Object.values(snapshot)) {
    if (group && typeof group === 'object' && group[feature]?.[key] !== undefined) return group[feature][key];
    if (group && typeof group === 'object' && group[key] !== undefined) return group[key];
  }
  return undefined;
}
function parseOffers(value) {
  const decoded = decode(value);
  if (Array.isArray(decoded)) return decoded.map(row => row?.name || row?.augment || row).filter(name => typeof name === 'string');
  if (!decoded || typeof decoded !== 'object') return [];
  return Object.keys(decoded).sort().map(key => decoded[key]?.name || decoded[key]?.augment || decoded[key]).filter(name => typeof name === 'string');
}

function createMayhemRuntime({ catalog, evidence, getBuildContext = async () => ({}), onState = () => {}, now = () => new Date().toISOString() } = {}) {
  const augmentRows = (catalog?.rows || []).filter(row => !row.retiredPatch);
  const byName = new Map();
  for (const row of augmentRows) {
    for (const label of [row.slug, row.augmentId, row.name?.en, row.name?.['es-MX'], row.name?.es]) {
      if (label) byName.set(norm(label), row);
    }
  }
  let state = emptyState();
  let offerSignature = '';
  let offerCycle = 0;
  const seenPicks = new Set();
  let revision = 0;

  function emptyState() {
    return { source: 'overwolf-gep', mode: 'unknown', status: 'waiting', matchStarted: false, sessionId: '', providerGameId: null, queueId: null, championId: '', headlinerId: null, headlinerStatus: 'not-exposed-by-gep', offers: [], selected: [], boughtItemIds: [], boughtItemsStatus: 'unavailable', historyComplete: true, syncGap: false, updatedAt: '', diagnostic: 'waiting-for-mayhem' };
  }
  function publish(extra = {}) {
    state = { ...state, ...extra, updatedAt: now(), revision: ++revision };
    onState(snapshot());
    return snapshot();
  }
  function snapshot() { return JSON.parse(JSON.stringify(state)); }
  function begin({ providerGameId, matchId = '', queueId = MAYHEM_QUEUE_ID, resumed = false } = {}) {
    const sessionId = String(matchId || '');
    if (!sessionId) return publish({ status: 'waiting', queueId: Number(queueId), providerGameId: Number(providerGameId), diagnostic: 'awaiting-provider-match-id' });
    if (state.status === 'active' && state.providerGameId === providerGameId && state.sessionId === sessionId) return snapshot();
    offerSignature = '';
    offerCycle = 0;
    seenPicks.clear();
    state = { ...emptyState(), source: 'overwolf-gep', mode: 'aram-mayhem', status: 'active', matchStarted: true, sessionId, providerGameId: Number.isFinite(Number(providerGameId)) ? Number(providerGameId) : null, queueId: Number(queueId), historyComplete: !resumed, syncGap: Boolean(resumed), diagnostic: resumed ? 'resumed-from-provider-snapshot-history-incomplete' : 'match-started' };
    return publish();
  }
  function end({ providerGameId, reason = 'match-ended' } = {}) {
    if (state.status !== 'active' || (providerGameId != null && Number(providerGameId) !== state.providerGameId)) return snapshot();
    const previous = snapshot();
    offerSignature = '';
    offerCycle = 0;
    seenPicks.clear();
    state = { ...emptyState(), source: 'overwolf-gep', status: 'ended', diagnostic: reason, previousMatchId: previous.sessionId, updatedAt: now(), revision: ++revision };
    onState(snapshot());
    return snapshot();
  }
  function resolve(name) { return byName.get(norm(name)) || null; }
  function applyOffers(raw) {
    const names = parseOffers(raw);
    const rows = names.map(name => resolve(name)).filter(Boolean);
    const signature = rows.map(row => row.slug).join('|');
    if (signature && signature !== offerSignature) {
      offerSignature = signature;
      offerCycle += 1;
      // A different offer round permits an augment of the same identity to be
      // selected again, while repeated GEP notifications in this round dedupe.
      state = { ...state, offers: rows.map(row => ({ id: row.augmentId, slug: row.slug, name: row.name, icon: row.icon || '', description: row.description || '' })), offerCycle };
    }
    if (names.length && rows.length !== names.length) state = { ...state, unknownOfferCount: names.length - rows.length, syncGap: true };
    return rows;
  }
  async function recompute({ picked = null, provenance = 'live-gep-event' } = {}) {
    if (state.status !== 'active') return snapshot();
    const context = await getBuildContext({ sessionId: state.sessionId, championId: state.championId, providerGameId: state.providerGameId });
    const championId = String(context?.championId || state.championId || '');
    const selected = state.selected.map(row => row.slug);
    const candidates = state.offers;
    const results = championId ? evaluateAugments({ championId, headlinerId: '', selectedAugments: selected, candidateAugments: candidates, evidence, language: context?.language === 'en' ? 'en' : 'es' }) : [];
    const buildAdaptation = adaptMayhemBuild({ itemIds: context?.itemIds || [], selectedAugments: selected, boughtItemIds: context?.boughtItemIds || state.boughtItemIds, interactions: evidence?.interactions || [], language: context?.language === 'en' ? 'en' : 'es' });
    const itemValidation = (context?.itemIds || []).length ? validateMayhemBuild({ itemIds: context.itemIds, itemData: context.itemData || {}, mayhemItems: context.mayhemItems || [], transformations: context.transformations || {} }) : null;
    return publish({ championId, headlinerId: null, headlinerStatus: 'not-exposed-by-gep', boughtItemIds: (context?.boughtItemIds || state.boughtItemIds || []).map(String), boughtItemsStatus: state.boughtItemsStatus, recommendation: { picked, provenance, selectedAugments: selected, results, buildAdaptation, itemValidation, boughtItemsStatus: state.boughtItemsStatus, buildStatus: itemValidation?.valid === false ? 'invalid-current-build-needs-review' : buildAdaptation.status, evaluatedAt: now() }, diagnostic: picked ? 'pick-received-and-recommendation-recomputed' : state.diagnostic });
  }
  async function acceptPick(rawName, { allowUnoffered = false, provenance = 'live-gep-event' } = {}) {
    if (state.status !== 'active') return snapshot();
    const row = resolve(rawName);
    if (!row) return publish({ unknownPickCount: (state.unknownPickCount || 0) + 1, syncGap: true, diagnostic: 'unknown-pick-not-added' });
    const fingerprint = `${state.sessionId}:${state.providerGameId}:${offerCycle}:${row.slug}`;
    if (seenPicks.has(fingerprint)) return snapshot();
    if (!allowUnoffered && !state.offers.some(offer => offer.slug === row.slug)) {
      // The event proves the pick, but an absent/stale offers update means the
      // offer history is incomplete. Record the known picked augment, not a guess.
      state = { ...state, syncGap: true };
    }
    seenPicks.add(fingerprint);
    state = { ...state, selected: [...state.selected, { id: row.augmentId, slug: row.slug, name: row.name, provenance, offerCycle }], diagnostic: 'pick-recorded' };
    return recompute({ picked: { id: row.augmentId, slug: row.slug, name: row.name }, provenance });
  }
  async function handleInfoUpdate(update, { providerGameId = update?.gameId, initialSnapshot = false } = {}) {
    if (!update || typeof update !== 'object') return snapshot();
    const info = updateValue(update);
    const feature = String(update.feature || update.category || '');
    const key = String(update.key || '');
    const value = update.value !== undefined ? update.value : findField(info, feature, key);
    if (feature === 'matchState' || update.category === 'game_info') {
      if (key === 'queueId') state = { ...state, queueId: Number(value) || null, providerGameId: Number.isFinite(Number(providerGameId)) ? Number(providerGameId) : state.providerGameId };
      if (key === 'matchId') state = { ...state, sessionId: String(value || '') };
      if (key === 'matchStarted') {
        const started = String(value).toLowerCase() === 'true' || value === true;
        if (!started) return end({ providerGameId, reason: 'match-ended' });
        state = { ...state, matchStarted: true };
        if (Number(state.queueId) === MAYHEM_QUEUE_ID) return begin({ providerGameId, matchId: state.sessionId, queueId: state.queueId, resumed: initialSnapshot });
        return publish({ status: 'waiting', diagnostic: 'non-mayhem-match' });
      }
      if (state.matchStarted && Number(state.queueId) === MAYHEM_QUEUE_ID && state.sessionId && state.status !== 'active') return begin({ providerGameId, matchId: state.sessionId, queueId: state.queueId, resumed: initialSnapshot });
    }
    if (feature === 'augments' || update.category === 'me') {
      // Overwolf documents this GEP feature specifically for ARAM Mayhem.
      // It can identify the mode when the initial matchState update was missed.
      if (state.status !== 'active') {
        state = { ...state, mode: 'aram-mayhem', queueId: MAYHEM_QUEUE_ID, matchStarted: true, providerGameId: Number(providerGameId) || state.providerGameId };
        if (state.sessionId) begin({ providerGameId, matchId: state.sessionId, queueId: MAYHEM_QUEUE_ID, resumed: true });
      }
      if (key === 'augments') {
        const rows = applyOffers(value);
        const context = await getBuildContext({ sessionId: state.sessionId, providerGameId: state.providerGameId });
        if (context?.championId) state = { ...state, championId: String(context.championId), boughtItemIds: (context.boughtItemIds || []).map(String) };
        return publish({ status: state.sessionId ? 'active' : 'waiting', offers: state.offers, diagnostic: !state.sessionId ? 'awaiting-provider-match-id' : rows.length ? (state.syncGap ? 'offers-received-with-partial-history' : 'offers-received') : 'offers-unresolved' });
      }
      if (key === 'picked_augment') return acceptPick(value, { allowUnoffered: initialSnapshot, provenance: initialSnapshot ? 'provider-current-state' : 'live-gep-event' });
    }
    return snapshot();
  }
  async function handleMatchStart({ providerGameId, matchId, queueId } = {}) {
    if (Number(queueId) !== MAYHEM_QUEUE_ID) return publish({ status: 'waiting', queueId: Number(queueId) || null, diagnostic: 'non-mayhem-match' });
    return begin({ providerGameId, matchId, queueId, resumed: false });
  }
  async function handleMatchEnd({ providerGameId } = {}) { return end({ providerGameId }); }
  async function updateLiveSnapshot({ championId, boughtItemIds = [] } = {}) {
    if (state.status !== 'active') return snapshot();
    state = { ...state, championId: String(championId || state.championId || ''), boughtItemIds: boughtItemIds.map(String), boughtItemsStatus: 'fresh' };
    if (!state.selected.length) return publish({ diagnostic: 'live-items-updated' });
    return recompute({ provenance: 'live-client-data-refresh' });
  }
  function markLiveItemsStale(errorCode = 'LIVE_CLIENT_READ_FAILED') {
    if (state.status !== 'active') return snapshot();
    return publish({ boughtItemsStatus: 'stale', liveItemsErrorCode: /^LIVE_CLIENT_[A-Z0-9_]+$/.test(errorCode) ? errorCode : 'LIVE_CLIENT_READ_FAILED', diagnostic: 'live-items-stale' });
  }
  return { handleInfoUpdate, handleMatchStart, handleMatchEnd, updateLiveSnapshot, markLiveItemsStale, snapshot };
}

module.exports = { MAYHEM_QUEUE_ID, createMayhemRuntime, parseOffers, findField };
