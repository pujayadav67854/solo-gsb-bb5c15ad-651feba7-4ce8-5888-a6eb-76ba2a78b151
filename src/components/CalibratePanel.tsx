import { useMemo, useState } from 'react';
import {
  previewMappedTime,
  type CalibAnchor,
  type CalibFit,
  type CalibOptions,
} from '../lib/calibrate';
import type { Cue } from '../lib/srt';
import { formatTimecode } from '../lib/srt';

const PAGE = 50;

interface CalibratePanelProps {
  nameA: string;
  nameB: string;
  cuesA: Cue[];
  cuesB: Cue[];
  anchors: CalibAnchor[];
  /** 基于 anchors 与 disabled 拟合出的当前方案（由父级 useMemo 计算） */
  fit: CalibFit;
  options: CalibOptions;
  onOptions(next: CalibOptions): void;
  /** 自动保留但被用户手动禁用的锚点 key */
  disabled: ReadonlySet<string>;
  /** 被自动剔除但由用户手动强制启用的锚点 key */
  forced: ReadonlySet<string>;
  onToggle(key: string): void;
  onReset(): void;
  /** 校准是否已被应用（当前对齐使用的是校准后的 B） */
  applied: boolean;
  /** 迁移模式：从工作区带着旧对齐组进入，应用按钮只生成迁移预览而不直接替换工作区 */
  migrateMode?: boolean;
  aligning: boolean;
  /** Worker 创建或对齐计算失败时的原因 */
  alignError?: string | null;
  onApply(): void;
  /** 取消正在进行的对齐 / 迁移预览计算 */
  onCancel(): void;
  /** 用原始 B 时间直接进入对齐（一键恢复原始 B 时间） */
  onUseOriginal(): void;
  onBack(): void;
}

type RowStatus = 'active' | 'off' | 'dropped';

const reasonLabel: Record<string, string> = {
  order: '顺序冲突',
  duplicate: '时间重复',
  outlier: '异常偏移',
};

