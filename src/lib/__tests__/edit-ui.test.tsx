import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditPanel } from '../../components/EditPanel';
import type { MergedCue } from '../merge';
import { buildEditedCues, buildSegmentSpans, editedTotalDuration, parseSegments } from '../edit';
import { serializeSrt } from '../srt';

const noop = () => {};

function renderPanel(
  cues: MergedCue[],
  text: string,
  opts: { sourceReady?: boolean } = {},
) {
  const parsed = parseSegments(text);
  const edited = buildEditedCues(cues, parsed.segments);
  const spans = buildSegmentSpans(parsed.segments, edited);
  const totalDuration = editedTotalDuration(parsed.segments);
  const html = renderToString(
    <EditPanel
      sourceCount={cues.length}
      sourceReady={opts.sourceReady ?? true}
      segmentText={text}
      onSegmentText={noop}
      parsed={parsed}
      edited={edited}
      spans={spans}
      totalDuration={totalDuration}
      preview={serializeSrt(edited)}
      canDownload={opts.sourceReady !== false && parsed.invalid.length === 0 && edited.length > 0}
      downloadReason={parsed.invalid.length > 0 ? '格式错误' : ''}
      onDownload={noop}
    />,
  ).replace(/<!-- -->/g, '');
  return html;
}

const cues: MergedCue[] = [
  { start: 0, end: 1000, text: '第一条', groupIndex: 0 },
  { start: 1000, end: 3000, text: '第二条', groupIndex: 1 },
];

describe('EditPanel 渲染冒烟', () => {
  it('展示片段输入、片段时间轴与剪辑版预览', () => {
    const html = renderPanel(cues, '0 2000\n1000 3000\n');
    expect(html).toContain('源片段列表');
    expect(html).toContain('上传片段文件');
    expect(html).toContain('已解析 2 个片段');
    expect(html).toContain('片段时间轴');
    expect(html).toContain('新时间轴预览');
    expect(html).toContain('下载剪辑版 SRT');
    // 第二条片段只命中 2000–3000（成片 1000–2000）
    expect(html).toContain('命中 2 条');
  });

  it('空输入时给出填写提示', () => {
    const html = renderPanel(cues, '');
    expect(html).toContain('请逐行填写源片段起止毫秒');
    expect(html).toContain('暂不可下载');
  });

  it('格式错误标出物理行号且禁止下载', () => {
    const html = renderPanel(cues, '0 1000\n坏行\n3000 1000');
    expect(html).toContain('第 2、3 行格式错误');
    expect(html).toContain('坏行');
    expect(html).toContain('disabled=""');
  });

  it('空白片段标记占位', () => {
    const html = renderPanel(cues, '90000 91000');
    expect(html).toContain('空白片段 · 仍占时长');
    expect(html).toContain('剪辑版结果为空');
  });

  it('上游不可导出时提示且禁止下载', () => {
    const html = renderPanel(cues, '0 1000', { sourceReady: false });
    expect(html).toContain('上游合并结果当前不可导出');
    expect(html).toContain('disabled=""');
  });
});
