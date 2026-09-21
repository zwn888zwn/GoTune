'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
let PprofViewer;
try {
  ({ PprofViewer } = require('../out/pprofViewer'));
} finally {
  Module._load = originalLoad;
}

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

function profileFixture() {
  const strings = ['', 'cpu', 'nanoseconds', 'main.leaf', '/tmp/main.go', 'main.root', 'main.entry'];
  const sample = Buffer.concat([
    message(1, Buffer.concat([varint(1), varint(2)])),
    message(2, varint(100))
  ]);
  return Buffer.concat([
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
}

function session(id, overrides = {}) {
  return {
    id,
    name: `Profile ${id}`,
    source: `/tmp/${id}.pprof`,
    importedAt: 123,
    sampleType: 'cpu',
    sampleUnit: 'stale-unit',
    total: 0,
    target: 'example/app',
    hotspots: [],
    callTree: [],
    lineMetrics: [],
    ...overrides
  };
}

function output() {
  return { append() {}, appendLine() {} };
}

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gotune-profile-persistence-'));
}

function artifactPath(directory, id) {
  return path.join(directory, `${encodeURIComponent(id)}.pb.gz`);
}

test('restores raw data and preserves session metadata after viewer disposal', async () => {
  const directory = await temporaryDirectory();
  const bytes = profileFixture();
  try {
    const original = session('saved');
    const writer = new PprofViewer(output(), directory);
    await writer.registerProfile(original.id, bytes);
    writer.dispose();

    const restored = session('saved');
    const reader = new PprofViewer(output(), directory);
    await reader.restoreProfiles([restored]);

    assert.equal(reader.hasProfile(original.id), true);
    assert.equal(restored.id, original.id);
    assert.equal(restored.target, original.target);
    assert.equal(restored.importedAt, original.importedAt);
    assert.equal(restored.total, 100);
    assert.equal(restored.sampleUnit, 'nanoseconds');
    assert.equal(restored.hotspots.length, 3);
    assert.equal(restored.lineMetrics.length, 3);
    assert.equal(restored.callTree.length, 1);
    assert.equal(restored.hotspots[0].name, 'main.leaf');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('skips missing or corrupt profiles while restoring other valid profiles', async () => {
  const directory = await temporaryDirectory();
  const bytes = profileFixture();
  try {
    const writer = new PprofViewer(output(), directory);
    await writer.registerProfile('valid', bytes);
    writer.dispose();
    await fs.writeFile(artifactPath(directory, 'corrupt'), Buffer.from('not a protobuf profile'));

    const valid = session('valid');
    const corrupt = session('corrupt');
    const reader = new PprofViewer(output(), directory);
    await reader.restoreProfiles([session('missing'), corrupt, valid]);

    assert.equal(reader.hasProfile('missing'), false);
    assert.equal(reader.hasProfile('valid'), true);
    assert.equal(reader.hasProfile('corrupt'), false);
    assert.equal(valid.total, 100);
    assert.equal(corrupt.total, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('removes stale persisted profiles while retaining requested profiles', async () => {
  const directory = await temporaryDirectory();
  try {
    const writer = new PprofViewer(output(), directory);
    await writer.registerProfile('valid', profileFixture());
    await fs.writeFile(artifactPath(directory, 'stale'), Buffer.from('stale'));
    writer.dispose();

    await new PprofViewer(output(), directory).restoreProfiles([session('valid')]);

    await assert.doesNotReject(() => fs.access(artifactPath(directory, 'valid')));
    await assert.rejects(() => fs.access(artifactPath(directory, 'stale')), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('clear removes persistent profiles but dispose leaves them intact', async () => {
  const directory = await temporaryDirectory();
  try {
    const viewer = new PprofViewer(output(), directory);
    await viewer.registerProfile('kept', profileFixture());
    viewer.dispose();
    await assert.doesNotReject(() => fs.access(artifactPath(directory, 'kept')));

    const cleared = new PprofViewer(output(), directory);
    await cleared.restoreProfiles([session('kept')]);
    await cleared.clear();
    assert.equal(cleared.hasProfile('kept'), false);
    await assert.rejects(() => fs.access(artifactPath(directory, 'kept')), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejects a disk write while retaining the in-memory profile', async () => {
  const directory = await temporaryDirectory();
  const blocker = path.join(directory, 'not-a-directory');
  try {
    await fs.writeFile(blocker, Buffer.from('blocker'));
    const viewer = new PprofViewer(output(), blocker);
    await assert.rejects(() => viewer.registerProfile('memory-only', profileFixture()));
    assert.equal(viewer.hasProfile('memory-only'), true);
    viewer.dispose();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retains the in-memory behavior when no storage directory is configured', async () => {
  const viewer = new PprofViewer(output());
  await viewer.registerProfile('memory-only', profileFixture());
  assert.equal(viewer.hasProfile('memory-only'), true);
  await viewer.clear();
  assert.equal(viewer.hasProfile('memory-only'), false);
  viewer.dispose();
});
