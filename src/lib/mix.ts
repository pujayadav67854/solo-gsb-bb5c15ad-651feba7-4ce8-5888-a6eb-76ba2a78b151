/**
 * 局部混编：把双侧对齐组的两侧拼接文本按 Unicode 字素求最长公共子序列（LCS），
 * 相同片段固定保留，差异片段逐段选择取 A 或取 B；两次相邻匹配之间的 A 删除与
 * B 插入归入同一差异段（替换关系）。
 *
 * 多条最优 LCS 路径的固定方式：在所有最长（匹配数最多）路径中，取“匹配位置序列”
 * 字典序最小的一条——先比匹配到的 A 下标序列（越小越优先），A 序列相同再比 B 下标
 * 序列。这样即使两侧存在重复词，差异片段的边界也不会漂移。实现上先求后缀长度 DP
 * G[i][j] = LCS(A[i:], B[j:])，再求 NP[i][j] = 最优路径从该格出发的“下一对匹配
 * 位置”（在保持最长匹配数的后继格中取行优先编码最小者，行优先顺序正好是先 A 后 B
 * 的字典序），随后沿 NP 从 (0,0) 跳跃式正向走即可。
 *
 * DP 单元数有上限保护；超出上限时返回 { ok:false }，调用方不提供局部混编入口。
 */
import { graphemes } from './wrap';

export type MixChoice = 'A' | 'B';

export interface MixHunk {
  /** 相同片段为 true（固定保留，不可选择）；差异片段为 false */
  equal: boolean;
  /** 该段在 A 中的文本（差异段里可能为空字符串，表示 B 侧插入） */
  aText: string;
  /** 该段在 B 中的文本（差异段里可能为空字符串，表示 A 侧删除） */
  bText: string;
}

export interface MixPlan {
  ok: true;
  hunks: MixHunk[];
  /** 可逐段选择的差异段数量 */
  diffCount: number;
}

export interface MixFailure {
  ok: false;
  reason: 'too-large';
}

export type MixResult = MixPlan | MixFailure;

/** DP 单元数上限（两侧字素数乘积）；Uint32 全量矩阵，约 16MB。 */
export const MAX_MIX_CELLS = 4_000_000;

interface MixBlock {
  equal: boolean;
  a: string;
  b: string;
}

/**
 * 计算两侧文本的局部混编分段。差异段按 LCS 对齐中的连续非匹配区域合并：
 * 相邻（中间没有相同片段）的删除与插入归入同一段（替换关系），由用户在该段
 * 整体选 A 或选 B；被相同片段隔开的插入/删除各自独立成段。
 */
