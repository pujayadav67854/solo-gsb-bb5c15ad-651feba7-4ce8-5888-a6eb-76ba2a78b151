/**
 * 时间轴校准：在顺序对齐之前，先校正版本 B 的时间轴。
 *
 * 流程：
 *  1. 候选锚点：用 bigram 倒排表从两侧文本中粗筛，再以 bigram Dice 相似度精选
 *     （阈值与最小归一化长度可调）；
 *  2. 剔除顺序冲突：把候选视为 (aIdx, bIdx) 匹配，用树状数组做带权最长递增子序列，
 *     全局优先保留“相似度高且数量多”的顺序一致匹配（两侧均严格一对一），
 *     并对同起点时间的重复锚点去重；
 *  3. 剔除异常偏移：对顺序一致的锚点迭代拟合 Theil–Sen 稳健直线（成对斜率/截距中位数），
 *     按残差的 MAD 自适应尺度与固定容忍度迭代剔除最差锚点（至少保留两个）；
 *  4. 分段线性映射：相邻锚点连成区段，斜率钳制到安全范围，首尾按最近区段斜率外推；
 *  5. 映射后逐条保证开始/结束时间单调、时长为正。
 */
import type { Cue } from './srt';
import { bigramDice, normalizeText } from './similarity';

export interface CalibOptions {
  /** 锚点文本相似度下限（bigram Dice，∈(0,1)） */
  minSim: number;
  /** 归一化文本最短长度（字符），过短的字幕不参与锚点筛选 */
  minLength: number;
  /** 异常偏移固定容忍（毫秒），实际阈值取它与 MAD 自适应阈值的较大者 */
  outlierTolMs: number;
}

export const DEFAULT_CALIB_OPTIONS: CalibOptions = {
  minSim: 0.6,
  minLength: 4,
  outlierTolMs: 1500,
};

export type AnchorDropReason = 'order' | 'duplicate' | 'outlier';

export interface CalibAnchor {
  /** 稳定标识 `${aIdx}:${bIdx}` */
  key: string;
  aIdx: number;
  bIdx: number;
  /** 文本相似度 ∈ [0,1] */
  textSim: number;
  /** 是否通过自动筛选（顺序一致、非重复、非异常） */
  autoKept: boolean;
  /** 未通过自动筛选时的原因 */
  dropReason?: AnchorDropReason;
}

export interface CalibSegment {
  /** 区段在 B 时间轴上的起止（毫秒） */
  b0: number;
  b1: number;
  /** 对应映射到 A 时间轴上的起止 */
  a0: number;
  a1: number;
  /** 钳制后的实际使用斜率 */
  slope: number;
}

export interface CalibFit {
  /** 至少两个启用锚点才能构建映射 */
  ok: boolean;
  /** 当前启用（自动保留且未被用户禁用）的锚点，按 B 开始时间升序 */
  active: CalibAnchor[];
  /** 分段线性区段（首尾外推不单独列出） */
  segments: CalibSegment[];
  /**
   * 留一法残差（毫秒）：用其余启用锚点拟合后预测该锚点 B 时间对应的 A 时间，
   * 残差 = A 实际开始 − 预测值。仅两个启用锚点时为 null（无法留一）。
   */
  residuals: Map<string, number | null>;
  /** 未启用锚点相对当前映射的偏差（毫秒），仅用于界面展示 */
  deviations: Map<string, number>;
  /** 映射后的 B 字幕（ok=false 时返回原始 B，且不应被提交） */
  mappedCues: Cue[];
}

const MIN_SLOPE = 0.5;
const MAX_SLOPE = 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface RawAnchor {
  aIdx: number;
  bIdx: number;
  sim: number;
}

