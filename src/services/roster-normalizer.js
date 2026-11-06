const PRIORITY = { manual: 4, 'live-client': 3, lcu: 3 };

function mergeRosterEvents(current, incoming) {
  if (!incoming || !incoming.sessionId || incoming.sessionId !== current?.sessionId) return current;
  const old = current || { sessionId: incoming.sessionId, version: 0, allies: [], enemies: [] };
  if (Number(incoming.version || 0) < Number(old.version || 0)) return old;
  const mergeSide = team => {
    const key = team === 'ally' ? 'allies' : 'enemies';
    const result = Array.from({ length: 5 }, (_, slot) => ({ slot, championId: '', team, source: '', confirmed: false }));
    for (const row of [...(old[key] || []), ...(incoming[key] || [])]) {
      const slot = Number(row?.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot > 4 || !row.championId) continue;
      const existing = result[slot];
      const existingManual = existing.source === 'manual' && existing.confirmed;
      const nextManual = row.source === 'manual' && row.confirmed;
      if (existingManual && !nextManual) continue;
      if (!existing.championId || (PRIORITY[row.source] || 0) > (PRIORITY[existing.source] || 0) || (row.confirmed && !existing.confirmed)) result[slot] = { ...row, slot, team };
    }
    return result;
  };
  return { ...old, ...incoming, allies: mergeSide('ally'), enemies: mergeSide('enemy'), version: Math.max(Number(old.version || 0), Number(incoming.version || 0)) };
}

module.exports = { PRIORITY, mergeRosterEvents };
