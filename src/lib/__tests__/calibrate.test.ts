import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALIB_OPTIONS,
  fitCalibration,
  selectAnchors,
  type CalibOptions,
} from '../calibrate';
import type { Cue } from '../srt';

function cue(id: number, start: number, end: number, text: string): Cue {
  return { id, start, end, text };
}

/** 生成 n 条唯一文本、均匀分布的字幕。 */
function makeCues(n: number, tOf: (i: number) => [number, number], prefix = '字幕'): Cue[] {
  return Array.from({ length: n }, (_, i) => {
    const [s, e] = tOf(i);
    return cue(i, s, e, `${prefix}第${i + 1}条完全不同的内容${'甲乙丙丁戊己庚辛'[i % 8]}`);
  });
}

const OPTS: CalibOptions = { ...DEFAULT_CALIB_OPTIONS };

describe('selectAnchors 候选筛选与顺序去冲突', () => {
  it('同序同文本全部成为保留锚点', () => {
    const a = makeCues(8, (i) => [i * 3000, i * 3000 + 2000]);
    // B 为匀速 1.1 倍 + 3 秒偏移
    const b = makeCues(8, (i) => [i * 3300 + 3000, i * 3300 + 5200]);
    const anchors = selectAnchors(a, b, OPTS);
    const kept = anchors.filter((x) => x.autoKept);
    expect(kept).toHaveLength(8);
    // 下标一一对应
    kept.forEach((an, i) => {
      expect(an.aIdx).toBe(i);
      expect(an.bIdx).toBe(i);
      expect(an.textSim).toBeGreaterThan(0.99);
    });
  });

  it('剔除顺序冲突：自动保留的锚点两侧下标均严格递增', () => {
    const a = makeCues(6, (i) => [i * 4000, i * 4000 + 2000]);
    // B 中第 2、3 条文本互换（时间顺序不变），形成交叉候选
    const bOrig = makeCues(6, (i) => [i * 4000 + 500, i * 4000 + 2500]);
    const b = bOrig.map((c, i) =>
      i === 1 ? { ...c, text: bOrig[2].text } : i === 2 ? { ...c, text: bOrig[1].text } : c,
    );
    const anchors = selectAnchors(a, b, OPTS);
    const kept = anchors.filter((x) => x.autoKept).sort((x, y) => x.bIdx - y.bIdx);
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i].aIdx).toBeGreaterThan(kept[i - 1].aIdx);
      expect(kept[i].bIdx).toBeGreaterThan(kept[i - 1].bIdx);
    }
    // 至少有交叉候选被标记为顺序冲突
    expect(anchors.some((x) => !x.autoKept && x.dropReason === 'order')).toBe(true);
  });

  it('过短文本与低相似度不产生候选', () => {
    const a = [cue(0, 0, 1000, '好'), cue(1, 2000, 4000, '这是一条足够长的独立字幕内容')];
    const b = [cue(0, 100, 1100, '好'), cue(1, 2200, 4200, '完全不一样的另外一句话啊啊啊')];
    const anchors = selectAnchors(a, b, OPTS);
    expect(anchors.filter((x) => x.aIdx === 0)).toHaveLength(0);
    expect(anchors.filter((x) => x.autoKept)).toHaveLength(0);
  });
});

