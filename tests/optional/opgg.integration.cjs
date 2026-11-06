if (process.env.RIFT_OPGG_INTEGRATION !== '1') {
  throw new Error('This optional suite must be launched with RIFT_OPGG_INTEGRATION=1. Use npm run test:opgg:integration.');
}

require('../ranked-pilot.test.cjs');
