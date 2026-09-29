import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GroupCard } from '../../components/GroupCard';
import type { AlignGroup } from '../align';
import { defaultStateFor } from '../merge';
import { parseSrt, type Cue } from '../srt';

const noop = () => {};

const cuesA = parseSrt('1\n00:00:01,000 --> 00:00:04,000\n你好世界\n');
const cuesB = parseSrt('1\n00:00:01,000 --> 00:00:03,000\n你好呀世界\n');
const group: AlignGroup = {
  id: 'g0',
  aIdx: [0],
  bIdx: [0],
  kind: '1:1',
  textSim: 0.7,
  timeOverlap: 0.8,
  confidence: 0.74,
};

function renderCard(state = defaultStateFor(group, cuesA, cuesB)) {
  return renderToString(
    <GroupCard
      index={0}
      group={group}
      state={state}
      cuesA={cuesA}
      cuesB={cuesB}
      suggestion="A"
      onResolve={noop}
    />,
  );
}

describe('GroupCard 局部混编', () => {
  it('双侧文本不同的卡片提供“局部混编”入口', () => {
    const html = renderCard();
    expect(html).toContain('局部混编');
  });

  it('选择局部混编后展示差异段的 A/B 选项、固定相同片段与混编结果', () => {
    const state = defaultStateFor(group, cuesA, cuesB);
    state.resolved = true;
    state.resolution.text = 'mix';
    state.resolution.mixChoices = ['B']; // 唯一差异段（插入“呀”）取 B
    const html = renderCard(state);
    expect(html).toContain('mix-editor');
    expect(html).toContain('你好世界'); // 相同片段固定展示
    expect(html).toContain('呀'); // 差异段
    expect(html).toContain('混编结果');
    expect(html).toContain('你好呀世界'); // 即时混编结果
  });

  it('单侧空片段以 ∅ 标记，且可作为删除该段的选择', () => {
    const aOnly: Cue[] = parseSrt('1\n00:00:01,000 --> 00:00:03,000\n甲乙\n');
    const bOnly: Cue[] = parseSrt('1\n00:00:01,000 --> 00:00:03,000\n甲X乙\n');
    const state = defaultStateFor(group, aOnly, bOnly);
    state.resolved = true;
    state.resolution.text = 'mix';
    state.resolution.mixChoices = ['B'];
    const html = renderToString(
      <GroupCard
        index={0}
        group={group}
        state={state}
        cuesA={aOnly}
        cuesB={bOnly}
        suggestion="A"
        onResolve={noop}
      />,
    );
    expect(html).toContain('∅'); // A 侧该段为空
    expect(html).toContain('甲X乙');
  });
});
