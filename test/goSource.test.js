'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isMainGoSource, parseMainPackageOutput } = require('../out/goSource');

test('detects package main without matching comments or similar names', () => {
  assert.equal(isMainGoSource('package main\n\nfunc main() {}'), true);
  assert.equal(isMainGoSource('// package main\npackage service'), false);
  assert.equal(isMainGoSource('/*\npackage main\n*/\npackage service'), false);
  assert.equal(isMainGoSource('// generated\n\npackage main'), true);
  assert.equal(isMainGoSource('package main_test'), false);
});

test('parses the real tab separator emitted by go list', () => {
  assert.deepEqual(
    parseMainPackageOutput('example.com/app\t/workspace/cmd/app\n'),
    { importPath: 'example.com/app', directory: '/workspace/cmd/app' }
  );
  assert.equal(parseMainPackageOutput('example.com/app\\t/workspace/cmd/app'), undefined);
});
