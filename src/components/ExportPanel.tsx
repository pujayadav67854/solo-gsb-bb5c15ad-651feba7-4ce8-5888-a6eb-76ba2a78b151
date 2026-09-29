import type { MergeIssue } from '../lib/merge';

interface ExportPanelProps {
  conflictCount: number;
  resolvedCount: number;
  unresolved: number;
  issues: MergeIssue[];
  autoFix: boolean;
  onAutoFix(v: boolean): void;
  cueCount: number;
  /** 识别出的滚动字幕链总数 */
  dedupChains: number;
  /** 已采纳消重的链数 */
  dedupApplied: number;
  /** 已采纳链累计节省的重复字符数 */
  dedupSaved: number;
  /** 已应用智能断行的条数 */
  wrapApplied: number;
  /** 无法满足断行限制、保持原文的条数 */
  wrapFailed: number;
  /** 阅读节奏超限区段总数 */
  paceSegments: number;
  /** 已采纳的阅读节奏修复区段数 */
  paceApplied: number;
  /** 无解（保持原时间）的区段数 */
  paceUnsolvable: number;
  /** 当前切点列表的切点数（0 表示未使用切点吸附） */
  snapCuts: number;
  /** 全局方案中可吸附（有边界移动）的条数 */
  snapMovable: number;
  /** 已采纳切点吸附的条数 */
  snapApplied: number;
  /** 当前切点与参数下是否存在可行吸附方案 */
  snapOk: boolean;
  /** 原始时间下跨镜头的字幕数 */
  snapCrossingBefore: number;
  /** 最优方案下跨镜头的字幕数 */
  snapCrossingAfter: number;
  preview: string;
  canExport: boolean;
  onExport(): void;
  onJump(groupIndex: number): void;
}

export function ExportPanel(props: ExportPanelProps) {
  const { unresolved, issues, canExport } = props;
  let disabledReason = '';
  if (props.cueCount === 0) disabledReason = '没有可导出的字幕';
  if (unresolved > 0) disabledReason = `还有 ${unresolved} 个未解决冲突`;
  else if (issues.length > 0) disabledReason = `存在 ${issues.length} 个校验错误`;

  return (
    <aside className="export-panel">
      <h2 className="panel-title">合并与导出</h2>

      <ul className="checklist">
        <li className={unresolved === 0 ? 'pass' : 'fail'}>
          <span className="check-ic">{unresolved === 0 ? '✓' : '!'}</span>
          冲突解决：{props.resolvedCount}/{props.conflictCount}
          {unresolved > 0 && <em>（未处理冲突不得导出）</em>}
        </li>
        <li className={issues.length === 0 ? 'pass' : 'fail'}>
          <span className="check-ic">{issues.length === 0 ? '✓' : '!'}</span>
          时间单调性校验：{issues.length === 0 ? '通过' : `${issues.length} 个错误`}
        </li>
        <li className="pass">
          <span className="check-ic">✓</span>
          输出 {props.cueCount} 条字幕（导出时从 1 重新编号）
        </li>
        <li className={props.dedupChains === 0 ? 'pass' : props.dedupApplied > 0 ? 'pass' : 'warn'}>
          <span className="check-ic">{props.dedupChains === 0 || props.dedupApplied > 0 ? '✓' : '!'}</span>
          滚动字幕消重：已采纳 {props.dedupApplied}/{props.dedupChains} 链
          {props.dedupApplied > 0 && <em>（节省 {props.dedupSaved} 个重复字符）</em>}
          {props.dedupChains > 0 && props.dedupApplied === 0 && <em>（尚未采纳，预览为未消重结果）</em>}
        </li>
        <li className={props.wrapFailed === 0 ? 'pass' : 'warn'}>
          <span className="check-ic">{props.wrapFailed === 0 ? '✓' : '!'}</span>
          智能断行：已应用 {props.wrapApplied} 条
          {props.wrapFailed > 0 && <em>（{props.wrapFailed} 条无法满足限制，保持原文）</em>}
        </li>
        <li className={props.paceSegments === 0 ? 'pass' : props.paceApplied > 0 ? 'pass' : 'warn'}>
          <span className="check-ic">
            {props.paceSegments === 0 || props.paceApplied > 0 ? '✓' : '!'}
          </span>
          阅读节奏：已采纳 {props.paceApplied}/{props.paceSegments} 区段
          {props.paceUnsolvable > 0 && <em>（{props.paceUnsolvable} 个区段无解，保持原时间）</em>}
          {props.paceSegments > 0 && props.paceApplied === 0 && props.paceUnsolvable === 0 && (
            <em>（尚未采纳，预览为原时间）</em>
          )}
        </li>
        <li
          className={
            props.snapCuts === 0 || !props.snapOk
              ? 'pass'
              : props.snapMovable === 0
                ? 'pass'
                : props.snapApplied > 0
                  ? 'pass'
                  : 'warn'
          }
        >
          <span className="check-ic">
            {props.snapCuts === 0 || !props.snapOk || props.snapMovable === 0 ||
            props.snapApplied > 0
              ? '✓'
              : '!'}
          </span>
          镜头切点吸附：
          {props.snapCuts === 0
            ? '未提供切点'
            : !props.snapOk
              ? '当前参数无解（保持原时间）'
              : props.snapMovable === 0
                ? `切点 ${props.snapCuts} 个，无需吸附`
                : `已采纳 ${props.snapApplied}/${props.snapMovable} 条（跨镜头 ${props.snapCrossingBefore} → ${props.snapCrossingAfter}）`}
          {props.snapCuts > 0 &&
            props.snapOk &&
            props.snapMovable > 0 &&
            props.snapApplied === 0 && <em>（尚未采纳，预览为原时间）</em>}
        </li>
      </ul>

      <label className="autofix">
        <input
          type="checkbox"
          checked={props.autoFix}
          onChange={(e) => props.onAutoFix(e.target.checked)}
        />
        自动修复时间重叠 / 非单调问题
      </label>

      {issues.length > 0 && (
        <div className="issues">
          {issues.map((it, i) => (
            <button key={i} className="issue" onClick={() => props.onJump(it.groupIndex)}>
              {it.message}
            </button>
          ))}
        </div>
      )}

      <h3 className="panel-sub">结果预览</h3>
      <pre className="preview">{props.preview || '（暂无内容）'}</pre>

      <button
        className="btn primary lg block"
        disabled={!canExport}
        title={canExport ? '下载 merged.srt' : disabledReason}
        onClick={props.onExport}
      >
        {canExport ? '下载合并 SRT' : disabledReason || '暂不可导出'}
      </button>
    </aside>
  );
}
