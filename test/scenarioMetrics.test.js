'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseJsonMetrics,
  parseMetricPatternSpec,
  parsePrometheusValue,
  parseRegexMetrics
} = require('../out/scenarioMetrics');

test('reads selected numeric fields from the last JSON Lines object', () => {
  assert.deepEqual(
    parseJsonMetrics(
      'starting load\n{"progress":50}\n{"throughput_mbps":892,"latency":{"p95_ms":30},"errors":0}\n',
      ['throughput_mbps', 'latency.p95_ms', 'errors']
    ),
    {
      throughput_mbps: 892,
      'latency.p95_ms': 30,
      errors: 0
    }
  );
});

test('reads scalar, vector, and latest matrix Prometheus samples', () => {
  assert.equal(parsePrometheusValue({
    status: 'success',
    data: { resultType: 'scalar', result: [1710000000, '712.5'] }
  }), 712.5);
  assert.equal(parsePrometheusValue({
    status: 'success',
    data: {
      resultType: 'vector',
      result: [{ metric: {}, value: [1710000000, '41'] }]
    }
  }), 41);
  assert.equal(parsePrometheusValue({
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [{ metric: {}, values: [[1, '10'], [2, '12']] }]
    }
  }), 12);
});

test('rejects ambiguous Prometheus vectors', () => {
  assert.throws(() => parsePrometheusValue({
    status: 'success',
    data: {
      resultType: 'vector',
      result: [
        { metric: { instance: 'a' }, value: [1, '1'] },
        { metric: { instance: 'b' }, value: [1, '2'] }
      ]
    }
  }), /exactly one series/);
});

test('extracts command metrics with named regular expressions', () => {
  const patterns = parseMetricPatternSpec(
    'throughput=Throughput: ([\\d.]+);p95=p95: ([\\d.]+)'
  );
  assert.deepEqual(parseRegexMetrics('Throughput: 712.5\np95: 41', patterns), {
    throughput: 712.5,
    p95: 41
  });
});
