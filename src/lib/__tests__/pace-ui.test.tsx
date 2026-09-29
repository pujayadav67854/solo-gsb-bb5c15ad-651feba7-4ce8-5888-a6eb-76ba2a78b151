import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PacePanel } from '../../components/PacePanel';
import type { MergedCue } from '../merge';
import { analyzePace, DEFAULT_PACE_OPTIONS } from '../pace';

const noop = () => {};

function renderPanel(cues: MergedCue[], accepted: ReadonlySet<string> = new Set()) {
  return renderToString(
    <PacePanel
      cues={cues}
      analysis={analyzePace(cues, DEFAULT_PACE_OPTIONS)}
      accepted={accepted}
      options={DEFAULT_PACE_OPTIONS}
      onOptions={noop}
      onAccept={noop}
      onRestore={noop}
      onAcceptAll={noop}
      onRestoreAll={noop}
    />,
  );
}

describe('PacePanel 渲染冒烟', () => {
  it('渲染参数区、区段与原/新时间速率对比', () => {
    const cues: MergedCue[] = [
      { start: 0, end: 1000, text: '好'.repeat(40), groupIndex: 0 }, // 40 字/秒 > 20：超速
      { start: 5000, end: 7000, text: '正常文本', groupIndex: 1 },
    ];
    const html = renderPanel(cues);
    expect(html).toContain('最大字符/秒');
    expect(html).toContain('最短时长');
    expect(html).toContain('最长时长');
    expect(html).toContain('区段');
    expect(html).toContain('原时间');
    expect(html).toContain('新时间');
    expect(html).toContain('原字/秒');
    expect(html).toContain('新字/秒');
    expect(html).toContain('超速');
    expect(html).toContain('采纳');
    expect(html).toContain('40.0'); // 原字/秒
    expect(html).toContain('20.0'); // 修复后字/秒
  });

  it('无解区段明确标记原因', () => {
    const cues: MergedCue[] = [
      { start: 0, end: 1000, text: '正常', groupIndex: 0 },
      { start: 1100, end: 1600, text: '好'.repeat(30), groupIndex: 1 }, // 需 1.5 秒，窗口 0.9 秒
      { start: 2000, end: 3000, text: '正常', groupIndex: 2 },
    ];
    const html = renderPanel(cues);
    expect(html).toContain('无解');
    expect(html).toContain('保持原时间');
  });

  it('全部达标时给出提示', () => {
    const cues: MergedCue[] = [{ start: 0, end: 2000, text: '正常文本', groupIndex: 0 }];
    const html = renderPanel(cues);
    expect(html).toContain('阅读节奏全部达标');
  });

  it('已采纳区段显示恢复入口', () => {
    const cues: MergedCue[] = [
      { start: 0, end: 1000, text: '好'.repeat(40), groupIndex: 0 },
      { start: 5000, end: 7000, text: '正常文本', groupIndex: 1 },
    ];
    const analysis = analyzePace(cues, DEFAULT_PACE_OPTIONS);
    const html = renderPanel(cues, new Set([analysis.segments[0].key]));
    expect(html).toContain('已采纳');
    expect(html).toContain('恢复');
  });
});
