'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isRuntimeFunction } = require('../out/classify');

test('distinguishes Go runtime frames from application frames', () => {
  assert.equal(isRuntimeFunction('runtime.mallocgc', '/go/src/runtime/malloc.go'), true);
  assert.equal(isRuntimeFunction('runtime/cgo(.text)', '/go/src/runtime/cgo/asm.s'), true);
  assert.equal(isRuntimeFunction('main.allocationHotspot', '/workspace/main.go'), false);
});
