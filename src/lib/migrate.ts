/**
 * 重新校准后的审校决定迁移。
 *
 * 匹配规则（严格按需求）：
 *  - 旧对齐组与新对齐组仅在「A 侧拼接后的原始文本」与「B 侧拼接后的原始文本」
 *    均完全相同时才可配对（单边组只比较其存在的一侧，另一侧为空）；
 *  - 在所有可配对上求顺序一对一、不允许交叉的全局最大基数匹配，即对“组内容符号序列”
 *    求最长公共子序列（LCS）；
 *  - 旧组只有在【所有】最优（最大匹配）方案中都对应同一个新组时，才允许迁移其决定；
 *    重复台词导致存在多个最优方案时一律标记歧义，绝不按出现下标猜配；
 *  - 时间选择不迁移（提交时使用新组默认值）；消重、断行、节奏、吸附采纳由 App 层清空。
 *
 * “是否在所有最优方案中都被匹配”的判定借助 LCS 的前向 DP f[i][j] 与后向 DP g[i][j]：
 *  - 配对边 (i−1 → j−1) 属于某条最优 LCS  ⇔  f[i−1][j−1] + 1 + g[i][j] === L；
 *  - 旧组 i−1 在某条最优 LCS 中可以不匹配 ⇔  存在 j 使 f[i][j] + g[i+1][j] === L。
 * 旧组的最优配偶恰有一个、且不存在“跳过它”的最优方案时，该对应关系才是唯一确定的。
 */
import type { AlignGroup, GroupKind } from './align';
import type { Cue } from './srt';
import { mergedText, type GroupState } from './merge';

/** DP 单元数上限（(n+1)(m+1)），Uint16 存储，约 40MB；超出则拒绝并让用户取消。 */
const MAX_DP_CELLS = 20_000_000;

export interface GroupContent {
  /** A 侧各 cue 原文按顺序拼接（仅 A 组为 ''） */
  aText: string;
  /** B 侧各 cue 原文按顺序拼接（仅 B 组为 ''） */
  bText: string;
}

export type MigrationStatus = 'transfer' | 'ambiguous' | 'none';
export type AmbiguousReason = 'multi-partner' | 'skip-optional';

export interface MigrationEntry {
  oldIndex: number;
  kind: GroupKind;
  aText: string;
  bText: string;
  status: MigrationStatus;
  /** status === 'ambiguous' 时的原因说明编码 */
  reason?: AmbiguousReason;
  /** 该旧组在最优匹配中可能对应的全部新组下标（已排序、去重） */
  candidateNewIndexes: number[];
  /** 是否存在不匹配该旧组的最优方案 */
  skipOptional: boolean;
}

export interface MigrationPlan {
  ok: boolean;
  /** 组数量过大、无法在浏览器内完成全量 LCS 判定 */
  error?: 'too-large';
  oldCount: number;
  newCount: number;
  /** 最优匹配的配对数（LCS 长度） */
  matchCount: number;
  transfer: MigrationEntry[];
  ambiguous: MigrationEntry[];
  none: MigrationEntry[];
  /** 从未出现在任何最优匹配中的新组下标（必然按新组默认处理） */
  newUnmatched: number[];
}

/** 取一个对齐组的双侧拼接原文作为身份内容。 */
export function contentOf(group: AlignGroup, cuesA: Cue[], cuesB: Cue[]): GroupContent {
  return {
    aText: mergedText(cuesA, group.aIdx),
    bText: mergedText(cuesB, group.bIdx),
  };
}

/** 把双侧文本组合 intern 成整数符号，避免 DP 中反复比较字符串。 */
class SymbolTable {
  private readonly outer = new Map<string, Map<string, number>>();
  private next = 0;

  id(c: GroupContent): number {
    let inner = this.outer.get(c.aText);
    if (!inner) {
      inner = new Map();
      this.outer.set(c.aText, inner);
    }
    let sym = inner.get(c.bText);
    if (sym === undefined) {
      sym = this.next++;
      inner.set(c.bText, sym);
    }
    return sym;
  }
}

