import { useMemo, useState } from 'react';
import type { MergedCue } from '../lib/merge';
import {
  charsPerSecond,
  type PaceAnalysis,
  type PaceOptions,
  type PaceSegment,
} from '../lib/pace';
import { formatTimecode } from '../lib/srt';

const PAGE = 30;

interface PacePanelProps {
  /** 当前（已采纳消重与断行后的）字幕 */
  cues: MergedCue[];
  /** 当前参数下的阅读节奏分析结果 */
  analysis: PaceAnalysis;
  /** 已采纳区段的 key 集合 */
  accepted: ReadonlySet<string>;
  options: PaceOptions;
  onOptions(next: PaceOptions): void;
  onAccept(key: string): void;
  onRestore(key: string): void;
  onAcceptAll(keys: string[]): void;
  onRestoreAll(): void;
}

type EntryStatus = 'applied' | 'ready' | 'fail';

const STATUS_LABEL: Record<EntryStatus, string> = {
  applied: '已采纳',
  ready: '待采纳',
  fail: '无解',
};

const STATUS_CLS: Record<EntryStatus, string> = {
  applied: 'ok',
  ready: 'go',
  fail: 'warn',
};

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const fmtCps = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '∞');
const fmtGap = (ms: number) => (Number.isFinite(ms) ? fmtSec(ms) : '∞');

