import * as zlib from 'node:zlib';
import { CallNode, Hotspot, LineMetric, ProfileSession, SourceLocation } from './model';

interface Field {
  number: number;
  wire: number;
  value: bigint | Buffer;
}

interface FunctionInfo {
  id: bigint;
  name: string;
  file: string;
}

interface LocationInfo {
  id: bigint;
  lines: Array<{ functionId: bigint; line: number }>;
}

interface SampleInfo {
  locations: bigint[];
  values: number[];
}

export interface ProfileSampleType {
  name: string;
  unit: string;
  isDefault: boolean;
}

function readVarint(data: Buffer, offset: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < data.length) {
    const byte = data[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [value, cursor];
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error('Invalid protobuf varint');
    }
  }
  throw new Error('Unexpected end of protobuf data');
}

function signed(value: bigint): number {
  return Number(BigInt.asIntN(64, value));
}

function fields(data: Buffer): Field[] {
  const result: Field[] = [];
  let offset = 0;
  while (offset < data.length) {
    const [tag, afterTag] = readVarint(data, offset);
    offset = afterTag;
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (number === 0) {
      throw new Error('Invalid protobuf field number');
    }
    if (wire === 0) {
      const [value, next] = readVarint(data, offset);
      result.push({ number, wire, value });
      offset = next;
    } else if (wire === 1) {
      if (offset + 8 > data.length) {
        throw new Error('Invalid fixed64 protobuf field');
      }
      offset += 8;
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(data, offset);
      const end = afterLength + Number(length);
      if (end > data.length) {
        throw new Error('Invalid length-delimited protobuf field');
      }
      result.push({ number, wire, value: data.subarray(afterLength, end) });
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > data.length) {
        throw new Error('Invalid fixed32 protobuf field');
      }
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return result;
}

function unpackVarints(field: Field): bigint[] {
  if (typeof field.value === 'bigint') {
    return [field.value];
  }
  const values: bigint[] = [];
  let offset = 0;
  while (offset < field.value.length) {
    const [value, next] = readVarint(field.value, offset);
    values.push(value);
    offset = next;
  }
  return values;
}

function firstVarint(message: Field[], number: number): bigint {
  const field = message.find((candidate) => candidate.number === number && typeof candidate.value === 'bigint');
  return field?.value as bigint | undefined ?? 0n;
}

function stringAt(table: string[], index: bigint): string {
  return table[Number(index)] ?? '';
}

function displayName(fullName: string): string {
  const slash = fullName.lastIndexOf('/');
  const packageStart = slash >= 0 ? slash + 1 : 0;
  return fullName.slice(packageStart);
}

function locationFor(location: LocationInfo, functions: Map<bigint, FunctionInfo>): [FunctionInfo, SourceLocation | undefined] | undefined {
  const line = location.lines[0];
  if (!line) {
    return undefined;
  }
  const fn = functions.get(line.functionId);
  if (!fn) {
    return undefined;
  }
  return [fn, fn.file ? { file: fn.file, line: line.line } : undefined];
}

function decodeProfile(input: Buffer): { profileFields: Field[]; strings: string[] } {
  const prefix = input.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) {
    throw new Error(
      'The URL returned an HTML pprof index, not profile data. Choose CPU, Heap, or another concrete profile type.'
    );
  }
  const data = input[0] === 0x1f && input[1] === 0x8b ? zlib.gunzipSync(input) : input;
  const profileFields = fields(data);
  const strings = profileFields
    .filter((field) => field.number === 6 && Buffer.isBuffer(field.value))
    .map((field) => (field.value as Buffer).toString('utf8'));
  if (strings.length === 0) {
    throw new Error('The file is not a valid pprof profile: string table is missing');
  }
  return { profileFields, strings };
}

export function listProfileSampleTypes(input: Buffer): ProfileSampleType[] {
  const { profileFields, strings } = decodeProfile(input);
  const sampleTypes = profileFields
    .filter((field) => field.number === 1 && Buffer.isBuffer(field.value))
    .map((field) => fields(field.value as Buffer));
  const defaultTypeStringIndex = firstVarint(profileFields, 14);
  const result = sampleTypes.map((type) => ({
    name: stringAt(strings, firstVarint(type, 1)) || 'samples',
    unit: stringAt(strings, firstVarint(type, 2)) || 'count',
    isDefault: defaultTypeStringIndex !== 0n && firstVarint(type, 1) === defaultTypeStringIndex
  }));
  if (result.length > 0 && !result.some((type) => type.isDefault)) {
    result[result.length - 1].isDefault = true;
  }
  return result;
}

