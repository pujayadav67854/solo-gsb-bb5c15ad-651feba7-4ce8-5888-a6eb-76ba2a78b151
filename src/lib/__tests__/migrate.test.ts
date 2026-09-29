import { describe, expect, it } from 'vitest';
import { migrateStates, planMigration } from '../migrate';
import type { AlignGroup, GroupKind } from '../align';
import { defaultStateFor } from '../merge';
import type { Cue } from '../srt';

function cue(text: string, i: number): Cue {
  return { id: i, start: i * 2000, end: i * 2000 + 1500, text };
}

type Desc = [string[] | null, string[] | null][];

/** 由旧描述展开得到两侧 cue（重新校准不改文本，新旧对齐使用同一批 cue）。 */
function flattenCues(desc: Desc): { cuesA: Cue[]; cuesB: Cue[] } {
  const aTexts: string[] = [];
  const bTexts: string[] = [];
  for (const [a, b] of desc) {
    a?.forEach((t) => aTexts.push(t));
    b?.forEach((t) => bTexts.push(t));
  }
  return { cuesA: aTexts.map((t, i) => cue(t, i)), cuesB: bTexts.map((t, i) => cue(t, i)) };
}

function kindOf(a: string[] | null, b: string[] | null): GroupKind {
  return a === null
    ? 'B-only'
    : b === null
      ? 'A-only'
      : a.length === 1 && b.length === 1
        ? '1:1'
        : a.length > 1
          ? 'N:1'
          : '1:N';
}

function rawGroup(kind: GroupKind, aIdx: number[], bIdx: number[]): AlignGroup {
  return {
    id: `g${aIdx.join('.')}/${bIdx.join('.')}`,
    aIdx,
    bIdx,
    kind,
    textSim: 1,
    timeOverlap: 1,
    confidence: 1,
  };
}

/** 旧描述：下标按展开顺序分配。 */
function oldGroupsOf(desc: Desc): AlignGroup[] {
  let pa = 0;
  let pb = 0;
  return desc.map(([a, b]) => {
    const aIdx: number[] = [];
    const bIdx: number[] = [];
    a?.forEach(() => aIdx.push(pa++));
    b?.forEach(() => bIdx.push(pb++));
    return rawGroup(kindOf(a, b), aIdx, bIdx);
  });
}

/**
 * 新描述：cue 集合与旧描述相同、仅分组不同；按文本把每次出现映射到该侧同名 cue
 * 的下一个下标——重复台词也因此指向真实的重复 cue，而不是按下标猜配。
 */
function newGroupsOf(desc: Desc, cuesA: Cue[], cuesB: Cue[]): AlignGroup[] {
  const qa = new Map<string, number[]>();
  const qb = new Map<string, number[]>();
  cuesA.forEach((c, i) => {
    const q = qa.get(c.text) ?? [];
    q.push(i);
    qa.set(c.text, q);
  });
  cuesB.forEach((c, i) => {
    const q = qb.get(c.text) ?? [];
    q.push(i);
    qb.set(c.text, q);
  });
  const take = (q: Map<string, number[]>, t: string): number => {
    const arr = q.get(t);
    if (!arr || arr.length === 0) throw new Error(`新描述引用了不存在的 cue：${t}`);
    return arr.shift()!;
  };
  return desc.map(([a, b]) =>
    rawGroup(
      kindOf(a, b),
      a ? a.map((t) => take(qa, t)) : [],
      b ? b.map((t) => take(qb, t)) : [],
    ),
  );
}

function planOf(oldDesc: Desc, newDesc: Desc) {
  const { cuesA, cuesB } = flattenCues(oldDesc);
  const oldGroups = oldGroupsOf(oldDesc);
  const newGroups = newGroupsOf(newDesc, cuesA, cuesB);
  return {
    plan: planMigration(oldGroups, newGroups, cuesA, cuesB),
    oldGroups,
    newGroups,
    cuesA,
    cuesB,
  };
}

