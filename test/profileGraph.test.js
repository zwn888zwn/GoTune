'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { profileGraphDot } = require('../out/profileGraph');

test('builds a source-linked Graphviz call graph with self and cumulative cost', () => {
  const session = {
    id: 'cpu',
    name: 'CPU',
    source: 'test',
    importedAt: 1,
    sampleType: 'cpu',
    sampleUnit: 'nanoseconds',
    total: 100,
    hotspots: [
      { id: '1', name: 'main.Handle', flat: 10, cumulative: 100, location: { file: '/tmp/main.go', line: 10 } },
      { id: '2', name: 'main.encode', flat: 70, cumulative: 70, location: { file: '/tmp/main.go', line: 20 } }
    ],
    callTree: [{
      id: '1',
      name: 'main.Handle',
      value: 100,
      location: { file: '/tmp/main.go', line: 10 },
      children: [{
        id: '2',
        name: 'main.encode',
        value: 70,
        location: { file: '/tmp/main.go', line: 20 },
        children: []
      }]
    }],
    lineMetrics: []
  };

  const graph = profileGraphDot(session, 'main.encode');

  assert.match(graph.dot, /main\.Handle/);
  assert.match(graph.dot, /自身 10\.0% · 包含下游 100\.0%/);
  assert.match(graph.dot, /"n0" -> "n1"/);
  assert.match(graph.dot, /gotune-node-1/);
  assert.deepEqual(graph.locations[1], { file: '/tmp/main.go', line: 20 });
  assert.deepEqual(graph.nodes[1], {
    name: 'main.encode',
    flat: 70,
    cumulative: 70,
    location: { file: '/tmp/main.go', line: 20 }
  });
});

test('focused graph only keeps nearby callers and callees and always includes the function', () => {
  const nodes = Array.from({ length: 90 }, (_, index) => ({
    id: String(index),
    name: `main.f${index}`,
    flat: 1,
    cumulative: 100 - index,
    location: { file: '/tmp/main.go', line: index + 1 }
  }));
  const root = {
    id: '0',
    name: 'main.f0',
    value: 100,
    location: nodes[0].location,
    children: []
  };
  let parent = root;
  for (let index = 1; index < nodes.length; index++) {
    const child = {
      id: String(index),
      name: `main.f${index}`,
      value: 100 - index,
      location: nodes[index].location,
      children: []
    };
    parent.children.push(child);
    parent = child;
  }
  const session = {
    id: 'cpu',
    name: 'CPU',
    source: 'test',
    importedAt: 1,
    sampleType: 'cpu',
    sampleUnit: 'nanoseconds',
    total: 100,
    hotspots: nodes,
    callTree: [root],
    lineMetrics: []
  };

  const graph = profileGraphDot(session, 'main.f85');

  assert.match(graph.dot, /main\.f85/);
  assert.match(graph.dot, /main\.f82/);
  assert.match(graph.dot, /main\.f87/);
  assert.doesNotMatch(graph.dot, /main\.f20/);
});
