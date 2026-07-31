const test = require('node:test');
const assert = require('node:assert/strict');
const { profileTreeRows } = require('../out/profileTree');

function session() {
  return {
    id: 'profile',
    name: 'CPU',
    source: 'test',
    importedAt: 0,
    sampleType: 'cpu',
    sampleUnit: 'nanoseconds',
    total: 100,
    hotspots: [
      { id: 'work', name: 'main.work', flat: 40, cumulative: 70 }
    ],
    callTree: [
      {
        id: 'main',
        name: 'main.main',
        value: 100,
        children: [
          { id: 'small', name: 'main.small', value: 30, children: [] },
          { id: 'work', name: 'main.work', value: 70, children: [] }
        ]
      }
    ],
    lineMetrics: []
  };
}

test('builds a value-sorted expandable tree with flat and cumulative costs', () => {
  const rows = profileTreeRows(session());
  assert.deepEqual(rows.map((row) => row.name), ['main.main', 'main.work', 'main.small']);
  assert.equal(rows[0].hasChildren, true);
    assert.equal(rows[1].parentId, rows[0].id);
    assert.equal(rows[1].parentValue, 100);
  assert.equal(rows[1].flat, 70);
  assert.equal(rows[1].value, 70);
});

test('limits very large profile trees', () => {
  assert.equal(profileTreeRows(session(), 2).length, 2);
});
