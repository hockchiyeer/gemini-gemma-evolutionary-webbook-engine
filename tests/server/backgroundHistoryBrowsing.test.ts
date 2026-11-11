import assert from 'node:assert/strict';
import { getLiveRunLabel } from '../../src/components/LiveRunBanner';

// 1. Live run progress label and percentage mappings
{
  const searching = getLiveRunLabel('searching');
  assert.equal(searching.pct, 25);
  assert.equal(searching.label, 'Searching & extracting sources');

  const parsing = getLiveRunLabel('parsing');
  assert.equal(parsing.pct, 40);
  assert.equal(parsing.label, 'Parsing sources');

  const evolving = getLiveRunLabel('evolving');
  assert.equal(evolving.pct, 55);
  assert.equal(evolving.label, 'Evolving source pages');

  const assembling = getLiveRunLabel('assembling');
  assert.equal(assembling.pct, 80);
  assert.equal(assembling.label, 'Assembling WebBook');
}

console.log('backgroundHistoryBrowsing tests passed');
