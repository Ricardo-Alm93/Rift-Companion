const { mergeRosterEvents } = require('./roster-normalizer');
const { normalizeRoster } = require('../domain/roster');

class DraftSessionController {
  constructor() { this.current = null; this.frozen = null; }
  begin(sessionId) {
    if (!sessionId) throw new Error('Session id required');
    this.current = { sessionId: String(sessionId), version: 0, allies: [], enemies: [], phase: 'draft' };
    this.frozen = null;
    return this.snapshot();
  }
  apply(event) {
    if (!this.current || event?.sessionId !== this.current.sessionId) return this.snapshot();
    this.current = mergeRosterEvents(this.current, event);
    return this.snapshot();
  }
  freeze({ player = {}, laneOpponentChampionId = '' } = {}) {
    if (!this.current) throw new Error('No active draft');
    this.frozen = normalizeRoster({ ...this.current, phase: 'ready', player, laneOpponentChampionId, input: { source: 'lcu' } });
    return structuredClone(this.frozen);
  }
  end(sessionId) {
    if (sessionId && this.current?.sessionId !== sessionId) return false;
    this.current = null; this.frozen = null; return true;
  }
  snapshot() { return this.current ? structuredClone(normalizeRoster({ ...this.current, input: { source: 'lcu' } })) : null; }
}

module.exports = { DraftSessionController };
