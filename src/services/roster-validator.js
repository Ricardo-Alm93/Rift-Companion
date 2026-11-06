const { validateRoster } = require('../domain/roster');

function validateAgainstDataDragon(roster, championData) {
  const ids = Object.keys(championData?.data || championData || {});
  return validateRoster(roster, ids);
}

module.exports = { validateAgainstDataDragon };