describe('fitCalibration 分段线性映射', () => {
  it('线性偏移被校正：映射后 B 时间贴近 A', () => {
    const a = makeCues(8, (i) => [i * 3000, i * 3000 + 2000]);
    const b = makeCues(8, (i) => [i * 3300 + 3000, i * 3300 + 5200]);
    const anchors = selectAnchors(a, b, OPTS);
    const fit = fitCalibration(a, b, anchors, new Set());
    expect(fit.ok).toBe(true);
    fit.mappedCues.forEach((m, i) => {
      expect(Math.abs(m.start - a[i].start)).toBeLessThan(150);
      expect(Math.abs(m.end - a[i].end)).toBeLessThan(150);
    });
  });

  it('剔除异常偏移锚点后仍能正确拟合', () => {
    const a = makeCues(8, (i) => [i * 4000, i * 4000 + 2000]);
    const b = makeCues(8, (i) => [i * 4000 + 800, i * 4000 + 2800]);
    // 第 4 个锚点匹配时间异常（A[3] 比正常位置晚 6 秒），B 自身仍保持单调
    a[3] = { ...a[3], start: 18000, end: 20000 };
    const anchors = selectAnchors(a, b, OPTS);
    const bad = anchors.find((x) => x.aIdx === 3 && x.bIdx === 3);
    expect(bad?.autoKept).toBe(false);
    expect(bad?.dropReason === 'outlier').toBe(true);

    const fit = fitCalibration(a, b, anchors, new Set());
    expect(fit.ok).toBe(true);
    // 其余各条仍被准确映射
    [0, 1, 2, 4, 5, 6, 7].forEach((i) => {
      expect(Math.abs(fit.mappedCues[i].start - a[i].start)).toBeLessThan(300);
    });
  });

  it('首尾按最近区段斜率外推', () => {
    const a = makeCues(6, (i) => [i * 5000, i * 5000 + 2000]);
    const b = makeCues(6, (i) => [i * 5000 + 4000, i * 5000 + 6000]);
    const anchors = selectAnchors(a, b, OPTS);
    const fit = fitCalibration(a, b, anchors, new Set());
    expect(fit.ok).toBe(true);
    // 常数偏移 -4000ms：首条外推也应校正
    expect(Math.abs(fit.mappedCues[0].start - a[0].start)).toBeLessThan(50);
    expect(Math.abs(fit.mappedCues[5].start - a[5].start)).toBeLessThan(50);
  });

  it('至少两个启用锚点才能拟合；禁用后即时重算', () => {
    const a = makeCues(4, (i) => [i * 3000, i * 3000 + 2000]);
    const b = makeCues(4, (i) => [i * 3000 + 1000, i * 3000 + 3000]);
    const anchors = selectAnchors(a, b, OPTS);
    expect(anchors.filter((x) => x.autoKept).length).toBeGreaterThanOrEqual(2);
    const disabled = new Set(
      anchors.filter((x) => x.autoKept).slice(0, -1).map((x) => x.key),
    );
    const fit1 = fitCalibration(a, b, anchors, disabled);
    expect(fit1.ok).toBe(false);
    // 取消禁用一个 → 恢复拟合
    disabled.delete([...disabled][0]);
    const fit2 = fitCalibration(a, b, anchors, disabled);
    expect(fit2.ok).toBe(true);
  });

  it('映射结果始终单调且时长为正（含退化/负斜率输入）', () => {
    const a = makeCues(5, (i) => [i * 4000, i * 4000 + 2000]);
    const b = makeCues(5, (i) => [i * 4000 + 500, i * 4000 + 2500]);
    // 直接构造锚点：时间交叉产生负斜率区段，验证钳制与单调修正
    const anchors = [
      { key: '0:0', aIdx: 0, bIdx: 0, textSim: 1, autoKept: true },
      { key: '1:1', aIdx: 2, bIdx: 1, textSim: 1, autoKept: true },
      { key: '2:2', aIdx: 4, bIdx: 2, textSim: 1, autoKept: true },
    ];
    const fit = fitCalibration(a, b, anchors, new Set());
    expect(fit.ok).toBe(true);
    for (const s of fit.segments) expect(s.slope).toBeGreaterThan(0);
    const out = fit.mappedCues;
    for (let i = 0; i < out.length; i++) {
      expect(out[i].end).toBeGreaterThan(out[i].start);
      expect(out[i].start).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start);
        expect(out[i].end).toBeGreaterThan(out[i - 1].end);
      }
    }
  });

  it('残差与区段数量合理：N 个锚点产生 N-1 段，留一残差对线性情形接近 0', () => {
    const a = makeCues(5, (i) => [i * 4000, i * 4000 + 2000]);
    const b = makeCues(5, (i) => [i * 4400 + 1200, i * 4400 + 3400]);
    const anchors = selectAnchors(a, b, OPTS);
    const fit = fitCalibration(a, b, anchors, new Set());
    expect(fit.segments).toHaveLength(4);
    for (const an of fit.active) {
      const r = fit.residuals.get(an.key);
      expect(typeof r).toBe('number');
      expect(Math.abs(r as number)).toBeLessThan(50);
    }
  });

  it('空输入安全', () => {
    const fit = fitCalibration([], [], [], new Set());
    expect(fit.ok).toBe(false);
    expect(fit.mappedCues).toEqual([]);
  });

  it('被自动剔除的锚点可手动强制启用并参与拟合', () => {
    const a = makeCues(8, (i) => [i * 4000, i * 4000 + 2000]);
    const b = makeCues(8, (i) => [i * 4000 + 800, i * 4000 + 2800]);
    a[3] = { ...a[3], start: 18000, end: 20000 };
    const anchors = selectAnchors(a, b, OPTS);
    const bad = anchors.find((x) => x.aIdx === 3 && x.bIdx === 3);
    expect(bad?.autoKept).toBe(false);
    // 默认不参与
    const fit0 = fitCalibration(a, b, anchors, new Set());
    expect(fit0.active.some((x) => x.key === bad!.key)).toBe(false);
    // 强制启用后参与拟合（输出仍保持单调）
    const fit1 = fitCalibration(a, b, anchors, new Set(), new Set([bad!.key]));
    expect(fit1.active.some((x) => x.key === bad!.key)).toBe(true);
    for (let i = 1; i < fit1.mappedCues.length; i++) {
      expect(fit1.mappedCues[i].start).toBeGreaterThanOrEqual(fit1.mappedCues[i - 1].start);
      expect(fit1.mappedCues[i].end).toBeGreaterThan(fit1.mappedCues[i].start);
    }
  });
});
