/**
 * 镜头切点吸附：给定一组镜头切点（每行一个 HH:MM:SS,mmm），对距切点不超过
 * 阈值的字幕开始/结束边界，用全局动态规划在“吸附到切点”与“保持原位”之间
 * 做选择，并按字典序依次最小化：
 *   ① 跨镜头字幕数（时间区间内部包含至少一个切点的条数，切点恰在边界上不算跨）；
 *   ② 边界总位移（各边界 |新位置 − 原位置| 之和，毫秒）；
 *   ③ 改动条数（有任意一边界移动的字幕数）。
 *
 * 硬约束（违背的方案直接丢弃）：
 *   - 保持顺序、相邻字幕不重叠：第 i 条开始 ≥ 第 i−1 条结束；
 *   - 每条不短于可调最小时长：end − start ≥ minDurMs；
 *   - 只有距原边界 ≤ thresholdMs 的切点才是候选，原位始终是候选。
 *
 * 动态规划：按 cue 顺序推进，阶段 i 的状态为该条“结束边界”选取的候选位置；
 * 转移枚举第 i 条的开始候选 s 与结束候选 e，要求 e − s ≥ minDurMs 且
 * s ≥ 上一条选中的结束位置；上一阶段的最优前缀用“按结束位置排序的前缀
 * 最小值 + 二分”取得，整体约为 O(n·k²)，k 为单边界候选数（阈值通常只有
 * 几百毫秒，k 一般为 1~3）。
 *
 * 任何最优吸附都只会把边界向字幕区间内侧收缩（外扩永远不能减少跨镜头或
 * 位移），因此逐条采纳是子集安全的：已采纳条彼此不会制造重叠，未采纳条
 * 保持原时间。
 *
 * 采纳以每条为单位，key 由 groupIndex、原时间与新时间共同构成；切点列表、
 * 参数或上游结果（消重 / 断行 / 节奏）变化导致方案不同时，旧采纳自动失效。
 */
import type { MergedCue } from './merge';
import { parseTimecode } from './srt';

export interface SnapOptions {
  /** 吸附阈值（毫秒）：切点与字幕边界距离不超过该值时才可吸附 */
  thresholdMs: number;
  /** 每条字幕吸附后的最短时长（毫秒） */
  minDurMs: number;
}

export const DEFAULT_SNAP_OPTIONS: SnapOptions = {
  thresholdMs: 500,
  minDurMs: 1000,
};

export interface BadCutLine {
  /** 行号（从 1 起，不计空行） */
  line: number;
  raw: string;
}

export interface CutParseResult {
  /** 解析成功、升序去重后的切点（毫秒） */
  cuts: number[];
  /** 无法解析的行 */
  invalid: BadCutLine[];
  /** 解析成功的原始行数（含重复） */
  totalLines: number;
}

/** 解析切点列表：每行一个 "HH:MM:SS,mmm"（兼容 MM:SS / 小数点 / 1~3 位毫秒）。 */
export function parseCutList(text: string): CutParseResult {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const seen = new Set<number>();
  const invalid: BadCutLine[] = [];
  let totalLines = 0;
  normalized.split('\n').forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    totalLines++;
    const t = parseTimecode(line);
    if (t === null) invalid.push({ line: idx + 1, raw: line });
    else seen.add(t);
  });
  return { cuts: [...seen].sort((a, b) => a - b), invalid, totalLines };
}

export interface SnapBoundary {
  /** 命中的切点（毫秒）；未移动时为 null */
  cut: number | null;
  /** 新位置（毫秒） */
  at: number;
  /** 原位置（毫秒） */
  from: number;
  /** 位移 at − from（毫秒，0 表示保持原位） */
  delta: number;
  /** 未吸附原因（未移动且未对齐切点时给出；移动或已对齐时为空串） */
  reason: string;
}

export interface SnapItem {
  /** cue 下标（与 planSnaps 输入对齐） */
  index: number;
  groupIndex: number;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  start: SnapBoundary;
  end: SnapBoundary;
  /** 原时间区间内部（不含边界）是否含切点 */
  oldCrossing: boolean;
  /** 新时间区间内部（不含边界）是否含切点 */
  newCrossing: boolean;
  /** 方案中该条是否有边界移动（可采纳的前提） */
  changed: boolean;
  /** 稳定标识：groupIndex + 原时间 + 新时间；任一变化即失效 */
  key: string;
}

export interface SnapCost {
  /** 跨镜头字幕数 */
  crossing: number;
  /** 边界总位移（毫秒） */
  displacement: number;
  /** 改动条数 */
  changed: number;
}