describe('planMigration', () => {
  it('内容完全一致时全部可迁移', () => {
    const desc: Desc = [
      [['你好'], ['你好']],
      [['谢谢'], ['谢谢']],
      [['再见'], ['再见']],
    ];
    const { plan } = planOf(desc, desc);
    expect(plan.ok).toBe(true);
    expect(plan.matchCount).toBe(3);
    expect(plan.transfer).toHaveLength(3);
    expect(plan.ambiguous).toHaveLength(0);
    expect(plan.none).toHaveLength(0);
    expect(plan.newUnmatched).toHaveLength(0);
    expect(plan.transfer.map((e) => e.oldIndex)).toEqual([0, 1, 2]);
    expect(plan.transfer.map((e) => e.candidateNewIndexes[0])).toEqual([0, 1, 2]);
  });

  it('合并组按双侧拼接文本比较，文本一致即可迁移', () => {
    const desc: Desc = [[['你好', '世界'], ['你好\n世界']]];
    const { plan } = planOf(desc, desc);
    expect(plan.matchCount).toBe(1);
    expect(plan.transfer).toHaveLength(1);
  });

  it('重新分组后拼接文本不同则不能配对，相同的组照常迁移', () => {
    // 旧：G0 把“你好/世界”与 B 的两条合并（拼接“你好世界”），G1 谢谢
    // 新：重新配对后 G0/G1 的双侧拼接均与旧组不同，只有 G2“谢谢”一致
    const { plan } = planOf(
      [
        [['你好世界'], ['你好', '世界']],
        [['别的'], ['别的']],
        [['谢谢'], ['谢谢']],
      ],
      [
        [['你好世界'], ['你好']],
        [['别的'], ['世界']],
        [['谢谢'], ['谢谢']],
      ],
    );
    expect(plan.matchCount).toBe(1);
    expect(plan.transfer.map((e) => e.oldIndex)).toEqual([2]);
    expect(plan.transfer[0].candidateNewIndexes).toEqual([2]);
    expect(plan.none.map((e) => e.oldIndex)).toEqual([0, 1]);
    expect(plan.newUnmatched).toEqual([0, 1]);
  });

  it('重复台词在不交叉前提下无法对应时不迁移，绝不按下标猜配', () => {
    // 同一两份字幕（两侧文本相同），重复台词“嗯”出现两次：
    //   旧对齐：你好 / 嗯 / 再见 / 嗯 / 结束
    //   新校准后第一个“嗯”未形成 1:1（拆为仅 A / 仅 B），新序列为
    //           你好 / [仅A嗯] / [仅B嗯] / 再见 / 嗯 / 结束
    // 旧第一个“嗯”越过“再见”才能配上新“嗯”，违反不交叉 → 无候选（none）；
    // 旧第二个“嗯”唯一对应新“嗯”，但旧第一个“嗯”仍可被跳过达到同样的最大匹配，
    // 因此它也不得被当作确定对应——系统不得按出现下标把旧第一个“嗯”迁过去。
    const mk = (texts: string[]) => texts.map((t, i) => cue(t, i));
    const cuesA = mk(['你好', '嗯', '再见', '嗯', '结束']);
    const cuesB = mk(['你好', '嗯', '再见', '嗯', '结束']);
    const oldGroups: AlignGroup[] = [
      rawGroup('1:1', [0], [0]),
      rawGroup('1:1', [1], [1]),
      rawGroup('1:1', [2], [2]),
      rawGroup('1:1', [3], [3]),
      rawGroup('1:1', [4], [4]),
    ];
    const newGroups: AlignGroup[] = [
      rawGroup('1:1', [0], [0]),
      rawGroup('A-only', [1], []),
      rawGroup('B-only', [], [1]),
      rawGroup('1:1', [2], [2]),
      rawGroup('1:1', [3], [3]),
      rawGroup('1:1', [4], [4]),
    ];
    const plan = planMigration(oldGroups, newGroups, cuesA, cuesB);
    expect(plan.matchCount).toBe(4);
    // 旧第一个“嗯”没有候选：不迁移
    const oldFirst = plan.none.find((e) => e.oldIndex === 1);
    expect(oldFirst).toBeDefined();
    expect(oldFirst!.candidateNewIndexes).toEqual([]);
    // 旧第二个“嗯”唯一确定地迁移
    const transfer3 = plan.transfer.find((e) => e.oldIndex === 3);
    expect(transfer3).toBeDefined();
    expect(transfer3!.candidateNewIndexes).toEqual([4]);
    // 其余三组也唯一迁移
    expect(plan.transfer.map((e) => e.oldIndex)).toEqual([0, 2, 3, 4]);
  });

  it('一个旧组在两个同内容新组间可配时标记 multi-partner', () => {
    // 旧：X Y（2 组）；新：X Y X Y（4 组，cue 集合与旧相同，多出的重复由校准前后
    // 分组差异承载——这里直接用显式下标构造）。旧 X 可配新 G0 或 G2，后续 Y 保证
    // 两种配法都能达到最大匹配 2 → multi-partner；旧 Y 同理。
    const mk = (texts: string[]) => texts.map((t, i) => cue(t, i));
    const cuesA = mk(['X', 'Y', 'X', 'Y']);
    const cuesB = mk(['X', 'Y', 'X', 'Y']);
    // 旧对齐只使用前两条 cue；新对齐把重复出现的两条也各自成组
    const oldGroups = [rawGroup('1:1', [0], [0]), rawGroup('1:1', [1], [1])];
    const newGroups = [
      rawGroup('1:1', [0], [0]),
      rawGroup('1:1', [1], [1]),
      rawGroup('1:1', [2], [2]),
      rawGroup('1:1', [3], [3]),
    ];
    const plan = planMigration(oldGroups, newGroups, cuesA, cuesB);
    expect(plan.matchCount).toBe(2);
    const x0 = plan.ambiguous.find((e) => e.oldIndex === 0);
    expect(x0).toBeDefined();
    expect(x0!.candidateNewIndexes).toEqual([0, 2]);
    expect(x0!.reason).toBe('multi-partner');
    expect(plan.transfer).toHaveLength(0);
  });

  it('跳过旧组也能达到最大匹配时标记歧义（skip-optional）', () => {
    // 旧：A X B；新：A B —— X 无对应 → none；A/B 唯一
    const { plan: p1 } = planOf(
      [
        [['A'], ['A']],
        [['X'], ['X']],
        [['B'], ['B']],
      ],
      [
        [['A'], ['A']],
        [['B'], ['B']],
      ],
    );
    expect(p1.transfer.map((e) => e.oldIndex)).toEqual([0, 2]);
    expect(p1.none.map((e) => e.oldIndex)).toEqual([1]);

    // 旧：A X B；新：X A B —— 内容相同的唯一最优方案是 X↔X 吗？不是：跳过旧 X
    // 配 A、B 同样得到 2 对；两条最优路径分别“用旧 X”与“跳过旧 X”，故旧 X 歧义。
    // （算法对 A/B 的判定也可能产生候选差异，这里只要求 X 出现在歧义列表）
    const { plan: p2 } = planOf(
      [
        [['A'], ['A']],
        [['X'], ['X']],
        [['B'], ['B']],
      ],
      [
        [['X'], ['X']],
        [['A'], ['A']],
        [['B'], ['B']],
      ],
    );
    expect(p2.matchCount).toBe(2);
    const xEntry = p2.ambiguous.find((e) => e.aText === 'X');
    expect(xEntry).toBeDefined();
    expect(xEntry!.candidateNewIndexes).toContain(0);
    // A 在两条最优路径中的配偶不同（新 1 或跳过），B 唯一确定
    expect(p2.transfer.map((e) => e.oldIndex)).toContain(2);
  });

  it('单边组仅按存在侧文本匹配', () => {
    const { plan } = planOf(
      [
        [['共有'], ['共有']],
        [['仅A片段'], null],
        [null, ['仅B片段']],
      ],
      [
        [['共有'], ['共有']],
        [['仅A片段'], null],
        [null, ['仅B片段']],
      ],
    );
    expect(plan.transfer).toHaveLength(3);
  });

  it('仅A组与1:1组不会误配（另一侧文本必须同时相同）', () => {
    const cuesA = [cue('同文', 0)];
    const cuesB = [cue('同文', 0)];
    const oldGroups = [rawGroup('A-only', [0], [])];
    const newGroups = [rawGroup('1:1', [0], [0])];
    const plan = planMigration(oldGroups, newGroups, cuesA, cuesB);
    expect(plan.matchCount).toBe(0);
    expect(plan.transfer).toHaveLength(0);
    expect(plan.none).toHaveLength(1);
  });

  it('不允许交叉：跨序内容不产生迁移', () => {
    // 旧：A B；新：B A。最大匹配为 1，两个旧组各有一个候选但均可跳过 → 均歧义
    const { plan } = planOf(
      [
        [['A'], ['A']],
        [['B'], ['B']],
      ],
      [
        [['B'], ['B']],
        [['A'], ['A']],
      ],
    );
    expect(plan.matchCount).toBe(1);
    expect(plan.transfer).toHaveLength(0);
    expect(plan.ambiguous).toHaveLength(2);
    for (const e of plan.ambiguous) {
      expect(e.reason).toBe('skip-optional');
      expect(e.candidateNewIndexes).toHaveLength(1);
    }
  });

  it('空一侧输入安全', () => {
    const { cuesA, cuesB } = flattenCues([[['A'], ['A']]]);
    const groups = oldGroupsOf([[['A'], ['A']]]);
    const plan = planMigration([], groups, cuesA, cuesB);
    expect(plan.ok).toBe(true);
    expect(plan.matchCount).toBe(0);
    expect(plan.transfer).toHaveLength(0);
    expect(plan.newUnmatched).toEqual([0]);
  });
});

