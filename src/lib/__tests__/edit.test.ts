import { describe, expect, it } from 'vitest';
import type { MergedCue } from '../merge';
import {
  buildEditedCues,
  buildSegmentSpans,
  editedTotalDuration,
  parseSegments,
} from '../edit';

function cue(start: number, end: number, text: string, groupIndex = 0): MergedCue {
  return { start, end, text, groupIndex };
}

describe('parseSegments 片段列表解析', () => {
  it('每行两个非负整数，保持填写顺序，行号为物理行', () => {
    const r = parseSegments('5000 12000\n\n20000,26500\n  0 \t 1000  \n');
    expect(r.invalid).toEqual([]);
    expect(r.totalLines).toBe(3);
    expect(r.segments.map((s) => [s.start, s.end])).toEqual([
      [5000, 12000],
      [20000, 26500],
      [0, 1000],
    ]);
    expect(r.segments.map((s) => s.line)).toEqual([1, 3, 4]);
  });

  it('兼容多种分隔符（空格/Tab/逗号/分号/中文标点/箭头/波浪号）', () => {
    const r = parseSegments('100,200\n300，400\n500;600\n700；800\n900-->1000\n1100 ~ 1200');
    expect(r.invalid).toEqual([]);
    expect(r.segments.map((s) => [s.start, s.end])).toEqual([
      [100, 200],
      [300, 400],
      [500, 600],
      [700, 800],
      [900, 1000],
      [1100, 1200],
    ]);
  });

  it('允许重复与倒序片段（不排序、不去重）', () => {
    const r = parseSegments('9000 10000\n1000 2000\n9000 10000\n5000 6000');
    expect(r.invalid).toEqual([]);
    expect(r.segments.map((s) => s.start)).toEqual([9000, 1000, 9000, 5000]);
  });

  it('格式错误标出行号与原因', () => {
    const text = '1000 2000\nabc 2000\n3000\n1000 500 600\n-100 200\n3000 3000\n4000 3000';
    const r = parseSegments(text);
    expect(r.segments).toHaveLength(1);
    expect(r.invalid.map((b) => b.line)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(r.totalLines).toBe(7);
  });

  it('不接受小数、加号、前导加号与十六进制写法', () => {
    const r = parseSegments('1.5 2.5\n+1 2\n1e3 2000');
    expect(r.segments).toEqual([]);
    expect(r.invalid.map((b) => b.line)).toEqual([1, 2, 3]);
  });

  it('空文本', () => {
    const r = parseSegments('');
    expect(r.segments).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.totalLines).toBe(0);
  });
});

describe('buildEditedCues 裁切重排', () => {
  const cues: MergedCue[] = [
    cue(0, 1000, 'A'),
    cue(1000, 3000, 'B'),
    cue(5000, 7000, 'C'),
    cue(7000, 9000, 'D'),
  ];

  it('基本拼接：减片段起点、加此前片段总时长，文本原样复制', () => {
    const r = parseSegments('0 2000\n5000 9000');
    const out = buildEditedCues(cues, r.segments);
    // 片段1 [0,2000): A 全量、B 前半
    // 片段2 [5000,9000) 落在成片 2000 起：C、D 平移
    expect(out.map((c) => [c.start, c.end])).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 4000],
      [4000, 6000],
    ]);
    expect(out.map((c) => c.text)).toEqual(['A', 'B', 'C', 'D']);
    expect(out.map((c) => c.segIndex)).toEqual([0, 0, 1, 1]);
    expect(out.map((c) => c.segLine)).toEqual([1, 1, 2, 2]);
  });

  it('半开区间：相切（end==start）不产生交集，仅保留正时长', () => {
    const r = parseSegments('1000 3000\n3000 5000');
    const out = buildEditedCues(cues, r.segments);
    // 片段1 命中 B；片段2 与 B 仅在 3000 点相切、与 C 在 5000 点相切，均丢弃
    expect(out.map((c) => [c.start, c.end, c.text])).toEqual([[0, 2000, 'B']]);
  });

  it('字幕跨越多个片段：在每个命中片段分别输出', () => {
    const long: MergedCue[] = [cue(1000, 5000, '长字幕')];
    const r = parseSegments('0 2000\n2000 4000\n4000 6000');
    const out = buildEditedCues(long, r.segments);
    expect(out.map((c) => [c.start, c.end])).toEqual([
      [1000, 2000],
      [2000, 4000],
      [4000, 5000],
    ]);
    expect(out.every((c) => c.text === '长字幕')).toBe(true);
  });

  it('重复片段重复输出', () => {
    const r = parseSegments('0 1000\n0 1000');
    const out = buildEditedCues(cues, r.segments);
    expect(out).toHaveLength(2);
    expect(out.map((c) => [c.start, c.end, c.text, c.segIndex])).toEqual([
      [0, 1000, 'A', 0],
      [1000, 2000, 'A', 1],
    ]);
  });

  it('倒序片段按行序拼接，不重排', () => {
    const r = parseSegments('7000 9000\n0 1000');
    const out = buildEditedCues(cues, r.segments);
    expect(out.map((c) => [c.start, c.end, c.text])).toEqual([
      [0, 2000, 'D'],
      [2000, 3000, 'A'],
    ]);
  });

  it('空白片段仍占时长（后续片段继续偏移）', () => {
    const r = parseSegments('90000 91000\n0 1000');
    const out = buildEditedCues(cues, r.segments);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: 1000, end: 2000, text: 'A' });
    const spans = buildSegmentSpans(r.segments, out);
    expect(spans.map((s) => [s.outStart, s.outEnd, s.hits])).toEqual([
      [0, 1000, 0],
      [1000, 2000, 1],
    ]);
  });

  it('不合并相邻同文字幕', () => {
    const dup: MergedCue[] = [cue(0, 1000, '同'), cue(1000, 2000, '同')];
    const r = parseSegments('0 2000');
    const out = buildEditedCues(dup, r.segments);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.text)).toEqual(['同', '同']);
  });

  it('重叠片段各自独立求交输出', () => {
    const r = parseSegments('0 3000\n2000 5000');
    const out = buildEditedCues(cues, r.segments);
    // 片段1：A、B；片段2：B[2000,3000]、无 C（C 从 5000 起，切点不算）
    expect(out.map((c) => [c.start, c.end, c.text, c.segIndex])).toEqual([
      [0, 1000, 'A', 0],
      [1000, 3000, 'B', 0],
      [3000, 4000, 'B', 1],
    ]);
  });

  it('成片总时长 = 各片段原时长之和', () => {
    const r = parseSegments('0 1000\n5000 7500\n9000 9001');
    expect(editedTotalDuration(r.segments)).toBe(3501);
  });

  it('无片段或无字幕时结果为空', () => {
    expect(buildEditedCues(cues, [])).toEqual([]);
    const r = parseSegments('0 1000');
    expect(buildEditedCues([], r.segments)).toEqual([]);
  });
});
