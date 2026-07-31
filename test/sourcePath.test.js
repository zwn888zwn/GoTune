'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applySourcePathMappings, sourcePathsMatch } = require('../out/sourcePath');

test('uses the longest matching remote source prefix', () => {
  assert.equal(applySourcePathMappings(
    '/app/services/api/server.go',
    {
      '/app': '/workspace',
      '/app/services/api': '/Users/me/project/Api'
    }
  ), '/Users/me/project/Api/server.go');
});

test('matches a remote profile source with its local workspace file', () => {
  assert.equal(sourcePathsMatch(
    '/container/src/project/pkg/work.go',
    '/Users/me/project/pkg/work.go',
    { '/container/src/project': '/Users/me/project' }
  ), true);
});

test('does not crash when an editor command provides an invalid source reference', () => {
  assert.equal(sourcePathsMatch(undefined, '/workspace/main.go'), false);
  assert.equal(sourcePathsMatch('/workspace/main.go', undefined), false);
});
