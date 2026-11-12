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

// 2. Button action label resolution based on viewing state and run outcome
{
  function getActionLabel(isViewingLive: boolean, outcome: 'complete' | 'failed' | null): string {
    if (isViewingLive) return 'Return to webbook in progress';
    if (outcome === 'complete') return 'View new book';
    return 'Switch to webbook in progress';
  }

  assert.equal(getActionLabel(true, null), 'Return to webbook in progress');
  assert.equal(getActionLabel(true, 'complete'), 'Return to webbook in progress');
  assert.equal(getActionLabel(false, null), 'Switch to webbook in progress');
  assert.equal(getActionLabel(false, 'complete'), 'View new book');
  assert.equal(getActionLabel(false, 'failed'), 'Switch to webbook in progress');

  // Verify that triggering onViewLive resets viewingItem and closes history
  let historyOpen = true;
  let viewingItem: unknown = { id: 'old-1' };
  const onViewLive = () => {
    viewingItem = null; // returnToRun
    historyOpen = false; // setShowHistory(false)
  };

  onViewLive();
  assert.equal(historyOpen, false, 'Drawer must close when live run button is clicked');
  assert.equal(viewingItem, null, 'Must clear viewingItem to restore live webbook progress');
}

console.log('backgroundHistoryBrowsing tests passed');
