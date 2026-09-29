import { describe, expect, it } from 'vitest';
import type { MergedCue } from '../merge';
import {
  analyzePace,
  applyPaceFixes,
  charsPerSecond,
  DEFAULT_PACE_OPTIONS,
  readableChars,
  type PaceOptions,
} from '../pace';

function cue(start: number, end: number, text: string, groupIndex: number): MergedCue {
  return { start, end, text, groupIndex };
}

/** 生成 n 个重复字符的文本。 */
const txt = (ch: string, n: number) => ch.repeat(n);

const OPTS: PaceOptions = { maxCps: 10, minDurMs: 1000, maxDurMs: 8000 };

describe('readableChars 字素统计', () => {
  it('按 Unicode 字素计数：标点计入、空白（含换行）不计', () => {
    expect(readableChars('你好，世界！')).toBe(6);
    expect(readableChars('a b\nc')).toBe(3);
    expect(readableChars('')).toBe(0);
    expect(readableChars('  \n ')).toBe(0);
  });

  it('HTML 与 ASS 标签不计入', () => {
    expect(readableChars('<i>Hello World</i>')).toBe(10);
    expect(readableChars('{\\an8}字幕')).toBe(2);
  });

  it('emoji 与组合序列按一个字素计', () => {
    expect(readableChars('👍🏽赞')).toBe(2);
    expect(readableChars('👨‍👩‍👧')).toBe(1);
  });
});

describe('charsPerSecond', () => {
  it('正常计算字符/秒', () => {
    expect(charsPerSecond(10, 2000)).toBe(5);
    expect(charsPerSecond(7, 1000)).toBe(7);
  });

  it('时长非正：有字符为 Infinity，无字符为 0', () => {
    expect(charsPerSecond(5, 0)).toBe(Infinity);
    expect(charsPerSecond(5, -100)).toBe(Infinity);
    expect(charsPerSecond(0, 0)).toBe(0);
  });
});

describe('超限判定与区段划分', () => {
  it('超速 / 过短 / 过长分别标记，连续超限划为一个区段', () => {
    const cues = [
      cue(0, 1000, txt('好', 20), 0), // 20 字/秒 > 10：超速
      cue(2000, 2500, '短', 1), // 500ms < 1000：过短
      cue(3000, 12000, '长', 2), // 9s > 8s：过长
      cue(13000, 15000, '正常文本', 3), // 4 字 / 2s = 2：正常
    ];
    const { stats, segments } = analyzePace(cues, OPTS);
    expect(stats[0].tooFast).toBe(true);
    expect(stats[1].tooShort).toBe(true);
    expect(stats[2].tooLong).toBe(true);
    expect(stats[3].violating).toBe(false);
    expect(segments).toHaveLength(1);
    expect(segments[0].startIdx).toBe(0);
    expect(segments[0].endIdx).toBe(2);
  });

  it('正常条打断区段', () => {
    const cues = [
      cue(0, 500, '甲', 0),
      cue(1000, 3000, '正常', 1),
      cue(3500, 4000, '乙', 2),
      cue(4500, 4800, '丙', 3),
    ];
    const { segments } = analyzePace(cues, OPTS);
    expect(segments.map((s) => [s.startIdx, s.endIdx])).toEqual([
      [0, 0],
      [2, 3],
    ]);
  });

  it('字符/秒恰等于上限不算超限', () => {
    const cues = [cue(0, 2000, txt('好', 20), 0)]; // 恰为 10 字/秒
    const { stats, segments } = analyzePace(cues, OPTS);
    expect(stats[0].violating).toBe(false);
    expect(segments).toHaveLength(0);
  });

  it('空文本（仅标签/空白）字符数为 0，不会因字符/秒超限', () => {
    const cues = [cue(0, 500, '<i> </i>', 0)]; // 仅过短
    const { stats } = analyzePace(cues, OPTS);
    expect(stats[0].chars).toBe(0);
    expect(stats[0].tooFast).toBe(false);
    expect(stats[0].tooShort).toBe(true);
  });
});

