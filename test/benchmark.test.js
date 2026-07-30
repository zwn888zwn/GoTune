'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseBenchmarkOutput } = require('../out/benchmark');

test('parses and aggregates repeated Go benchmark measurements', () => {
  const measurements = parseBenchmarkOutput(`
goos: darwin
BenchmarkEncode-8  1000  1200 ns/op  512 B/op  4 allocs/op
BenchmarkEncode-8  1100  1000 ns/op  256 B/op  2 allocs/op
BenchmarkDecode-8  2000   500 ns/op    0 B/op  0 allocs/op
PASS
`);

  assert.deepEqual(measurements, [
    {
      name: 'BenchmarkEncode',
      samples: 2,
      iterations: 1050,
      nsPerOp: 1100,
      bytesPerOp: 384,
      allocsPerOp: 3
    },
    {
      name: 'BenchmarkDecode',
      samples: 1,
      iterations: 2000,
      nsPerOp: 500,
      bytesPerOp: 0,
      allocsPerOp: 0
    }
  ]);
});

test('ignores non-benchmark output and optional metrics', () => {
  assert.deepEqual(parseBenchmarkOutput('BenchmarkPing-4  25  42 ns/op\n'), [{
    name: 'BenchmarkPing',
    samples: 1,
    iterations: 25,
    nsPerOp: 42,
    bytesPerOp: undefined,
    allocsPerOp: undefined
  }]);
});
