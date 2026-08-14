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
