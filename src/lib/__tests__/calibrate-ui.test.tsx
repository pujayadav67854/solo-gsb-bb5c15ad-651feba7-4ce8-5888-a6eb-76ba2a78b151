import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalibratePanel } from '../../components/CalibratePanel';
import { ImportPanel } from '../../components/ImportPanel';
import { DEFAULT_CALIB_OPTIONS, fitCalibration, selectAnchors } from '../calibrate';
import { SAMPLE_A, SAMPLE_B } from '../samples';
import { parseSrt } from '../srt';

const noop = () => {};

describe('校准相关组件渲染冒烟', () => {
  it('ImportPanel 渲染并包含校准入口', () => {
    const html = renderToString(
      <ImportPanel
        nameA="a.srt"
        nameB="b.srt"
        textA={SAMPLE_A}
        textB={SAMPLE_B}
        cuesA={parseSrt(SAMPLE_A)}
        cuesB={parseSrt(SAMPLE_B)}
        busy={false}
        error={null}
        onText={noop}
        onCalibrate={noop}
        onSkipCalibrate={noop}
        onCancel={noop}
        onSample={noop}
      />,
    );
    expect(html).toContain('时间轴校准');
    expect(html).toContain('跳过校准，直接对齐');
  });

  it('CalibratePanel 渲染锚点表、原/新时间与残差', () => {
    const a = parseSrt(SAMPLE_A);
    const b = parseSrt(SAMPLE_B);
    const anchors = selectAnchors(a, b, DEFAULT_CALIB_OPTIONS);
    const fit = fitCalibration(a, b, anchors, new Set());
    const html = renderToString(
      <CalibratePanel
        nameA="a.srt"
        nameB="b.srt"
        cuesA={a}
        cuesB={b}
        anchors={anchors}
        fit={fit}
        options={DEFAULT_CALIB_OPTIONS}
        onOptions={noop}
        disabled={new Set()}
        forced={new Set()}
        onToggle={noop}
        onReset={noop}
        applied={false}
        aligning={false}
        alignError={null}
        onApply={noop}
        onCancel={noop}
        onUseOriginal={noop}
        onBack={noop}
      />,
    );
    expect(html).toContain('应用校准并开始对齐');
    expect(html).toContain('恢复原始 B 时间并对齐');
    expect(html).toContain('候选锚点');
    expect(html).toContain('B 新时间');
  });
});
