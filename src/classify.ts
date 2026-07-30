import { Hotspot, LineMetric } from './model';

export function isRuntimeFunction(name: string, file = ''): boolean {
  const normalizedFile = file.replaceAll('\\', '/');
  return name.startsWith('runtime.')
    || name.startsWith('runtime/')
    || normalizedFile.includes('/src/runtime/');
}

export function isRuntimeHotspot(hotspot: Hotspot): boolean {
  return isRuntimeFunction(hotspot.name, hotspot.location?.file);
}

export function isRuntimeLine(metric: LineMetric): boolean {
  return isRuntimeFunction(metric.functionName, metric.file);
}
