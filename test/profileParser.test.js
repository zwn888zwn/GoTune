'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { listProfileSampleTypes } = require('../out/profileParser');

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
