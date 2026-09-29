import { useMemo, useState } from 'react';
import type { MergedCue } from '../lib/merge';
import { formatTimecode } from '../lib/srt';
import {
  findScrollChains,
  type ScrollAcceptance,
  type ScrollChain,
  type ScrollOptions,
} from '../lib/scroll';

const PAGE = 50;

interface DedupePanelProps {
  /** 当前合并结果（未消重） */
  cues: MergedCue[];
  options: ScrollOptions;
  onOptions(next: ScrollOptions): void;
  /** 已采纳链：key（成员组序号）→ 采纳当时的链方案指纹 */
  accepted: ScrollAcceptance;
  onAccept(key: string): void;
  onRestore(key: string): void;
  onAcceptAll(keys: string[]): void;
  onRestoreAll(): void;
}

type EntryStatus = 'applied' | 'ready';

export function DedupePanel(props: DedupePanelProps) {
  const { cues, options, accepted } = props;
  const [shown, setShown] = useState(PAGE);

  const chains = useMemo(() => findScrollChains(cues, options), [cues, options]);
  const chainByKey = useMemo(() => new Map(chains.map((c) => [c.key, c])), [chains]);

  // 采纳只对采纳当时的链方案有效：key 仍在且指纹完全一致才算已采纳。
  // key 只编码成员组序号，文本/时间/重叠改变后 key 不变、指纹变化，回到待采纳。
  const liveAccepted = useMemo(() => {
    const s = new Set<string>();
    accepted.forEach((sig, k) => {
      const ch = chainByKey.get(k);
      if (ch && ch.signature === sig) s.add(k);
    });
    return s;
  }, [accepted, chainByKey]);

  const readyKeys = chains.filter((c) => !liveAccepted.has(c.key)).map((c) => c.key);
  const totalSaved = chains.reduce((sum, c) => sum + c.saved, 0);
  const appliedSaved = chains.reduce((sum, c) => (liveAccepted.has(c.key) ? sum + c.saved : sum), 0);

  const setOpts = (patch: Partial<ScrollOptions>) => props.onOptions({ ...options, ...patch });
  const parseNum = (raw: string, fallback: number, lo: number, hi: number) => {
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };

  const statusOf = (ch: ScrollChain): EntryStatus =>
    liveAccepted.has(ch.key) ? 'applied' : 'ready';

  return (
    <section className="wrap-panel dedup-panel">
      <div className="wrap-settings">
        <label>
          最大相邻间隔（秒）
          <input
            type="number"
            min={0}
            max={60}
            step={0.1}
            value={options.maxGapMs / 1000}
            onChange={(e) =>
              setOpts({ maxGapMs: Math.round(parseNum(e.target.value, options.maxGapMs / 1000, 0, 60) * 1000) })
            }
          />
        </label>
        <label>
          最小文本重叠（字）
          <input
            type="number"
            min={1}
            max={200}
            value={options.minOverlap}
            onChange={(e) => setOpts({ minOverlap: parseNum(String(e.target.value), options.minOverlap, 1, 200) })}
          />
        </label>
        <span className="spacer" />
        <button
          className="btn sm accent"
          disabled={readyKeys.length === 0}
          onClick={() => props.onAcceptAll(readyKeys)}
        >
          全部采纳（{readyKeys.length}）
        </button>
        <button
          className="btn sm"
          disabled={liveAccepted.size === 0}
          onClick={props.onRestoreAll}
        >
          全部恢复
        </button>
      </div>

      <div className="wrap-summary">
        共 {cues.length} 条合并结果 · 识别出 {chains.length} 条滚动链 · 已采纳 {liveAccepted.size}
        {liveAccepted.size > 0 && <> · 已节省 {appliedSaved} 字</>}
        {chains.length > 0 && <em> · 全部采纳共可节省 {totalSaved} 个重复字符</em>}
        <span className="wrap-hint">
          按去标签/标点/空白后的字符序列计算相邻最长后缀-前缀重叠，全局动态规划选择互不重叠链
        </span>
        <span className="wrap-hint">
          采纳只对当时确认的链方案生效：采纳后再改动成员组的文本选择、时间或消重参数，导致链成员、原文、时间或重叠结果变化时，该链自动回到「待采纳」，预览与导出恢复保留未消重字幕，需重新采纳才折叠；链一度消失后再以相同内容出现也不会自动恢复采纳，其他未变化的已采纳链继续生效
        </span>
      </div>

      <div className="wrap-list">
        {cues.length === 0 && <div className="empty">当前没有可消重的合并结果。</div>}
        {cues.length > 0 && chains.length === 0 && (
          <div className="empty">当前参数下没有识别到连续滚动字幕，可尝试放宽间隔或最小重叠。</div>
        )}
        {chains.slice(0, shown).map((ch, ci) => {
          const st = statusOf(ch);
          return (
            <article className={`wrap-entry dedup-entry ${st}`} key={ch.key}>
              <div className="we-head">
                <span className="g-idx">链 {ci + 1}</span>
                <span className="cue-time">
                  {formatTimecode(ch.start)} → {formatTimecode(ch.end)}
                </span>
                <span className="tag dim">{ch.members.length} 条 → 1 条</span>
                <span className="tag ok">节省 {ch.saved} 字</span>
                <span className="spacer" />
                <span className={`tag ${st === 'applied' ? 'ok' : 'go'}`}>
                  {st === 'applied' ? '已采纳' : '待采纳'}
                </span>
                {st === 'ready' ? (
                  <button className="btn sm accent" onClick={() => props.onAccept(ch.key)}>
                    采纳
                  </button>
                ) : (
                  <button className="btn sm" onClick={() => props.onRestore(ch.key)}>
                    恢复
                  </button>
                )}
              </div>

              <ol className="dedup-members">
                {ch.members.map((mi, k) => (
                  <li key={mi} className="dedup-member">
                    <span className="cue-time">
                      #{mi + 1} {formatTimecode(cues[mi].start)} → {formatTimecode(cues[mi].end)}
                    </span>
                    <pre>{cues[mi].text}</pre>
                    {k < ch.edges.length && (
                      <span className="dedup-edge">↳ 后缀-前缀重叠 {ch.edges[k].overlap} 字，仅追加新增尾部</span>
                    )}
                  </li>
                ))}
              </ol>

              <div className="we-cols">
                <div className="we-col">
                  <div className="we-title">合并文本</div>
                  <pre className={st === 'applied' ? 'we-live' : ''}>{ch.text}</pre>
                </div>
              </div>
            </article>
          );
        })}
        {chains.length > shown && (
          <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
            显示更多（剩余 {chains.length - shown} 条链）
          </button>
        )}
      </div>
    </section>
  );
}
