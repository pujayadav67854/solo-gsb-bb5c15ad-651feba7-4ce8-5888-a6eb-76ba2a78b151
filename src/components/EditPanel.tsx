import { useMemo, useRef, useState } from 'react';
import type {
  EditedCue,
  SegmentParseResult,
  SegmentSpan,
} from '../lib/edit';
import { formatTimecode } from '../lib/srt';

const PAGE = 50;

interface EditPanelProps {
  /** 上游最终合并字幕条数（只读，绝不修改合并结果） */
  sourceCount: number;
  /** 上游合并结果当前是否可导出（无未解决冲突 / 校验错误 / 非空） */
  sourceReady: boolean;
  /** 片段列表原文（文本框） */
  segmentText: string;
  onSegmentText(text: string): void;
  /** 片段列表解析结果 */
  parsed: SegmentParseResult;
  /** 裁切重排后的剪辑版字幕 */
  edited: EditedCue[];
  /** 各片段成片落点与命中条数 */
  spans: SegmentSpan[];
  /** 成片总时长（毫秒） */
  totalDuration: number;
  /** 序列化后的剪辑版 SRT 预览文本 */
  preview: string;
  /** 是否允许下载剪辑版 SRT */
  canDownload: boolean;
  /** 不允许下载时的原因 */
  downloadReason: string;
  onDownload(): void;
}

const fmtDur = (ms: number) => `${(ms / 1000).toFixed(3)} 秒`;

export function EditPanel(props: EditPanelProps) {
  const { parsed, edited, spans, segmentText } = props;
  const [shown, setShown] = useState(PAGE);
  const fileRef = useRef<HTMLInputElement>(null);

  const nonEmptyLines = useMemo(
    () => segmentText.split('\n').filter((l) => l.trim().length > 0).length,
    [segmentText],
  );
  const emptySegs = spans.filter((s) => s.hits === 0).length;
  const hasError = parsed.invalid.length > 0;

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => props.onSegmentText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  return (
    <section className="wrap-panel edit-panel">
      <div className="snap-input">
        <div className="snap-input-head">
          <strong>源片段列表（剪辑点）</strong>
          <span className="tag dim">每行：起点毫秒 终点毫秒</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            上传片段文件
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
          {segmentText.length > 0 && (
            <button className="btn sm" onClick={() => props.onSegmentText('')}>
              清空
            </button>
          )}
        </div>
        <textarea
          className="snap-paste"
          placeholder={'按成片顺序逐行填写源片段的起止毫秒，例如：\n5000 12000\n20000 26500\n12000 20000\n允许重复、重叠与倒序片段；空白片段仍占时长'}
          value={segmentText}
          spellCheck={false}
          onChange={(e) => props.onSegmentText(e.target.value)}
        />
        {nonEmptyLines > 0 && (
          <div className="snap-parse">
            {!hasError ? (
              <span className="tag ok">
                ✓ 已解析 {parsed.segments.length} 个片段 · 成片总时长 {fmtDur(props.totalDuration)}
              </span>
            ) : (
              <span className="tag warn">
                ⚠ 第 {parsed.invalid.map((b) => b.line).join('、')} 行格式错误
                {parsed.segments.length > 0 && `，其余 ${parsed.segments.length} 行已解析`}
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
        上游最终字幕 {props.sourceCount} 条（只读） · 片段 {parsed.segments.length} 个 ·
        剪辑版字幕 {edited.length} 条 · 成片总时长 {fmtDur(props.totalDuration)}
        {emptySegs > 0 && <em> · {emptySegs} 个空白片段仍占时长</em>}
        <span className="wrap-hint">
          片段按原时长首尾拼接；每条字幕与半开区间求交，仅保留正时长交集；跨片段分别输出，重复片段重复输出，不合并相邻同文字幕
        </span>
      </div>

      {!props.sourceReady && (
        <div className="we-fail">
          ⚠ 上游合并结果当前不可导出（仍有未解决冲突或校验错误，或结果为空）。剪辑模块只读展示，修正上游前禁止下载剪辑版 SRT。
        </div>
      )}

      {parsed.segments.length > 0 && (
        <>
          <h3 className="panel-sub edit-sub">片段时间轴（行序即成片顺序）</h3>
          <div className="edit-segtable">
            {spans.slice(0, shown).map((s) => (
              <div
                className={`edit-seg ${s.hits === 0 ? 'empty' : ''}`}
                key={`${s.segIndex}-${s.segLine}`}
              >
                <span className="g-idx">#{s.segIndex + 1}</span>
                <span className="tag dim">原文第 {s.segLine} 行</span>
                <span className="mono edit-time">
                  {formatTimecode(s.srcStart)} → {formatTimecode(s.srcEnd)}
                </span>
                <span className="tag dim">{fmtDur(s.srcEnd - s.srcStart)}</span>
                <span className="edit-arrow">⇒</span>
                <span className="mono edit-time">
                  {formatTimecode(s.outStart)} → {formatTimecode(s.outEnd)}
                </span>
                <span className="spacer" />
                {s.hits === 0 ? (
                  <span className="tag low">空白片段 · 仍占时长</span>
                ) : (
                  <span className="tag ok">命中 {s.hits} 条</span>
                )}
              </div>
            ))}
          </div>
          {spans.length > shown && (
            <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
              显示更多（剩余 {spans.length - shown} 个片段）
            </button>
          )}
        </>
      )}

      <h3 className="panel-sub edit-sub">新时间轴预览（剪辑版 SRT，导出时从 1 重新编号）</h3>
      {parsed.segments.length === 0 ? (
        <div className="empty">
          请逐行填写源片段起止毫秒（非负整数，起点小于终点），系统将立即裁切重排出剪辑版时间轴。
        </div>
      ) : edited.length === 0 ? (
        <div className="empty">所有片段都没有与任何字幕相交，剪辑版结果为空（片段仍按时长占位）。</div>
      ) : (
        <pre className="preview edit-preview">{props.preview || '（暂无内容）'}</pre>
      )}

      <button
        className="btn primary lg block"
        disabled={!props.canDownload}
        title={props.canDownload ? '下载 edited.srt' : props.downloadReason}
        onClick={props.onDownload}
      >
        {props.canDownload ? '下载剪辑版 SRT' : props.downloadReason || '暂不可下载'}
      </button>
    </section>
  );
}
