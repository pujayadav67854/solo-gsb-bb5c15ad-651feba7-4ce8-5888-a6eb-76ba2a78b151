import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SnapPanel } from '../../components/SnapPanel';
import type { MergedCue } from '../merge';
import { DEFAULT_SNAP_OPTIONS, parseCutList, planSnaps } from '../snap';

const noop = () => {};

function renderPanel(cues: MergedCue[], cutText: string, accepted: ReadonlySet<string> = new Set()) {
  const parsed = parseCutList(cutText);
  const plan = planSnaps(cues, parsed.cuts, DEFAULT_SNAP_OPTIONS);
  return renderToString(
    <SnapPanel
      cues={cues}
      plan={plan}
      parsed={parsed}
      accepted={accepted}
      cutText={cutText}
      onCutText={noop}
      options={DEFAULT_SNAP_OPTIONS}
      onOptions={noop}
      onAccept={noop}
      onRestore={noop}
      onAcceptAll={noop}
      onRestoreAll={noop}
    />,
  );
}

describe('SnapPanel 渲染冒烟', () => {
  it('展示切点输入、参数与逐条原/新时间、位移、命中切点', () => {
    const cues: MergedCue[] = [
      { start: 1000, end: 3000, text: '第一条字幕', groupIndex: 0 },
      { start: 3000, end: 5000, text: '第二条字幕', groupIndex: 1 },
    ];
    const html = renderPanel(cues, '00:00:01,300\n00:00:04,800\n');
    expect(html).toContain('镜头切点列表');
    expect(html).toContain('上传切点文件');
    expect(html).toContain('吸附阈值');
    expect(html).toContain('最短时长');
    expect(html).toContain('已解析');
    expect(html).toContain('个切点');
    expect(html).toContain('全部采纳');
    expect(html).toContain('可吸附');
    expect(html).toContain('采纳');
    expect(html).toContain('+300');
    expect(html).toContain('新时长');
  });

  it('未提供切点时给出粘贴提示', () => {
    const cues: MergedCue[] = [{ start: 1000, end: 3000, text: '字幕', groupIndex: 0 }];
    const html = renderPanel(cues, '');
    expect(html).toContain('请粘贴或上传镜头切点列表');
  });

  it('非法行被标出', () => {
    const cues: MergedCue[] = [{ start: 1000, end: 3000, text: '字幕', groupIndex: 0 }];
    const html = renderPanel(cues, '00:00:01,000\n坏行\n');
    expect(html).toContain('行无法识别');
    expect(html).toContain('坏行');
  });

  it('已采纳条目显示“已采纳”与恢复入口', () => {
    const cues: MergedCue[] = [{ start: 1000, end: 3000, text: '字幕', groupIndex: 0 }];
    const parsed = parseCutList('00:00:01,300');
    const plan = planSnaps(cues, parsed.cuts, DEFAULT_SNAP_OPTIONS);
    const html = renderPanel(cues, '00:00:01,300', new Set([plan.items[0].key]));
    expect(html).toContain('已采纳');
    expect(html).toContain('恢复');
  });

  it('阈值内无切点的边界给出未吸附原因', () => {
    const cues: MergedCue[] = [{ start: 1000, end: 3000, text: '字幕', groupIndex: 0 }];
    const html = renderPanel(cues, '00:00:10,000');
    expect(html).toContain('阈值内无切点');
  });

  it('整体无解时显示原因', () => {
    // 原时长 500ms < 默认最短 1000ms
    const cues: MergedCue[] = [{ start: 1000, end: 1500, text: '太短', groupIndex: 0 }];
    const html = renderPanel(cues, '00:00:01,200');
    expect(html).toContain('当前无解');
    expect(html).toContain('短于最短时长');
  });
});