export interface SnapPlan {
  /** 是否存在满足全部硬约束的方案 */
  ok: boolean;
  /** 不可行原因（ok 时为空串） */
  reason: string;
  /** 与输入 cues 一一对齐的逐条方案（不可行时为原位占位，不允许采纳） */
  items: SnapItem[];
  /** 所选方案的目标函数值（不可行时按原位统计） */
  cost: SnapCost;
  /** 原始时间下的跨镜头条数 */
  originalCrossing: number;
}

interface Cost3 {
  crossing: number;
  displacement: number;
  changed: number;
}

function isBetter(a: Cost3, b: Cost3): boolean {
  if (a.crossing !== b.crossing) return a.crossing < b.crossing;
  if (a.displacement !== b.displacement) return a.displacement < b.displacement;
  return a.changed < b.changed;
}

const addCost = (a: Cost3, crossing: number, displacement: number, changed: number): Cost3 => ({
  crossing: a.crossing + crossing,
  displacement: a.displacement + displacement,
  changed: a.changed + changed,
});

const ZERO_COST: Cost3 = { crossing: 0, displacement: 0, changed: 0 };

function normOptions(o: SnapOptions): SnapOptions {
  const thresholdMs = Math.max(
    0,
    Math.round(Number.isFinite(o.thresholdMs) ? o.thresholdMs : DEFAULT_SNAP_OPTIONS.thresholdMs),
  );
  const minDurMs = Math.max(
    1,
    Math.round(Number.isFinite(o.minDurMs) ? o.minDurMs : DEFAULT_SNAP_OPTIONS.minDurMs),
  );
  return { thresholdMs, minDurMs };
}