describe('区段修复', () => {
  it('单条超速：向后空隙延长结束时间', () => {
    const cues = [cue(0, 1000, txt('好', 20), 0), cue(5000, 6000, '正常', 1)];
    const { segments } = analyzePace(cues, OPTS);
    expect(segments).toHaveLength(1);
    const seg = segments[0];
    expect(seg.ok).toBe(true);
    expect(seg.items[0].newStart).toBe(0);
    expect(seg.items[0].newEnd).toBe(2000); // 需 20 字 / 10 字每秒 = 2 秒
    expect(seg.gapAfterMs).toBe(4000);
  });

  it('后空隙不足时借用前空隙整体左移', () => {
    const cues = [
      cue(0, 1000, '正常', 0),
      cue(1500, 2000, txt('好', 10), 1), // 500ms → 需 1000ms
      cue(2000, 3000, '正常', 2),
    ];
    const { segments } = analyzePace(cues, OPTS);
    const seg = segments[0];
    expect(seg.ok).toBe(true);
    // 窗口 [1000, 2000] 恰好容纳 1000ms：整体左移到前边界
    expect(seg.items[0].newStart).toBe(1000);
    expect(seg.items[0].newEnd).toBe(2000);
    expect(seg.gapBeforeMs).toBe(500);
  });

  it('区段内联动：前条延长推动后条顺延', () => {
    const cues = [
      cue(0, 1000, txt('甲', 15), 0), // 需 1500
      cue(1000, 2000, txt('乙', 15), 1), // 需 1500
      cue(6000, 7000, '正常', 2),
    ];
    const { segments } = analyzePace(cues, OPTS);
    const seg = segments[0];
    expect(seg.ok).toBe(true);
    expect(seg.items[0].newStart).toBe(0);
    expect(seg.items[0].newEnd).toBe(1500);
    expect(seg.items[1].newStart).toBe(1500);
    expect(seg.items[1].newEnd).toBe(3000);
  });

  it('过长：缩短到最长时长', () => {
    const cues = [cue(0, 10000, '五个字而已', 0)];
    const { segments } = analyzePace(cues, OPTS);
    expect(segments[0].ok).toBe(true);
    expect(segments[0].items[0].newStart).toBe(0);
    expect(segments[0].items[0].newEnd).toBe(8000);
  });

  it('过短：延长到最短时长', () => {
    const cues = [cue(1000, 1400, '短', 0)];
    const { segments } = analyzePace(cues, OPTS);
    expect(segments[0].items[0].newStart).toBe(1000);
    expect(segments[0].items[0].newEnd).toBe(2000);
  });

  it('窗口不足：明确标记无解并保持原时间', () => {
    const cues = [
      cue(0, 1000, '正常', 0),
      cue(1100, 1600, txt('好', 20), 1), // 需 2000ms，窗口只有 900ms
      cue(2000, 3000, '正常', 2),
    ];
    const { segments } = analyzePace(cues, OPTS);
    const seg = segments[0];
    expect(seg.ok).toBe(false);
    expect(seg.reason).toContain('2.0 秒');
    expect(seg.items[0].newStart).toBe(seg.items[0].oldStart);
    expect(seg.items[0].newEnd).toBe(seg.items[0].oldEnd);
  });

  it('字符/秒与最长时长冲突：无解', () => {
    const cues = [cue(0, 5000, txt('好', 60), 0)]; // 需 6000ms > 最长 5000ms
    const { segments } = analyzePace(cues, { maxCps: 10, minDurMs: 1000, maxDurMs: 5000 });
    expect(segments[0].ok).toBe(false);
    expect(segments[0].reason).toContain('最长时长');
  });

  it('修复后不重叠、不早于前边界、不晚于后边界，且全部满足字符/秒', () => {
    const cues = [
      cue(0, 1000, '正常', 0),
      cue(1000, 2000, txt('甲', 30), 1), // 需 3000
      cue(2000, 3000, txt('乙', 30), 2), // 需 3000
      cue(8000, 9000, '正常', 3),
    ];
    const { segments } = analyzePace(cues, OPTS);
    const seg = segments[0];
    expect(seg.ok).toBe(true);
    const its = seg.items;
    expect(its[0].newStart).toBeGreaterThanOrEqual(1000);
    expect(its[1].newEnd).toBeLessThanOrEqual(8000);
    expect(its[1].newStart).toBeGreaterThanOrEqual(its[0].newEnd);
    for (const it of its) {
      expect(charsPerSecond(it.chars, it.newEnd - it.newStart)).toBeLessThanOrEqual(10 + 1e-9);
      expect(it.newEnd - it.newStart).toBeGreaterThanOrEqual(1000);
      expect(it.newEnd - it.newStart).toBeLessThanOrEqual(8000);
    }
  });

  it('期望时长总和超窗时按比例压缩，但不低于各自所需最短时长', () => {
    const cues = [
      cue(0, 9000, txt('甲', 30), 0), // 过长：want 8000，need 3000
      cue(9000, 9500, txt('乙', 30), 1), // 超速：need 3000
      cue(9800, 10800, '正常', 2), // 窗口 [0, 9800] < Σwant 11000
    ];
    const { segments } = analyzePace(cues, OPTS);
    const seg = segments[0];
    expect(seg.ok).toBe(true);
    const d0 = seg.items[0].newEnd - seg.items[0].newStart;
    const d1 = seg.items[1].newEnd - seg.items[1].newStart;
    expect(d0).toBeGreaterThanOrEqual(3000);
    expect(d1).toBeGreaterThanOrEqual(3000);
    expect(d0).toBeLessThanOrEqual(8000);
    expect(d1).toBeLessThanOrEqual(8000);
    expect(d0 + d1).toBeLessThanOrEqual(9800);
    expect(seg.items[0].newStart).toBeGreaterThanOrEqual(0);
    expect(seg.items[1].newEnd).toBeLessThanOrEqual(9800);
    expect(seg.items[1].newStart).toBeGreaterThanOrEqual(seg.items[0].newEnd);
  });

  it('首条可向前延伸到 0，末条右侧无界', () => {
    const cues = [cue(500, 1000, txt('好', 20), 0)]; // 需 2000ms，可左移到 0 再右延
    const { segments } = analyzePace(cues, OPTS);
    const seg = segments[0];
    expect(seg.ok).toBe(true);
    expect(seg.gapAfterMs).toBe(Infinity);
    expect(seg.items[0].newEnd - seg.items[0].newStart).toBe(2000);
  });
});

