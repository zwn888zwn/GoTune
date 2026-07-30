import { isRuntimeHotspot } from './classify';
import { Hotspot, ProfileSession, SourceLocation } from './model';

export type InsightKind = 'info' | 'warning';

export interface ProfileInsight {
  title: string;
  detail: string;
  kind: InsightKind;
  location?: SourceLocation;
}

export function profileMeaning(sampleType: string): string {
  if (sampleType === 'cpu') return 'CPU 采样时间：用于定位真正消耗 CPU 的函数和调用路径。';
  if (sampleType === 'inuse_space') return 'GC 后仍存活的内存：用于定位当前内存占用和疑似泄漏。';
  if (sampleType === 'inuse_objects') return 'GC 后仍存活的对象数：用于定位大量未释放的小对象。';
  if (sampleType === 'alloc_space') return '启动以来累计分配量：用于定位分配压力，不等于内存泄漏。';
  if (sampleType === 'alloc_objects') return '启动以来累计分配对象数：用于定位频繁创建对象的位置。';
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

  const application = session.hotspots.filter((hotspot) =>
    hotspot.location && !isRuntimeHotspot(hotspot)
  );
  const candidates = application.length > 0 ? application : session.hotspots;
  const pathHotspot = candidates[0];
  const selfHotspot = [...candidates].sort((left, right) => right.flat - left.flat)[0];
  const insights: ProfileInsight[] = [];
  const pathPercent = percent(pathHotspot.cumulative, session.total);

  if (session.sampleType === 'cpu') {
    insights.push(hotspotInsight(
      `主要 CPU 调用路径：${shortName(pathHotspot)}`,
      `包含下层调用后占本次采样的 ${pathPercent}%。先从这条调用路径进入源码。`,
      pathHotspot
    ));
    if (selfHotspot.flat > 0) {
      insights.push(hotspotInsight(
        `函数自身 CPU 最高：${shortName(selfHotspot)}`,
        `不包含下层调用时占 ${percent(selfHotspot.flat, session.total)}%，通常是最直接的计算热点。`,
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
      `主要保留路径：${shortName(pathHotspot)}`,
      `包含下层分配后占 ${pathPercent}%，可沿调用关系查找对象由谁创建。`,
      pathHotspot
    ));
  } else if (/^alloc_/.test(session.sampleType)) {
    insights.push(hotspotInsight(
      `累计分配热点：${shortName(selfHotspot)}`,
      `该函数自身产生 ${percent(selfHotspot.flat, session.total)}% 的累计分配，适合检查临时对象和复用机会。`,
      selfHotspot
    ));
    insights.push({
      title: '累计分配高不等于内存泄漏',
      detail: '泄漏要看 inuse_space 在多次强制 GC 后是否持续增长。',
      kind: 'info'
    });
  } else {
    insights.push(hotspotInsight(
      `主要等待路径：${shortName(pathHotspot)}`,
      `累计贡献 ${pathPercent}%，点击可查看对应源码。`,
      pathHotspot
    ));
  }

  if (application.length === 0) {
    insights.push({
      title: '没有映射到工作区业务源码',
      detail: '当前热点主要来自 Go 运行时或依赖；可以关闭“隐藏 Go runtime”继续查看完整调用链。',
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
