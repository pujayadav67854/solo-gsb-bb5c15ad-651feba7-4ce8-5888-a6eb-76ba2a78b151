import { useState } from 'react';
import type { CueAtoms, LocateIndex, LocateResult } from '../lib/locate';
import { cueSegments } from '../lib/locate';
import { formatTimecode } from '../lib/srt';

const PAGE = 50;

interface LocatePanelProps {
  /** 上游最终合并字幕条数（只读，绝不修改合并结果） */
  sourceCount: number;
  /** 定位索引（finalCues 变化时由 App 重建） */
  index: LocateIndex;
  /** 短语输入原文 */
  phraseText: string;
  onPhraseText(text: string): void;
  /** 跨条最大间隔输入原文（非负整数毫秒） */
  gapText: string;
  onGapText(text: string): void;
  /** 检索结果（输入或上游变化即重算） */
  result: LocateResult;
}

const fmtRange = (start: number, end: number) =>
  `${formatTimecode(start)} → ${formatTimecode(end)}`;

/** 渲染一条内的高亮分段：仅命中字素加 <mark>，标签/换行原样输出。 */
function CuePart({ cue, atomStart, atomEnd }: { cue: CueAtoms; atomStart: number; atomEnd: number }) {
  return (
    <>
      {cueSegments(cue, atomStart, atomEnd).map((seg, i) =>
        seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

export function LocatePanel(props: LocatePanelProps) {
  const { result, index } = props;
  const [shown, setShown] = useState(PAGE);

  return (
    <section className="wrap-panel locate-panel">
      <div className="snap-input">
        <div className="snap-input-head">
          <strong>原文短语</strong>
          <span className="tag dim">区分大小写 · 按 Unicode 字素逐字匹配</span>
          <span className="spacer" />
          <label className="wrap-lock">
            允许跨条最大间隔（毫秒）
            <input
              type="text"
              inputMode="numeric"
              className="locate-gap-input"
              value={props.gapText}
              spellCheck={false}
              onChange={(e) => props.onGapText(e.target.value)}
            />
          </label>
          {props.phraseText.length > 0 && (
            <button className="btn sm" onClick={() => props.onPhraseText('')}>
              清空
            </button>
          )}
        </div>
        <textarea
          className="snap-paste"
          placeholder={
            '粘贴要定位的原文短语，例如：我们明天同一时间在这里集合\n标点与空格必须逐字相同；字幕中的标签 <...> 与换行不参与匹配但原样显示'
          }
          value={props.phraseText}
          spellCheck={false}
          onChange={(e) => props.onPhraseText(e.target.value)}
        />
      </div>

      <div className="wrap-summary">
        上游最终字幕 {props.sourceCount} 条（只读）
        {result.error === null && result.maxGap !== null && (
          <>
            {' '}· 短语 {result.phraseGraphemes} 字素 · 跨条间隔 ≤ {result.maxGap} 毫秒 ·{' '}
            <em>{result.hits.length > 0 ? `命中 ${result.hits.length} 处` : '暂无命中'}</em>
          </>
        )}
        <span className="wrap-hint">
          相邻条目间隔（下一条开始 − 上一条结束）超过阈值时必须中断；重复出现（含互相重叠）的命中全部列出；仅读取最终结果，不修改合并 SRT
        </span>
      </div>

      {result.error && (
        <div className="we-fail">⚠ {result.error.message}（命中已清空）</div>
      )}

      {props.sourceCount === 0 ? (
        <div className="empty">上游结果为空，没有可供定位的最终字幕。</div>
      ) : result.error ? (
        <div className="empty">请修正上方输入后查看命中位置。</div>
      ) : result.hits.length === 0 ? (
        <div className="empty">未在最终字幕中找到该短语。</div>
      ) : (
        <>
          <h3 className="panel-sub edit-sub">命中列表（{result.hits.length} 处，按出现顺序）</h3>
          <div className="locate-list">
            {result.hits.slice(0, shown).map((hit, hi) => (
              <div className="locate-entry" key={hi}>
                <div className="we-head">
                  <span className="g-idx">#{hi + 1}</span>
                  <span className="mono occ-time">{fmtRange(hit.start, hit.end)}</span>
                  <span className="tag dim">
                    条目 {hit.startCue + 1}
                    {hit.endCue > hit.startCue ? ` – ${hit.endCue + 1}（跨 ${hit.parts.length} 条）` : ''}
                  </span>
                </div>
                <div className="locate-parts">
                  {hit.parts.map((part, pi) => (
                    <div className="locate-part" key={pi}>
                      <div className="locate-part-head">
                        <span className="tag dim">条目 {part.cueIndex + 1}</span>
                        <span className="mono occ-time">{fmtRange(part.start, part.end)}</span>
                        {pi < hit.parts.length - 1 && (
                          <span className="locate-gapval">
                            间隔 {index.cues[part.cueIndex + 1].start - part.end} 毫秒 ⇣
                          </span>
                        )}
                      </div>
                      <pre className="locate-text">
                        <CuePart
                          cue={index.cues[part.cueIndex]}
                          atomStart={part.atomStart}
                          atomEnd={part.atomEnd}
                        />
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {result.hits.length > shown && (
            <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
              显示更多（剩余 {result.hits.length - shown} 处）
            </button>
          )}
        </>
      )}
    </section>
  );
}