describe('migrateStates', () => {
  it('迁移 A/B/自定义文本选择与单边保留决定，时间选择重置为新默认', () => {
    const r = planOf(
      [
        [['甲'], ['甲']],
        [['你好世界'], ['你好世界呀']],
        [['单边'], null],
        [['新增'], ['新增']],
      ],
      [
        [['甲'], ['甲']],
        [['你好世界'], ['你好世界呀']],
        [['单边'], null],
        [['新增'], ['新增']],
      ],
    );
    const { plan, oldGroups, cuesA, cuesB } = r;
    expect(plan.transfer).toHaveLength(4);

    const oldStates = oldGroups.map((g) => defaultStateFor(g, cuesA, cuesB));
    oldStates[1] = {
      isConflict: true,
      resolved: true,
      resolution: { ...oldStates[1].resolution, text: 'B', time: 'union' },
    };
    oldStates[2] = {
      isConflict: false,
      resolved: true,
      resolution: { ...oldStates[2].resolution, keep: false },
    };

    // 新校准多对齐出一组旧对齐中不存在的两侧 cue；为承载它扩展两侧 cue。
    // 原 cue：A 4 条、B 3 条。
    const cuesAExtra = [...cuesA, cue('新出现', 4)];
    const cuesBExtra = [...cuesB, cue('新出现', 3)];
    const newGroupsWithExtra: AlignGroup[] = [
      ...r.newGroups,
      rawGroup('1:1', [4], [3]),
    ];

    const newBase = newGroupsWithExtra.map((g) => defaultStateFor(g, cuesAExtra, cuesBExtra));
    const out = migrateStates(newGroupsWithExtra, newBase, oldStates, plan);

    expect(out[0].resolved).toBe(true);
    expect(out[1].resolved).toBe(true);
    expect(out[1].resolution.text).toBe('B');
    expect(out[1].resolution.time).toBe('A');
    expect(out[2].resolution.keep).toBe(false);
    // 无旧对应的新组保持默认（一致文本自动解决）
    expect(out[4].resolution.text).toBe('A');
  });

  it('自定义文本随选择迁移，自定义时间不迁移', () => {
    const r = planOf([[['原文本'], ['原文本']]], [[['原文本'], ['原文本']]]);
    const { plan, oldGroups, newGroups, cuesA, cuesB } = r;
    const oldStates = oldGroups.map((g) => defaultStateFor(g, cuesA, cuesB));
    oldStates[0] = {
      isConflict: false,
      resolved: true,
      resolution: {
        ...oldStates[0].resolution,
        text: 'custom',
        customText: '人工改写',
        time: 'custom',
        customStart: '00:00:01,000',
        customEnd: '00:00:02,000',
      },
    };
    const newBase = newGroups.map((g) => defaultStateFor(g, cuesA, cuesB));
    const out = migrateStates(newGroups, newBase, oldStates, plan);
    expect(out[0].resolution.text).toBe('custom');
    expect(out[0].resolution.customText).toBe('人工改写');
    expect(out[0].resolution.time).toBe('A');
    expect(out[0].resolution.customStart).toBe('');
    expect(out[0].resolution.customEnd).toBe('');
  });

  it('旧组未作出决定时不覆盖新默认（冲突仍需重新处理）', () => {
    const r = planOf([[['甲'], ['甲乙']]], [[['甲'], ['甲乙']]]);
    const { plan, oldGroups, newGroups, cuesA, cuesB } = r;
    const oldStates = oldGroups.map((g) => defaultStateFor(g, cuesA, cuesB));
    expect(oldStates[0].resolved).toBe(false);
    const newBase = newGroups.map((g) => defaultStateFor(g, cuesA, cuesB));
    const out = migrateStates(newGroups, newBase, oldStates, plan);
    expect(out[0].resolved).toBe(false);
    expect(out[0].isConflict).toBe(true);
  });
});