interface Point {
  anchor: CalibAnchor;
  b: number; // B 开始时间
  a: number; // A 开始时间
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/**
 * 候选锚点筛选：bigram 倒排表粗筛（任何共同 bigram 即进入候选），
 * 粗筛重叠数达到必要下界后再计算精确 Dice，避免 O(n·m) 全比较。
 */
export function findAnchorCandidates(
  cuesA: Cue[],
  cuesB: Cue[],
  opts: CalibOptions,
): RawAnchor[] {
  const normA = cuesA.map((c) => normalizeText(c.text));
  const normB = cuesB.map((c) => normalizeText(c.text));
  const m = normB.length;

  // B 侧倒排表：bigram → 含该 bigram 的 B 下标
  const postings = new Map<string, number[]>();
  // 过于常见（区分度低）的 bigram 不参与粗筛计数
  const listCap = Math.max(40, Math.floor(m / 2));
  normB.forEach((s, j) => {
    if (s.length < opts.minLength) return;
    for (const g of new Set(bigrams(s))) {
      const list = postings.get(g);
      if (list) list.push(j);
      else postings.set(g, [j]);
    }
  });

  const raws: RawAnchor[] = [];
  normA.forEach((sa, i) => {
    if (sa.length < opts.minLength) return;
    const gramsA = [...new Set(bigrams(sa))];
    const tally = new Map<number, number>();
    for (const g of gramsA) {
      const list = postings.get(g);
      if (!list || list.length > listCap) continue;
      for (const j of list) tally.set(j, (tally.get(j) ?? 0) + 1);
    }
    // Dice ≥ s 的必要条件：2·overlap ≥ s·(da + db)，其中 db 为 B 去重 bigram 数。
    // 用粗筛重叠计数代入先筛掉无望候选，显著减少精确 Dice 计算量。
    for (const [j, overlap] of tally) {
      const db = normB[j].length - 1;
      const need = (opts.minSim * (gramsA.length + db)) / 2;
      if (overlap < need) continue;
      const sim = bigramDice(sa, normB[j]);
      if (sim >= opts.minSim) raws.push({ aIdx: i, bIdx: j, sim });
    }
  });
  return raws;
}

/**
 * 剔除顺序冲突：带权（相似度）最长递增子序列，aIdx、bIdx 均严格递增且一对一。
 * 用树状数组维护前缀最优，相同 aIdx 的候选先统一查询快照、再统一更新。
 */
function chooseOrderConsistent(raws: RawAnchor[]): RawAnchor[] {
  if (raws.length === 0) return [];

  interface Node {
    r: RawAnchor;
    val: number;
    prev: number;
  }
  const nodes: Node[] = [];

  const byA = new Map<number, RawAnchor[]>();
  let maxB = 0;
  for (const r of raws) {
    const g = byA.get(r.aIdx);
    if (g) g.push(r);
    else byA.set(r.aIdx, [r]);
    if (r.bIdx > maxB) maxB = r.bIdx;
  }
  const size = maxB + 1;
  const neg = -1e18;
  const bestVal = new Float64Array(size + 1).fill(neg);
  const bestId = new Int32Array(size + 1).fill(-1);
  const query = (pos1: number): number => {
    let id = -1;
    let val = neg;
    for (let x = pos1; x > 0; x -= x & -x) {
      if (bestVal[x] > val) {
        val = bestVal[x];
        id = bestId[x];
      }
    }
    return id;
  };
  const update = (pos1: number, val: number, id: number) => {
    for (let x = pos1; x <= size; x += x & -x) {
      if (val > bestVal[x]) {
        bestVal[x] = val;
        bestId[x] = id;
      }
    }
  };

  for (const ai of [...byA.keys()].sort((x, y) => x - y)) {
    const planned: { id: number; b1: number; val: number }[] = [];
    for (const r of byA.get(ai)!) {
      const prevId = query(r.bIdx); // 位置 1..bIdx 对应 b 下标 0..bIdx-1（严格递增）
      const id = nodes.length;
      const val = r.sim + (prevId >= 0 ? nodes[prevId].val : 0);
      nodes.push({ r, val, prev: prevId });
      planned.push({ id, b1: r.bIdx + 1, val });
    }
    for (const p of planned) update(p.b1, p.val, p.id);
  }

  const chosen: RawAnchor[] = [];
  let cur = query(size);
  while (cur >= 0) {
    chosen.push(nodes[cur].r);
    cur = nodes[cur].prev;
  }
  chosen.reverse();
  return chosen;
}

/** 两点间钳制到安全范围的斜率。 */
const segSlope = (p: Point, q: Point): number => {
  const raw = (q.a - p.a) / (q.b - p.b);
  return clamp(Number.isFinite(raw) ? raw : 1, MIN_SLOPE, MAX_SLOPE);
};

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/** Theil–Sen 稳健直线：成对斜率中位数 + 截距中位数，对个别异常点不敏感。 */
function theilSen(pts: Point[]): { slope: number; intercept: number } {
  const slopes: number[] = [];
  const n = pts.length;
  const totalPairs = (n * (n - 1)) / 2;
  const MAX_PAIRS = 100_000;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // 超大锚点集时确定性等间隔抽样，控制开销
      if (totalPairs > MAX_PAIRS && (i * n + j) % Math.ceil(totalPairs / MAX_PAIRS) !== 0) continue;
      const s = (pts[j].a - pts[i].a) / (pts[j].b - pts[i].b);
      if (Number.isFinite(s)) slopes.push(s);
    }
  }
  slopes.sort((x, y) => x - y);
  const slope = clamp(median(slopes), MIN_SLOPE, MAX_SLOPE);
  const intercepts = pts.map((p) => p.a - slope * p.b).sort((x, y) => x - y);
  return { slope, intercept: median(intercepts) };
}

