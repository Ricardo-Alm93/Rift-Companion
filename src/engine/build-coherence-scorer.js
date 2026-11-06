function scoreBuild(profile, threat, composition) {
  const suppliedByAllies = new Set(composition?.allyCoverage || []);
  if ((profile.avoidWhenAllies || []).some(tag => suppliedByAllies.has(tag))) return 0;
  const required = profile.when || [];
  if (!required.length) return 40;
  const confirmedTags = new Set(composition?.tags || []);
  const matched = required.filter(tag => confirmedTags.has(tag));
  if (!matched.length) return 0;
  const threatMatches = threat.filter(row => row.known && row.tags.some(tag => matched.includes(tag)));
  return Math.min(100, 55 + matched.length * 10 + threatMatches.length * 8);
}

module.exports = { scoreBuild };
