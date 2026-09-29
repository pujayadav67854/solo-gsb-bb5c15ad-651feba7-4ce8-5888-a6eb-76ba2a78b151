import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocatePanel } from '../../components/LocatePanel';
import type { MergedCue } from '../merge';
import { buildLocateIndex, searchPhrases } from '../locate';

const noop = () => {};

function renderPanel(cues: MergedCue[], phrase: string, gap = '0') {
  const index = buildLocateIndex(cues);
  const result = searchPhrases(index, phrase, gap);
  const html = renderToString(
    <LocatePanel
      sourceCount={cues.length}
      index={index}
      phraseText={phrase}
      onPhraseText={noop}
      gapText={gap}
      onGapText={noop}
      result={result}
    />,
  ).replace(/<!-- -->/g, '');
  return html;
}

const cues: MergedCue[] = [
  { start: 0, end: 1000, text: '你好世界', groupIndex: 0 },
  { start: 1200, end: 2000, text: '再见朋友', groupIndex: 1 },
];

describe('LocatePanel 渲染冒烟', () => {
  it('展示短语输入、间隔输入与逐条命中高亮', () => {
    const html = renderPanel(cues, '世界再见', '200');
    expect(html).toContain('原文短语');
    expect(html).toContain('允许跨条最大间隔');
    expect(html).toContain('命中 1 处');
    expect(html).toContain('条目 1 – 2（跨 2 条）');
    expect(html).toContain('00:00:00,000 → 00:00:02,000');
    expect(html).toContain('<mark>世界</mark>');
    expect(html).toContain('<mark>再见</mark>');
    expect(html).toContain('间隔 200 毫秒');
  });

  it('跨条超阈时提示无命中', () => {
    const html = renderPanel(cues, '世界再见', '100');
    expect(html).toContain('未在最终字幕中找到该短语');
  });

  it('空短语说明原因并清空命中', () => {
    const html = renderPanel(cues, '', '0');
    expect(html).toContain('短语为空');
    expect(html).toContain('命中已清空');
  });

  it('间隔无效时说明原因并清空命中', () => {
    const html = renderPanel(cues, '世界', 'abc');
    expect(html).toContain('非负整数毫秒');
    expect(html).toContain('命中已清空');
  });

  it('上游为空时提示', () => {
    const html = renderPanel([], '甲乙', '0');
    expect(html).toContain('上游结果为空');
  });
});