/**
 * 异常偏移迭代剔除：每轮用 Theil–Sen 稳健直线计算各点残差，残差超过
 * max(固定容忍, 3.5·MAD尺度 + 100ms) 的最差锚点被剔除，直到无超标或仅剩两个。
 * 稳健回归不会被个别异常点“带偏”，避免 LOO 外推误剔正常端点。
 */
function filterOutliers(ptsIn: Point[], tolMs: number): Set<CalibAnchor> {
  const dropped = new Set<CalibAnchor>();
  let pts = [...ptsIn].sort((x, y) => x.b - y.b);

  while (pts.length > 2) {
    const { slope, intercept } = theilSen(pts);
    const entries = pts.map((p) => ({ p, r: p.a - (slope * p.b + intercept) }));
    const med = median(entries.map((e) => e.r).sort((x, y) => x - y));
    const mad = median(
      entries.map((e) => Math.abs(e.r - med)).sort((x, y) => x - y),
    );
    const threshold = Math.max(tolMs, 3.5 * 1.4826 * mad + 100);

    let worst: { p: Point; r: number } | null = null;
    for (const e of entries) {
      if (!worst || Math.abs(e.r) > Math.abs(worst.r)) worst = e;
    }
    if (worst && Math.abs(worst.r) > threshold) {
      dropped.add(worst.p.anchor);
      pts = pts.filter((p) => p !== worst!.p);
    } else {
      break;
    }
  }
  return dropped;
}

/**
 * 自动发现并筛选锚点。返回的列表包含全部候选（autoKept 标记是否被自动保留），
 * 被剔除的锚点带 dropReason，界面仍可展示但默认禁用。
 */