export function planMix(textA: string, textB: string): MixResult {
  const a = graphemes(textA);
  const b = graphemes(textB);
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return { ok: true, hunks: [], diffCount: 0 };
  // 单侧文本为空：整体是一个差异段（另一侧的插入）
  if (n === 0 || m === 0) {
    return {
      ok: true,
      hunks: [{ equal: false, aText: textA, bText: textB }],
      diffCount: 1,
    };
  }
  if ((n + 1) * (m + 1) > MAX_MIX_CELLS) return { ok: false, reason: 'too-large' };

  // 后缀 LCS 长度 DP：G[i][j] = LCS(A[i:], B[j:])，从右下角向左上角计算。
  // 另用 NP[i][j] 记录从该格出发的最优路径中“下一对匹配位置”（编码为
  // i*(m+1)+j，越大表示越靠后；用 (n+1)(m+1) 作为“再无匹配”哨兵）。匹配位置序列
  // 先按 A 下标、再按 B 下标做字典序比较，即编码数值越小越优。
  const W = m + 1;
  const cells = (n + 1) * W;
  const NONE = cells;
  let G: Uint32Array;
  let NP: Uint32Array;
  try {
    G = new Uint32Array(cells);
    NP = new Uint32Array(cells);
  } catch {
    return { ok: false, reason: 'too-large' };
  }
  for (let k = 0; k < cells; k++) NP[k] = NONE;
  /** 两个“下一对匹配位置”编码（行优先 index = i·W+j）取小者：行优先顺序与
   *  “先比 A 下标、再比 B 下标”的字典序一致。 */
  const minPair = (x: number, y: number): number => (x <= y ? x : y);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * W;
    const below = (i + 1) * W;
    for (let j = m - 1; j >= 0; j--) {
      const down = G[below + j];
      const right = G[row + j + 1];
      let v = down >= right ? down : right;
      if (a[i] === b[j]) {
        const diag = G[below + j + 1] + 1;
        if (diag > v) v = diag;
      }
      G[row + j] = v;

      // 下一对匹配位置：
      //  - 能在 (i,j) 匹配且匹配属于某条最优路径 → 就是 (i,j)
      //  - 否则在“仍保持最优长度”的转移方向（右：消费 B / 下：消费 A）中，
      //    取后继格的下一对匹配位置，编码小者胜（行优先 ⇔ 先 A 后 B 字典序）
      let np = NONE;
      if (a[i] === b[j] && G[below + j + 1] + 1 === v) {
        np = row + j;
      } else {
        if (G[row + j + 1] === v) np = minPair(np, NP[row + j + 1]);
        if (G[below + j] === v) np = minPair(np, NP[below + j]);
      }
      NP[row + j] = np;
    }
  }

  // 依据“下一对匹配位置”表 NP 正向走规范路径：跳到下一对匹配，途中被跳过的
  // A 字素（删除）与 B 字素（插入）归入同一个差异段；匹配位置序列由 NP 保证
  // 为“先 A 后 B”字典序最小，重复词不会导致片段边界漂移。
  const blocks: MixBlock[] = [];
  let cur: MixBlock | null = null;
  const addMatch = (ga: string) => {
    cur = null;
    const last = blocks[blocks.length - 1];
    if (last && last.equal) {
      last.a += ga;
      last.b += ga;
    } else {
      blocks.push({ equal: true, a: ga, b: ga });
    }
  };
  const addDiff = (ga: string, gb: string) => {
    if (cur) {
      cur.a += ga;
      cur.b += gb;
    } else {
      cur = { equal: false, a: ga, b: gb };
      blocks.push(cur);
    }
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const np = NP[i * W + j];
    if (np === NONE) {
      // 剩余全部为差异（插入/删除）
      for (; i < n; i++) addDiff(a[i], '');
      for (; j < m; j++) addDiff('', b[j]);
      break;
    }
    const mi = Math.floor(np / W);
    const mj = np % W;
    // 到下一对匹配之前的 A 删除与 B 插入属于同一差异段
    for (; i < mi; i++) addDiff(a[i], '');
    for (; j < mj; j++) addDiff('', b[j]);
    addMatch(a[mi]);
    i = mi + 1;
    j = mj + 1;
  }

  const hunks: MixHunk[] = blocks.map((s) => ({ equal: s.equal, aText: s.a, bText: s.b }));
  return { ok: true, hunks, diffCount: hunks.reduce((c2, h) => c2 + (h.equal ? 0 : 1), 0) };
}

/** 差异段的默认选择：优先 A，A 段为空（纯 B 插入）时取 B，避免默认结果缺字。 */
export function defaultMixChoices(hunks: readonly MixHunk[]): MixChoice[] {
  return hunks
    .filter((h) => !h.equal)
    .map((h) => (h.aText === '' ? 'B' : 'A'));
}

/** 按逐段选择渲染混编文本；相同片段固定保留。 */
export function renderMix(hunks: readonly MixHunk[], choices: readonly MixChoice[]): string {
  let out = '';
  let di = 0;
  for (const h of hunks) {
    if (h.equal) {
      out += h.aText;
    } else {
      out += choices[di] === 'B' ? h.bText : h.aText;
      di++;
    }
  }
  return out;
}
