import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OccludePanel } from '../../components/OccludePanel';
import type { MergedCue } from '../merge';
import { parseOcclusions, planTracks } from '../occlude';

const noop = () => {};

function renderPanel(
  cues: MergedCue[],
  text: string,
  opts: { sourceReady?: boolean } = {},
) {
  const parsed = parseOcclusions(text);
  const plan = planTracks(cues, parsed.occlusions);
  const canDownload =
    (opts.sourceReady ?? true) && parsed.invalid.length === 0 && plan.ok && cues.length > 0;
  const html = renderToString(
    <OccludePanel
      sourceCount={cues.length}
      sourceReady={opts.sourceReady ?? true}
      occText={text}
      onOccText={noop}
      parsed={parsed}
      cues={cues}
      plan={plan}
      canDownload={canDownload}
      downloadReason={parsed.invalid.length > 0 ? '格式错误' : !plan.ok ? '无完整方案' : ''}
      onDownload={noop}
    />,
  ).replace(/<!-- -->/g, '');
  return html;
}

const cues: MergedCue[] = [
  { start: 0, end: 1000, text: '第一条', groupIndex: 0 },
  { start: 1000, end: 3000, text: '第二条', groupIndex: 1 },
  { start: 3000, end: 4000, text: '第三条', groupIndex: 2 },
];

describe('OccludePanel 渲染冒烟', () => {
  it('展示遮挡输入、区间列表与逐条轨道分配预览', () => {
    const html = renderPanel(cues, '0 500 下\n3500 4000 上\n');
    expect(html).toContain('遮挡区间列表');
    expect(html).toContain('上传遮挡文件');
    expect(html).toContain('✓ 已解析 2 个遮挡区间（上轨 1 · 下轨 1）');
    expect(html).toContain('轨道分配预览');
    expect(html).toContain('下载轨道分配 CSV');
    // 第 1 条下轨被遮挡 → 只能上轨；第 3 条上轨被遮挡 → 只能下轨；第 2 条默认下轨
    expect(html).toContain('下轨被第 1 行遮挡 → 只能上轨');
    expect(html).toContain('上轨被第 2 行遮挡 → 只能下轨');
    expect(html).toContain('双轨可用 · 默认下轨');
    // 汇总：上轨 1 条 · 下轨 2 条 · 切换 1 次
    expect(html).toContain('上轨 1 条');
    expect(html).toContain('下轨 2 条');
    expect(html).toContain('轨道切换 1 次');
  });

  it('空输入时全部默认下轨', () => {
    const html = renderPanel(cues, '');
    expect(html).toContain('双轨可用 · 默认下轨');
    expect(html).toContain('轨道切换 0 次');
    expect(html).toContain('下载轨道分配 CSV');
  });

  it('格式错误标出物理行号且禁止下载', () => {
    const html = renderPanel(cues, '0 1000 上\n坏行\n3000 1000 下');
    expect(html).toContain('第 2、3 行格式错误');
    expect(html).toContain('坏行');
    expect(html).toContain('disabled=""');
  });

  it('两轨均被遮挡时展示首条无解原因，不导出部分方案', () => {
    const html = renderPanel(cues, '1000 3000 上\n1000 3000 下\n');
    expect(html).toContain('第 2 条字幕');
    expect(html).toContain('两轨均被遮挡');
    expect(html).toContain('不生成、也不导出任何部分方案');
    expect(html).toContain('无完整方案可预览');
    expect(html).toContain('disabled=""');
  });

  it('上游不可导出时提示且禁止下载', () => {
    const html = renderPanel(cues, '0 1000 上', { sourceReady: false });
    expect(html).toContain('上游合并结果当前不可导出');
    expect(html).toContain('disabled=""');
  });
});
