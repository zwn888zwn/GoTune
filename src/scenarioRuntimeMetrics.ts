import { ProfileSession, RuntimeMetrics } from './model';

export function runtimeMetricsBetween(
  before: RuntimeMetrics,
  after: RuntimeMetrics
): Record<string, number> {
  const elapsedSeconds = Math.max(1, (after.timestamp - before.timestamp) / 1000);
  const allocated = after.totalAlloc - before.totalAlloc;
  return {
    runtime_alloc_bytes: allocated,
    runtime_alloc_rate_bytes_per_s: allocated / elapsedSeconds,
    heap_alloc_change_bytes: after.heapAlloc - before.heapAlloc,
    gc_cycles: after.numGC - before.numGC,
    gc_pause_ns: after.pauseTotalNs - before.pauseTotalNs
  };
}

export function profileRuntimeMetrics(
  captures: ProfileSession[]
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const capture of captures) {
    const source = capture.source.toLowerCase();
    if (capture.sampleType === 'cpu') {
      metrics.cpu_sample_ns = capture.total;
    } else if (capture.sampleType === 'alloc_space') {
      metrics.alloc_bytes = capture.total;
    } else if (capture.sampleType === 'alloc_objects') {
      metrics.alloc_objects = capture.total;
    } else if (source.includes('/mutex')) {
      metrics.mutex_wait_ns = capture.total;
    } else if (source.includes('/block')) {
      metrics.block_wait_ns = capture.total;
    }
  }
  return metrics;
}
