import { Hotspot, LineMetric } from './model';

export interface ProfileLineHeat {
  metric: LineMetric;
  score: number;
  share: number;
  hot: boolean;
}

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

export function classifyProfileLineMetrics(
  metrics: LineMetric[],
  total: number
): ProfileLineHeat[] {
  if (total <= 0) return [];
  const candidates = metrics
    .filter((metric) => metric.value > 0 && !isRuntimeLine(metric))
    .map((metric) => {
      const direct = metric.flat ?? metric.value;
      return {
        metric,
        direct,
        score: Math.max(direct, metric.value),
        share: Math.max(direct, metric.value) / total
      };
    });
  const directRanks = [...candidates]
    .filter(({ direct }) => direct > 0)
    .sort((left, right) => right.direct - left.direct);
  return candidates
    .filter(({ share }) => share >= 0.005)
    .map(({ metric, direct, score, share }) => {
      const directShare = direct / total;
      const directRank = directRanks.findIndex((candidate) => candidate.metric === metric);
      return {
        metric,
        score,
        share,
        hot: directShare >= 0.05 || (directRank >= 0 && directRank < 3 && directShare >= 0.01)
      };
    });
}
