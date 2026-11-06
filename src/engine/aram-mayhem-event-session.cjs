'use strict';

// Provider-neutral event state. Providers must translate their own payloads
// into this contract before an event reaches the recommendation engine.
const MAYHEM_QUEUE_ID = 2400;
const TYPES = new Set(['match-start', 'match-end', 'augment-offers', 'augment-selected', 'item-acquired', 'connection-state']);

function normalizeEvent(input, { receivedAt = new Date().toISOString() } = {}) {
  if (!input || typeof input !== 'object' || !TYPES.has(input.type)) throw new TypeError('Unsupported Mayhem event type');
  const source = String(input.source || '').trim();
  const matchId = String(input.matchId || '').trim();
  if (!source || source.length > 64) throw new TypeError('Mayhem event source is required');
  if (!matchId || matchId.length > 128) throw new TypeError('Mayhem event match ID is required');
  const eventId = input.eventId == null ? '' : String(input.eventId).slice(0, 160);
  const round = Number.isInteger(input.round) && input.round >= 0 && input.round <= 12 ? input.round : null;
  const base = { schemaVersion: 1, type: input.type, source, matchId, eventId, round, confirmed: input.confirmed === true, occurredAt: String(input.occurredAt || receivedAt).slice(0, 40), receivedAt };
  if (input.type === 'match-start') return { ...base, queueId: Number.isSafeInteger(Number(input.queueId)) ? Number(input.queueId) : null };
  if (input.type === 'match-end') return { ...base, reason: String(input.reason || 'match-ended').slice(0, 48) };
  if (input.type === 'augment-offers') {
    if (!base.confirmed || !Array.isArray(input.augmentIds)) throw new TypeError('Confirmed augment offer IDs are required');
    return { ...base, augmentIds: [...new Set(input.augmentIds.map(String).filter(id => id && id.length <= 96))].slice(0, 8) };
  }
  if (input.type === 'augment-selected') {
    if (!base.confirmed || !String(input.augmentId || '').trim()) throw new TypeError('A confirmed augment selection is required');
    return { ...base, augmentId: String(input.augmentId).trim().slice(0, 96) };
  }
  if (input.type === 'item-acquired') {
    if (!base.confirmed || !Number.isSafeInteger(Number(input.itemId)) || Number(input.itemId) <= 0) throw new TypeError('A confirmed item ID is required');
    return { ...base, itemId: String(input.itemId) };
  }
  if (!['connected', 'disconnected', 'degraded'].includes(input.connection)) throw new TypeError('Invalid connection state');
  return { ...base, connection: input.connection };
}

function createMayhemEventSession({ onEvent = () => {}, onAugmentSelected = () => {}, now = () => new Date().toISOString() } = {}) {
  let state = { status: 'idle', matchId: '', queueId: null, mode: 'unknown', offers: [], selectedAugments: [], itemIds: [], connection: 'disconnected', provenance: null, updatedAt: now() };
  const seen = new Set();
  function snapshot() { return structuredClone(state); }
  function apply(input) {
    const event = normalizeEvent(input, { receivedAt: now() });
    if (event.type !== 'match-start' && state.matchId !== event.matchId) return { accepted: false, reason: 'match-id-mismatch', state: snapshot() };
    const fingerprint = event.eventId ? `${event.matchId}:${event.source}:${event.eventId}` : [event.matchId, event.source, event.type, event.round ?? '', event.type === 'augment-selected' ? event.augmentId : event.type === 'augment-offers' ? event.augmentIds.join(',') : event.type === 'item-acquired' ? event.itemId : event.type === 'connection-state' ? event.connection : event.reason || event.queueId].join(':');
    if (seen.has(fingerprint)) return { accepted: false, reason: 'duplicate', state: snapshot() };
    if (event.type === 'match-start') {
      if (!event.confirmed) return { accepted: false, reason: 'unconfirmed-match-start', state: snapshot() };
      if (state.matchId !== event.matchId) { seen.clear(); state = { status: 'active', matchId: event.matchId, queueId: event.queueId, mode: event.queueId === MAYHEM_QUEUE_ID ? 'aram-mayhem' : 'unknown', offers: [], selectedAugments: [], itemIds: [], connection: 'connected', provenance: event.source, updatedAt: event.receivedAt }; }
    } else if (event.type === 'match-end') {
      if (!event.confirmed) return { accepted: false, reason: 'unconfirmed-match-end', state: snapshot() };
      state = { ...state, status: 'ended', offers: [], connection: 'disconnected', updatedAt: event.receivedAt };
    } else if (state.status !== 'active') return { accepted: false, reason: 'no-active-match', state: snapshot() };
    else if (event.type === 'augment-offers') state = { ...state, offers: event.augmentIds, provenance: event.source, updatedAt: event.receivedAt };
    else if (event.type === 'augment-selected') {
      if (state.selectedAugments.some(row => row.augmentId === event.augmentId && row.eventId === event.eventId)) return { accepted: false, reason: 'duplicate-selection', state: snapshot() };
      const selection = { augmentId: event.augmentId, source: event.source, matchId: event.matchId, round: event.round, confirmed: event.confirmed, eventId: event.eventId, occurredAt: event.occurredAt };
      state = { ...state, selectedAugments: [...state.selectedAugments, selection], provenance: event.source, updatedAt: event.receivedAt };
      onAugmentSelected(selection, snapshot());
    } else if (event.type === 'item-acquired') state = { ...state, itemIds: [...new Set([...state.itemIds, event.itemId])], provenance: event.source, updatedAt: event.receivedAt };
    else if (event.type === 'connection-state') state = { ...state, connection: event.connection, provenance: event.source, updatedAt: event.receivedAt };
    seen.add(fingerprint);
    onEvent(event, snapshot());
    return { accepted: true, reason: 'applied', state: snapshot() };
  }
  return { apply, snapshot };
}

module.exports = { MAYHEM_QUEUE_ID, normalizeEvent, createMayhemEventSession };
