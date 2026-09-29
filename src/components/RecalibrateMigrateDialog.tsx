import { useMemo, useState } from 'react';
import type { AlignGroup, GroupKind } from '../lib/align';
import { mergedText } from '../lib/merge';
import type { MigrationEntry, MigrationPlan } from '../lib/migrate';
import type { Cue } from '../lib/srt';

const KIND_LABEL: Record<GroupKind, string> = {
  '1:1': '一对一',
  '1:N': '一对多',
  'N:1': '多对一',
  'A-only': '仅 A',
  'B-only': '仅 B',
};

interface RecalibrateMigrateProps {
  open: boolean;
  busy: boolean;
  /** Worker 创建或迁移预览计算失败时的原因 */
  error?: string | null;
  oldGroupCount: number;
  newGroups: AlignGroup[] | null;
  newCuesA: Cue[];
  newCuesB: Cue[];
  plan: MigrationPlan | null;
  /** 新校准是否已应用（校准后的 B 时间轴） */
  calibrated: boolean;
  anchorCount: number;
  onClose(): void;
  /** Worker 失败后用相同参数再次发起计算 */
  onRetry(): void;
  onConfirm(): void;
}

const PAGE = 50;

export function RecalibrateMigrateDialog({
  open,
  busy,
  error,
  oldGroupCount,
  newGroups,
  newCuesA,
  newCuesB,
  plan,
  calibrated,
  anchorCount,
  onClose,
  onRetry,
  onConfirm,
}: RecalibrateMigrateProps) {
  const [shown, setShown] = useState(PAGE);
  if (!open) return null;

  const body = () => {
    if (busy) {
      return (
        <div className="rm-notice">
          <span className="spinner" aria-hidden="true" />
          正在用新校准重新对齐并比对旧工作区…
        </div>
      );
    }
    if (error) {
      return (
        <div className="rm-notice warn">{`迁移预览计算失败：${error}。旧工作区保持原样，可重新发起计算或取消返回。`}</div>
      );
    }
    if (!plan || !newGroups) {
      return <div className="rm-notice">尚未生成新对齐方案。</div>;
    }
    if (!plan.ok) {
      return (
        <div className="rm-notice warn">
          新旧对齐组数量过大（旧 {plan.oldCount} 组、新 {plan.newCount} 组），浏览器内无法在
          合理时间内完成全量最优匹配判定。请取消后在更小的字幕上使用本功能。
        </div>
      );
    }
    return (
      <PlanBody
        plan={plan}
        newGroups={newGroups}
        newCuesA={newCuesA}
        newCuesB={newCuesB}
        shown={shown}
        setShown={setShown}
      />
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal rm-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-head">
          <h2>重新校准并迁移审校决定</h2>
          <button className="btn-mini" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="rm-intro">
          旧对齐组与人工文本选择已保留；将
          {calibrated ? `按新校准（${anchorCount} 个锚点）` : '按原始 B 时间'}
          对相同两份字幕重新对齐，再把旧决定迁移到新组。匹配仅依据
          <strong>两侧各自拼接后的原始文本完全相同</strong>
          ，全局求组数最多的顺序一对一方案、不允许交叉；只有在所有最优方案中都对应同一新组的旧组才会迁移其文本选择与单边保留/丢弃决定，重复台词有歧义时不会按下标猜配。
        </p>
        {plan?.ok && (
          <div className="rm-summary">
            <span className="stat-chip">
              旧组 <strong>{oldGroupCount}</strong>
            </span>
            <span className="stat-chip">
              新组 <strong>{plan.newCount}</strong>
            </span>
            <span className="stat-chip ok">
              可迁移 <strong>{plan.transfer.length}</strong>
            </span>
            <span className="stat-chip warn">
              歧义不迁移 <strong>{plan.ambiguous.length}</strong>
            </span>
            <span className="stat-chip bad">
              无对应 <strong>{plan.none.length}</strong>
            </span>
            <span className="stat-chip">
              最优配对数 <strong>{plan.matchCount}</strong>
            </span>
          </div>
        )}
        <div className="rm-body">{body()}</div>
        <footer className="modal-foot">
          <span className="rm-hint">
            时间选择一律使用新组默认值；消重、断行、节奏与切点吸附的采纳将被清空，迁移后可继续冲突处理、预览与导出。
          </span>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            {busy ? '取消计算（保留旧工作区）' : '取消（保留旧工作区）'}
          </button>
          {error && !busy && (
            <button className="btn warn" onClick={onRetry}>
              重新计算
            </button>
          )}
          <button
            className="btn primary"
            onClick={onConfirm}
            disabled={busy || !!error || !plan?.ok}
          >
            确认并一次提交
          </button>
        </footer>
      </div>
    </div>
  );
}

function PlanBody({
  plan,
  newGroups,
  newCuesA,
  newCuesB,
  shown,
  setShown,
}: {
  plan: MigrationPlan;
  newGroups: AlignGroup[];
  newCuesA: Cue[];
  newCuesB: Cue[];
  shown: number;
  setShown(n: number): void;
}) {
  // 按旧组顺序合并三类条目展示
  const ordered = useMemo(() => {
    const map = new Map<number, MigrationEntry>();
    [...plan.transfer, ...plan.ambiguous, ...plan.none].forEach((e) => map.set(e.oldIndex, e));
    return [...map.values()].sort((a, b) => a.oldIndex - b.oldIndex);
  }, [plan]);

  const visible = ordered.slice(0, shown);

  return (
    <div className="rm-sections">
      <div className="rm-legend">
        <SectionTitle cls="ok" count={plan.transfer.length} label="可迁移" text="这些旧组在所有最优方案中都唯一对应同一新组，提交后迁移其 A/B/自定义文本选择，或单边保留/丢弃决定。" />
        <SectionTitle cls="warn" count={plan.ambiguous.length} label="歧义 · 不迁移" text="重复台词或多种最优配法导致对应关系不唯一，提交后这些组按新组默认处理，需要时请人工重新决定。" />
        <SectionTitle cls="bad" count={plan.none.length} label="无对应" text="重新校准后没有文本完全一致的新组，旧决定作废。" />
      </div>

      <table className="rm-table">
        <thead>
          <tr>
            <th className="col-old">旧组</th>
            <th className="col-st">状态</th>
            <th className="col-new">对应新组</th>
            <th className="col-text">旧组 A / B 拼接文本</th>
            <th className="col-text">新组 A / B 拼接文本</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((e) => {
            const ni = e.status === 'transfer' ? e.candidateNewIndexes[0] : -1;
            const ng = ni >= 0 ? newGroups[ni] : null;
            return (
              <tr key={e.oldIndex} className={`rm-row ${rowCls(e.status)}`}>
                <td className="mono">
                  #{e.oldIndex + 1} · {KIND_LABEL[e.kind]}
                </td>
                <td>
                  <StatusTag status={e.status} reason={e.reason} />
                </td>
                <td className="mono">
                  {e.status === 'transfer' ? (
                    <>
                      #{ni + 1}
                      <span className="rm-new-kind"> · {ng && KIND_LABEL[ng.kind]}</span>
                    </>
                  ) : e.status === 'ambiguous' ? (
                    e.candidateNewIndexes.map((j) => `#${j + 1}`).join(' / ') || '（仅可跳过）'
                  ) : (
                    '—'
                  )}
                </td>
                <td className="rm-text">
                  <span className="cal-line a">{oneLine(e.aText) || '（无 A）'}</span>
                  <span className="cal-line b">{oneLine(e.bText) || '（无 B）'}</span>
                </td>
                <td className="rm-text">
                  {ng ? (
                    <>
                      <span className="cal-line a">
                        {oneLine(mergedText(newCuesA, ng.aIdx)) || '（无 A）'}
                      </span>
                      <span className="cal-line b">
                        {oneLine(mergedText(newCuesB, ng.bIdx)) || '（无 B）'}
                      </span>
                    </>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {ordered.length === 0 && <div className="empty">没有旧组需要迁移。</div>}
      {ordered.length > shown && (
        <button className="btn more" onClick={() => setShown(shown + PAGE)}>
          显示更多（剩余 {ordered.length - shown} 组）
        </button>
      )}
      {plan.newUnmatched.length > 0 && (
        <p className="rm-unmatched">
          另有 {plan.newUnmatched.length} 个新组无旧对应（
          {plan.newUnmatched.slice(0, 12).map((j) => `#${j + 1}`).join('、')}
          {plan.newUnmatched.length > 12 ? ' …' : ''}），全部按新组默认处理。
        </p>
      )}
    </div>
  );
}

function SectionTitle({ cls, count, label, text }: { cls: string; count: number; label: string; text: string }) {
  return (
    <span className={`rm-legend-item ${cls}`} title={text}>
      <span className="rm-dot" />
      {label} <strong>{count}</strong>
    </span>
  );
}

function StatusTag({ status, reason }: { status: MigrationEntry['status']; reason?: string }) {
  if (status === 'transfer') return <span className="tag ok">可迁移</span>;
  if (status === 'none') return <span className="tag bad">无对应</span>;
  return (
    <span
      className="tag warn"
      title={reason === 'multi-partner' ? '该旧组可对应多个新组' : '存在跳过该旧组的最优方案'}
    >
      歧义{reason === 'multi-partner' ? '（多个新组）' : '（可跳过）'}
    </span>
  );
}

function rowCls(status: MigrationEntry['status']): string {
  return status === 'transfer' ? 'ok' : status === 'ambiguous' ? 'warn' : 'bad';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 80);
}
