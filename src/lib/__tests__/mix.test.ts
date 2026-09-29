import { describe, expect, it } from 'vitest';
import { defaultMixChoices, planMix, renderMix, MAX_MIX_CELLS } from '../mix';

/** 取差异段文本对（aText, bText），便于断言分段边界。 */
function diffPairs(a: string, b: string): [string, string][] {
  const r = planMix(a, b);
  expect(r.ok).toBe(true);
  if (!r.ok) return [];
  return r.hunks.filter((h) => !h.equal).map((h) => [h.aText, h.bText]);
}

/** 相同片段（固定保留）按顺序拼出的文本。 */
function equalText(a: string, b: string): string {
  const r = planMix(a, b);
  if (!r.ok) return '';
  return r.hunks.filter((h) => h.equal).map((h) => h.aText).join('');
}

describe('planMix 基础分段', () => {
  it('完全相同：只有一个相同片段，无差异段', () => {
    const r = planMix('你好世界', '你好世界');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diffCount).toBe(0);
    expect(r.hunks).toEqual([{ equal: true, aText: '你好世界', bText: '你好世界' }]);
  });

  it('B 单侧插入：差异段 A 为空、B 为插入内容', () => {
    expect(diffPairs('你好世界', '你好呀世界')).toEqual([['', '呀']]);
    expect(equalText('你好世界', '你好呀世界')).toBe('你好世界');
  });

  it('A 单侧插入（B 缺失）：差异段 B 为空', () => {
    expect(diffPairs('你好呀世界', '你好世界')).toEqual([['呀', '']]);
  });

  it('相邻插入与删除合并为同一替换段', () => {
    const pairs = diffPairs('今天天气很好', '今天心情很好');
    expect(pairs).toEqual([['天气', '心情']]);
  });

  it('多段差异与相同片段交替', () => {
    const pairs = diffPairs('甲乙丙丁', '甲X丙Y');
    expect(pairs).toEqual([
      ['乙', 'X'],
      ['丁', 'Y'],
    ]);
    expect(equalText('甲乙丙丁', '甲X丙Y')).toBe('甲丙');
  });

  it('单侧文本为空时整体是一个差异段', () => {
    const r1 = planMix('', '新增');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.hunks).toEqual([{ equal: false, aText: '', bText: '新增' }]);
    const r2 = planMix('原有', '');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.hunks).toEqual([{ equal: false, aText: '原有', bText: '' }]);
  });

  it('按 Unicode 字素（emoji 组合序列）对齐，而不是按 UTF-16 码元', () => {
    const a = '嗨👋走';
    const b = '嗨👋走走';
    expect(diffPairs(a, b)).toEqual([['', '走']]);
  });
});

describe('LCS 多最优路径固定（匹配位置字典序：先 A 后 B）', () => {
  it('重复词不使边界漂移：A=ab B=ba 固定为插 b、匹配 a、删 b', () => {
    const r = planMix('ab', 'ba');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 两条最优 LCS（匹配 a 或匹配 b）。先比匹配到的 A 下标：匹配 a（下标 0）
    // 字典序更小，故规范路径固定为 [插 b][equal 'a'][删 b]
    expect(r.hunks.map((h) => [h.equal, h.aText, h.bText])).toEqual([
      [false, '', 'b'],
      [true, 'a', 'a'],
      [false, 'b', ''],
    ]);
  });

  it('同一句重复词的多种 LCS 取确定的同一条', () => {
    // "的" 重复出现：插入点可能匹配前一个或后一个"的"，规范路径必须稳定
    const r1 = planMix('红色的苹果的味道', '红色的的苹果的味道');
    const r2 = planMix('红色的苹果的味道', '红色的的苹果的味道');
    expect(r1).toEqual(r2);
    expect(r1.ok && r1.diffCount).toBe(1);
    if (r1.ok) {
      expect(r1.hunks.filter((h) => !h.equal)).toEqual([{ equal: false, aText: '', bText: '的' }]);
      // 固定匹配前缀（A 匹配位置最小）：插入的"的"在第一个"的"之后
      expect(r1.hunks[0]).toEqual({ equal: true, aText: '红色的', bText: '红色的' });
    }
  });

  it('同一段输入两次计算结果严格一致（无随机边界）', () => {
    const a = 'the quick brown fox and the quick dog';
    const b = 'the slow brown fox or the quick cat';
    expect(planMix(a, b)).toEqual(planMix(a, b));
  });
});

describe('renderMix 与默认选择', () => {
  it('默认选择：优先 A，纯 B 插入段取 B，保证默认结果不丢字', () => {
    const r = planMix('你好世界', '你好呀世界');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(defaultMixChoices(r.hunks)).toEqual(['B']); // 纯插入段默认 B
    expect(renderMix(r.hunks, ['B'])).toBe('你好呀世界');
    expect(renderMix(r.hunks, ['A'])).toBe('你好世界');
  });

  it('替换段默认取 A', () => {
    const r = planMix('天气', '心情');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(defaultMixChoices(r.hunks)).toEqual(['A']);
    expect(renderMix(r.hunks, ['A'])).toBe('天气');
    expect(renderMix(r.hunks, ['B'])).toBe('心情');
  });

  it('逐段选择拼接：多段差异各自独立', () => {
    const r = planMix('甲乙丙丁', '甲X丙Y');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renderMix(r.hunks, ['B', 'A'])).toBe('甲X丙丁');
    expect(renderMix(r.hunks, ['A', 'B'])).toBe('甲乙丙Y');
    expect(renderMix(r.hunks, ['B', 'B'])).toBe('甲X丙Y');
    expect(renderMix(r.hunks, ['A', 'A'])).toBe('甲乙丙丁');
  });

  it('保留跨行文本中的换行（字素序列含 \\n）', () => {
    const r = planMix('第一行\n第二行', '第一行\n第二行\n第三行');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renderMix(r.hunks, defaultMixChoices(r.hunks))).toBe('第一行\n第二行\n第三行');
  });
});

describe('上限保护', () => {
  it('两侧字素数乘积超限时返回 too-large', () => {
    const side = Math.ceil(Math.sqrt(MAX_MIX_CELLS)) + 10;
    const a = 'a'.repeat(side);
    const b = 'a'.repeat(side);
    const r = planMix(a, b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-large');
  });
});
