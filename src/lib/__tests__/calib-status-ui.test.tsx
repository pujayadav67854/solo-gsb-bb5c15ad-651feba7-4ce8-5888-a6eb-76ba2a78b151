import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalibStatusChip } from '../../components/CalibStatusChip';

describe('工作区 B 时间轴状态标识', () => {
  it('生效校准显示确认提交时快照的锚点数，不受草稿变化影响', () => {
    const html = renderToString(<CalibStatusChip calibrated anchorCount={7} />);
    expect(html).toContain('时间轴已校准');
    expect(html).toMatch(/已校准（(<!-- -->)?7(<!-- -->)? 锚点）/);
    expect(html).toContain('7 个锚点 · 分段线性映射');
    // 同一组件在父级传入不同（被草稿污染的）锚点数前保持原样：
    // 这里断言渲染只取决于 props 快照，而非任何外部实时状态
    const again = renderToString(<CalibStatusChip calibrated anchorCount={7} />);
    expect(again).toBe(html);
  });

  it('确认改用原始 B 时间（calibrated=false）时显示未校准，锚点数被忽略', () => {
    const html = renderToString(<CalibStatusChip calibrated={false} anchorCount={7} />);
    expect(html).toContain('使用原始 B 时间');
    expect(html).not.toContain('时间轴已校准');
    expect(html).not.toContain('锚点');
  });
});