export function parseProfile(
  input: Buffer,
  name: string,
  source: string,
  preferredSampleType?: string
): ProfileSession {
  const { profileFields, strings } = decodeProfile(input);
  const sampleTypes = profileFields
    .filter((field) => field.number === 1 && Buffer.isBuffer(field.value))
    .map((field) => fields(field.value as Buffer));
  const defaultTypeStringIndex = firstVarint(profileFields, 14);
  let selectedIndex = preferredSampleType
    ? sampleTypes.findIndex((type) => stringAt(strings, firstVarint(type, 1)) === preferredSampleType)
    : sampleTypes.findIndex((type) => firstVarint(type, 1) === defaultTypeStringIndex);
  if (selectedIndex < 0) {
    selectedIndex = Math.max(0, sampleTypes.length - 1);
  }
  const selectedType = sampleTypes[selectedIndex] ?? [];
  const sampleType = stringAt(strings, firstVarint(selectedType, 1)) || 'samples';
  const sampleUnit = stringAt(strings, firstVarint(selectedType, 2)) || 'count';

  const functions = new Map<bigint, FunctionInfo>();
  for (const field of profileFields.filter((candidate) => candidate.number === 5 && Buffer.isBuffer(candidate.value))) {
    const message = fields(field.value as Buffer);
    const info: FunctionInfo = {
      id: firstVarint(message, 1),
      name: stringAt(strings, firstVarint(message, 2)),
      file: stringAt(strings, firstVarint(message, 4))
    };
    functions.set(info.id, info);
  }

  const locations = new Map<bigint, LocationInfo>();
  for (const field of profileFields.filter((candidate) => candidate.number === 4 && Buffer.isBuffer(candidate.value))) {
    const message = fields(field.value as Buffer);
    const info: LocationInfo = {
      id: firstVarint(message, 1),
      lines: message
        .filter((candidate) => candidate.number === 4 && Buffer.isBuffer(candidate.value))
        .map((candidate) => {
          const line = fields(candidate.value as Buffer);
          return { functionId: firstVarint(line, 1), line: signed(firstVarint(line, 2)) };
        })
    };
    locations.set(info.id, info);
  }

  const samples: SampleInfo[] = profileFields
    .filter((field) => field.number === 2 && Buffer.isBuffer(field.value))
    .map((field) => {
      const message = fields(field.value as Buffer);
      return {
        locations: message.filter((candidate) => candidate.number === 1).flatMap(unpackVarints),
        values: message.filter((candidate) => candidate.number === 2).flatMap(unpackVarints).map(signed)
      };
    });

  const totals = new Map<bigint, { name: string; flat: number; cumulative: number; location?: SourceLocation }>();
  const lineTotals = new Map<string, LineMetric>();
  const root: CallNode = { id: 'root', name: 'root', value: 0, children: [] };
  let total = 0;

  for (const sample of samples) {
    const value = sample.values[selectedIndex] ?? 0;
    if (value === 0) {
      continue;
    }
    total += value;
    root.value += value;
    const stack = sample.locations
      .map((id) => locations.get(id))
      .filter((location): location is LocationInfo => Boolean(location))
      .map((location) => ({ location, resolved: locationFor(location, functions) }))
      .filter((entry): entry is { location: LocationInfo; resolved: [FunctionInfo, SourceLocation | undefined] } => Boolean(entry.resolved));

    stack.forEach((entry, index) => {
      const [fn, sourceLocation] = entry.resolved;
      const current = totals.get(fn.id) ?? { name: fn.name, flat: 0, cumulative: 0, location: sourceLocation };
      current.cumulative += value;
      if (index === 0) {
        current.flat += value;
      }
      totals.set(fn.id, current);

      if (sourceLocation) {
        const key = `${sourceLocation.file}:${sourceLocation.line}`;
        const metric = lineTotals.get(key) ?? {
          file: sourceLocation.file,
          line: sourceLocation.line,
          value: 0,
          functionName: fn.name
        };
        metric.value += value;
        lineTotals.set(key, metric);
      }
    });

    let parent = root;
    for (const entry of [...stack].reverse()) {
      const [fn, sourceLocation] = entry.resolved;
      const id = fn.id.toString();
      let node = parent.children.find((candidate) => candidate.id === id);
      if (!node) {
        node = { id, name: fn.name, value: 0, location: sourceLocation, children: [] };
        parent.children.push(node);
      }
      node.value += value;
      parent = node;
    }
  }

  const hotspots: Hotspot[] = [...totals.entries()]
    .map(([id, value]) => ({ id: id.toString(), ...value }))
    .sort((left, right) => right.cumulative - left.cumulative);
  const sortTree = (nodes: CallNode[]): CallNode[] => nodes
    .sort((left, right) => right.value - left.value)
    .map((node) => ({ ...node, children: sortTree(node.children) }));

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    source,
    importedAt: Date.now(),
    sampleType,
    sampleUnit,
    total,
    hotspots,
    callTree: sortTree(root.children),
    lineMetrics: [...lineTotals.values()]
  };
}
