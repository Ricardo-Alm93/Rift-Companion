'use strict';

// Queue classification controls recommendations, not visibility of picks
// already revealed by the client.
const OverlayRoster = Object.freeze({
  visibleEnemyRows(roster) {
    return (Array.isArray(roster?.enemies) ? roster.enemies : [])
      .filter(row => row?.visible === true && typeof row.championId === 'string' && row.championId.length > 0);
  },
  rankedLaneOpponent(roster) {
    if (roster?.phase !== 'InProgress' || roster?.mode !== 'ranked' || roster?.modeVerified !== true) return '';
    const role = String(roster.player?.role || '').toLowerCase();
    if (!role) return '';
    const candidates = this.visibleEnemyRows(roster).filter(row => row.confirmed === true && String(row.role || '').toLowerCase() === role);
    return candidates.length === 1 ? candidates[0].championId : '';
  }
});
if (typeof module !== 'undefined' && module.exports) module.exports = OverlayRoster;
if (typeof window !== 'undefined') window.RiftOverlayRoster = OverlayRoster;