describe('applyPaceFixes', () => {
  it('采纳后应用新时间，文本与 groupIndex 不变', () => {
    const cues = [cue(0, 1000, txt('好', 20), 0), cue(5000, 6000, '正常', 1)];
    const { segments } = analyzePace(cues, OPTS);
    const out = applyPaceFixes(cues, segments, new Set([segments[0].key]));
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(2000);
    expect(out[0].text).toBe(cues[0].text);
    expect(out[0].groupIndex).toBe(0);
    expect(out[1]).toEqual(cues[1]);
    // 不修改原数组
    expect(cues[0].end).toBe(1000);
  });

  it('未采纳或 key 失效时保持原样', () => {
    const cues = [cue(0, 1000, txt('好', 20), 0)];
    const { segments } = analyzePace(cues, OPTS);
    expect(applyPaceFixes(cues, segments, new Set())).toEqual(cues);
    expect(applyPaceFixes(cues, segments, new Set(['stale-key']))).toEqual(cues);
  });

  it('无解区段即使 key 被采纳也不改时间', () => {
    const cues = [
      cue(0, 1000, '正常', 0),
      cue(1100, 1600, txt('好', 20), 1),
      cue(2000, 3000, '正常', 2),
    ];
    const { segments } = analyzePace(cues, OPTS);
    expect(segments[0].ok).toBe(false);
    expect(applyPaceFixes(cues, segments, new Set([segments[0].key]))).toEqual(cues);
  });

  it('上游时间变化导致修复不同：旧 key 自动失效', () => {
    const cues = [cue(0, 1000, txt('好', 20), 0), cue(5000, 6000, '正常', 1)];
    const before = analyzePace(cues, OPTS);
    const key = before.segments[0].key;
    const changed = [cue(500, 1500, txt('好', 20), 0), cue(5000, 6000, '正常', 1)];
    const after = analyzePace(changed, OPTS);
    expect(after.segments.map((s) => s.key)).not.toContain(key);
    expect(applyPaceFixes(changed, after.segments, new Set([key]))).toEqual(changed);
  });

  it('参数变化导致修复不同：旧 key 同样失效', () => {
    const cues = [cue(0, 1000, txt('好', 20), 0)];
    const a = analyzePace(cues, OPTS);
    const b = analyzePace(cues, { ...OPTS, maxCps: 12 });
    expect(a.segments[0].key).not.toBe(b.segments[0].key);
  });

  it('部分采纳：只应用命中的区段', () => {
    const cues = [
      cue(0, 500, '甲', 0), // 过短 → [0, 1000]
      cue(2000, 4000, '正常', 1),
      cue(5000, 5500, '乙', 2), // 过短 → [5000, 6000]
    ];
    const { segments } = analyzePace(cues, OPTS);
    expect(segments).toHaveLength(2);
    const out = applyPaceFixes(cues, segments, new Set([segments[1].key]));
    expect(out[0]).toEqual(cues[0]);
    expect(out[2].start).toBe(5000);
    expect(out[2].end).toBe(6000);
  });
});

describe('默认参数与边界', () => {
  it('默认参数：20 字/秒、1–7 秒', () => {
    expect(DEFAULT_PACE_OPTIONS).toEqual({ maxCps: 20, minDurMs: 1000, maxDurMs: 7000 });
  });

  it('非法参数回退且最短时长不超过最长时长', () => {
    const cues = [cue(0, 500, '甲乙', 0)];
    const { stats } = analyzePace(cues, { maxCps: NaN, minDurMs: 5000, maxDurMs: 1000 });
    // maxCps 回退默认 20；maxDurMs 被抬升到 minDurMs
    expect(stats[0].tooShort).toBe(true);
    expect(stats[0].tooLong).toBe(false);
  });

  it('空输入与全正常输入不产生区段', () => {
    expect(analyzePace([], OPTS).segments).toEqual([]);
    const ok = [cue(0, 2000, '正常文本', 0), cue(3000, 5000, '也正常', 1)];
    const { segments } = analyzePace(ok, OPTS);
    expect(segments).toEqual([]);
    expect(applyPaceFixes(ok, segments, new Set())).toEqual(ok);
  });
});
