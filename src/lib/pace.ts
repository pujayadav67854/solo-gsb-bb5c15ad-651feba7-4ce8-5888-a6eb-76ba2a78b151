/**
 * 阅读节奏：按 Unicode 字素统计每条字幕的显示时长与字符/秒，把连续超限项
 * 划为区段，并在不改文本、不打乱顺序、时间不重叠的前提下，利用区段前后
 * 空隙联动调整边界，给出可行修复或明确标记无解。
 *
 * - 字符口径：去除 HTML 标签（<...>）与 ASS 覆盖标签（{...}）后按 Unicode
 *   字素簇（grapheme cluster）计数；空白（含换行）不计入，标点计入。
 * - 超限判定：字符/秒 > 最大字符/秒（超速）、时长 < 最短时长（过短）、
 *   时长 > 最长时长（过长），满足其一即超限；下标连续的超限条构成一个区段，
 *   正常条打断区段。
 * - 修复模型：区段 [a..b] 的左界 L 为前一条结束时间（首条为 0），右界 R 为
 *   后一条开始时间（末条为 +∞）。每条所需最短时长
 *   need = max(最短时长, ⌈字符数×1000 / 最大字符每秒⌉)，期望时长
 *   want = clamp(原时长, need, 最长时长)。Σneed ≤ R − L 时可解：先按原开始
 *   时间从 L 前向摆放（不重叠、不早于 L），末端超出 R 时再从 R 整体回推
 *   （仅左移必要的条，借用区段前空隙）；Σwant 超出窗口时把富余
 *   （want − need）按比例压缩（最大剩余法取整），保证每条仍 ≥ need 且
 *   ≤ 最长时长。need > 最长时长或 Σneed 超过窗口时无解，保持原时间并
 *   标明原因。
 * - 采纳：以区段为单位采纳/恢复；key 由成员 groupIndex 与修复后时间构成，
 *   上游（冲突解决、消重、断行）或参数变化导致修复结果不同时，旧采纳
 *   自动失效。已采纳区段只改时间，文本、顺序与 groupIndex 均不变。
 */
import type { MergedCue } from './merge';
import { graphemes } from './wrap';

export interface PaceOptions {
  /** 最大字符/秒 */
  maxCps: number;
  /** 最短显示时长（毫秒） */
  minDurMs: number;
  /** 最长显示时长（毫秒） */
  maxDurMs: number;
}

export const DEFAULT_PACE_OPTIONS: PaceOptions = {
  maxCps: 20,
  minDurMs: 1000,
  maxDurMs: 7000,
};

const TAG_RE = /<[^>]*>|\{[^}]*\}/g;
const WS_RE = /^\s+$/u;
const EPS = 1e-9;

/** 阅读节奏统计口径的字符数：去标签后按字素簇计数，空白不计、标点计入。 */
export function readableChars(text: string): number {
  const plain = text.replace(TAG_RE, '');
  let n = 0;
  for (const g of graphemes(plain)) if (!WS_RE.test(g)) n++;
  return n;
}

/** 字符/秒；时长非正时：有字符视为 Infinity，无字符为 0。 */
export function charsPerSecond(chars: number, durMs: number): number {
  if (durMs <= 0) return chars > 0 ? Infinity : 0;
  return (chars * 1000) / durMs;
}

export interface PaceCueStat {
  /** 字素数（去标签、不计空白） */
  chars: number;
  /** 显示时长（毫秒） */
  durMs: number;
  /** 字符/秒 */
  cps: number;
  tooFast: boolean;
  tooShort: boolean;
  tooLong: boolean;
  violating: boolean;
  /** 满足字符/秒与最短时长所需的最短时长（毫秒，向上取整） */
  needMs: number;
}

function statCue(cue: { start: number; end: number; text: string }, opts: PaceOptions): PaceCueStat {
  const chars = readableChars(cue.text);
  const durMs = cue.end - cue.start;
  const cps = charsPerSecond(chars, durMs);
  const tooFast = cps > opts.maxCps + EPS;
  const tooShort = durMs < opts.minDurMs;
  const tooLong = durMs > opts.maxDurMs;
  const cpsNeed = chars > 0 ? Math.ceil((chars * 1000) / opts.maxCps - EPS) : 0;
  const needMs = Math.max(opts.minDurMs, cpsNeed);
  return {
    chars,
    durMs,
    cps,
    tooFast,
    tooShort,
    tooLong,
    violating: tooFast || tooShort || tooLong,
    needMs,
  };
}

