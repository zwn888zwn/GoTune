'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  injectPprofBridge,
  pprofArguments,
  pprofGraphPath,
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

test('uses the version-appropriate official pprof graph path', () => {
  assert.equal(pprofGraphPath(200, undefined), '/ui/');
  assert.equal(pprofGraphPath(301, 'flamegraph?n=1'), '/ui/graph');
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
  assert.match(bridged, /installTopSingleSelection/);
  assert.match(bridged, /table\.querySelectorAll\('tr\.hilite,tr\.hilite2'\)/);
  assert.match(bridged, /item\.classList\.remove\('hilite', 'hilite2'\)/);
  assert.match(bridged, /\^sum%\$/);
  assert.match(bridged, /sumPercentColumn/);
  assert.match(bridged, /gotune-flame-tooltip/);
  assert.match(bridged, /gotune-tooltip-track/);
  assert.match(bridged, /removeAttribute\('title'\)/);
  assert.match(bridged, /installGraphPan/);
  assert.match(bridged, /addEventListener\('wheel'/);
  assert.match(bridged, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(bridged, /deltaX \* 1\.35/);
  assert.match(bridged, /svg\.style\.cursor = 'grab'/);
  assert.match(bridged, /graphDragEndedAt/);
  assert.match(bridged, /if \(drag\.moved\) \{\s*event\.preventDefault\(\)/);
  assert.doesNotMatch(
    bridged,
    /svg\.setPointerCapture\(event\.pointerId\);\s*svg\.style\.cursor = 'grabbing'/
  );
  assert.match(bridged, /if \(!drag\.moved\) svg\.setPointerCapture\(event\.pointerId\)/);
  assert.match(bridged, /flameClickTimer/);
  assert.match(bridged, /flameSingleClick/);
  assert.match(bridged, /message\.command === 'flame-options'/);
  assert.match(bridged, /clearTimeout\(flameClickTimer\)/);
  assert.doesNotMatch(bridged, /graphOverviewApplied/);
  assert.match(bridged, /focusGraphNode/);
  assert.match(bridged, /clearGraphFocus/);
  assert.match(bridged, /const canPan = event\.button === 2/);
  assert.match(bridged, /event\.button === 0 && \(event\.ctrlKey \|\| event\.metaKey\)/);
  assert.match(bridged, /host\(\{ command: 'selected-function', functionName \}\);\s*focusGraphNode\(graphNode\)/);
  assert.doesNotMatch(bridged, /graphClickTimer/);
  const doubleClickHandler = /addEventListener\('dblclick', \(event\) => \{([\s\S]*?)window\.addEventListener\('message'/.exec(bridged)?.[1];
  assert.ok(doubleClickHandler);
  assert.doesNotMatch(doubleClickHandler, /setFlamePivot\(flameName\)/);
  assert.match(
    doubleClickHandler,
    /if \(flameName\) \{\s*clearTimeout\(flameClickTimer\);\s*host\(\{ command: 'selected-function', functionName: flameName \}\);\s*return;/
  );
  assert.match(bridged, /host\(\{ command: 'selected-function', functionName: '' \}\)/);
  assert.match(bridged, /gotune-related/);
  assert.match(bridged, /const graphNodeForKey/);
  assert.match(bridged, /centerGraphNode\(node\)/);
  assert.doesNotMatch(bridged, /centerGraphNode\(graphFunction\(node\)\)/);
  assert.match(bridged, /message\.command === 'focus-node'/);
  assert.match(bridged, /路径 ' \+ index \+ '\/' \+ total/);
  assert.doesNotMatch(bridged, /results\.includes\(name\)/);
  assert.match(bridged, /search-results/);
  assert.match(bridged, /searchGraph/);
  assert.match(bridged, /searchFlame/);
  assert.match(bridged, /setFlamePivot/);
  assert.match(bridged, /url\.searchParams\.set\('p'/);
  assert.match(bridged, /url\.searchParams\.delete\('p'\)/);
  assert.match(bridged, /new PopStateEvent\('popstate'\)/);
  assert.match(bridged, /message\.command === 'flame-reset'/);
  assert.match(bridged, /search-position/);
  assert.match(bridged, /search-step/);
  assert.match(bridged, /event\.ctrlKey \|\| event\.metaKey/);
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

test('ignores stale iframe readiness from a different pprof view', () => {
  const viewer = fs.readFileSync(require.resolve('../out/pprofViewer'), 'utf8');
  assert.match(viewer, /view==='graph'\?model\.graphPath/);
  assert.match(viewer, /if\(message\.path!==viewPath\(currentView\)\)return/);
});

test('keeps call-tree node identities and focuses sampled functions without expanding the whole graph', () => {
  const viewer = fs.readFileSync(require.resolve('../out/pprofViewer'), 'utf8');
  assert.match(viewer, /command:'focus-node',nodeKey:result\.key/);
  assert.match(viewer, /if\(graphFocusFilter\)params\.set\('f',graphFocusFilter\)/);
  assert.match(viewer, /graphFocusFilter=exactGraphPattern\(message\.functionName\)/);
  assert.match(viewer, /已采样，但 pprof 调用图无法定位该节点/);
  assert.doesNotMatch(viewer, /graphNodeCount=Math\.max\(graphNodeCount,500\)/);
  assert.doesNotMatch(viewer, /new Set\(message\.results/);
});
