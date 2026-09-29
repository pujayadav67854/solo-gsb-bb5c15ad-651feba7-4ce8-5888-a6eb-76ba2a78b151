import { describe, expect, it } from 'vitest';
import type { MergedCue } from '../merge';
import {
  buildTrackCsv,
  overlapsHalfOpen,
  parseOcclusions,
  planTracks,
  type Occlusion,
} from '../occlude';

function cue(start: number, end: number, text = '字幕', groupIndex = 0): MergedCue {
  return { start, end, text, groupIndex };
}

function occ(start: number, end: number, track: 'top' | 'bottom', line = 1): Occlusion {
  return { start, end, track, line };
}

describe('parseOcclusions 遮挡列表解析', () => {
  it('每行三项（起点 终点 位置），保持填写顺序，行号为物理行', () => {
    const r = parseOcclusions('5000 12000 上\n\n20000,26500,下\n  0 \t 1000 \t 上\n');
    expect(r.invalid).toEqual([]);
    expect(r.totalLines).toBe(3);
    expect(r.occlusions.map((o) => [o.start, o.end, o.track])).toEqual([
      [5000, 12000, 'top'],
      [20000, 26500, 'bottom'],
      [0, 1000, 'top'],
    ]);
    expect(r.occlusions.map((o) => o.line)).toEqual([1, 3, 4]);
  });

  it('兼容多种分隔符与位置写法（上/下/上轨/下轨/top/bottom，英文不区分大小写）', () => {
    const r = parseOcclusions(
      '100,200,上\n300，400 下轨\n500;600;TOP\n700；800 Bottom\n900-->1000 上轨\n1100 ~ 1200 ~ 下',
    );
    expect(r.invalid).toEqual([]);
    expect(r.occlusions.map((o) => o.track)).toEqual([
      'top',
      'bottom',
      'top',
      'bottom',
      'top',
      'bottom',
    ]);
  });

  it('格式错误标出行号与原因：列数不对、非整数、负数、小数、起点不小于终点、位置非法', () => {
    const text =
      '1000 2000 上\nabc 2000 上\n3000 上\n1000 500 600 上\n-100 200 下\n1.5 2.5 上\n3000 3000 下\n4000 3000 上\n1000 2000 中';
    const r = parseOcclusions(text);
    expect(r.occlusions).toHaveLength(1);
    expect(r.invalid.map((b) => b.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.totalLines).toBe(9);
    expect(r.invalid[6].reason).toContain('起点必须小于终点');
    expect(r.invalid[7].reason).toContain('位置必须是 上 或 下');
  });

  it('空文本与全空行', () => {
    expect(parseOcclusions('').occlusions).toEqual([]);
    expect(parseOcclusions('\n  \n\t\n').totalLines).toBe(0);
  });

  it('去 BOM、兼容 CRLF', () => {
    const r = parseOcclusions('﻿1000 2000 上\r\n3000 4000 下\r\n');
    expect(r.invalid).toEqual([]);
    expect(r.occlusions.map((o) => o.track)).toEqual(['top', 'bottom']);
  });
});

describe('overlapsHalfOpen 半开区间相交', () => {
  it('正时长交集才算遮挡，端点相接不算', () => {
    expect(overlapsHalfOpen(0, 1000, 500, 1500)).toBe(true);
    expect(overlapsHalfOpen(0, 1000, 1000, 2000)).toBe(false);
    expect(overlapsHalfOpen(1000, 2000, 0, 1000)).toBe(false);
    expect(overlapsHalfOpen(0, 1000, 999, 1001)).toBe(true);
    expect(overlapsHalfOpen(0, 1000, 2000, 3000)).toBe(false);
  });
});

describe('planTracks 全局轨道分配', () => {
  it('无遮挡时全部默认下轨，切换 0 次、上轨 0 条', () => {
    const cues = [cue(0, 1000), cue(1000, 2000), cue(2000, 3000)];
    const p = planTracks(cues, []);
    expect(p.ok).toBe(true);
    expect(p.tracks).toEqual(['bottom', 'bottom', 'bottom']);
    expect(p.switches).toBe(0);
    expect(p.topCount).toBe(0);
  });

  it('被遮挡的轨道不可用：下轨被挡只能上轨，上轨被挡只能下轨', () => {
    const cues = [cue(0, 1000), cue(2000, 3000)];
    const p = planTracks(cues, [occ(0, 500, 'bottom'), occ(2000, 2500, 'top')]);
    expect(p.ok).toBe(true);
    expect(p.tracks).toEqual(['top', 'bottom']);
    expect(p.blocks[0].bottomHits).toHaveLength(1);
    expect(p.blocks[1].topHits).toHaveLength(1);
  });

  it('半开区间：遮挡终点等于字幕起点不算遮挡', () => {
    const cues = [cue(1000, 2000)];
    const p = planTracks(cues, [occ(0, 1000, 'bottom'), occ(2000, 3000, 'top')]);
    expect(p.ok).toBe(true);
    expect(p.tracks).toEqual(['bottom']);
    expect(p.blocks[0].bottomOk).toBe(true);
    expect(p.blocks[0].topOk).toBe(true);
  });

  it('先最小化相邻切换次数：双轨可用的中间条随两侧改到上轨', () => {
    // 第 1、3 条只能上轨，第 2 条双轨可用
    // 第 2 条放上轨：切换 0 次、上轨 3 条；放下轨：切换 2 次、上轨 2 条 → 切换优先
    const cues = [cue(0, 1000), cue(1000, 2000), cue(2000, 3000)];
    const p = planTracks(cues, [
      occ(0, 1000, 'bottom'),
      occ(2000, 3000, 'bottom'),
    ]);
    expect(p.ok).toBe(true);
    expect(p.tracks).toEqual(['top', 'top', 'top']);
    expect(p.switches).toBe(0);
    expect(p.topCount).toBe(3);
  });

  it('再最小化上轨条数：双轨可用的中间条保持下轨', () => {
    // 第 1、3 条只能下轨，第 2 条双轨可用 → 放下轨：切换 0、上轨 0
    const cues = [cue(0, 1000), cue(1000, 2000), cue(2000, 3000)];
    const p = planTracks(cues, [occ(0, 1000, 'top'), occ(2000, 3000, 'top')]);
    expect(p.ok).toBe(true);
    expect(p.tracks).toEqual(['bottom', 'bottom', 'bottom']);
    expect(p.switches).toBe(0);
    expect(p.topCount).toBe(0);
  });

  it('切换数相同的前提下，双轨可用的字幕优先下轨（减少上轨条数）', () => {
    // c1 只能上、c3 只能下、c5 只能上；c2/c4 双轨可用。
    // 切换数最少为 2（上→下→上），此时 c2/c4 都放下轨：上轨仅 2 条
    const cues = [
      cue(0, 1000),
      cue(1000, 2000),
      cue(2000, 3000),
      cue(3000, 4000),
      cue(4000, 5000),
    ];
    const p = planTracks(cues, [
      occ(0, 1000, 'bottom'),
      occ(2000, 3000, 'top'),
      occ(4000, 5000, 'bottom'),
    ]);
    expect(p.ok).toBe(true);
    expect(p.tracks).toEqual(['top', 'bottom', 'bottom', 'bottom', 'top']);
    expect(p.switches).toBe(2);
    expect(p.topCount).toBe(2);
  });

  it('任一字幕两轨均被遮挡时整体无解，报告第一条', () => {
    const cues = [cue(0, 1000), cue(2000, 3000), cue(4000, 5000)];
    const p = planTracks(cues, [
      occ(2000, 3000, 'top', 1),
      occ(2500, 3500, 'bottom', 2),
      occ(4000, 5000, 'top', 3),
      occ(4000, 5000, 'bottom', 4),
    ]);
    expect(p.ok).toBe(false);
    expect(p.failIndex).toBe(1);
    expect(p.tracks).toEqual([]);
    expect(p.blocks[1].topHits.map((h) => h.line)).toEqual([1]);
    expect(p.blocks[1].bottomHits.map((h) => h.line)).toEqual([2]);
  });

  it('空字幕列表有解且方案为空', () => {
    const p = planTracks([], [occ(0, 1000, 'top')]);
    expect(p.ok).toBe(true);
    expect(p.tracks).toEqual([]);
    expect(p.switches).toBe(0);
    expect(p.topCount).toBe(0);
  });

  it('随机可用性组合下与暴力枚举的最优解一致（含同分优先下轨）', () => {
    // 确定性伪随机（mulberry32）
    let seed = 42;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    type T = 'top' | 'bottom';
    const brute = (avail: T[][]): T[] | null => {
      let best: T[] | null = null;
      let bestKey: [number, number] | null = null;
      const walk = (i: number, acc: T[]) => {
        if (i === avail.length) {
          let sw = 0;
          let tp = 0;
          for (let k = 0; k < acc.length; k++) {
            if (acc[k] === 'top') tp++;
            if (k > 0 && acc[k] !== acc[k - 1]) sw++;
          }
          const key: [number, number] = [sw, tp];
          if (
            !bestKey ||
            sw < bestKey[0] ||
            (sw === bestKey[0] && tp < bestKey[1]) ||
            // 同分时按字幕顺序优先下轨：逐位比较，bottom 视为更小
            (sw === bestKey[0] &&
              tp === bestKey[1] &&
              best !== null &&
              acc.join() < best.join())
          ) {
            bestKey = key;
            best = [...acc];
          }
          return;
        }
        // bottom 先展开，保证同分时字典序（bottom < top）最小者最后被严格比较命中
        for (const t of ['bottom', 'top'] as T[]) {
          if (avail[i].includes(t)) walk(i + 1, [...acc, t]);
        }
      };
      walk(0, []);
      return best;
    };

    for (let iter = 0; iter < 300; iter++) {
      const n = 1 + Math.floor(rand() * 8);
      const cues: MergedCue[] = [];
      const occlusions: Occlusion[] = [];
      let t = 0;
      for (let i = 0; i < n; i++) {
        const start = t;
        const end = start + 500 + Math.floor(rand() * 1500);
        cues.push(cue(start, end, `c${i}`, i));
        t = end;
        // 随机生成遮挡：每条字幕以一定概率被上/下轨遮挡
        if (rand() < 0.35) occlusions.push(occ(start, end, 'top'));
        if (rand() < 0.35) occlusions.push(occ(start, end, 'bottom'));
      }
      const avail: ('top' | 'bottom')[][] = cues.map((c) => {
        const a: ('top' | 'bottom')[] = [];
        if (!occlusions.some((o) => o.track === 'top' && overlapsHalfOpen(c.start, c.end, o.start, o.end)))
          a.push('top');
        if (!occlusions.some((o) => o.track === 'bottom' && overlapsHalfOpen(c.start, c.end, o.start, o.end)))
          a.push('bottom');
        return a;
      });
      const p = planTracks(cues, occlusions);
      const expected = brute(avail);
      if (expected === null) {
        expect(p.ok).toBe(false);
      } else {
        expect(p.ok).toBe(true);
        expect(p.tracks).toEqual(expected);
      }
    }
  });
});

describe('buildTrackCsv 轨道分配 CSV', () => {
  it('含字幕序号、起止时间与轨道，时间码加引号，序号从 1 起', () => {
    const cues = [cue(0, 1000), cue(61000, 63500)];
    const csv = buildTrackCsv(cues, ['bottom', 'top']);
    expect(csv).toBe(
      '序号,开始时间,结束时间,轨道\n' +
        '1,"00:00:00,000","00:00:01,000",下\n' +
        '2,"00:01:01,000","00:01:03,500",上\n',
    );
  });

  it('空列表只输出表头', () => {
    expect(buildTrackCsv([], [])).toBe('序号,开始时间,结束时间,轨道\n');
  });
});
