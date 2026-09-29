import { describe, expect, it } from 'vitest';
import type { MergedCue } from '../merge';
import {
  buildLocateIndex,
  cueSegments,
  locatePhrase,
  parseMaxGap,
  searchPhrases,
} from '../locate';

function cue(start: number, end: number, text: string, groupIndex = 0): MergedCue {
  return { start, end, text, groupIndex };
}

const plain = (segs: { text: string; hit: boolean }[]) => segs.map((s) => s.text).join('');

describe('parseMaxGap 间隔解析', () => {
  it('接受非负整数（含 0）', () => {
    expect(parseMaxGap('0')).toEqual({ value: 0, message: null });
    expect(parseMaxGap('500')).toEqual({ value: 500, message: null });
    expect(parseMaxGap('  1000 ')).toEqual({ value: 1000, message: null });
  });

  it('拒绝空串、小数、负数、非数字、前导零', () => {
    expect(parseMaxGap('').value).toBeNull();
    expect(parseMaxGap('   ').value).toBeNull();
    expect(parseMaxGap('1.5').value).toBeNull();
    expect(parseMaxGap('-1').value).toBeNull();
    expect(parseMaxGap('abc').value).toBeNull();
    expect(parseMaxGap('01').value).toBeNull();
    expect(parseMaxGap('1e3').value).toBeNull();
  });
});

describe('locatePhrase 单条内匹配', () => {
  it('区分大小写、标点与空格必须逐字相同', () => {
    const idx = buildLocateIndex([cue(0, 1000, 'Hello, world! Hello。')]);
    expect(locatePhrase(idx, 'Hello', 0)).toHaveLength(2);
    expect(locatePhrase(idx, 'hello', 0)).toHaveLength(0);
    expect(locatePhrase(idx, 'Hello, world', 0)).toHaveLength(1);
    expect(locatePhrase(idx, 'Hello,world', 0)).toHaveLength(0);
    expect(locatePhrase(idx, 'Hello, world! Hello。', 0)).toHaveLength(1);
  });

  it('重复与重叠出现全部列出，按出现顺序', () => {
    const idx = buildLocateIndex([cue(0, 1000, 'aaaa')]);
    const hits = locatePhrase(idx, 'aa', 0);
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => [h.startCue, h.endCue])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it('Unicode 字素簇作为不可拆整体', () => {
    const family = '👨‍👩‍👧';
    const idx = buildLocateIndex([cue(0, 1000, `一个${family}和${family}`)]);
    const hits = locatePhrase(idx, family, 0);
    expect(hits).toHaveLength(2);
    // é = e + U+0301 是一个字素
    const idx2 = buildLocateIndex([cue(0, 1000, 'éé')]);
    expect(locatePhrase(idx2, 'é', 0)).toHaveLength(2);
  });

  it('标签与换行不参与匹配但在分段中原样保留', () => {
    const idx = buildLocateIndex([cue(0, 1000, '<i>abc</i>')]);
    const hits = locatePhrase(idx, 'abc', 0);
    expect(hits).toHaveLength(1);
    const cue0 = idx.cues[0];
    const part = hits[0].parts[0];
    const segs = cueSegments(cue0, part.atomStart, part.atomEnd);
    expect(plain(segs)).toBe('<i>abc</i>');
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['abc']);
  });

  it('短语可跨越空标签与换行命中，跳过段原位保留', () => {
    const idx = buildLocateIndex([cue(0, 1000, 'a<i></i>b\nc')]);
    const hits = locatePhrase(idx, 'abc', 0);
    expect(hits).toHaveLength(1);
    const part = hits[0].parts[0];
    const segs = cueSegments(idx.cues[0], part.atomStart, part.atomEnd);
    expect(plain(segs)).toBe('a<i></i>b\nc');
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['a', 'b', 'c']);
  });

  it('标签之间夹了其他字则匹配被打断', () => {
    const idx = buildLocateIndex([cue(0, 1000, 'a<i>x</i>b')]);
    expect(locatePhrase(idx, 'ab', 0)).toHaveLength(0);
  });

  it('换行在短语侧按字面量处理：短语含换行无法在单条内命中', () => {
    const idx = buildLocateIndex([cue(0, 1000, '甲乙')]);
    expect(locatePhrase(idx, '甲\n乙', 0)).toHaveLength(0);
    expect(locatePhrase(idx, '甲乙', 0)).toHaveLength(1);
  });

  it('孤立的尖括号按普通字符匹配', () => {
    const idx = buildLocateIndex([cue(0, 1000, 'x a<b y')]);
    expect(locatePhrase(idx, 'a<b', 0)).toHaveLength(1);
  });
});

