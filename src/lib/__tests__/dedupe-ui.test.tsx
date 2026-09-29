import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DedupePanel } from '../../components/DedupePanel';
import type { MergedCue } from '../merge';
import { findScrollChains } from '../scroll';

const noop = () => {};
const OPTS = { maxGapMs: 1000, minOverlap: 2 };

function renderPanel(cues: MergedCue[], accepted: ReadonlySet<string> = new Set()) {
  return renderToString(
    <DedupePanel
      cues={cues}
      options={OPTS}
      onOptions={noop}
      accepted={accepted}
      onAccept={noop}
      onRestore={noop}
      onAcceptAll={noop}
      onRestoreAll={noop}
    />,
  );
}

const SCROLL_CUES: MergedCue[] = [
  { start: 0, end: 2000, text: '你好世界', groupIndex: 0 },
  { start: 2100, end: 4000, text: '世界你好', groupIndex: 1 },
];

describe('DedupePanel 渲染冒烟', () => {
  it('识别链并展示待采纳入口、成员与合并文本', () => {
    const html = renderPanel(SCROLL_CUES);
    expect(html).toContain('最大相邻间隔');
    expect(html).toContain('最小文本重叠');
    expect(html).toContain('识别出');
    expect(html).toContain('条滚动链');
    expect(html).toContain('待采纳');
    expect(html).toContain('全部采纳');
    expect(html).toContain('合并文本');
    expect(html).toContain('你好世界你好');
  });

  it('已采纳链显示“已采纳”与恢复入口', () => {
    const key = findScrollChains(SCROLL_CUES, OPTS)[0].key;
    const html = renderPanel(SCROLL_CUES, new Set([key]));
    expect(html).toContain('>已采纳</span>');
    expect(html).toContain('恢复');
    expect(html).toContain('已节省');
  });

  it('链内容变化后旧采纳 key 不再生效：显示待采纳，不计入已采纳', () => {
    // 采纳时的链方案（第二组文本为“世界你好”）
    const staleKey = findScrollChains(SCROLL_CUES, OPTS)[0].key;
    // 改动其中一组文本后，链仍存在但重叠与合并文本已变
    const changed: MergedCue[] = [
      { start: 0, end: 2000, text: '你好世界', groupIndex: 0 },
      { start: 2100, end: 4000, text: '世界你好吗', groupIndex: 1 },
    ];
    const html = renderPanel(changed, new Set([staleKey]));
    expect(html).toContain('>待采纳</span>');
    expect(html).not.toContain('>已采纳</span>');
    expect(html).not.toContain('已节省');
    // 变化后的链可重新采纳
    expect(html).toContain('>采纳</button>');
  });
});
