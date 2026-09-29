import { useMemo, useRef, useState } from 'react';
import type { MergedCue } from '../lib/merge';
import {
  overlapsHalfOpen,
  type OcclusionParseResult,
  type TrackPlan,
} from '../lib/occlude';
import { formatTimecode } from '../lib/srt';

const PAGE = 50;

interface OccludePanelProps {
  /** 上游最终合并字幕条数（只读，绝不修改合并结果） */
  sourceCount: number;
  /** 上游合并结果当前是否可导出（无未解决冲突 / 校验错误 / 非空） */
  sourceReady: boolean;
  /** 遮挡列表原文（文本框） */
  occText: string;
  onOccText(text: string): void;
  /** 遮挡列表解析结果 */
  parsed: OcclusionParseResult;
  /** 上游最终字幕（用于逐条预览时间与文本） */
  cues: MergedCue[];
  /** 全局轨道分配方案（含逐条可用性与遮挡依据） */
  plan: TrackPlan;
  /** 是否允许下载轨道分配 CSV */
  canDownload: boolean;
  /** 不允许下载时的原因 */
  downloadReason: string;
  onDownload(): void;
}

const fmtRange = (start: number, end: number) =>
  `${formatTimecode(start)} → ${formatTimecode(end)}`;

export function OccludePanel(props: OccludePanelProps) {
  const { parsed, cues, plan, occText } = props;
  const [shown, setShown] = useState(PAGE);
  const fileRef = useRef<HTMLInputElement>(null);

  const nonEmptyLines = useMemo(
    () => occText.split('\n').filter((l) => l.trim().length > 0).length,
    [occText],
  );
  const hasError = parsed.invalid.length > 0;
  const topOcc = parsed.occlusions.filter((o) => o.track === 'top').length;

  // 每个遮挡区间命中（半开区间相交）的字幕条数，供遮挡依据展示
  const occHits = useMemo(
    () =>
      parsed.occlusions.map(
        (o) => cues.filter((c) => overlapsHalfOpen(c.start, c.end, o.start, o.end)).length,
      ),
    [parsed, cues],
  );

  const fail = !plan.ok && plan.failIndex >= 0 ? plan.failIndex : -1;
  const failCue = fail >= 0 ? cues[fail] : null;
  const failBlock = fail >= 0 ? plan.blocks[fail] : null;

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => props.onOccText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  /** 逐条遮挡依据文案。 */
  const basisOf = (i: number): string => {
    const b = plan.blocks[i];
    const lines = (hits: { line: number }[]) => hits.map((h) => h.line).join('、');
    if (!b.topOk && !b.bottomOk) {
      return `上轨被第 ${lines(b.topHits)} 行遮挡，下轨被第 ${lines(b.bottomHits)} 行遮挡，两轨均不可用`;
    }
    if (!b.topOk) return `上轨被第 ${lines(b.topHits)} 行遮挡 → 只能下轨`;
    if (!b.bottomOk) return `下轨被第 ${lines(b.bottomHits)} 行遮挡 → 只能上轨`;
    return plan.tracks[i] === 'top'
      ? '双轨可用 · 为减少轨道切换改到上轨'
      : '双轨可用 · 默认下轨';
  };

  return (
    <section className="wrap-panel occlude-panel">
      <div className="snap-input">
        <div className="snap-input-head">
          <strong>遮挡区间列表</strong>
          <span className="tag dim">每行：起点毫秒 终点毫秒 上/下</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            上传遮挡文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.tsv,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = '';
            }}
          />
          {occText.length > 0 && (
            <button className="btn sm" onClick={() => props.onOccText('')}>
              清空
            </button>
          )}
        </div>
        <textarea
          className="snap-paste"
          placeholder={'逐行填写遮挡区间的起止毫秒与位置（上/下），例如：\n5000 12000 上\n20000 26500 下\n半开区间相交即占用该位置；端点相接不算遮挡'}
          value={occText}
          spellCheck={false}
          onChange={(e) => props.onOccText(e.target.value)}
        />
        {nonEmptyLines > 0 && (
          <div className="snap-parse">
            {!hasError ? (
              <span className="tag ok">
                ✓ 已解析 {parsed.occlusions.length} 个遮挡区间（上轨 {topOcc} · 下轨{' '}
                {parsed.occlusions.length - topOcc}）
              </span>
            ) : (
              <span className="tag warn">
                ⚠ 第 {parsed.invalid.map((b) => b.line).join('、')} 行格式错误
                {parsed.occlusions.length > 0 && `，其余 ${parsed.occlusions.length} 行已解析`}
              </span>
            )}
            {parsed.invalid.slice(0, 5).map((b) => (
              <span className="snap-badline" key={b.line} title={b.reason}>
                第 {b.line} 行：{b.raw}（{b.reason}）
              </span>
            ))}
            {parsed.invalid.length > 5 && (
              <span className="snap-badline">…等 {parsed.invalid.length} 行</span>
            )}
          </div>
        )}
      </div>

      <div className="wrap-summary">
        上游最终字幕 {props.sourceCount} 条（只读） · 遮挡区间 {parsed.occlusions.length} 个
        {plan.ok && cues.length > 0 && (
          <>
            {' '}
            · 上轨 {plan.topCount} 条 · 下轨 {cues.length - plan.topCount} 条 · 轨道切换{' '}
            {plan.switches} 次
          </>
        )}
        <span className="wrap-hint">
          每条字幕默认下轨；先最少化相邻切换次数，再最少化上轨条数，并列时按字幕顺序优先下轨
        </span>
      </div>

      {!props.sourceReady && (
        <div className="we-fail">
          ⚠ 上游合并结果当前不可导出（仍有未解决冲突或校验错误，或结果为空）。遮挡避让模块只读展示，修正上游前禁止下载轨道 CSV。
        </div>
      )}

      {!hasError && failCue && failBlock && (
        <div className="we-fail">
          ✗ 第 {fail + 1} 条字幕（{fmtRange(failCue.start, failCue.end)}）两轨均被遮挡：
          上轨被第 {failBlock.topHits.map((h) => h.line).join('、')} 行遮挡，下轨被第{' '}
          {failBlock.bottomHits.map((h) => h.line).join('、')} 行遮挡。存在无解字幕，
          不生成、也不导出任何部分方案。
        </div>
      )}

      {parsed.occlusions.length > 0 && (
        <>
          <h3 className="panel-sub edit-sub">遮挡区间（半开区间相交即占用对应轨道）</h3>
          <div className="edit-segtable">
            {parsed.occlusions.slice(0, shown).map((o, i) => (
              <div className="edit-seg" key={`${i}-${o.line}`}>
                <span className="g-idx">#{i + 1}</span>
                <span className="tag dim">原文第 {o.line} 行</span>
                <span className="mono edit-time">{fmtRange(o.start, o.end)}</span>
                <span className={`tag ${o.track === 'top' ? 'go' : 'dim'}`}>
                  {o.track === 'top' ? '上轨' : '下轨'}
                </span>
                <span className="spacer" />
                {occHits[i] === 0 ? (
                  <span className="tag dim">未命中任何字幕</span>
                ) : (
                  <span className="tag low">遮挡 {occHits[i]} 条</span>
                )}
              </div>
            ))}
          </div>
          {parsed.occlusions.length > shown && (
            <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
              显示更多（剩余 {parsed.occlusions.length - shown} 个区间）
            </button>
          )}
        </>
      )}

      <h3 className="panel-sub edit-sub">轨道分配预览（逐条字幕的轨道与遮挡依据）</h3>
      {cues.length === 0 ? (
        <div className="empty">上游结果为空，没有需要分配轨道的字幕。</div>
      ) : !plan.ok ? (
        <div className="empty">存在两轨均被遮挡的字幕，无完整方案可预览。</div>
      ) : (
        <>
          <div className="occ-table">
            {cues.slice(0, shown).map((c, i) => (
              <div className="occ-row" key={i}>
                <span className="g-idx">#{i + 1}</span>
                <span className="mono occ-time">{fmtRange(c.start, c.end)}</span>
                <span className="occ-text" title={c.text}>
                  {c.text}
                </span>
                <span className={`tag occ-track ${plan.tracks[i] === 'top' ? 'go' : 'dim'}`}>
                  {plan.tracks[i] === 'top' ? '上轨' : '下轨'}
                </span>
                <span className="occ-basis">{basisOf(i)}</span>
              </div>
            ))}
          </div>
          {cues.length > shown && (
            <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
              显示更多（剩余 {cues.length - shown} 条）
            </button>
          )}
        </>
      )}

      <button
        className="btn primary lg block"
        disabled={!props.canDownload}
        title={props.canDownload ? '下载 tracks.csv' : props.downloadReason}
        onClick={props.onDownload}
      >
        {props.canDownload ? '下载轨道分配 CSV' : props.downloadReason || '暂不可下载'}
      </button>
    </section>
  );
}