describe('locatePhrase 跨相邻条目', () => {
  const cues = [
    cue(0, 1000, '你好世界'),
    cue(1200, 2000, '再见朋友'),
    cue(2500, 3000, '最终章'),
  ];

  it('间隔在阈值内可跨条，超过阈值中断', () => {
    const idx = buildLocateIndex(cues);
    // 条1结束1000 → 条2开始1200 = 200
    let hits = locatePhrase(idx, '世界再见', 200);
    expect(hits).toHaveLength(1);
    expect(hits[0].startCue).toBe(0);
    expect(hits[0].endCue).toBe(1);
    expect(hits[0].start).toBe(0);
    expect(hits[0].end).toBe(2000);
    expect(hits[0].parts.map((p) => p.cueIndex)).toEqual([0, 1]);

    hits = locatePhrase(idx, '世界再见', 199);
    expect(hits).toHaveLength(0);
  });

  it('恰等于阈值允许跨越', () => {
    const idx = buildLocateIndex(cues);
    expect(locatePhrase(idx, '世界再见', 200)).toHaveLength(1);
  });

  it('连续跨多条：沿途任一跳超阈即中断', () => {
    const idx = buildLocateIndex(cues);
    // 间隔 200 与 500
    expect(locatePhrase(idx, '世界再见朋友最终', 500)).toHaveLength(1);
    expect(locatePhrase(idx, '世界再见朋友最终', 499)).toHaveLength(0);
  });

  it('阈值 0：仅首尾相接可跨', () => {
    const idx = buildLocateIndex([cue(0, 1000, '甲'), cue(1000, 2000, '乙')]);
    const hits = locatePhrase(idx, '甲乙', 0);
    expect(hits).toHaveLength(1);
    expect(hits[0].parts).toHaveLength(2);
  });

  it('穿过只有标签/换行的空条目时逐跳检查间隔', () => {
    const cs = [
      cue(0, 1000, '甲'),
      cue(1200, 2000, '<i></i>\n'),
      cue(2200, 3000, '乙'),
    ];
    const idx = buildLocateIndex(cs);
    // 两跳间隔各为 200；阈值 200 可穿，199 第一跳即断
    expect(locatePhrase(idx, '甲乙', 200)).toHaveLength(1);
    expect(locatePhrase(idx, '甲乙', 199)).toHaveLength(0);
    const hit = locatePhrase(idx, '甲乙', 200)[0];
    expect(hit.parts.map((p) => p.cueIndex)).toEqual([0, 2]);
  });

  it('穿过空字符串条目同理逐跳检查', () => {
    const cs = [cue(0, 1000, '甲'), cue(1100, 2000, ''), cue(2000, 3000, '乙')];
    const idx = buildLocateIndex(cs);
    expect(locatePhrase(idx, '甲乙', 100)).toHaveLength(1);
    expect(locatePhrase(idx, '甲乙', 99)).toHaveLength(0);
  });

  it('各条命中部分给出各自时间与原子范围', () => {
    const idx = buildLocateIndex(cues);
    const hit = locatePhrase(idx, '界再', 200)[0];
    expect(hit.parts).toHaveLength(2);
    expect(hit.parts[0]).toMatchObject({ cueIndex: 0, start: 0, end: 1000 });
    expect(hit.parts[1]).toMatchObject({ cueIndex: 1, start: 1200, end: 2000 });
    expect(cueSegments(idx.cues[0], hit.parts[0].atomStart, hit.parts[0].atomEnd).filter((s) => s.hit).map((s) => s.text)).toEqual(['界']);
    expect(cueSegments(idx.cues[1], hit.parts[1].atomStart, hit.parts[1].atomEnd).filter((s) => s.hit).map((s) => s.text)).toEqual(['再']);
  });
});

describe('cueSegments 高亮分段', () => {
  it('原子覆盖整条文本，未命中部分与跳过段均不标记', () => {
    const idx = buildLocateIndex([cue(0, 1000, 'x<i>y</i>abz')]);
    // 命中 ab
    const hit = locatePhrase(idx, 'ab', 0)[0];
    const segs = cueSegments(idx.cues[0], hit.parts[0].atomStart, hit.parts[0].atomEnd);
    expect(plain(segs)).toBe('x<i>y</i>abz');
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['ab']);
  });
});

describe('searchPhrases 输入校验与即时清空', () => {
  const idx = buildLocateIndex([cue(0, 1000, '因特网')]);

  it('短语为空：错误原因且无命中', () => {
    const r = searchPhrases(idx, '', '0');
    expect(r.error?.kind).toBe('empty-phrase');
    expect(r.hits).toEqual([]);
  });

  it('间隔无效：错误原因且无命中', () => {
    expect(searchPhrases(idx, '因特网', '').error?.kind).toBe('bad-gap');
    expect(searchPhrases(idx, '因特网', '-1').error?.kind).toBe('bad-gap');
    expect(searchPhrases(idx, '因特网', '1.5').error?.kind).toBe('bad-gap');
    for (const r of [searchPhrases(idx, '因特网', ''), searchPhrases(idx, '因特网', '-1')]) {
      expect(r.hits).toEqual([]);
    }
  });

  it('间隔阈值改变后旧命中即时重算（500 命中、10 不命中）', () => {
    const cs = [cue(0, 1000, '甲'), cue(1500, 2000, '乙')];
    const i = buildLocateIndex(cs);
    expect(searchPhrases(i, '甲乙', '500').hits).toHaveLength(1);
    expect(searchPhrases(i, '甲乙', '10').hits).toHaveLength(0);
  });

  it('去 BOM、兼容 CRLF，但不 trim、不归一空白', () => {
    // 开头 BOM 被剥离后命中
    expect(searchPhrases(idx, '\uFEFF因特网', '0').hits).toHaveLength(1);
    // 字幕侧换行（parseSrt 已统一为 \n）不参与匹配
    const nl = buildLocateIndex([cue(0, 1000, '因特\n网')]);
    expect(searchPhrases(nl, '因特网', '0').hits).toHaveLength(1);
    // 不 trim：两侧空格属于短语
    expect(searchPhrases(idx, ' 因特网 ', '0').hits).toHaveLength(0);
  });

  it('上游 finalCues 改变：以新索引重算', () => {
    const i1 = buildLocateIndex([cue(0, 1000, '旧文本')]);
    const i2 = buildLocateIndex([cue(0, 1000, '新文本')]);
    expect(searchPhrases(i1, '新文本', '0').hits).toHaveLength(0);
    expect(searchPhrases(i2, '新文本', '0').hits).toHaveLength(1);
  });

  it('空短语优先于间隔错误报告', () => {
    expect(searchPhrases(idx, '', 'x').error?.kind).toBe('empty-phrase');
  });
});