export interface PaceFixItem {
  /** cue 下标 */
  index: number;
  chars: number;
  /** 该条满足字符/秒与最短时长所需的最短时长（毫秒） */
  needMs: number;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export interface PaceSegment {
  /** 稳定标识：成员 groupIndex 与修复后时间构成；上游或参数变化导致修复不同即失效 */
  key: string;
  /** 首条 cue 下标 */
  startIdx: number;
  /** 末条 cue 下标（含） */
  endIdx: number;
  /** 区段前可利用的空隙（首条开始 − 左界） */
  gapBeforeMs: number;
  /** 区段后可利用的空隙（右界 − 末条结束）；末尾无后条时为 Infinity */
  gapAfterMs: number;
  /** 区段满足限制所需的最短总时长（Σneed） */
  needMs: number;
  /** 前后边界之间的可用窗口（右界 − 左界）；右侧无界时为 Infinity */
  windowMs: number;
  /** 是否存在可行修复 */
  ok: boolean;
  /** 无解原因（ok 时为空串） */
  reason: string;
  /** 逐条原/新时间（无解时新时间等于原时间） */
  items: PaceFixItem[];
}

export interface PaceAnalysis {
  /** 与输入 cues 对齐的逐条统计 */
  stats: PaceCueStat[];
  /** 连续超限项划出的区段（按下标升序，互不重叠） */
  segments: PaceSegment[];
}

function normOptions(o: PaceOptions): PaceOptions {
  const maxCps =
    Number.isFinite(o.maxCps) && o.maxCps > 0 ? o.maxCps : DEFAULT_PACE_OPTIONS.maxCps;
  const minDurMs = Math.max(
    1,
    Math.round(Number.isFinite(o.minDurMs) ? o.minDurMs : DEFAULT_PACE_OPTIONS.minDurMs),
  );
  const maxDurMs = Math.max(
    minDurMs,
    Math.round(Number.isFinite(o.maxDurMs) ? o.maxDurMs : DEFAULT_PACE_OPTIONS.maxDurMs),
  );
  return { maxCps, minDurMs, maxDurMs };
}

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/** 构建区段 [a..b] 的修复方案（或判定无解）。 */
function buildSegment(
  cues: MergedCue[],
  stats: PaceCueStat[],
  a: number,
  b: number,
  opts: PaceOptions,
): PaceSegment {
  const n = cues.length;
  const L = a > 0 ? cues[a - 1].end : 0;
  const R = b + 1 < n ? cues[b + 1].start : Infinity;
  const m = b - a + 1;

  const need: number[] = [];
  const want: number[] = [];
  let sumNeed = 0;
  let sumWant = 0;
  let conflictK = -1; // 第一条 need > 最长时长的成员
  for (let k = 0; k < m; k++) {
    const st = stats[a + k];
    need.push(st.needMs);
    const w = Math.min(Math.max(st.durMs, st.needMs), opts.maxDurMs);
    want.push(w);
    sumNeed += st.needMs;
    sumWant += w;
    if (st.needMs > opts.maxDurMs && conflictK === -1) conflictK = k;
  }
  const windowMs = R - L;

  const items: PaceFixItem[] = [];
  for (let k = 0; k < m; k++) {
    const i = a + k;
    items.push({
      index: i,
      chars: stats[i].chars,
      needMs: need[k],
      oldStart: cues[i].start,
      oldEnd: cues[i].end,
      newStart: cues[i].start,
      newEnd: cues[i].end,
    });
  }

  const keyOf = () =>
    items.map((it) => `${cues[it.index].groupIndex}@${it.newStart}-${it.newEnd}`).join('|');

  const base = {
    startIdx: a,
    endIdx: b,
    gapBeforeMs: Math.max(0, cues[a].start - L),
    gapAfterMs: R === Infinity ? Infinity : Math.max(0, R - cues[b].end),
    needMs: sumNeed,
    windowMs,
    items,
  };

  if (conflictK !== -1) {
    return {
      ...base,
      key: keyOf(),
      ok: false,
      reason: `第 ${a + conflictK + 1} 条满足字符/秒至少需要 ${fmtSec(need[conflictK])}，超过最长时长 ${fmtSec(opts.maxDurMs)}，二者冲突`,
    };
  }
  if (sumNeed > windowMs) {
    return {
      ...base,
      key: keyOf(),
      ok: false,
      reason: `区段满足限制至少需要 ${fmtSec(sumNeed)}，前后边界之间仅有 ${fmtSec(windowMs)} 可用`,
    };
  }

  // 时长分配：优先取期望时长 want；Σwant 超窗时把富余（want − need）按比例压缩
  const dur = want.slice();
  if (sumWant > windowMs) {
    const budget = windowMs - sumNeed; // >= 0
    const extras = want.map((w, k) => w - need[k]);
    const extraTotal = extras.reduce((s, x) => s + x, 0);
    const raw = extras.map((e) => (extraTotal > 0 ? (e * budget) / extraTotal : 0));
    const alloc = raw.map((r) => Math.floor(r));
    let rem = budget - alloc.reduce((s, x) => s + x, 0);
    // 最大剩余法分配取整余下的毫秒（rem < m，每条约分 1ms）
    const order = extras
      .map((_, k) => k)
      .sort((x, y) => raw[y] - alloc[y] - (raw[x] - alloc[x]) || x - y);
    for (let t = 0; rem > 0 && t < order.length; t++) {
      alloc[order[t]]++;
      rem--;
    }
    for (let k = 0; k < m; k++) dur[k] = need[k] + alloc[k];
  }

  // 前向摆放：保持原开始时间，不早于左界，不与上一条重叠
  const s = new Array<number>(m);
  const e = new Array<number>(m);
  let cur = L;
  for (let k = 0; k < m; k++) {
    s[k] = Math.max(cues[a + k].start, cur);
    e[k] = s[k] + dur[k];
    cur = e[k];
  }
  if (e[m - 1] > R) {
    // 末端超出右界：从右界整体回推，仅左移必要的条（借用区段前空隙）
    let cur2 = R;
    for (let k = m - 1; k >= 0; k--) {
      e[k] = Math.min(e[k], cur2);
      s[k] = e[k] - dur[k];
      cur2 = s[k];
    }
  }
  for (let k = 0; k < m; k++) {
    items[k].newStart = s[k];
    items[k].newEnd = e[k];
  }

  return { ...base, key: keyOf(), ok: true, reason: '' };
}

/** 统计每条字幕的阅读节奏并把连续超限项划为区段、给出修复方案。 */
export function analyzePace(cues: MergedCue[], options: PaceOptions): PaceAnalysis {
  const opts = normOptions(options);
  const stats = cues.map((c) => statCue(c, opts));
  const segments: PaceSegment[] = [];
  let i = 0;
  while (i < cues.length) {
    if (!stats[i].violating) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < cues.length && stats[j + 1].violating) j++;
    segments.push(buildSegment(cues, stats, i, j, opts));
    i = j + 1;
  }
  return { stats, segments };
}

/**
 * 按已采纳区段（key 集合）应用时间修复：命中区段的成员替换为修复后时间，
 * 文本、顺序与 groupIndex 不变；未采纳或已失效（不在 segments 中）的 key
 * 被忽略；无解区段不会被应用。没有任何生效采纳时返回原数组。
 */
export function applyPaceFixes(
  cues: MergedCue[],
  segments: PaceSegment[],
  accepted: ReadonlySet<string>,
): MergedCue[] {
  if (accepted.size === 0) return cues;
  const out = cues.map((c) => ({ ...c }));
  let touched = false;
  for (const seg of segments) {
    if (!seg.ok || !accepted.has(seg.key)) continue;
    for (const it of seg.items) {
      out[it.index] = { ...out[it.index], start: it.newStart, end: it.newEnd };
      touched = true;
    }
  }
  return touched ? out : cues;
}