/**
 * 计算迁移预览。oldGroups/newGroups 的 bIdx 均指向各自对齐时使用的 B 时间轴；
 * 校准只改时间不改文本且保持顺序，因此两侧都可以直接用原始 cuesB 取文本。
 */
export function planMigration(
  oldGroups: AlignGroup[],
  newGroups: AlignGroup[],
  cuesA: Cue[],
  cuesB: Cue[],
): MigrationPlan {
  const n = oldGroups.length;
  const m = newGroups.length;
  const base: Omit<MigrationPlan, 'transfer' | 'ambiguous' | 'none' | 'newUnmatched'> = {
    ok: true,
    oldCount: n,
    newCount: m,
    matchCount: 0,
  };

  if (n === 0 || m === 0) {
    return {
      ...base,
      transfer: [],
      ambiguous: [],
      none: oldGroups.map((g, i) => ({
        oldIndex: i,
        kind: g.kind,
        aText: mergedText(cuesA, g.aIdx),
        bText: mergedText(cuesB, g.bIdx),
        status: 'none' as const,
        candidateNewIndexes: [],
        skipOptional: false,
      })),
      newUnmatched: [...Array(m).keys()],
    };
  }

  if ((n + 1) * (m + 1) > MAX_DP_CELLS) {
    return { ...base, ok: false, error: 'too-large', transfer: [], ambiguous: [], none: [], newUnmatched: [] };
  }

  const table = new SymbolTable();
  const oldSym = oldGroups.map((g) => table.id(contentOf(g, cuesA, cuesB)));
  const newSym = newGroups.map((g) => table.id(contentOf(g, cuesA, cuesB)));

  // 前向 LCS DP（完整矩阵，回边判定需要任意 f[i][j]）
  const W = m + 1;
  let f: Uint16Array;
  try {
    f = new Uint16Array((n + 1) * W);
  } catch {
    return { ...base, ok: false, error: 'too-large', transfer: [], ambiguous: [], none: [], newUnmatched: [] };
  }
  for (let i = 1; i <= n; i++) {
    const rowBase = i * W;
    const prevBase = (i - 1) * W;
    const sym = oldSym[i - 1];
    let left = 0; // f[i][j-1]
    for (let j = 1; j <= m; j++) {
      const up = f[prevBase + j];
      let v = up;
      if (sym === newSym[j - 1]) {
        const diag = f[prevBase + j - 1] + 1;
        if (diag > v) v = diag;
      }
      if (left > v) v = left;
      f[rowBase + j] = v;
      left = v;
    }
  }
  const L = f[n * W + m];

  const entries: MigrationEntry[] = new Array(n);
  const matchedAny = new Uint8Array(m);

  // 后向 DP 滚动两行。本轮开始时 giNext[j] = G[i][j]（旧下标 i..n−1 与新下标 j..m−1 的 LCS）；
  // 本轮计算后 cur[j] = G[i−1][j]。
  let giNext = new Uint16Array(W); // i = n 时 G[n][*] = 0
  for (let i = n; i >= 1; i--) {
    const cur = new Uint16Array(W); // G[i−1][m] = 0（j=0 列也需正常计算）
    const sym = oldSym[i - 1];
    for (let j = m - 1; j >= 0; j--) {
      // G[i−1][j] = max(G[i][j], G[i−1][j+1], 1 + G[i][j+1] 若符号相同)
      let v = cur[j + 1];
      if (giNext[j] > v) v = giNext[j];
      if (j < m && sym === newSym[j] && giNext[j + 1] + 1 > v) v = giNext[j + 1] + 1;
      cur[j] = v;
    }

    const oldGroup = oldGroups[i - 1];
    const prevBase = (i - 1) * W;

    // 是否存在“跳过该旧组”的最优方案：f[i−1][j] + G[i][j] === L
    let skipOptional = false;
    for (let j = 0; j <= m; j++) {
      if (f[prevBase + j] + giNext[j] === L) {
        skipOptional = true;
        break;
      }
    }

    // 枚举该旧组在最优匹配中的全部配偶（j 为新组 0 基下标）：
    // 配对边 (i−1 → j) 属于某条最优 LCS ⇔ f[i−1][j] + 1 + G[i][j+1] === L
    const candidates: number[] = [];
    for (let j = 0; j < m; j++) {
      if (sym === newSym[j] && f[prevBase + j] + 1 + giNext[j + 1] === L) {
        candidates.push(j);
        matchedAny[j] = 1;
      }
    }
    let status: MigrationStatus;
    let reason: AmbiguousReason | undefined;
    if (candidates.length === 0) {
      status = 'none';
    } else if (candidates.length === 1 && !skipOptional) {
      status = 'transfer';
    } else {
      status = 'ambiguous';
      reason = candidates.length >= 2 ? 'multi-partner' : 'skip-optional';
    }

    entries[i - 1] = {
      oldIndex: i - 1,
      kind: oldGroup.kind,
      aText: mergedText(cuesA, oldGroup.aIdx),
      bText: mergedText(cuesB, oldGroup.bIdx),
      status,
      reason,
      candidateNewIndexes: candidates,
      skipOptional,
    };
    giNext = cur;
  }

  const transfer: MigrationEntry[] = [];
  const ambiguous: MigrationEntry[] = [];
  const none: MigrationEntry[] = [];
  for (const e of entries) {
    if (e.status === 'transfer') transfer.push(e);
    else if (e.status === 'ambiguous') ambiguous.push(e);
    else none.push(e);
  }
  const newUnmatched: number[] = [];
  for (let j = 0; j < m; j++) if (!matchedAny[j]) newUnmatched.push(j);

  return { ok: true, oldCount: n, newCount: m, matchCount: L, transfer, ambiguous, none, newUnmatched };
}

