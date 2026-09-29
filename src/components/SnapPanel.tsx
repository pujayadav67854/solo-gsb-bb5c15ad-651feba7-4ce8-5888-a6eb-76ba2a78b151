import { useMemo, useRef, useState } from 'react';
import type { MergedCue } from '../lib/merge';
import {
  formatDelta,
  type CutParseResult,
  type SnapItem,
  type SnapOptions,
  type SnapPlan,
} from '../lib/snap';
import { formatTimecode } from '../lib/srt';

const PAGE = 50;

interface SnapPanelProps {
  /** 当前（已采纳消重、断行与节奏后的）字幕 */
  cues: MergedCue[];
  /** 当前切点与参数下的吸附方案 */
  plan: SnapPlan;
  /** 当前切点文本的解析结果（用于行数 / 非法行提示） */
  parsed: CutParseResult;
  /** 已采纳条目的 key 集合 */
  accepted: ReadonlySet<string>;
  /** 切点文本（粘贴框） */
  cutText: string;
  onCutText(text: string): void;
  options: SnapOptions;
  onOptions(next: SnapOptions): void;
  onAccept(key: string): void;
  onRestore(key: string): void;
  onAcceptAll(keys: string[]): void;
  onRestoreAll(): void;
}

type EntryStatus = 'applied' | 'ready' | 'keep' | 'fail';

const STATUS_LABEL: Record<EntryStatus, string> = {
  applied: '已采纳',
  ready: '可吸附',
  keep: '保持原位',
  fail: '无法求解',
};

const STATUS_CLS: Record<EntryStatus, string> = {
  applied: 'ok',
  ready: 'go',
  keep: 'dim',
  fail: 'warn',
};

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

function BoundaryCell({ it, which }: { it: SnapItem; which: 'start' | 'end' }) {
  const b = it[which];
  const label = which === 'start' ? '开始' : '结束';
  if (b.cut !== null && b.delta !== 0) {
    return (
      <span className="mono snap-new">
        {label} → {formatTimecode(b.at)}
        <span className="snap-delta">{formatDelta(b.delta)}</span>
      </span>
    );
  }
  if (b.cut !== null) {
    return (
      <span className="mono">
        {label} · {formatTimecode(b.at)}
        <span className="snap-hit">已在切点</span>
      </span>
    );
  }
  return (
    <span className="mono">
      {label} · {formatTimecode(b.from)}
      {b.reason && <span className="snap-reason" title={b.reason}>不吸附：{b.reason}</span>}
    </span>
  );
}

