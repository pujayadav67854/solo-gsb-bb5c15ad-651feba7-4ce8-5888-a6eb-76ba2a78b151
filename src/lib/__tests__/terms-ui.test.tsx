import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TermsPanel } from '../../components/TermsPanel';
import type { MergedCue } from '../merge';
import { serializeSrt } from '../srt';
import { normalizeCues, parseTerms } from '../terms';

const noop = () => {};

function renderPanel(
  cues: MergedCue[],
  text: string,
  opts: { sourceReady?: boolean } = {},
) {
  const parsed = parseTerms(text);
  const results = normalizeCues(cues, parsed.rules);
  const srt = serializeSrt(results.map((c) => ({ start: c.start, end: c.end, text: c.after })));
  const hitCount = results.reduce((n, c) => n + c.hits.length, 0);
  const changedCount = results.filter((c) => c.hits.length > 0).length;
  const reason =
    opts.sourceReady === false
      ? '上游不可导出'
      : parsed.invalid.length > 0
        ? '术语表有误'
        : parsed.rules.length === 0
          ? '请先填写术语表'
          : '';
  const html = renderToString(
    <TermsPanel
      sourceCount={cues.length}
      sourceReady={opts.sourceReady ?? true}
      termsText={text}
      onTermsText={noop}
      parsed={parsed}
      results={results}
      hitCount={hitCount}
      changedCount={changedCount}
      preview={srt}
      canDownload={reason === ''}
      downloadReason={reason || '暂不可下载'}
      onDownload={noop}
    />,
  ).replace(/<!-- -->/g, '');
  return html;
}

const cues: MergedCue[] = [
  { start: 0, end: 1000, text: '使用因特网冲浪', groupIndex: 0 },
  { start: 1000, end: 3000, text: '不涉及术语\n第二行', groupIndex: 1 },
];

describe('TermsPanel 渲染冒烟', () => {
  it('展示术语表输入、有效规则、逐条前后文本与命中规则', () => {
    const html = renderPanel(cues, '因特网\t互联网\n');
    expect(html).toContain('术语表');
    expect(html).toContain('上传术语文件');
    expect(html).toContain('已解析 1 条规则');
    expect(html).toContain('使用因特网冲浪');
    expect(html).toContain('使用互联网冲浪');
    expect(html).toContain('命中 1 次');
    expect(html).toContain('未变化');
    expect(html).toContain('下载术语统一 SRT');
    // 时间与条数不变
    expect(html).toContain('规范化后 2 条');
  });

  it('空输入时给出填写提示且禁止下载', () => {
    const html = renderPanel(cues, '');
    expect(html).toContain('请先填写有效的术语表');
    expect(html).toContain('disabled=""');
  });

  it('错误行（列数错误 / 重复原词）逐行标出且禁止下载', () => {
    const html = renderPanel(cues, '因特网\t互联网\n缺Tab列\n因特网\t重复');
    expect(html).toContain('第 2、3 行有误');
    expect(html).toContain('缺Tab列');
    expect(html).toContain('disabled=""');
  });

  it('上游不可导出时提示且禁止下载', () => {
    const html = renderPanel(cues, '因特网\t互联网', { sourceReady: false });
    expect(html).toContain('上游合并结果当前不可导出');
    expect(html).toContain('disabled=""');
  });
});