export function selectAnchors(
  cuesA: Cue[],
  cuesB: Cue[],
  opts: CalibOptions,
): CalibAnchor[] {
  const raws = findAnchorCandidates(cuesA, cuesB, opts);
  const ordered = chooseOrderConsistent(raws);
  const orderedSet = new Set(ordered);

  // 同起点时间去重（会产生 Δb=0 或 Δa=0 的退化区段）：同点保留相似度最高者
  const bestByAStart = new Map<number, RawAnchor>();
  const bestByBStart = new Map<number, RawAnchor>();
  for (const r of ordered) {
    const aT = cuesA[r.aIdx].start;
    const bT = cuesB[r.bIdx].start;
    const ca = bestByAStart.get(aT);
    if (!ca || r.sim > ca.sim) bestByAStart.set(aT, r);
    const cb = bestByBStart.get(bT);
    if (!cb || r.sim > cb.sim) bestByBStart.set(bT, r);
  }
  const duplicateDropped = new Set<RawAnchor>();
  for (const r of ordered) {
    if (
      bestByAStart.get(cuesA[r.aIdx].start) !== r ||
      bestByBStart.get(cuesB[r.bIdx].start) !== r
    ) {
      duplicateDropped.add(r);
    }
  }

  const survivors = ordered.filter((r) => !duplicateDropped.has(r));
  const pts: Point[] = survivors
    .map((r) => ({
      anchor: anchorOf(r),
      b: cuesB[r.bIdx].start,
      a: cuesA[r.aIdx].start,
    }))
    .sort((x, y) => x.b - y.b);
  const outlierDropped =
    pts.length > 2 ? filterOutliers(pts, opts.outlierTolMs) : new Set<CalibAnchor>();
  const outlierKeys = new Set([...outlierDropped].map((a) => a.key));

  return raws
    .map((r) => {
      const anchor = anchorOf(r);
      if (!orderedSet.has(r)) return { ...anchor, autoKept: false, dropReason: 'order' as const };
      if (duplicateDropped.has(r))
        return { ...anchor, autoKept: false, dropReason: 'duplicate' as const };
      if (outlierKeys.has(anchor.key))
        return { ...anchor, autoKept: false, dropReason: 'outlier' as const };
      return anchor;
    })
    .sort((x, y) =>
      x.autoKept !== y.autoKept
        ? x.autoKept
          ? -1
          : 1
        : cuesB[x.bIdx].start - cuesB[y.bIdx].start,
    );

  function anchorOf(r: RawAnchor): CalibAnchor {
    return { key: `${r.aIdx}:${r.bIdx}`, aIdx: r.aIdx, bIdx: r.bIdx, textSim: r.sim, autoKept: true };
  }
}

/**
 * 根据自动筛选结果、用户禁用与强制启用集合，拟合当前校准方案。
 * forced 中的锚点即使被自动剔除（顺序冲突/重复/异常）也参与拟合，用于人工纠正误剔。
 */
