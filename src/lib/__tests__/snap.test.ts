import { describe, expect, it } from 'vitest';
import type { MergedCue } from '../merge';
import {
  applySnaps,
  countCutsBetween,
  DEFAULT_SNAP_OPTIONS,
  parseCutList,
  planSnaps,
  type SnapOptions,
} from '../snap';

function cue(start: number, end: number, groupIndex: number, text = '字幕文本'): MergedCue {
  return { start, end, text, groupIndex };
}

const OPTS: SnapOptions = { thresholdMs: 500, minDurMs: 1000 };

describe('parseCutList 切点列表解析', () => {
  it('每行一个 HH:MM:SS,mmm，升序返回毫秒', () => {
    const r = parseCutList('00:00:03,200\n00:00:01,040\n00:01:00,000\n');
    expect(r.invalid).toEqual([]);
    expect(r.cuts).toEqual([1040, 3200, 60000]);
    expect(r.totalLines).toBe(3);
  });

  it('兼容小数点、MM:SS 与 1~3 位毫秒，忽略空白行与 BOM', () => {
    const r = parseCutList('﻿  00:01.5 \n\n1:02:03,5\n');
    expect(r.invalid).toEqual([]);
    expect(r.cuts).toEqual([1500, 3723500]);
  });

  it('去重且报告非法行号与原文', () => {
    const r = parseCutList('00:00:01,000\n00:00:01,000\nnot-a-time\n  \n00:61:00,000');
    expect(r.cuts).toEqual([1000]);
    expect(r.invalid.map((b) => b.line)).toEqual([3, 5]);
    expect(r.invalid[0].raw).toBe('not-a-time');
    expect(r.totalLines).toBe(4);
  });

  it('空文本', () => {
    const r = parseCutList('');
    expect(r.cuts).toEqual([]);
    expect(r.invalid).toEqual([]);
  });
});

describe('countCutsBetween', () => {
  it('切点恰在边界上不计入开区间', () => {
    expect(countCutsBetween([1000, 2000, 3000], 1000, 3000)).toBe(1);
    expect(countCutsBetween([1000, 2000, 3000], 0, 1000)).toBe(0);
  });
});

describe('planSnaps 基本吸附', () => {
  it('切点在字幕内部且只够到开始边界：开始吸附到切点，不再跨镜头', () => {
    const cues = [cue(1000, 3000, 0)];
    const plan = planSnaps(cues, [1300], OPTS);
    expect(plan.ok).toBe(true);
    expect(plan.originalCrossing).toBe(1);
    expect(plan.items[0].newStart).toBe(1300);
    expect(plan.items[0].newEnd).toBe(3000);
    expect(plan.cost.crossing).toBe(0);
    expect(plan.cost.displacement).toBe(300);
    expect(plan.cost.changed).toBe(1);
    expect(plan.items[0].start.cut).toBe(1300);
    expect(plan.items[0].end.cut).toBeNull();
  });

  it('切点同时在两端阈值内：两端收缩，时长不短于最小值', () => {
    const cues = [cue(1000, 5000, 0)];
    const plan = planSnaps(cues, [1400, 4600], OPTS);
    expect(plan.ok).toBe(true);
    const it = plan.items[0];
    expect([it.newStart, it.newEnd]).toEqual([1400, 4600]);
    expect(it.newEnd - it.newStart).toBeGreaterThanOrEqual(1000);
    expect(it.newCrossing).toBe(false);
  });

  it('切点恰在原边界上：不算跨镜头、不移动，标记“已在切点”', () => {
    const cues = [cue(2000, 4000, 0)];
    const plan = planSnaps(cues, [2000], OPTS);
    const it = plan.items[0];
    expect(plan.originalCrossing).toBe(0);
    expect(it.changed).toBe(false);
    expect(it.start.cut).toBe(2000);
    expect(it.start.reason).toBe('');
  });

  it('阈值外切点不产生候选，保持原位', () => {
    const cues = [cue(1000, 3000, 0)];
    const plan = planSnaps(cues, [4000], OPTS);
    expect(plan.items[0].changed).toBe(false);
    expect(plan.items[0].end.reason).toContain('阈值内无切点');
  });

  it('区间外的邻近切点不会触发外扩（跨镜头数相同时位移更小者胜）', () => {
    const cues = [cue(2000, 3000, 0)];
    const plan = planSnaps(cues, [1800, 3200], OPTS);
    expect(plan.cost).toEqual({ crossing: 0, displacement: 0, changed: 0 });
    expect(plan.items[0].changed).toBe(false);
    expect(plan.items[0].start.reason).toContain('未跨切点');
  });
});

