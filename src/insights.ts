import { isRuntimeHotspot } from './classify';
import { Hotspot, ProfileSession, SourceLocation } from './model';

export type InsightKind = 'info' | 'warning';

export interface ProfileInsight {
  title: string;
  detail: string;
  kind: InsightKind;
  location?: SourceLocation;
}

export function profileMeaning(
  sampleType: string,
  source = '',
  captureMode?: ProfileSession['captureMode']
): string {
  if (sampleType === 'cpu') return 'CPU 采样时间：用于定位真正消耗 CPU 的函数和调用路径。';
  if (sampleType === 'inuse_space') return 'Heap Profile 中记录的存活内存：按对象分配调用栈归因。';
  if (sampleType === 'inuse_objects') return 'Heap Profile 中记录的存活对象数：按对象分配调用栈归因。';
  if (sampleType === 'alloc_space') return `${captureMode === 'delta' ? '采集窗口内' : 'Profile 范围内'}累计分配量：用于定位分配压力，不等于内存泄漏。`;
  if (sampleType === 'alloc_objects') return `${captureMode === 'delta' ? '采集窗口内' : 'Profile 范围内'}累计分配对象数：用于定位频繁创建对象的位置。`;
  if (source.toLowerCase().includes('/mutex')) {
    return 'Mutex Profile：等待时间归因到发生解锁的调用栈，表示锁竞争成本，不是等待方调用栈。';
  }
  if (source.toLowerCase().includes('/block')) {
    return 'Block Profile：阻塞时间归因到发生阻塞的 goroutine 调用栈。';
  }
  if (/delay|contentions|mutex|block/i.test(sampleType)) {
    return '阻塞或锁竞争证据：用于定位 goroutine 等待时间花在哪里。';
  }
  return `${sampleType} Profile：数值来自运行时采样证据。`;
}

export function buildProfileInsights(session: ProfileSession): ProfileInsight[] {
  if (session.total === 0 || session.hotspots.length === 0) {
    return [{
      title: '这次没有采到有效样本',
      detail: session.sampleType === 'cpu'
        ? '采集期间程序可能处于空闲状态，请在采集窗口内复现慢操作。'
        : '当前 Profile 没有可分析的数据。',
      kind: 'warning'
    }];
  }

  const sourceMapped = session.hotspots.filter((hotspot) =>
    hotspot.location && !isRuntimeHotspot(hotspot)
  );
  const candidates = sourceMapped.length > 0 ? sourceMapped : session.hotspots;
  const pathHotspot = candidates[0];
  const selfHotspot = [...candidates].sort((left, right) => right.flat - left.flat)[0];
  const insights: ProfileInsight[] = [];
  const pathPercent = percent(pathHotspot.cumulative, session.total);

  if (session.sampleType === 'cpu') {
    insights.push(hotspotInsight(
      `主要 CPU 调用路径：${shortName(pathHotspot)}`,
      `包含下层调用后占本次采样的 ${pathPercent}%。`,
      pathHotspot
    ));
    if (selfHotspot.flat > 0) {
      insights.push(hotspotInsight(
        `函数自身 CPU 最高：${shortName(selfHotspot)}`,
        `不包含下层调用时占本次采样的 ${percent(selfHotspot.flat, session.total)}%。`,
        selfHotspot
      ));
    }
  } else if (/^inuse_/.test(session.sampleType)) {
    insights.push(hotspotInsight(
      `当前存活内存热点：${shortName(selfHotspot)}`,
      `该函数自身贡献 ${percent(selfHotspot.flat, session.total)}%。是否泄漏还需比较多次 GC 后的增长趋势。`,
      selfHotspot
    ));
    insights.push(hotspotInsight(
      `存活对象的主要分配调用路径：${shortName(pathHotspot)}`,
      `该分配调用路径的累计值占 ${pathPercent}%。Heap Profile 不提供“谁仍在引用对象”的保留关系。`,
      pathHotspot
    ));
  } else if (/^alloc_/.test(session.sampleType)) {
    insights.push(hotspotInsight(
      `累计分配热点：${shortName(selfHotspot)}`,
      `该函数自身记录了本次 Profile 总累计分配的 ${percent(selfHotspot.flat, session.total)}%。`,
      selfHotspot
    ));
    insights.push({
      title: '累计分配高不等于内存泄漏',
      detail: '泄漏要看 inuse_space 在多次强制 GC 后是否持续增长。',
      kind: 'info'
    });
  } else {
    const mutex = session.source.toLowerCase().includes('/mutex');
    insights.push(hotspotInsight(
      `${mutex ? '主要互斥锁释放栈' : '主要阻塞调用栈'}：${shortName(pathHotspot)}`,
      `累计样本占 ${pathPercent}%。${mutex ? 'Mutex Profile 将竞争成本记录在解锁栈。' : '点击可查看发生阻塞的源码。'}`,
      pathHotspot
    ));
  }

  if (sourceMapped.length === 0) {
    insights.push({
      title: '没有非运行时源码位置',
      detail: '当前热点没有可用的非运行时源码位置；可以关闭“隐藏 Go runtime”继续查看完整调用链。',
      kind: 'warning'
    });
  }
  return insights.slice(0, 3);
}

function hotspotInsight(title: string, detail: string, hotspot: Hotspot): ProfileInsight {
  return { title, detail, location: hotspot.location, kind: 'info' };
}

function percent(value: number, total: number): string {
  return `${(total === 0 ? 0 : value / total * 100).toFixed(1)}`;
}

function shortName(hotspot: Hotspot): string {
  const slash = hotspot.name.lastIndexOf('/');
  return hotspot.name.slice(slash + 1);
}
