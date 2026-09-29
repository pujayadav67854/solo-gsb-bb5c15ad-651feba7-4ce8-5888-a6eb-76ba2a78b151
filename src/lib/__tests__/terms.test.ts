import { describe, expect, it } from 'vitest';
import type { MergedCue } from '../merge';
import { normalizeCues, normalizeText, parseTerms } from '../terms';

function cue(start: number, end: number, text: string, groupIndex = 0): MergedCue {
  return { start, end, text, groupIndex };
}

describe('parseTerms 术语表解析', () => {
  it('每行用 Tab 分隔原词与替换词，保留两侧空格（不 trim、不改大小写）', () => {
    const r = parseTerms('因特网\t互联网\n WiFi \t Wi-Fi \n');
    expect(r.invalid).toEqual([]);
    expect(r.totalLines).toBe(2);
    expect(r.rules).toEqual([
      { from: '因特网', to: '互联网', line: 1 },
      { from: ' WiFi ', to: ' Wi-Fi ', line: 2 },
    ]);
  });

  it('空行忽略，物理行号与文本框一致', () => {
    const r = parseTerms('a\tA\n\nb\tB\n');
    expect(r.invalid).toEqual([]);
    expect(r.rules.map((x) => x.line)).toEqual([1, 3]);
    expect(r.totalLines).toBe(2);
  });

  it('去 BOM、兼容 CRLF', () => {
    const r = parseTerms('﻿a\tA\r\nb\tB\r\n');
    expect(r.invalid).toEqual([]);
    expect(r.rules.map((x) => [x.from, x.to])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
  });

  it('列数错误逐行提示（少于或多于两列）', () => {
    const r = parseTerms('只有原词\na\tA\nb\tB\tC\tD');
    expect(r.rules.map((x) => x.line)).toEqual([2]);
    expect(r.invalid.map((b) => b.line)).toEqual([1, 3]);
    expect(r.invalid[0].reason).toContain('两列');
    expect(r.invalid[1].reason).toContain('两列');
  });

  it('仅以 Tab 分列：空格与逗号不分列', () => {
    const r = parseTerms('a b\tA B\nx,y\tX,Y');
    expect(r.invalid).toEqual([]);
    expect(r.rules.map((x) => [x.from, x.to])).toEqual([
      ['a b', 'A B'],
      ['x,y', 'X,Y'],
    ]);
  });

  it('空列报错（前空 / 后空 / Tab 两侧皆空）', () => {
    const r = parseTerms('\tX\na\t\n\t\nx\tX');
    expect(r.rules.map((x) => x.line)).toEqual([4]);
    expect(r.invalid.map((b) => b.line)).toEqual([1, 2, 3]);
  });

  it('原词或替换词含标签报错', () => {
    const r = parseTerms('<i>a</i>\tA\nb\t<b>B</b>\nc\tC');
    expect(r.rules.map((x) => x.line)).toEqual([3]);
    expect(r.invalid.map((b) => b.line)).toEqual([1, 2]);
  });

  it('重复原词：保留首行、后续逐行提示且不覆盖', () => {
    const r = parseTerms('a\tA\nb\tB\na\tAA');
    expect(r.rules).toEqual([
      { from: 'a', to: 'A', line: 1 },
      { from: 'b', to: 'B', line: 2 },
    ]);
    expect(r.invalid.map((b) => b.line)).toEqual([3]);
    expect(r.invalid[0].reason).toContain('第 1 行');
  });

  it('空文本', () => {
    const r = parseTerms('');
    expect(r).toEqual({ rules: [], invalid: [], totalLines: 0 });
  });
});

describe('normalizeText 匹配与替换', () => {
  const rules = (text: string) => parseTerms(text).rules;

  it('基本替换：命中处替换、其余原样', () => {
    const rs = rules('因特网\t互联网');
    expect(normalizeText('使用因特网冲浪', rs).out).toBe('使用互联网冲浪');
  });

  it('区分大小写', () => {
    const rs = rules('WiFi\t无线网络');
    const r = normalizeText('WiFi 和 WIFI 与 wifi', rs);
    expect(r.out).toBe('无线网络 和 WIFI 与 wifi');
    expect(r.hits).toHaveLength(1);
  });

  it('按字面量匹配：标点与空白不做归一', () => {
    const rs = rules('a b\tab');
    expect(normalizeText('xa bx和a  b', rs).out).toBe('xabx和a  b');
  });

  it('自左向右取当前起点最长原词', () => {
    const rs = rules('abc\tX\nabcd\tY');
    expect(normalizeText('abcdabc', rs).out).toBe('YX');
  });

  it('命中后整段越过：替换内容不再参与匹配，不重叠不嵌套', () => {
    // 替换词恰好等于另一规则原词，也不会再次替换
    const rs = rules('ab\tbc\nbc\tZZ');
    const r = normalizeText('ab', rs);
    expect(r.out).toBe('bc');
    expect(r.hits.map((h) => h.from)).toEqual(['ab']);
  });

  it('同一原词相邻多次出现分别命中', () => {
    const rs = rules('aa\tX');
    const r = normalizeText('aaaa', rs);
    expect(r.out).toBe('XX');
    expect(r.hits).toHaveLength(2);
  });

  it('未命中时原样输出（结果严格相等）', () => {
    const rs = rules('xyz\tX');
    const s = '没有任何命中的文本 ABC 123';
    expect(normalizeText(s, rs).out).toBe(s);
    expect(normalizeText(s, rs).hits).toEqual([]);
  });

  it('Unicode 字素簇整体匹配，不拆代理对与组合序列', () => {
    // 👨‍👩‍👧 是多码点 ZWJ 字素；é = e + U+0301
    const family = '👨‍👩‍👧';
    const rs = rules(`${family}\t家人`).concat(parseTerms('é\tE').rules);
    const r = normalizeText(`一个${family}与é`, rs);
    expect(r.out).toBe('一个家人与E');
  });

  it('标签本身不参与匹配但原样保留；标签之间的文本仍是普通文本', () => {
    const rs = rules('ab\tXY');
    // <i> 与 </i> 是被跳过的标签；其间的 ab 是普通文本，照常命中
    expect(normalizeText('<i>ab</i>ab', rs).out).toBe('<i>XY</i>XY');
    // 标签之间夹了其他文本 x：字面序列 a,x,b 不构成连续匹配
    expect(normalizeText('a<i>x</i>b', rs).out).toBe('a<i>x</i>b');
  });

  it('原词可跨越空标签与换行命中，标签与换行原位保留', () => {
    const rs = rules('abc\tX');
    const r = normalizeText('a<i></i>b\nc', rs);
    expect(r.out).toBe('X<i></i>\n');
    expect(r.hits.map((h) => h.line)).toEqual([1]);
  });

  it('跨空标签命中时段内标签保留、命中字素删除', () => {
    const rs = rules('abcd\tZ');
    // a <i></i> b c d：空标签不提供匹配字素，abcd 跨标签命中；
    // 首字素 a 处置换为 Z，bcd 删除，空标签 <i></i> 原位保留
    expect(normalizeText('a<i></i>bcd', rs).out).toBe('Z<i></i>');
    // 标签之间若有别的文本 x，则 abcd 的字面序列被打断，不命中
    expect(normalizeText('a<i>x</i>bcd', rs).out).toBe('a<i>x</i>bcd');
  });

  it('换行不参与匹配但原样保留', () => {
    const rs = rules('甲乙\tX');
    expect(normalizeText('甲\n乙', rs).out).toBe('X\n');
  });

  it('孤立的 < 与 > 按普通字符处理', () => {
    const rs = rules('a<b\tX');
    const r = normalizeText('x a<b y', rs);
    expect(r.out).toBe('x X y');
  });

  it('命中记录含行号与原词/替换词', () => {
    const rs = rules('a\tA\nb\tB');
    const r = normalizeText('a和b再a', rs);
    expect(r.hits).toEqual([
      { from: 'a', to: 'A', line: 1 },
      { from: 'b', to: 'B', line: 2 },
      { from: 'a', to: 'A', line: 1 },
    ]);
  });

  it('替换词比原词长 / 短时输出正确（插入与删除）', () => {
    const rs = rules('a\t更长的替换\n短词\tX');
    expect(normalizeText('xa', rs).out).toBe('x更长的替换');
    expect(normalizeText('x短词y', rs).out).toBe('xXy');
  });
});

describe('normalizeCues 规范化副本', () => {
  it('时间、顺序、条数与上游完全一致，仅文本变化', () => {
    const cues = [
      cue(0, 1000, '因特网'),
      cue(1000, 2000, '不涉及术语\n第二行'),
      cue(2000, 3000, '<i>因特网</i>因特网'),
    ];
    const rs = parseTerms('因特网\t互联网').rules;
    const out = normalizeCues(cues, rs);
    expect(out.map((c) => [c.start, c.end])).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
    ]);
    expect(out[0].after).toBe('互联网');
    expect(out[1].after).toBe('不涉及术语\n第二行');
    expect(out[2].after).toBe('<i>互联网</i>互联网');
    expect(out[2].hits).toHaveLength(2);
    expect(out[0].before).toBe('因特网');
    expect(out[0].hits).toHaveLength(1);
    expect(out[1].hits).toHaveLength(0);
  });

  it('无规则时所有条目原样返回', () => {
    const cues = [cue(0, 10, 'abc'), cue(10, 20, 'def')];
    const out = normalizeCues(cues, []);
    expect(out.map((c) => c.after)).toEqual(['abc', 'def']);
    expect(out.every((c) => c.hits.length === 0)).toBe(true);
  });

  it('空输入返回空数组', () => {
    expect(normalizeCues([], parseTerms('a\tb').rules)).toEqual([]);
  });
});