describe('目标函数字典序', () => {
  it('先最小化跨镜头数：宁可多位移也要吸附到更远切点', () => {
    // 切点 1200/1300 都在区间内：吸到 1200 仍跨 1300，吸到 1300 才不跨
    const cues = [cue(1000, 5000, 0)];
    const plan = planSnaps(cues, [1200, 1300], OPTS);
    expect(plan.items[0].newStart).toBe(1300);
    expect(plan.cost.crossing).toBe(0);
    expect(plan.cost.displacement).toBe(300);
  });

  it('跨镜头数相同时最小化位移：选择更近的切点', () => {
    // 两个切点都在开始侧阈值内，吸到任一都使区间不含切点（切点在区间外）
    // 无跨镜头时原位最优；这里构造区间内单个切点、两个可达切点的情形
    const cues = [cue(1000, 5000, 0)];
    // 切点 1300 在区间内，1200 也在区间内：1200 方案仍跨 1300，故取 1300（上一用例）
    // 改为：切点 1300 在区间内，开始候选还有更近的区间外切点 —— 原位跨镜头，
    // 吸附到 1300（300）唯一可消除，吸附到 800（外扩）不能消除，验证不会选外扩
    const plan = planSnaps(cues, [800, 1300], OPTS);
    expect(plan.items[0].newStart).toBe(1300);
  });
});

describe('硬约束', () => {
  it('吸附后短于最小时长的候选被丢弃：切点留在区间内并给出原因', () => {
    const cues = [cue(2000, 3500, 0)]; // 1.5 秒；开始吸到 2600 后只剩 900ms
    const plan = planSnaps(cues, [2600], { thresholdMs: 600, minDurMs: 1000 });
    expect(plan.ok).toBe(true);
    const it = plan.items[0];
    expect(it.changed).toBe(false);
    expect(it.newCrossing).toBe(true);
    expect(it.start.reason).toContain('短于最小时长');
  });

  it('相邻不重叠：上一条结束可左移切点为下一条让路（全局联动）', () => {
    const cues = [
      cue(0, 2100, 0),
      cue(2100, 4100, 1),
    ];
    // 切点 1900 在第 1 条内部：第 1 条结束左移到 1900
    const plan = planSnaps(cues, [1900], OPTS);
    expect(plan.ok).toBe(true);
    expect(plan.items[0].newEnd).toBe(1900);
    expect(plan.items[1].newStart).toBe(2100);
    expect(plan.items[1].newStart).toBeGreaterThanOrEqual(plan.items[0].newEnd);
  });

  it('原始重叠且阈值内切点不足以消除：整体无解并说明原因', () => {
    const cues = [
      cue(0, 2000, 0),
      cue(1500, 3500, 1), // 重叠 500ms
    ];
    const plan = planSnaps(cues, [1700, 1800], { thresholdMs: 200, minDurMs: 1000 });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('重叠');
    // 无解时条目保持原位、不可采纳
    expect(plan.items.every((it) => !it.changed)).toBe(true);
  });

  it('原时长不足最短时长：无解（吸附只会收缩）', () => {
    const cues = [cue(1000, 1500, 0)];
    const plan = planSnaps(cues, [1200], OPTS);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('短于最短时长');
  });

  it('大规模顺序：全部相邻边界取切点后仍保持顺序与最小时长', () => {
    const cues: MergedCue[] = [];
    const cuts: number[] = [];
    for (let i = 0; i < 200; i++) {
      cues.push(cue(i * 3000, i * 3000 + 2000, i, `第 ${i + 1} 条字幕文本`));
      cuts.push(i * 3000 + 200, i * 3000 + 1800);
    }
    const plan = planSnaps(cues, cuts, { thresholdMs: 300, minDurMs: 1000 });
    expect(plan.ok).toBe(true);
    expect(plan.cost.crossing).toBe(0);
    for (let i = 0; i < 200; i++) {
      const it = plan.items[i];
      expect(it.newEnd - it.newStart).toBeGreaterThanOrEqual(1000);
      if (i > 0) expect(it.newStart).toBeGreaterThanOrEqual(plan.items[i - 1].newEnd);
    }
  });
});

