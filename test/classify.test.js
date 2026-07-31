'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyProfileLineMetrics,
  isRuntimeFunction
} = require('../out/classify');

test('distinguishes Go runtime frames from application frames', () => {
  assert.equal(isRuntimeFunction('runtime.mallocgc', '/go/src/runtime/malloc.go'), true);
  assert.equal(isRuntimeFunction('runtime/cgo(.text)', '/go/src/runtime/cgo/asm.s'), true);
  assert.equal(isRuntimeFunction('main.allocationHotspot', '/workspace/main.go'), false);
});

test('classifies line heat from global profile contribution', () => {
  const metrics = [
    { file: '/workspace/hot.go', line: 10, value: 120, flat: 100, functionName: 'main.hot' },
    { file: '/workspace/hot.go', line: 20, value: 80, flat: 40, functionName: 'main.warm' },
    { file: '/workspace/caller.go', line: 30, value: 80, flat: 0, functionName: 'main.caller' },
    { file: '/workspace/tiny.go', line: 40, value: 2, flat: 2, functionName: 'main.tiny' },
    { file: '/go/src/runtime/proc.go', line: 50, value: 500, flat: 500, functionName: 'runtime.main' }
  ];

  const classified = classifyProfileLineMetrics(metrics, 1000);

  assert.deepEqual(
    classified.map(({ metric, hot }) => [metric.functionName, hot]),
    [
      ['main.hot', true],
      ['main.warm', true],
      ['main.caller', false]
    ]
  );
});

test('uses cumulative cost only for visibility when direct line cost is known to be zero', () => {
  const [classified] = classifyProfileLineMetrics([
    { file: '/workspace/main.go', line: 10, value: 100, flat: 0, functionName: 'main.callsExpensiveWork' }
  ], 1000);

  assert.equal(classified.share, 0.1);
  assert.equal(classified.hot, false);
});
