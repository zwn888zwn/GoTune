'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildProfileInsights, profileMeaning } = require('../out/insights');

function session(sampleType, total, hotspots) {
  return {
    id: 'profile',
    name: 'profile',
    source: 'test',
    importedAt: 0,
    sampleType,
    sampleUnit: 'bytes',
    total,
    hotspots,
    callTree: [],
    lineMetrics: []
  };
}

test('explains allocation profiles without calling them memory leaks', () => {
  const profile = session('alloc_space', 100, [{
    id: '1',
    name: 'example.com/app.makeBuffer',
    flat: 60,
    cumulative: 80,
    location: { file: '/workspace/buffer.go', line: 12 }
  }]);

  assert.match(profileMeaning('alloc_space'), /不等于内存泄漏/);
  const insights = buildProfileInsights(profile);
  assert.match(insights[0].title, /累计分配热点/);
  assert.deepEqual(insights[0].location, { file: '/workspace/buffer.go', line: 12 });
});

test('describes timed allocation profiles as capture-window data', () => {
  assert.match(profileMeaning('alloc_space', '/debug/pprof/allocs?seconds=10', 'delta'), /采集窗口内/);
});

test('distinguishes mutex attribution from block wait stacks', () => {
  assert.match(profileMeaning('delay', '/debug/pprof/mutex'), /解锁/);
  assert.match(profileMeaning('delay', '/debug/pprof/block'), /发生阻塞/);
});

test('identifies both CPU call path and self hotspot', () => {
  const profile = {
    ...session('cpu', 100, [
      {
        id: '1',
        name: 'example.com/app.handle',
        flat: 10,
        cumulative: 80,
        location: { file: '/workspace/handler.go', line: 20 }
      },
      {
        id: '2',
        name: 'example.com/app.calculate',
        flat: 55,
        cumulative: 60,
        location: { file: '/workspace/calc.go', line: 8 }
      }
    ]),
    sampleUnit: 'nanoseconds'
  };

  const insights = buildProfileInsights(profile);
  assert.match(insights[0].title, /主要 CPU 调用路径/);
  assert.match(insights[1].title, /calculate/);
});