describe('未吸附原因', () => {
  it('吸附会与上一条重叠时标明原因', () => {
    // 第 1 条 [0,1010]（恰 ≥ 最短时长），切点 950：第 1 条结束吸到 950 会不足
    // 1000ms 不可行；第 2 条开始 [1010,…] 距切点 60ms，但吸到 950 会与上一条重叠
    const cues = [cue(0, 1010, 0), cue(1010, 3010, 1)];
    const plan = planSnaps(cues, [950], OPTS);
    expect(plan.ok).toBe(true);
    expect(plan.items[1].start.reason).toContain('与上一条重叠');
    expect(plan.items[0].end.reason).toContain('短于最小时长');
  });
});

describe('applySnaps 采纳与失效', () => {
  it('采纳条目替换时间，文本与 groupIndex 不变', () => {
    const cues = [cue(1000, 3000, 0, '原文')];
    const plan = planSnaps(cues, [1300], OPTS);
    const out = applySnaps(cues, plan.items, new Set([plan.items[0].key]));
    expect(out[0].start).toBe(1300);
    expect(out[0].end).toBe(3000);
    expect(out[0].text).toBe('原文');
    expect(out[0].groupIndex).toBe(0);
    // 不修改原数组
    expect(cues[0].start).toBe(1000);
  });

  it('无采纳或 key 失效时原样返回（同引用）', () => {
    const cues = [cue(1000, 3000, 0)];
    const plan = planSnaps(cues, [1300], OPTS);
    expect(applySnaps(cues, plan.items, new Set())).toBe(cues);
    expect(applySnaps(cues, plan.items, new Set(['stale']))).toBe(cues);
  });

  it('部分采纳只改命中条目，且已采纳条彼此不制造重叠', () => {
    const cues = [cue(0, 2100, 0), cue(2100, 4100, 1)];
    const plan = planSnaps(cues, [1900], OPTS);
    const out = applySnaps(cues, plan.items, new Set([plan.items[0].key]));
    expect(out[0].end).toBe(1900);
    expect(out[1]).toEqual(cues[1]);
  });

  it('切点变化后旧 key 自动失效', () => {
    const cues = [cue(1000, 3000, 0)];
    const before = planSnaps(cues, [1300], OPTS);
    const after = planSnaps(cues, [1200], OPTS);
    expect(after.items[0].key).not.toBe(before.items[0].key);
    expect(applySnaps(cues, after.items, new Set([before.items[0].key]))).toBe(cues);
  });

  it('参数变化后旧 key 自动失效', () => {
    // 阈值 500：开始吸到 1300；阈值 200：1300 不再是候选，保持原位
    const cues = [cue(1000, 3000, 0)];
    const a = planSnaps(cues, [1300], OPTS);
    const b = planSnaps(cues, [1300], { ...OPTS, thresholdMs: 200 });
    expect(b.items[0].key).not.toBe(a.items[0].key);
    expect(b.items[0].changed).toBe(false);
  });

  it('上游时间变化后旧 key 自动失效', () => {
    const cues = [cue(1000, 3000, 0)];
    const before = planSnaps(cues, [1300], OPTS);
    const changed = [cue(1050, 3000, 0)];
    const after = planSnaps(changed, [1300], OPTS);
    expect(after.items[0].key).not.toBe(before.items[0].key);
  });

  it('空输入', () => {
    const plan = planSnaps([], [1000], OPTS);
    expect(plan.ok).toBe(true);
    expect(plan.items).toEqual([]);
    expect(applySnaps([], plan.items, new Set())).toEqual([]);
  });
});

describe('默认参数', () => {
  it('阈值 500ms、最短时长 1000ms', () => {
    expect(DEFAULT_SNAP_OPTIONS).toEqual({ thresholdMs: 500, minDurMs: 1000 });
  });
});
