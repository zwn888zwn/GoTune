import { spawn } from 'node:child_process';
import { isRuntimeFunction } from './classify';
import { CallNode, ProfileSession, SourceLocation } from './model';

export interface ProfileGraph {
  svg: string;
  locations: Array<SourceLocation | undefined>;
  nodes: ProfileGraphNode[];
}

export interface ProfileGraphNode {
  name: string;
  flat: number;
  cumulative: number;
  location?: SourceLocation;
}

interface GraphNode {
  id: string;
  name: string;
  flat: number;
  cumulative: number;
  location?: SourceLocation;
}

interface GraphData {
  nodes: GraphNode[];
  edges: Array<{ from: string; to: string; value: number }>;
}

export function profileGraphDot(
  session: ProfileSession,
  focusedFunction?: string,
  maximumNodes = 80
): {
  dot: string;
  locations: Array<SourceLocation | undefined>;
  nodes: ProfileGraphNode[];
} {
  const graph = graphData(session, maximumNodes, focusedFunction);
  const indexes = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const locations = graph.nodes.map((node) => node.location);
  const total = Math.max(Math.abs(session.total), 1);
  const nodes = graph.nodes.map((node, index) => {
    const flatPercent = Math.abs(node.flat) / total * 100;
    const cumulativePercent = Math.abs(node.cumulative) / total * 100;
    const focused = focusedFunction === node.name;
    const fill = heatColor(cumulativePercent);
    const label = `${shortName(node.name)}\n自身 ${flatPercent.toFixed(1)}% · 包含下游 ${cumulativePercent.toFixed(1)}%`;
    return `"n${index}" [id="gotune-node-${index}",label="${dotEscape(label)}",tooltip="${dotEscape(node.name)}",fillcolor="${fill}",fontcolor="${cumulativePercent >= 20 ? '#ffffff' : '#1f2937'}",color="${focused ? '#3b82f6' : '#64748b'}",penwidth="${focused ? 4 : 1.2}"];`;
  });
  const edges = graph.edges.flatMap((edge) => {
    const from = indexes.get(edge.from);
    const to = indexes.get(edge.to);
    if (from === undefined || to === undefined || from === to) return [];
    const percent = Math.abs(edge.value) / total * 100;
    return [`"n${from}" -> "n${to}" [label="${percent.toFixed(1)}%",penwidth="${Math.min(8, 1 + percent / 8).toFixed(1)}",color="#64748b"];`];
  });
  return {
    locations,
    nodes: graph.nodes.map((node) => ({
      name: node.name,
      flat: node.flat,
      cumulative: node.cumulative,
      location: node.location
    })),
    dot: [
      'digraph gotune {',
      'graph [bgcolor="transparent",rankdir=LR,ranksep=0.8,nodesep=0.35,pad=0.2];',
      'node [shape=box,style="rounded,filled",fontname="Arial",fontsize=11,margin="0.12,0.08"];',
      'edge [fontname="Arial",fontsize=9,fontcolor="#94a3b8",arrowsize=0.7];',
      ...nodes,
      ...edges,
      '}'
    ].join('\n')
  };
}

export async function renderProfileGraph(
  session: ProfileSession,
  focusedFunction?: string
): Promise<ProfileGraph | undefined> {
  if (session.total === 0 || session.callTree.length === 0) return undefined;
  const graph = profileGraphDot(session, focusedFunction);
  try {
    const svg = await renderDot(graph.dot);
    const start = svg.indexOf('<svg');
    if (start < 0) return undefined;
    return {
      svg: svg.slice(start).replace('<svg ', '<svg class="profile-graph" '),
      locations: graph.locations,
      nodes: graph.nodes
    };
  } catch {
    return undefined;
  }
}

function graphData(
  session: ProfileSession,
  maximumNodes: number,
  focusedFunction?: string
): GraphData {
  const hotspots = new Map(session.hotspots.map((hotspot) => [hotspot.id, hotspot]));
  const focusedIds = new Set(
    session.hotspots
      .filter((hotspot) => hotspot.name === focusedFunction)
      .map((hotspot) => hotspot.id)
  );
  const selected = focusedIds.size > 0
    ? focusedNeighborhood(session.callTree, focusedIds)
    : new Set<string>();
  if (selected.size === 0) {
    const preferred = session.hotspots
      .filter((hotspot) => hotspot.location && !isRuntimeFunction(hotspot.name))
      .slice(0, maximumNodes);
    for (const hotspot of preferred) selected.add(hotspot.id);
    if (selected.size < Math.min(maximumNodes, session.hotspots.length)) {
      for (const hotspot of session.hotspots) {
        if (selected.size >= maximumNodes) break;
        selected.add(hotspot.id);
      }
    }
  }
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, { from: string; to: string; value: number }>();
  const visit = (node: CallNode, selectedParentId?: string): void => {
    let nextParentId = selectedParentId;
    if (selected.has(node.id)) {
      const hotspot = hotspots.get(node.id);
      nodes.set(node.id, {
        id: node.id,
        name: node.name,
        flat: hotspot?.flat ?? 0,
        cumulative: hotspot?.cumulative ?? node.value,
        location: hotspot?.location ?? node.location
      });
      if (selectedParentId) {
        const key = `${selectedParentId}\0${node.id}`;
        const edge = edges.get(key) ?? { from: selectedParentId, to: node.id, value: 0 };
        edge.value += node.value;
        edges.set(key, edge);
      }
      nextParentId = node.id;
    }
    for (const child of node.children) visit(child, nextParentId);
  };
  for (const root of session.callTree) visit(root);
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function focusedNeighborhood(roots: CallNode[], focusedIds: Set<string>): Set<string> {
  const selected = new Set<string>();
  const addDescendants = (node: CallNode, depth: number): void => {
    if (depth < 0) return;
    selected.add(node.id);
    for (const child of node.children) addDescendants(child, depth - 1);
  };
  const visit = (node: CallNode, ancestors: CallNode[]): void => {
    if (focusedIds.has(node.id)) {
      for (const ancestor of ancestors.slice(-3)) selected.add(ancestor.id);
      addDescendants(node, 2);
    }
    for (const child of node.children) visit(child, [...ancestors, node]);
  };
  for (const root of roots) visit(root, []);
  return selected;
}

async function renderDot(dot: string): Promise<string> {
  const candidates = process.platform === 'win32'
    ? ['dot.exe', 'dot']
    : ['dot', '/opt/homebrew/bin/dot', '/usr/local/bin/dot'];
  let lastError: unknown;
  for (const executable of candidates) {
    try {
      return await renderDotCommand(executable, dot);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function renderDotCommand(executable: string, dot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-Tsvg'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Graphviz timed out'));
    }, 5000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `Graphviz exited with ${code}`));
      }
    });
    child.stdin.end(dot);
  });
}

function heatColor(percent: number): string {
  if (percent >= 50) return '#b91c1c';
  if (percent >= 25) return '#ea580c';
  if (percent >= 10) return '#f59e0b';
  if (percent >= 3) return '#fde68a';
  return '#e2e8f0';
}

function shortName(name: string): string {
  const slash = name.lastIndexOf('/');
  const value = slash >= 0 ? name.slice(slash + 1) : name;
  return value.length > 55 ? `…${value.slice(-54)}` : value;
}

function dotEscape(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}
