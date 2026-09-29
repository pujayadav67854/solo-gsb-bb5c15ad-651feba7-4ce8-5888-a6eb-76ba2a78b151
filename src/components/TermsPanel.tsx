import { useMemo, useRef, useState } from 'react';
import type { TermCueResult, TermParseResult } from '../lib/terms';
import { formatTimecode } from '../lib/srt';

const PAGE = 50;

interface TermsPanelProps {
  /** 上游最终合并字幕条数（只读，绝不修改合并结果） */
  sourceCount: number;
  /** 上游合并结果当前是否可导出（无未解决冲突 / 校验错误 / 非空） */
  sourceReady: boolean;
  /** 术语表原文（文本框，每行 原词⇥替换词） */
  termsText: string;
  onTermsText(text: string): void;
  /** 术语表解析结果 */
  parsed: TermParseResult;
  /** 规范化后的逐条字幕（时间、条数与上游一致） */
  results: TermCueResult[];
  /** 命中总次数 / 发生变化的条数 */
  hitCount: number;
  changedCount: number;
  /** 规范化后 SRT 预览文本 */
  preview: string;
  /** 是否允许下载 terms.srt */
  canDownload: boolean;
  /** 不允许下载时的原因 */
  downloadReason: string;
  onDownload(): void;
}

const fmtRange = (start: number, end: number) =>
  `${formatTimecode(start)} → ${formatTimecode(end)}`;

/** 用于文本框展示的规则行（原词⇥替换词）。 */
const ruleRow = (line: number) => `第 ${line} 行`;

export function TermsPanel(props: TermsPanelProps) {
  const { parsed, results, termsText } = props;
  const [shown, setShown] = useState(PAGE);
  const fileRef = useRef<HTMLInputElement>(null);

  const nonEmptyLines = useMemo(
    () => termsText.split('\n').filter((l) => l.length > 0).length,
    [termsText],
  );
  const hasError = parsed.invalid.length > 0;

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => props.onTermsText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  return (
    <section className="wrap-panel terms-panel">
      <div className="snap-input">
        <div className="snap-input-head">
          <strong>术语表</strong>
          <span className="tag dim">每行：原词 ⇥ Tab ⇥ 替换词</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            上传术语文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.tsv,.tab,text/plain,text/tab-separated-values"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = '';
            }}
          />
          {termsText.length > 0 && (
            <button className="btn sm" onClick={() => props.onTermsText('')}>
              清空
            </button>
          )}
        </div>
        <textarea
          className="snap-paste"
          placeholder={'逐行填写原词与替换词，两列之间按 Tab，例如：\n因特网\t互联网\nWiFi\t无线网络\n区分大小写；标签 <...> 与换行不参与匹配但原样保留'}
          value={termsText}
          spellCheck={false}
          onChange={(e) => props.onTermsText(e.target.value)}
        />
        {nonEmptyLines > 0 && (
          <div className="snap-parse">
            {!hasError ? (
              <span className="tag ok">
                ✓ 已解析 {parsed.rules.length} 条规则
              </span>
            ) : (
              <span className="tag warn">
                ⚠ 第 {parsed.invalid.map((b) => b.line).join('、')} 行有误
                {parsed.rules.length > 0 && `，其余 ${parsed.rules.length} 行规则正常生效`}
              </span>
            )}
            {parsed.invalid.slice(0, 5).map((b) => (
              <span className="snap-badline" key={b.line} title={b.reason}>
                第 {b.line} 行：{b.raw === '' ? '（空白）' : b.raw}（{b.reason}）
              </span>
            ))}
            {parsed.invalid.length > 5 && (
              <span className="snap-badline">…等 {parsed.invalid.length} 行</span>
            )}
          </div>
        )}
      </div>

      <div className="wrap-summary">
        上游最终字幕 {props.sourceCount} 条（只读） · 有效规则 {parsed.rules.length} 条 ·
        规范化后 {results.length} 条 · 变化 {props.changedCount} 条 · 命中 {props.hitCount} 次
        <span className="wrap-hint">
          区分大小写、按字素字面量匹配；自左向右取最长原词；标签与换行不参与匹配但原样保留；时间、条数与原合并结果一致
        </span>
      </div>

      {!props.sourceReady && (
        <div className="we-fail">
          ⚠ 上游合并结果当前不可导出（仍有未解决冲突或校验错误，或结果为空）。术语统一模块只读展示，修正上游前禁止下载 terms.srt。
        </div>
      )}

      {parsed.rules.length > 0 && (
        <>
          <h3 className="panel-sub edit-sub">有效规则（{parsed.rules.length} 条）</h3>
          <div className="edit-segtable">
            {parsed.rules.slice(0, shown).map((r) => (
              <div className="edit-seg" key={r.line}>
                <span className="tag dim">{ruleRow(r.line)}</span>
                <span className="terms-word">{r.from}</span>
                <span className="edit-arrow">⇒</span>
                <span className="terms-word to">{r.to}</span>
              </div>
            ))}
          </div>
          {parsed.rules.length > shown && (
            <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
              显示更多（剩余 {parsed.rules.length - shown} 条规则）
            </button>
          )}
        </>
      )}

      <h3 className="panel-sub edit-sub">逐条规范化结果（前后文本与命中规则）</h3>
      {results.length === 0 ? (
        <div className="empty">上游结果为空，没有需要规范化的字幕。</div>
      ) : (
        <>
          <div className="terms-list">
            {results.slice(0, shown).map((c, i) => {
              const changed = c.hits.length > 0;
              return (
                <div className={`terms-entry ${changed ? 'hit' : ''}`} key={i}>
                  <div className="we-head">
                    <span className="g-idx">#{i + 1}</span>
                    <span className="mono occ-time">{fmtRange(c.start, c.end)}</span>
                    <span className="spacer" />
                    {changed ? (
                      <span className="tag ok">命中 {c.hits.length} 次</span>
                    ) : (
                      <span className="tag dim">未变化</span>
                    )}
                  </div>
                  <div className="we-cols">
                    <div className="we-col">
                      <div className="we-title">规范化前</div>
                      <pre>{c.before || '（空文本）'}</pre>
                    </div>
                    <div className="we-col">
                      <div className="we-title">规范化后</div>
                      <pre>{c.after || '（空文本）'}</pre>
                    </div>
                  </div>
                  {changed && (
                    <div className="terms-rules">
                      {c.hits.map((h, hi) => (
                        <span className="terms-rule" key={hi}>
                          <span className="tag dim">第 {h.line} 行</span>
                          <span className="terms-word">{h.from}</span>
                          <span className="edit-arrow">⇒</span>
                          <span className="terms-word to">{h.to}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {results.length > shown && (
            <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
              显示更多（剩余 {results.length - shown} 条）
            </button>
          )}
        </>
      )}

      <h3 className="panel-sub edit-sub">规范化 SRT 预览（序号从 1 重新编号）</h3>
      {results.length === 0 ? (
        <div className="empty">上游结果为空，暂无可预览内容。</div>
      ) : parsed.rules.length === 0 ? (
        <div className="empty">请先填写有效的术语表（每行用 Tab 分隔原词与替换词），系统将立即生成规范化副本。</div>
      ) : (
        <pre className="preview edit-preview">{props.preview || '（暂无内容）'}</pre>
      )}

      <button
        className="btn primary lg block"
        disabled={!props.canDownload}
        title={props.canDownload ? '下载 terms.srt' : props.downloadReason}
        onClick={props.onDownload}
      >
        {props.canDownload ? '下载术语统一 SRT' : props.downloadReason || '暂不可下载'}
      </button>
    </section>
  );
}
