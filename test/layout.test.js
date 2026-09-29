'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLayout } = require('../src/layout');

test('keeps branch lanes stable and maps merge edges between them', () => {
  const repository = {
    branches: [
      { name: 'main', tip: 'c3', current: true },
      { name: 'feature', tip: 'f2', current: false }
    ],
    commits: [
      { hash:'c3', parents:['c2','f2'] },
      { hash:'f2', parents:['f1'] },
      { hash:'f1', parents:['c1'] },
      { hash:'c2', parents:['c1'] },
      { hash:'c1', parents:[] }
    ],
    ownerByHash: new Map([
      ['c3','main'], ['c2','main'], ['c1','main'],
      ['f2','feature'], ['f1','feature']
    ])
  };

  const layout = buildLayout(repository);
  assert.deepEqual(layout.lanes, ['main','feature']);
  assert.equal(layout.rows.find(r => r.hash === 'f2').laneIndex, 1);
  const mergeEdge = layout.edges.find(e => e.childHash === 'c3' && e.parentHash === 'f2');
  assert.equal(mergeEdge.fromLane, 0);
  assert.equal(mergeEdge.toLane, 1);
  assert.equal(mergeEdge.mergeParent, true);
});

test('uses a history lane for commits not owned by a current branch first-parent chain', () => {
  const repository = {
    branches: [{ name:'main', tip:'m2', current:true }],
    commits: [{hash:'m2',parents:['x1']},{hash:'x1',parents:[]}],
    ownerByHash: new Map([['m2','main']])
  };
  const layout = buildLayout(repository);
  assert.deepEqual(layout.lanes, ['main','history']);
  assert.equal(layout.rows[1].lane, 'history');
});

test('splits overlapping history chains into separate sub-lanes of the shared history lane', () => {
  // main merges two deleted branches a (a2,a1) and b (b2,b1) that were alive at the same time,
  // and later a third deleted branch c that starts only after a and b ended.
  const repository = {
    branches: [{ name:'main', tip:'m4', current:true }],
    commits: [
      { hash:'m4', parents:['m3','c1'] },
      { hash:'c1', parents:['m3'] },
      { hash:'m3', parents:['m2','b2'] },
      { hash:'m2', parents:['m1','a2'] },
      { hash:'b2', parents:['b1'] },
      { hash:'a2', parents:['a1'] },
      { hash:'b1', parents:['m1'] },
      { hash:'a1', parents:['m1'] },
      { hash:'m1', parents:[] }
    ],
    ownerByHash: new Map([['m4','main'], ['m3','main'], ['m2','main'], ['m1','main']])
  };
  const layout = buildLayout(repository);
  const row = (hash) => layout.rows.find(r => r.hash === hash);
  assert.equal(layout.historyChains.length, 3);
  assert.equal(row('b2').historyChain, row('b1').historyChain);
  assert.equal(row('a2').historyChain, row('a1').historyChain);
  assert.notEqual(row('a2').historyChain, row('b2').historyChain);
  assert.notEqual(row('a1').subLane, row('b1').subLane);
  assert.equal(row('c1').subLane, 0);
  assert.equal(layout.historySubLanes, 2);
  assert.equal(row('m1').subLane, undefined);
});
