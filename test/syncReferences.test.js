'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { describeSyncUsage, syncSymbolAtLine } = require('../out/syncReferences');

test('finds channel sends and receives at the referenced channel symbol', () => {
  assert.deepEqual(syncSymbolAtLine('    q.jobs <- job'), {
    symbol: 'jobs',
    start: 6,
    kind: 'channel-send'
  });
  assert.deepEqual(syncSymbolAtLine('    value := <-q.jobs'), {
    symbol: 'jobs',
    start: 17,
    kind: 'channel-receive'
  });
});

test('finds lock and wait-group receivers', () => {
  assert.equal(syncSymbolAtLine('s.table.mu.Lock()').symbol, 'mu');
  assert.equal(syncSymbolAtLine('wg.Wait()').kind, 'wait');
  assert.equal(describeSyncUsage('s.table.mu.Unlock()'), 'lock usage');
});