/**
 * 按预览结果生成新对齐的组状态：
 *  - 以新组默认状态为底（时间轴选择即为新组默认值）；
 *  - 仅对“所有最优方案中唯一对应”的旧组迁移其已作出的人工决定：
 *    匹配组迁移 A/B/自定义文本选择与自定义文本，单边组迁移保留/丢弃；
 *  - 旧组本身尚未作出决定（如未解决冲突）时不覆盖新组默认；
 *  - 时间选择（A/B/并集/自定义时间）一律不迁移。
 */
export function migrateStates(
  newGroups: AlignGroup[],
  newBaseStates: GroupState[],
  oldStates: GroupState[],
  plan: MigrationPlan,
): GroupState[] {
  const result = newBaseStates.map((s) => ({ ...s, resolution: { ...s.resolution } }));
  for (const e of plan.transfer) {
    const oldState = oldStates[e.oldIndex];
    if (!oldState || !oldState.resolved) continue;
    const ni = e.candidateNewIndexes[0];
    const ng = newGroups[ni];
    const base = result[ni];
    const resolution = { ...base.resolution };
    if (ng.kind === 'A-only' || ng.kind === 'B-only') {
      resolution.keep = oldState.resolution.keep;
    } else {
      const oldChoice = oldState.resolution.text;
      // 自定义文本始终可迁移；A/B 选择仅在新组该侧非空时迁移，否则保持新组默认。
      // 局部混编（mix）的逐片段选择依赖该组双侧文本的 LCS 分段，重新对齐后分段可能
      // 变化，故不迁移，新组按默认处理（仍为冲突时照常标红拦截导出）。
      if (
        (oldChoice === 'custom' ||
          (oldChoice === 'A' && ng.aIdx.length > 0) ||
          (oldChoice === 'B' && ng.bIdx.length > 0))
      ) {
        resolution.text = oldChoice;
        resolution.customText = oldState.resolution.customText;
      }
    }
    // isConflict 以新组默认状态为准（新组可能不再是冲突）；迁入了人工决定即视为已解决
    result[ni] = { ...base, resolved: true, resolution };
  }
  return result;
}
