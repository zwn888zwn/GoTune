'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { listProfileSampleTypes, parseProfile } = require('../out/profileParser');

function varint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  while (remaining >= 0x80n) {
    bytes.push(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Buffer.from(bytes);
}

function field(number, wire, value) {
  return Buffer.concat([varint((number << 3) | wire), value]);
}

function message(number, value) {
  return field(number, 2, Buffer.concat([varint(value.length), value]));
}

function valueType(typeIndex, unitIndex) {
  return Buffer.concat([field(1, 0, varint(typeIndex)), field(2, 0, varint(unitIndex))]);
}

function fn(id, nameIndex, fileIndex) {
  return Buffer.concat([
    field(1, 0, varint(id)),
    field(2, 0, varint(nameIndex)),
    field(4, 0, varint(fileIndex))
  ]);
}

function sourceLine(functionId, line) {
  return Buffer.concat([field(1, 0, varint(functionId)), field(2, 0, varint(line))]);
}

function location(id, lines) {
  return Buffer.concat([
    field(1, 0, varint(id)),
    ...lines.map((line) => message(4, line))
  ]);
}

test('lists pprof sample types and identifies the default', () => {
  const strings = ['', 'samples', 'count', 'alloc_space', 'bytes'];
  const profile = Buffer.concat([
    message(1, valueType(1, 2)),
    message(1, valueType(3, 4)),
    ...strings.map((value) => message(6, Buffer.from(value))),
    field(14, 0, varint(3))
  ]);

  assert.deepEqual(listProfileSampleTypes(profile), [
    { name: 'samples', unit: 'count', isDefault: false },
    { name: 'alloc_space', unit: 'bytes', isDefault: true }
  ]);
});

test('reports an actionable error for a pprof HTML index', () => {
  assert.throws(
    () => listProfileSampleTypes(Buffer.from('<!doctype html><html><body>pprof</body></html>')),
    /HTML pprof index/
  );
});

test('separates self cost from cumulative source cost and keeps inline frames', () => {
  const strings = ['', 'cpu', 'nanoseconds', 'main.leaf', '/tmp/main.go', 'main.inlineCaller', 'main.root'];
  const sample = Buffer.concat([
    message(1, Buffer.concat([varint(1), varint(2)])),
    message(2, varint(100))
  ]);
  const profile = Buffer.concat([
    message(1, valueType(1, 2)),
    message(2, sample),
    message(4, location(1, [sourceLine(1, 10), sourceLine(2, 20)])),
    message(4, location(2, [sourceLine(3, 30)])),
    message(5, fn(1, 3, 4)),
    message(5, fn(2, 5, 4)),
    message(5, fn(3, 6, 4)),
    ...strings.map((value) => message(6, Buffer.from(value))),
    field(14, 0, varint(1))
  ]);

  const parsed = parseProfile(profile, 'cpu.pprof', '/tmp/cpu.pprof');
  assert.deepEqual(
    parsed.lineMetrics.map(({ line, value, flat, functionName }) => ({ line, value, flat, functionName })),
    [
      { line: 10, value: 100, flat: 100, functionName: 'main.leaf' },
      { line: 20, value: 100, flat: 0, functionName: 'main.inlineCaller' },
      { line: 30, value: 100, flat: 0, functionName: 'main.root' }
    ]
  );
});