export function CalibratePanel(props: CalibratePanelProps) {
  const { cuesA, cuesB, anchors, options, disabled, forced, fit } = props;
  const [shown, setShown] = useState(PAGE);

  const activeCount = fit.active.length;
  const keptCount = anchors.filter((a) => a.autoKept).length;
  const reasons: Record<string, number> = { order: 0, duplicate: 0, outlier: 0 };
  anchors
    .filter((a) => !a.autoKept)
    .forEach((a) => {
      if (a.dropReason) reasons[a.dropReason]++;
    });

  const setOpts = (patch: Partial<CalibOptions>) => props.onOptions({ ...options, ...patch });

  const statusOf = (a: CalibAnchor): RowStatus =>
    !a.autoKept && !forced.has(a.key)
      ? 'dropped'
      : a.autoKept && disabled.has(a.key)
        ? 'off'
        : 'active';

  const ordered = useMemo(
    () =>
      [...anchors].sort((x, y) => {
        const ax = x.autoKept ? !disabled.has(x.key) : forced.has(x.key);
        const ay = y.autoKept ? !disabled.has(y.key) : forced.has(y.key);
        if (ax !== ay) return ax ? -1 : 1;
        return cuesB[x.bIdx].start - cuesB[y.bIdx].start;
      }),
    [anchors, cuesB, disabled, forced],
  );

  const resid = fit.active
    .map((a) => fit.residuals.get(a.key))
    .filter((r): r is number => typeof r === 'number');
  const rms = resid.length
    ? Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / resid.length)
    : null;
  const maxAbs = resid.length ? Math.max(...resid.map((r) => Math.abs(r))) : null;

  return (
    <section className="calibrate">
      <div className="cal-head">
        <div className="cal-title">
          <h2>{props.migrateMode ? '重新校准并迁移审校决定' : '时间轴校准'}</h2>
          <p>
            自动从两侧文本筛选高相似锚点，剔除顺序冲突与异常偏移后，用分段线性映射校正
            <strong> {props.nameB} </strong>
            的时间轴（参考 <strong>{props.nameA}</strong>）。
            {props.migrateMode ? (
              <>
                应用后会用新校准对相同两份字幕重新对齐，先预览可迁移、歧义与无对应的旧组，
                确认后才一次提交；<strong>取消则旧工作区保持不变</strong>。
              </>
            ) : (
              <>仅点击「应用校准」才会替换对齐输入。</>
            )}
          </p>
        </div>
        <div className="cal-actions">
          <button className="btn ghost sm" onClick={props.onBack}>
            {props.migrateMode ? '← 取消，保留旧工作区' : '← 返回导入'}
          </button>
        </div>
      </div>

      <div className="wrap-settings cal-settings">
        <label>
          最低文本相似度
          <input
            type="number"
            min={0.3}
            max={0.99}
            step={0.01}
            value={options.minSim}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) setOpts({ minSim: Math.min(0.99, Math.max(0.3, v)) });
            }}
          />
        </label>
        <label>
          最短文本（字）
          <input
            type="number"
            min={2}
            max={100}
            step={1}
            value={options.minLength}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) setOpts({ minLength: Math.min(100, Math.max(2, Math.round(v))) });
            }}
          />
        </label>
        <label>
          偏移容忍（毫秒）
          <input
            type="number"
            min={100}
            max={10000}
            step={100}
            value={options.outlierTolMs}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v))
                setOpts({ outlierTolMs: Math.min(10000, Math.max(100, Math.round(v))) });
            }}
          />
        </label>
        <span className="spacer" />
        <button
          className="btn sm"
          disabled={disabled.size === 0 && forced.size === 0}
          onClick={props.onReset}
          title="清空手动禁用与强制启用，恢复自动筛选结果"
        >
          重置锚点选择
        </button>
      </div>

      <div className="cal-summary">
        <span className="stat-chip">
          候选锚点 <strong>{anchors.length}</strong>
        </span>
        <span className="stat-chip ok">
          自动保留 <strong>{keptCount}</strong>
        </span>
        <span className="stat-chip">
          启用中 <strong>{activeCount}</strong>
        </span>
        {(reasons.order > 0 || reasons.duplicate > 0 || reasons.outlier > 0) && (
          <span className="stat-chip bad">
            已剔除：顺序冲突 {reasons.order} · 时间重复 {reasons.duplicate} · 异常偏移 {reasons.outlier}
          </span>
        )}
        {rms !== null && (
          <span className="stat-chip">
            留一残差 RMS <strong>{rms.toFixed(0)} ms</strong> · 最大 {maxAbs?.toFixed(0)} ms
          </span>
        )}
        {props.applied && <span className="stat-chip ok">✓ 校准已应用于当前对齐</span>}
      </div>

      {activeCount < 2 ? (
        <div className="cal-notice warn">
          可用锚点不足 2 个（当前 {activeCount} 个），无法构建分段线性映射。请放宽筛选参数、检查两侧文本，或直接用原始
          B 时间开始对齐。
        </div>
      ) : (
        <div className="cal-notice ok">
          已基于 {activeCount} 个锚点构建 {fit.segments.length} 个线性区段，首尾按最近区段斜率外推；映射后各条字幕开始/结束单调且时长为正。
          {props.applied && <em> · 当前对齐已使用校准后的 B 时间，可重新应用或恢复原始时间。</em>}
        </div>
      )}

      <div className="cal-table-wrap">
        <table className="cal-table">
          <thead>
            <tr>
              <th className="col-toggle">启用</th>
              <th className="col-idx">A# / B#</th>
              <th className="col-text">锚点文本</th>
              <th className="col-sim">相似度</th>
              <th className="col-time">A 时间（参考）</th>
              <th className="col-time">B 原时间</th>
              <th className="col-time">B 新时间</th>
              <th className="col-res">残差 / 偏差</th>
              <th className="col-flag">状态</th>
            </tr>
          </thead>
          <tbody>
            {ordered.slice(0, shown).map((a) => {
              const ca = cuesA[a.aIdx];
              const cb = cuesB[a.bIdx];
              const st = statusOf(a);
              const residual = fit.residuals.get(a.key);
              const deviation = fit.deviations.get(a.key);
              const newStart = Math.max(0, Math.round(previewMappedTime(fit, cb.start)));
              const drift = newStart - cb.start;
              return (
                <tr key={a.key} className={`cal-row ${st}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={st === 'active'}
                      onChange={() => props.onToggle(a.key)}
                    />
                  </td>
                  <td className="mono">
                    {a.aIdx + 1} / {a.bIdx + 1}
                  </td>
                  <td className="cal-text" title={ca.text}>
                    <span className="cal-line a">{oneLine(ca.text)}</span>
                    <span className="cal-line b">{oneLine(cb.text)}</span>
                  </td>
                  <td className="mono">{(a.textSim * 100).toFixed(1)}%</td>
                  <td className="mono">{formatTimecode(ca.start)}</td>
                  <td className="mono">{formatTimecode(cb.start)}</td>
                  <td className="mono">
                    {fit.ok ? (
                      <>
                        {formatTimecode(newStart)}
                        <span className={`drift ${drift >= 0 ? 'plus' : 'minus'}`}>
                          {' '}
                          {drift >= 0 ? '+' : ''}
                          {(drift / 1000).toFixed(2)}s
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="mono">
                    {st === 'active' ? (
                      residual === null || residual === undefined ? (
                        <span className="tag dim">留一不足</span>
                      ) : (
                        <span className={`res ${resClass(residual, options.outlierTolMs)}`}>
                          {residual >= 0 ? '+' : ''}
                          {residual.toFixed(0)} ms
                        </span>
                      )
                    ) : deviation !== undefined ? (
                      <span
                        className={`res ${resClass(deviation, options.outlierTolMs)}`}
                        title="相对当前映射的偏差"
                      >
                        {deviation >= 0 ? '+' : ''}
                        {deviation.toFixed(0)} ms
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {st === 'active' ? (
                      a.autoKept ? (
                        <span className="tag ok">已启用</span>
                      ) : (
                        <span className="tag go" title="该锚点被自动剔除，已被手动强制启用">
                          手动启用
                        </span>
                      )
                    ) : st === 'off' ? (
                      <span className="tag go">手动禁用</span>
                    ) : (
                      <span className="tag bad" title="自动筛选已剔除，调整参数或勾选可重新启用">
                        {reasonLabel[a.dropReason ?? 'order']}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {anchors.length === 0 && (
          <div className="empty">当前参数下没有找到高相似锚点，请放宽相似度或最短文本限制。</div>
        )}
        {ordered.length > shown && (
          <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
            显示更多（剩余 {ordered.length - shown} 个锚点）
          </button>
        )}
      </div>

      <div className="cal-footer">
        <div className="cal-segments">
          {fit.ok && fit.segments.length > 0 && (
            <details>
              <summary>查看 {fit.segments.length} 个映射区段（斜率 / 截距）</summary>
              <ol className="seg-list">
                {fit.segments.map((s, i) => (
                  <li key={i} className="mono">
                    区段 {i + 1}：B {formatTimecode(s.b0)}~{formatTimecode(s.b1)} → A{' '}
                    {formatTimecode(s.a0)}~{formatTimecode(s.a1)}，斜率 {s.slope.toFixed(4)}
                  </li>
                ))}
                <li className="mono dim">
                  首段外推：A = {formatTimecode(fit.segments[0].a0)} +{' '}
                  {fit.segments[0].slope.toFixed(4)}·(B − {formatTimecode(fit.segments[0].b0)})
                </li>
              </ol>
            </details>
          )}
          {props.aligning && (
            <span className="hint busy-hint">
              <span className="spinner" aria-hidden="true" />
              {props.migrateMode ? '正在后台重新对齐并计算迁移预览' : '正在后台执行顺序对齐'}
              ，页面可继续操作，结果返回前可取消。
            </span>
          )}
          {!props.aligning && props.alignError && (
            <span className="hint error-hint" role="alert">
              {props.migrateMode ? '迁移预览计算失败：' : '对齐失败：'}
              {props.alignError}。可再次发起。
            </span>
          )}
        </div>
        <span className="spacer" />
        {props.aligning ? (
          <button className="btn warn lg" onClick={props.onCancel}>
            取消计算
          </button>
        ) : (
          <button className="btn ghost lg" onClick={props.onUseOriginal}>
            {props.migrateMode ? '用原始 B 时间重新对齐并预览' : '恢复原始 B 时间并对齐'}
          </button>
        )}
        <button
          className="btn primary lg"
          disabled={props.aligning || (!props.migrateMode && activeCount < 2)}
          onClick={props.onApply}
        >
          {props.aligning
            ? props.migrateMode
              ? '预览计算中…'
              : '对齐中…'
            : props.migrateMode
              ? '应用新校准并预览迁移'
              : props.applied
                ? '重新应用校准并对齐'
                : '应用校准并开始对齐'}
        </button>
      </div>
    </section>
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 60);
}

function resClass(r: number, tol: number): string {
  const a = Math.abs(r);
  if (a <= tol) return 'good';
  if (a <= tol * 2) return 'warn';
  return 'bad';
}
