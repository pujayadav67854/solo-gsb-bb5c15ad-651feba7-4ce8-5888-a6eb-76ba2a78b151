import { describe, expect, it } from 'vitest';
import { alignCues } from '../align';
import { buildMergedCues, defaultStateFor } from '../merge';
import { analyzePace, applyPaceFixes, DEFAULT_PACE_OPTIONS } from '../pace';
import { SAMPLE_A, SAMPLE_B } from '../samples';
import { parseSrt, serializeSrt } from '../srt';
import { applyScrollChains, findScrollChains } from '../scroll';
import { smartWrap } from '../wrap';

describe('全链路集成：对齐 → 合并 → 消重 → 断行 → 阅读节奏 → 导出', () => {
  it('示例数据：已采纳节奏修复进入导出，文本与顺序不变、时间不重叠', () => {
    const cuesA = parseSrt(SAMPLE_A);
    const cuesB = parseSrt(SAMPLE_B);
    const groups = alignCues(cuesA, cuesB);
    const states = groups.map((g) => defaultStateFor(g, cuesA, cuesB));
    const merged = buildMergedCues(groups, states, cuesA, cuesB);
    const chains = findScrollChains(merged.cues, { maxGapMs: 1000, minOverlap: 2 });
    const deduped = applyScrollChains(merged.cues, chains, new Set(chains.map((c) => c.key)));
    const wrapped = deduped.map((c) => {
      const r = smartWrap(c.text, { maxWidth: 42, maxLines: 2, lockManualBreaks: true });
      return r.ok ? { ...c, text: r.text } : c;
    });

    const analysis = analyzePace(wrapped, DEFAULT_PACE_OPTIONS);
    expect(analysis.stats.length).toBe(wrapped.length);

    // 采纳全部可行区段
    const keys = analysis.segments.filter((s) => s.ok).map((s) => s.key);
    const out = applyPaceFixes(wrapped, analysis.segments, new Set(keys));
    expect(out.length).toBe(wrapped.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i].text).toBe(wrapped[i].text);
      expect(out[i].groupIndex).toBe(wrapped[i].groupIndex);
      expect(out[i].end).toBeGreaterThan(out[i].start);
      if (i > 0) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
    }

    // 采纳后重新分析：被采纳区段的成员不再超限
    const re = analyzePace(out, DEFAULT_PACE_OPTIONS);
    for (const seg of analysis.segments) {
      if (!seg.ok) continue;
      for (const it of seg.items) {
        expect(re.stats[it.index].violating).toBe(false);
      }
    }

    // 导出为标准 SRT
    expect(serializeSrt(out)).toContain('-->');
  });
});
