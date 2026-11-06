const { normalizeRoster } = require('../domain/roster');

function fromManual(input) {
  const roster = normalizeRoster({ ...input, input: { source: 'manual', collectedAt: input?.input?.collectedAt || new Date().toISOString() } });
  return { ...roster, input: { ...roster.input, source: 'manual' } };
}

module.exports = { fromManual };