/** 首个 >= t 的切点下标。 */
function lowerBound(cuts: number[], t: number): number {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** 首个 > t 的切点下标。 */
function upperBound(cuts: number[], t: number): number {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 严格位于开区间 (s, e) 内的切点数。 */
export function countCutsBetween(cuts: number[], s: number, e: number): number {
  return lowerBound(cuts, e) - upperBound(cuts, s);
}

const includes = (arr: number[], v: number) => arr.includes(v);

/** 构造某条边界的候选位置：原位 + 阈值内切点，升序去重。 */
function boundaryCandidates(origin: number, cuts: number[], threshold: number): number[] {
  const out = [origin];
  const lo = lowerBound(cuts, origin - threshold);
  const hi = upperBound(cuts, origin + threshold);
  for (let k = lo; k < hi; k++) {
    if (cuts[k] !== origin) out.push(cuts[k]);
  }
  out.sort((a, b) => a - b);
  return out;
}

interface DpState {
  cost: Cost3;
  /** 上一阶段结束候选的下标（首条为 −1） */
  prevE: number;
  /** 本条开始候选的下标 */
  sIdx: number;
}

/**
 * 全局动态规划求最优吸附方案。原始时间本身重叠、或某条原时长不足最短时长
 * （吸附只会收缩）时无可行解，返回 ok:false 与具体原因。
 */
export function planSnaps(
  cues: MergedCue[],
  cuts: number[],
  options: SnapOptions,
): SnapPlan {
  const opts = normOptions(options);
  const n = cues.length;

  const crossingAt = (i: number) => countCutsBetween(cuts, cues[i].start, cues[i].end) > 0;

  const infeasible = (reason: string, shortIdx: number[]): SnapPlan => {
    const shortSet = new Set(shortIdx);
    const items: SnapItem[] = cues.map((c, i) => {
      const oldCrossing = crossingAt(i);
      const r = shortSet.has(i) ? '原时长不足最短时长' : '整体方案无解';
      return {
        index: i,
        groupIndex: c.groupIndex,
        oldStart: c.start,
        oldEnd: c.end,
        newStart: c.start,
        newEnd: c.end,
        start: { cut: null, at: c.start, from: c.start, delta: 0, reason: r },
        end: { cut: null, at: c.end, from: c.end, delta: 0, reason: r },
        oldCrossing,
        newCrossing: oldCrossing,
        changed: false,
        key: itemKey(c.groupIndex, c.start, c.end, c.start, c.end),
      };
    });
    return {
      ok: false,
      reason,
      items,
      cost: {
        crossing: items.reduce((m, it) => m + (it.oldCrossing ? 1 : 0), 0),
        displacement: 0,
        changed: 0,
      },
      originalCrossing: items.reduce((m, it) => m + (it.oldCrossing ? 1 : 0), 0),
    };
  };

  if (n === 0) {
    return { ok: true, reason: '', items: [], cost: { ...ZERO_COST }, originalCrossing: 0 };
  }

  // 快速不可行诊断：原时长不足（吸附只会收缩，无法拉长）
  const shortIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (cues[i].end - cues[i].start < opts.minDurMs) shortIdx.push(i);
  }
  if (shortIdx.length > 0) {
    const i = shortIdx[0];
    return infeasible(
      `第 ${i + 1} 条原时长 ${fmtMs(cues[i].end - cues[i].start)} 短于最短时长 ` +
        `${fmtMs(opts.minDurMs)}，切点吸附只会收缩边界、无法拉长`,
      shortIdx,
    );
  }

  const starts = cues.map((c) => boundaryCandidates(c.start, cuts, opts.thresholdMs));
  const ends = cues.map((c) => boundaryCandidates(c.end, cuts, opts.thresholdMs));

  /** stages[i][eIdx]：第 i 条结束取 ends[i][eIdx] 时的最优状态 */
  const stages: (DpState | null)[][] = [];
  let prevEnds = ends[0];

  for (let i = 0; i < n; i++) {
    const cur: (DpState | null)[] = new Array(ends[i].length).fill(null);
    const prevStage = i === 0 ? null : stages[i - 1];

    // 上一阶段按结束位置升序排列的前缀最优（ends 候选本身升序；缺位用前一个有效值）
    const prefix: ({ idx: number; state: DpState } | null)[] = [];
    if (prevStage) {
      let best: { idx: number; state: DpState } | null = null;
      prevStage.forEach((st, j) => {
        if (st && (!best || isBetter(st.cost, best.state.cost))) best = { idx: j, state: st };
        prefix.push(best);
      });
    }

    for (let a = 0; a < starts[i].length; a++) {
      const s = starts[i][a];
      let base: { cost: Cost3; prevE: number } | null = null;
      if (i === 0) {
        base = { cost: ZERO_COST, prevE: -1 };
      } else {
        // 最大的、结束位置 ≤ s 的上一条候选
        let j = -1;
        let lo = 0;
        let hi = prevEnds.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (prevEnds[mid] <= s) {
            j = mid;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        const p = j >= 0 ? prefix[j] : null;
        if (p) base = { cost: p.state.cost, prevE: p.idx };
      }
      if (!base) continue;

      for (let b = 0; b < ends[i].length; b++) {
        const e = ends[i][b];
        if (e - s < opts.minDurMs) continue;
        const os = cues[i].start;
        const oe = cues[i].end;
        const crossing = countCutsBetween(cuts, s, e) > 0 ? 1 : 0;
        const displacement = Math.abs(s - os) + Math.abs(e - oe);
        const changed = s !== os || e !== oe ? 1 : 0;
        const cand: Cost3 = addCost(base.cost, crossing, displacement, changed);
        const existing = cur[b];
        if (!existing || isBetter(cand, existing.cost)) {
          cur[b] = { cost: cand, prevE: base.prevE, sIdx: a };
        }
      }
    }

    stages.push(cur);
    prevEnds = ends[i];
    if (cur.every((st) => st === null)) {
      return infeasible(
        `第 ${i + 1} 条附近没有同时满足顺序、相邻不重叠与最短时长的切点方案` +
          (i > 0 ? `（原始时间与第 ${i} 条重叠或过短）` : '（原时长不足最短时长）'),
        [],
      );
    }
  }

  // 末阶段取最优
  const last = stages[n - 1];
  let bestE = -1;
  for (let j = 0; j < last.length; j++) {
    const st = last[j];
    if (st && (bestE < 0 || isBetter(st.cost, last[bestE]!.cost))) bestE = j;
  }

  const chosenS = new Array<number>(n);
  const chosenE = new Array<number>(n);
  let eIdx = bestE;
  for (let i = n - 1; i >= 0; i--) {
    const st = stages[i][eIdx]!;
    chosenS[i] = starts[i][st.sIdx];
    chosenE[i] = ends[i][eIdx];
    eIdx = st.prevE;
  }

  const items: SnapItem[] = cues.map((c, i) => {
    const ns = chosenS[i];
    const ne = chosenE[i];
    const oldCrossing = countCutsBetween(cuts, c.start, c.end) > 0;
    const newCrossing = countCutsBetween(cuts, ns, ne) > 0;
    const changed = ns !== c.start || ne !== c.end;
    return {
      index: i,
      groupIndex: c.groupIndex,
      oldStart: c.start,
      oldEnd: c.end,
      newStart: ns,
      newEnd: ne,
      start: {
        cut: ns !== c.start ? ns : includes(cuts, c.start) ? c.start : null,
        at: ns,
        from: c.start,
        delta: ns - c.start,
        reason: '',
      },
      end: {
        cut: ne !== c.end ? ne : includes(cuts, c.end) ? c.end : null,
        at: ne,
        from: c.end,
        delta: ne - c.end,
        reason: '',
      },
      oldCrossing,
      newCrossing,
      changed,
      key: itemKey(c.groupIndex, c.start, c.end, ns, ne),
    };
  });

  // 未移动边界的未吸附原因（用方案中相邻条的选定位置判断可行性）
  for (let i = 0; i < n; i++) {
    const it = items[i];
    if (it.start.delta === 0 && it.start.cut === null) {
      const neighbor = i > 0 ? chosenE[i - 1] : -Infinity;
      it.start.reason = keepReason(
        cues[i].start,
        cuts,
        opts,
        chosenE[i],
        neighbor,
        'start',
        it.oldCrossing,
        it.newCrossing,
      );
    }
    if (it.end.delta === 0 && it.end.cut === null) {
      const neighbor = i + 1 < n ? chosenS[i + 1] : Infinity;
      it.end.reason = keepReason(
        cues[i].end,
        cuts,
        opts,
        chosenS[i],
        neighbor,
        'end',
        it.oldCrossing,
        it.newCrossing,
      );
    }
  }

  return {
    ok: true,
    reason: '',
    items,
    cost: last[bestE]!.cost,
    originalCrossing: items.reduce((m, it) => m + (it.oldCrossing ? 1 : 0), 0),
  };
}

function itemKey(
  groupIndex: number,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): string {
  return `${groupIndex}|${oldStart}-${oldEnd}>${newStart}-${newEnd}`;
}

/**
 * 边界保持原位时给出未吸附原因。
 * @param origin   原边界位置
 * @param anchor   同条另一边界的选定位置
 * @param neighbor 相邻约束：start 时为上一条选定结束；end 时为下一条选定开始
 */
function keepReason(
  origin: number,
  cuts: number[],
  opts: SnapOptions,
  anchor: number,
  neighbor: number,
  kind: 'start' | 'end',
  oldCrossing: boolean,
  newCrossing: boolean,
): string {
  const nearby: number[] = [];
  const lo = lowerBound(cuts, origin - opts.thresholdMs);
  const hi = upperBound(cuts, origin + opts.thresholdMs);
  for (let k = lo; k < hi; k++) {
    if (cuts[k] !== origin) nearby.push(cuts[k]);
  }
  if (nearby.length === 0) return '阈值内无切点';

  const feasible = (c: number) =>
    kind === 'start'
      ? c >= neighbor && anchor - c >= opts.minDurMs
      : c - anchor >= opts.minDurMs && c <= neighbor;

  let overlapBlocked = false;
  let durBlocked = false;
  let anyFeasible = false;
  for (const c of nearby) {
    const overlap = kind === 'start' ? c < neighbor : c > neighbor;
    const tooShort =
      kind === 'start' ? anchor - c < opts.minDurMs : c - anchor < opts.minDurMs;
    if (overlap) overlapBlocked = true;
    if (tooShort) durBlocked = true;
    if (feasible(c)) anyFeasible = true;
  }
  if (!anyFeasible) {
    const overlapMsg = kind === 'start' ? '吸附会与上一条重叠' : '吸附会与下一条重叠';
    if (overlapBlocked && durBlocked) return `${overlapMsg}或短于最小时长`;
    if (overlapBlocked) return overlapMsg;
    return '吸附后短于最小时长';
  }
  if (!oldCrossing) return '未跨切点，吸附只增加位移';
  if (newCrossing) return '吸附后仍跨越其他切点';
  return '吸附无收益';
}

/**
 * 按已采纳条目（key 集合）应用吸附：命中标条目的开始/结束替换为方案位置，
 * 文本、顺序与 groupIndex 不变；未采纳或已失效（key 不在当前方案中）的
 * 采纳被忽略。没有任何生效采纳时返回原数组。
 */
export function applySnaps(
  cues: MergedCue[],
  items: SnapItem[],
  accepted: ReadonlySet<string>,
): MergedCue[] {
  if (accepted.size === 0) return cues;
  const live = new Set(items.map((it) => it.key));
  let hit = false;
  accepted.forEach((k) => {
    if (live.has(k)) hit = true;
  });
  if (!hit) return cues;

  const out = cues.map((c) => ({ ...c }));
  for (const it of items) {
    if (!it.changed || !accepted.has(it.key)) continue;
    out[it.index].start = it.newStart;
    out[it.index].end = it.newEnd;
  }
  return out;
}

const fmtMs = (ms: number) => `${(ms / 1000).toFixed(2)} 秒`;

/** 供界面展示的带符号位移，如 “+320 ms” / “−240 ms”。 */
export function formatDelta(ms: number): string {
  if (ms === 0) return '0 ms';
  return `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`;
}