export function fitCalibration(
  cuesA: Cue[],
  cuesB: Cue[],
  anchors: CalibAnchor[],
  disabled: ReadonlySet<string>,
  forced: ReadonlySet<string> = new Set(),
): CalibFit {
  const empty: CalibFit = {
    ok: false,
    active: [],
    segments: [],
    residuals: new Map(),
    deviations: new Map(),
    mappedCues: cuesB,
  };
  if (cuesA.length === 0 || cuesB.length === 0) return empty;

  const isActive = (a: CalibAnchor) =>
    (a.autoKept && !disabled.has(a.key)) || (!a.autoKept && forced.has(a.key));

  const pts: Point[] = anchors
    .filter(isActive)
    .map((a) => ({ anchor: a, b: cuesB[a.bIdx].start, a: cuesA[a.aIdx].start }))
    .sort((x, y) => x.b - y.b || x.a - y.a);

  if (pts.length < 2) return empty;

  // 强制启用可能引入同 B 起点的退化点：同 b 只保留一个（优先自动保留的锚点）
  const dedupPts: Point[] = [];
  for (const p of pts) {
    const last = dedupPts[dedupPts.length - 1];
    if (last && last.b === p.b) {
      if (!last.anchor.autoKept && p.anchor.autoKept) dedupPts[dedupPts.length - 1] = p;
      continue;
    }
    dedupPts.push(p);
  }
  if (dedupPts.length < 2) return empty;

  const segments: CalibSegment[] = [];
  for (let i = 0; i < dedupPts.length - 1; i++) {
    const rawSlope = (dedupPts[i + 1].a - dedupPts[i].a) / (dedupPts[i + 1].b - dedupPts[i].b);
    segments.push({
      b0: dedupPts[i].b,
      b1: dedupPts[i + 1].b,
      a0: dedupPts[i].a,
      a1: dedupPts[i + 1].a,
      slope: clamp(Number.isFinite(rawSlope) ? rawSlope : 1, MIN_SLOPE, MAX_SLOPE),
    });
  }

  /** 未取整的映射值；段间按锚点取值（各段在锚点处连续），首尾用最近区段斜率外推。 */
  const evalRaw = (b: number): number => {
    if (b <= segments[0].b0) {
      const s = segments[0];
      return s.a0 + s.slope * (b - s.b0);
    }
    const last = segments[segments.length - 1];
    if (b >= last.b1) {
      return last.a1 + last.slope * (b - last.b1);
    }
    for (const s of segments) {
      if (b <= s.b1) return s.a0 + s.slope * (b - s.b0);
    }
    return b;
  };

  // 留一法残差（分段预测、斜率钳制），用于评估每个启用锚点。
  // 移除某点后：内部点由其左右邻居连成的区段预测；端点用移除后的首/尾区段外推。
  const residuals = new Map<string, number | null>();
  const P = dedupPts;
  if (P.length === 2) {
    residuals.set(P[0].anchor.key, null);
    residuals.set(P[1].anchor.key, null);
  } else {
    const looPred = (k: number): number => {
      if (k === 0) {
        return P[1].a + segSlope(P[1], P[2]) * (P[0].b - P[1].b);
      }
      if (k === P.length - 1) {
        return P[P.length - 2].a +
          segSlope(P[P.length - 3], P[P.length - 2]) *
            (P[k].b - P[P.length - 2].b);
      }
      return P[k - 1].a + segSlope(P[k - 1], P[k + 1]) * (P[k].b - P[k - 1].b);
    };
    for (let k = 0; k < P.length; k++) {
      residuals.set(P[k].anchor.key, P[k].a - looPred(k));
    }
  }

  // 未启用锚点相对当前映射的偏差（展示用）
  const deviations = new Map<string, number>();
  for (const a of anchors) {
    if (isActive(a)) continue;
    deviations.set(a.key, cuesA[a.aIdx].start - evalRaw(cuesB[a.bIdx].start));
  }

  // 映射所有 B cue，并保证开始/结束单调、时长为正
  const mapped: Cue[] = cuesB.map((c) => {
    const start = Math.max(0, Math.round(evalRaw(c.start)));
    let end = Math.max(0, Math.round(evalRaw(c.end)));
    if (end <= start) end = start + 1;
    return { id: c.id, start, end, text: c.text };
  });
  for (let i = 1; i < mapped.length; i++) {
    if (mapped[i].start < mapped[i - 1].start) mapped[i].start = mapped[i - 1].start;
    if (mapped[i].end < mapped[i - 1].end + 1) mapped[i].end = mapped[i - 1].end + 1;
    if (mapped[i].end <= mapped[i].start) mapped[i].end = mapped[i].start + 1;
  }

  return {
    ok: true,
    active: dedupPts.map((p) => p.anchor),
    segments,
    residuals,
    deviations,
    mappedCues: mapped,
  };
}

/** 未取整映射值的便捷导出（界面预览单条时间时复用）。 */
export function previewMappedTime(fit: CalibFit, b: number): number {
  if (!fit.ok || fit.segments.length === 0) return b;
  const s0 = fit.segments[0];
  if (b <= s0.b0) return s0.a0 + s0.slope * (b - s0.b0);
  const last = fit.segments[fit.segments.length - 1];
  if (b >= last.b1) return last.a1 + last.slope * (b - last.b1);
  for (const s of fit.segments) {
    if (b <= s.b1) return s.a0 + s.slope * (b - s.b0);
  }
  return b;
}