export function PacePanel(props: PacePanelProps) {
  const { cues, analysis, accepted, options } = props;
  const { stats, segments } = analysis;
  const [shown, setShown] = useState(PAGE);

  // 已采纳集合可能引用上游变化前的区段；统计与操作都以当前区段为准
  const segKeys = useMemo(() => new Set(segments.map((s) => s.key)), [segments]);
  const liveAccepted = useMemo(() => {
    const s = new Set<string>();
    accepted.forEach((k) => {
      if (segKeys.has(k)) s.add(k);
    });
    return s;
  }, [accepted, segKeys]);

  const summary = useMemo(() => {
    let fast = 0;
    let short = 0;
    let long = 0;
    let violating = 0;
    let unsolvable = 0;
    for (const st of stats) {
      if (!st.violating) continue;
      violating++;
      if (st.tooFast) fast++;
      if (st.tooShort) short++;
      if (st.tooLong) long++;
    }
    for (const seg of segments) if (!seg.ok) unsolvable++;
    return { fast, short, long, violating, unsolvable };
  }, [stats, segments]);

  const readyKeys = segments.filter((s) => s.ok && !liveAccepted.has(s.key)).map((s) => s.key);

  const setOpts = (patch: Partial<PaceOptions>) => {
    const next = { ...options, ...patch };
    // 最短时长不得超过最长时长（改动哪一侧就推动另一侧）
    if (next.minDurMs > next.maxDurMs) {
      if (patch.minDurMs !== undefined) next.maxDurMs = next.minDurMs;
      else next.minDurMs = next.maxDurMs;
    }
    props.onOptions(next);
  };
  const parseNum = (raw: string, fallback: number, lo: number, hi: number) => {
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };

  const statusOf = (seg: PaceSegment): EntryStatus =>
    !seg.ok ? 'fail' : liveAccepted.has(seg.key) ? 'applied' : 'ready';

  return (
    <section className="wrap-panel pace-panel">
      <div className="wrap-settings">
        <label>
          最大字符/秒
          <input
            type="number"
            min={1}
            max={100}
            step={0.5}
            value={options.maxCps}
            onChange={(e) => setOpts({ maxCps: parseNum(e.target.value, options.maxCps, 1, 100) })}
          />
        </label>
        <label>
          最短时长（秒）
          <input
            type="number"
            min={0.1}
            max={30}
            step={0.1}
            value={options.minDurMs / 1000}
            onChange={(e) =>
              setOpts({
                minDurMs: Math.round(parseNum(e.target.value, options.minDurMs / 1000, 0.1, 30) * 1000),
              })
            }
          />
        </label>
        <label>
          最长时长（秒）
          <input
            type="number"
            min={0.5}
            max={60}
            step={0.1}
            value={options.maxDurMs / 1000}
            onChange={(e) =>
              setOpts({
                maxDurMs: Math.round(parseNum(e.target.value, options.maxDurMs / 1000, 0.5, 60) * 1000),
              })
            }
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
        <button className="btn sm" disabled={liveAccepted.size === 0} onClick={props.onRestoreAll}>
          全部恢复
        </button>
      </div>

      <div className="wrap-summary">
        共 {cues.length} 条 · 超限 {summary.violating} 条（超速 {summary.fast} · 过短 {summary.short} ·
        过长 {summary.long}）· 划为 {segments.length} 个区段 · 已采纳 {liveAccepted.size}
        {summary.unsolvable > 0 && <em> · {summary.unsolvable} 个区段无解（保持原时间）</em>}
        <span className="wrap-hint">
          字符按 Unicode 字素统计：去标签、不计空白；修复只改时间，不改文本与顺序
        </span>
      </div>

      <div className="wrap-list">
        {cues.length === 0 && <div className="empty">当前没有可分析的合并结果。</div>}
        {cues.length > 0 && segments.length === 0 && (
          <div className="empty">当前参数下没有超限条目，阅读节奏全部达标。</div>
        )}
        {segments.slice(0, shown).map((seg, si) => {
          const st = statusOf(seg);
          return (
            <article className={`wrap-entry pace-entry ${st}`} key={seg.key}>
              <div className="we-head">
                <span className="g-idx">区段 {si + 1}</span>
                <span className="cue-time">
                  第 {seg.startIdx + 1} – {seg.endIdx + 1} 条 · 共 {seg.endIdx - seg.startIdx + 1} 条
                </span>
                <span className="tag dim">前空隙 {fmtGap(seg.gapBeforeMs)}</span>
                <span className="tag dim">后空隙 {fmtGap(seg.gapAfterMs)}</span>
                {seg.ok && (
                  <span className="tag dim">
                    需 {fmtSec(seg.needMs)} / 可用 {fmtGap(seg.windowMs)}
                  </span>
                )}
                <span className="spacer" />
                <span className={`tag ${STATUS_CLS[st]}`}>{STATUS_LABEL[st]}</span>
                {st === 'ready' && (
                  <button className="btn sm accent" onClick={() => props.onAccept(seg.key)}>
                    采纳
                  </button>
                )}
                {st === 'applied' && (
                  <button className="btn sm" onClick={() => props.onRestore(seg.key)}>
                    恢复
                  </button>
                )}
              </div>

              {!seg.ok && <div className="we-fail">⚠ {seg.reason}，保持原时间。</div>}

              <div className="pace-table-wrap">
                <table className="pace-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>文本</th>
                      <th>原时间</th>
                      <th>{seg.ok ? '新时间' : '所需时长'}</th>
                      <th>原时长</th>
                      <th>新时长</th>
                      <th>原字/秒</th>
                      <th>新字/秒</th>
                      <th>问题</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seg.items.map((it) => {
                      const cst = stats[it.index];
                      const newDur = it.newEnd - it.newStart;
                      const changed = it.newStart !== it.oldStart || it.newEnd !== it.oldEnd;
                      return (
                        <tr key={it.index} className={st === 'applied' && changed ? 'pace-live' : ''}>
                          <td className="mono">#{it.index + 1}</td>
                          <td className="pace-text">
                            <span>{cues[it.index].text}</span>
                          </td>
                          <td className="mono">
                            {formatTimecode(it.oldStart)} → {formatTimecode(it.oldEnd)}
                          </td>
                          <td className={`mono ${seg.ok && changed ? 'pace-new' : ''}`}>
                            {seg.ok
                              ? `${formatTimecode(it.newStart)} → ${formatTimecode(it.newEnd)}`
                              : `≥ ${fmtSec(it.needMs)}`}
                          </td>
                          <td className="mono">{fmtSec(it.oldEnd - it.oldStart)}</td>
                          <td className="mono">{seg.ok ? fmtSec(newDur) : '—'}</td>
                          <td className={`mono ${cst.tooFast ? 'pace-bad' : ''}`}>
                            {fmtCps(cst.cps)}
                          </td>
                          <td className="mono">
                            {seg.ok ? fmtCps(charsPerSecond(it.chars, newDur)) : '—'}
                          </td>
                          <td>
                            <span className="pace-flags">
                              {cst.tooFast && <span className="tag warn">超速</span>}
                              {cst.tooShort && <span className="tag low">过短</span>}
                              {cst.tooLong && <span className="tag low">过长</span>}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </article>
          );
        })}
        {segments.length > shown && (
          <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
            显示更多（剩余 {segments.length - shown} 个区段）
          </button>
        )}
      </div>
    </section>
  );
}