export function SnapPanel(props: SnapPanelProps) {
  const { cues, plan, parsed, accepted, options, cutText } = props;
  const [shown, setShown] = useState(PAGE);
  const fileRef = useRef<HTMLInputElement>(null);

  const itemKeys = useMemo(() => new Set(plan.items.map((it) => it.key)), [plan]);
  const liveAccepted = useMemo(() => {
    const s = new Set<string>();
    accepted.forEach((k) => {
      if (itemKeys.has(k)) s.add(k);
    });
    return s;
  }, [accepted, itemKeys]);

  const readyKeys = useMemo(
    () => (plan.ok ? plan.items.filter((it) => it.changed && !liveAccepted.has(it.key)).map((it) => it.key) : []),
    [plan, liveAccepted],
  );

  const statusOf = (it: SnapItem): EntryStatus => {
    if (!plan.ok) return 'fail';
    if (liveAccepted.has(it.key)) return 'applied';
    return it.changed ? 'ready' : 'keep';
  };

  const counts = useMemo(() => {
    const c = { applied: 0, ready: 0, keep: 0, fail: 0, crossing: 0 };
    plan.items.forEach((it) => {
      if (!plan.ok) c.fail++;
      else if (liveAccepted.has(it.key)) c.applied++;
      else if (it.changed) c.ready++;
      else c.keep++;
      if (it.oldCrossing) c.crossing++;
    });
    return c;
  }, [plan, liveAccepted]);

  const setOpts = (patch: Partial<SnapOptions>) => props.onOptions({ ...options, ...patch });
  const parseNum = (raw: string, fallback: number, lo: number, hi: number) => {
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => props.onCutText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const nonEmptyLines = cutText.split('\n').filter((l) => l.trim().length > 0).length;
  const duplicateCount = parsed.totalLines - parsed.cuts.length - parsed.invalid.length;

  return (
    <section className="wrap-panel snap-panel">
      <div className="snap-input">
        <div className="snap-input-head">
          <strong>镜头切点列表</strong>
          <span className="tag dim">每行一个 HH:MM:SS,mmm</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            上传切点文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.srt,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = '';
            }}
          />
          {cutText.length > 0 && (
            <button className="btn sm" onClick={() => props.onCutText('')}>
              清空
            </button>
          )}
        </div>
        <textarea
          className="snap-paste"
          placeholder={'粘贴切点，每行一个，例如：\n00:00:03,200\n00:00:08,520\n00:00:15,040'}
          value={cutText}
          spellCheck={false}
          onChange={(e) => props.onCutText(e.target.value)}
        />
        {nonEmptyLines > 0 && (
          <div className="snap-parse">
            {parsed.invalid.length === 0 ? (
              <span className="tag ok">
                ✓ 已解析 {parsed.cuts.length} 个切点
                {duplicateCount > 0 && `（去除 ${duplicateCount} 个重复）`}
              </span>
            ) : (
              <span className="tag warn">
                ⚠ {parsed.invalid.length} 行无法识别
                {parsed.cuts.length > 0 && `，其余 ${parsed.cuts.length} 个切点可用`}
              </span>
            )}
            {parsed.invalid.slice(0, 5).map((b) => (
              <span className="snap-badline" key={b.line} title={b.raw}>
                第 {b.line} 行：{b.raw}
              </span>
            ))}
            {parsed.invalid.length > 5 && <span className="snap-badline">…等 {parsed.invalid.length} 行</span>}
          </div>
        )}
      </div>

      <div className="wrap-settings">
        <label>
          吸附阈值（秒）
          <input
            type="number"
            min={0}
            max={10}
            step={0.05}
            value={options.thresholdMs / 1000}
            onChange={(e) =>
              setOpts({
                thresholdMs: Math.round(
                  parseNum(e.target.value, options.thresholdMs / 1000, 0, 10) * 1000,
                ),
              })
            }
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
                minDurMs: Math.round(
                  parseNum(e.target.value, options.minDurMs / 1000, 0.1, 30) * 1000,
                ),
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
        共 {cues.length} 条 · 切点 {parsed.cuts.length} 个 · 原跨镜头 {plan.originalCrossing} 条
        {plan.ok && <> → 方案后 {plan.cost.crossing} 条</>} · 边界总位移 {plan.cost.displacement} ms ·
        改动 {plan.cost.changed} 条 · 已采纳 {liveAccepted.size}
        {counts.ready > 0 && <em> · {counts.ready} 条可吸附</em>}
        {!plan.ok && <em> · 当前无解（保持原时间）</em>}
        <span className="wrap-hint">
          全局动态规划依次最小化：跨镜头字幕数 → 边界总位移 → 改动条数；只收缩边界、不改文本
        </span>
      </div>

      {!plan.ok && (
        <div className="we-fail">
          ⚠ {plan.reason}。无法给出满足顺序、相邻不重叠与最小时长的吸附方案，所有条目保持原时间。
        </div>
      )}

      <div className="wrap-list">
        {cues.length === 0 && <div className="empty">当前没有可处理的合并结果。</div>}
        {cues.length > 0 && parsed.cuts.length === 0 && (
          <div className="empty">
            请粘贴或上传镜头切点列表（每行一个 HH:MM:SS,mmm），系统将对切点附近的字幕边界试算吸附。
          </div>
        )}
        {parsed.cuts.length > 0 &&
          plan.items.slice(0, shown).map((it) => {
            const st = statusOf(it);
            return (
              <article className={`wrap-entry snap-entry ${st}`} key={it.key}>
                <div className="we-head">
                  <span className="g-idx">#{it.index + 1}</span>
                  <span className="cue-time">
                    {formatTimecode(it.oldStart)} → {formatTimecode(it.oldEnd)}
                    <span className="snap-dur">（{fmtSec(it.oldEnd - it.oldStart)}）</span>
                  </span>
                  {it.oldCrossing && (
                    <span className="tag warn">{it.newCrossing ? '仍跨切点' : '原跨切点'}</span>
                  )}
                  {!it.oldCrossing && it.newCrossing && <span className="tag warn">跨切点</span>}
                  {it.changed && (
                    <span className="tag dim">
                      位移 {Math.abs(it.start.delta) + Math.abs(it.end.delta)} ms
                    </span>
                  )}
                  <span className="spacer" />
                  <span className={`tag ${STATUS_CLS[st]}`}>{STATUS_LABEL[st]}</span>
                  {st === 'ready' && (
                    <button className="btn sm accent" onClick={() => props.onAccept(it.key)}>
                      采纳
                    </button>
                  )}
                  {st === 'applied' && (
                    <button className="btn sm" onClick={() => props.onRestore(it.key)}>
                      恢复
                    </button>
                  )}
                </div>

                <div className="snap-row">
                  <pre className="snap-text">{cues[it.index].text}</pre>
                  <div className="snap-times">
                    <BoundaryCell it={it} which="start" />
                    <span className="snap-arrow">›</span>
                    <BoundaryCell it={it} which="end" />
                    <span className="tag dim snap-newdur">
                      新时长 {fmtSec(it.newEnd - it.newStart)}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        {cues.length > 0 && parsed.cuts.length > 0 && plan.items.length > shown && (
          <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
            显示更多（剩余 {plan.items.length - shown} 条）
          </button>
        )}
      </div>
    </section>
  );
}
