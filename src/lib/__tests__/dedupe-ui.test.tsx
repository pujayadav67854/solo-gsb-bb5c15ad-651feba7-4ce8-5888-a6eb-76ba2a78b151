import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DedupePanel } from '../../components/DedupePanel';
import type { MergedCue } from '../merge';
import { findScrollChains, type ScrollChain, type ScrollOptions } from '../scroll';

const OPTS: ScrollOptions = { maxGapMs: 1000, minOverlap: 2 };
const noop = () => {};

function cuesOf(texts: string[]): MergedCue[] {
  return texts.map((t, i) => ({ start: i * 2100, end: i * 2100 + 2000, text: t, groupIndex: i }));
}

function renderPanel(cues: MergedCue[], accepted: ReadonlyMap<string, string>) {
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

const acceptOf = (chains: ScrollChain[]) =>
  new Map(chains.map((c) => [c.key, c.signature] as const));

describe('DedupePanel 采纳状态与链方案绑定', () => {
  it('指纹与当前链一致时显示已采纳与恢复入口', () => {
    const cues = cuesOf(['你好世界', '世界再见']);
    const chains = findScrollChains(cues, OPTS);
    const html = renderPanel(cues, acceptOf(chains));
    expect(html).toContain('dedup-entry applied');
    expect(html).toContain('<span class="tag ok">已采纳</span>');
    expect(html).toContain('恢复');
    expect(html).not.toContain('dedup-entry ready');
  });

  it('组序号相同但文本改选（指纹过期）时显示待采纳，不把新合并文本标成已采纳', () => {
    const before = cuesOf(['你好世界', '世界再见']);
    const old = findScrollChains(before, OPTS)[0];

    // 改选第二组文本：链 key 相同、合并文本变化
    const after = cuesOf(['你好世界', '世界明天见']);
    const now = findScrollChains(after, OPTS)[0];
    expect(now.key).toBe(old.key);
    expect(now.signature).not.toBe(old.signature);

    const html = renderPanel(after, new Map([[old.key, old.signature]]));
    expect(html).toContain('dedup-entry ready');
    expect(html).toContain('<span class="tag go">待采纳</span>');
    expect(html).toContain('>采纳</button>');
    expect(html).not.toContain('dedup-entry applied');
    // 新方案的合并文本照常展示供确认，但没有“已采纳”高亮态
    expect(html).toContain('你好世界明天见');
  });

  it('无采纳时显示待采纳与采纳入口', () => {
    const cues = cuesOf(['你好世界', '世界再见']);
    const html = renderPanel(cues, new Map());
    expect(html).toContain('dedup-entry ready');
    expect(html).toContain('>采纳</button>');
    expect(html).toContain('已采纳 <!-- -->0');
  });
});
