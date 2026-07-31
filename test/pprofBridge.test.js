'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  injectPprofBridge,
  pprofArguments,
  pprofViewerUrl
} = require('../out/pprofBridge');

test('starts the official pprof UI on a discoverable loopback port', () => {
  assert.deepEqual(pprofArguments('inuse_space', '/tmp/profile.pb.gz'), [
    'tool',
    'pprof',
    '-http=127.0.0.1:',
    '-no_browser',
    '-sample_index=inuse_space',
    '/tmp/profile.pb.gz'
  ]);
});

test('extracts the actual random pprof port from mixed tool output', () => {
  assert.equal(
    pprofViewerUrl('warning\nServing web UI on http://127.0.0.1:53930\n'),
    'http://127.0.0.1:53930'
  );
  assert.equal(
    pprofViewerUrl('Serving web UI on http://localhost:6061.'),
    'http://localhost:6061'
  );
  assert.equal(pprofViewerUrl('pprof failed before listening'), undefined);
});

test('injects a non-invasive IDE bridge into official pprof HTML', () => {
  const original = '<html><body><div id="toptable"></div></body></html>';
  const bridged = injectPprofBridge(original);

  assert.match(bridged, /source: 'gotune-pprof'/);
  assert.match(bridged, /#toptable tr/);
  assert.match(bridged, /g\.node/);
  assert.match(bridged, /\.boxbg/);
  assert.match(bridged, /#content\.source/);
  assert.match(bridged, /addEventListener\('click'/);
  assert.match(bridged, /addEventListener\('dblclick'/);
  assert.match(bridged, /centerGraphNode/);
  assert.match(bridged, /graph-control/);
  assert.match(bridged, /gotune-target/);
  assert.match(bridged, /installTopSorting/);
  assert.match(bridged, /\^sum%\$/);
  assert.match(bridged, /sumPercentColumn/);
  assert.match(bridged, /gotune-flame-tooltip/);
  assert.match(bridged, /gotune-tooltip-track/);
  assert.match(bridged, /removeAttribute\('title'\)/);
  assert.match(bridged, /installGraphPan/);
  assert.match(bridged, /graphOverviewApplied/);
  assert.match(bridged, /if \(flameFunction\(event\.target\) \|\| topFunction\(event\.target\)\) return/);
  assert.match(bridged, /scrollbar-width:thin/);
  assert.match(
    bridged,
    /message\.command === 'focus-function' && graphSvg\(\)/
  );
  assert.ok(bridged.indexOf("addEventListener('dblclick'") < bridged.indexOf('</body>'));
  const script = /<script>([\s\S]+)<\/script>/.exec(bridged)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('still injects the bridge when pprof returns an HTML fragment', () => {
  assert.match(injectPprofBridge('<div>profile</div>'), /gotune-pprof/);
});
