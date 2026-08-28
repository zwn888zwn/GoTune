'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assessGoroutineSnapshot,
  GoroutineTracker,
  parseGoroutineDump
} = require('../out/goroutine');

const dump = `goroutine 1 [chan receive]:
main.worker()
\t/workspace/main.go:10 +0x20

goroutine 2 [chan receive]:
main.worker()
\t/workspace/main.go:10 +0x20

goroutine 3 [IO wait]:
internal/poll.runtime_pollWait(0x123, 0x72)
\t/go/src/runtime/netpoll.go:305 +0xa0
net.(*TCPListener).Accept(0x123)
\t/go/src/net/tcpsock.go:288 +0x2c

goroutine 4 [running]:
runtime/pprof.writeGoroutineStacks({0x1, 0x2})
\t/go/src/runtime/pprof/pprof.go:692 +0x6c
`;

test('parses goroutine states and source frames', () => {
  const parsed = parseGoroutineDump(dump);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].state, 'chan receive');
  assert.equal(parsed[0].frames[0].functionName, 'main.worker');
  assert.equal(parsed[0].frames[0].line, 10);
});

test('groups stacks, removes profiler noise, and reports blocking without a stall verdict', () => {
  const tracker = new GoroutineTracker();
  const first = tracker.capture(dump);
  assert.equal(first.total, 3);
  assert.equal(first.groups.find((group) => group.state === 'chan receive').count, 2);
  assert.equal(first.suspiciousCount, 0);

  const second = tracker.capture(dump);
  const blocked = second.groups.find((group) => group.state === 'chan receive');
  assert.equal(blocked.stableCaptures, 2);
  assert.equal(blocked.severity, 'watch');
  assert.equal(second.suspiciousCount, 0);
  assert.equal(second.totalDelta, 0);
  assert.equal(second.totalGrowth, 0);
  assert.equal(assessGoroutineSnapshot(second).kind, 'needs-more-samples');
});

test('reports goroutine count growth for a stable stack', () => {
  const tracker = new GoroutineTracker();
  tracker.capture(dump);
  const grown = tracker.capture(dump.replace(
    'goroutine 3 [IO wait]:',
    'goroutine 5 [chan receive]:\nmain.worker()\n\t/workspace/main.go:10 +0x20\n\ngoroutine 3 [IO wait]:'
  ));
  const blocked = grown.groups.find((group) => group.state === 'chan receive');
  assert.equal(blocked.count, 3);
  assert.equal(blocked.countDelta, 1);
  assert.equal(blocked.countGrowth, 1);
  assert.equal(grown.totalDelta, 1);
  assert.equal(grown.totalGrowth, 1);
  assert.equal(assessGoroutineSnapshot(grown).kind, 'growth');
});

test('classifies stable I/O waits as normal rather than a deadlock', () => {
  const tracker = new GoroutineTracker();
  const ioOnly = dump.replaceAll('chan receive', 'IO wait');
  tracker.capture(ioOnly);
  const snapshot = tracker.capture(ioOnly);

  assert.equal(snapshot.suspiciousCount, 0);
  assert.equal(assessGoroutineSnapshot(snapshot).kind, 'normal-io');
});
