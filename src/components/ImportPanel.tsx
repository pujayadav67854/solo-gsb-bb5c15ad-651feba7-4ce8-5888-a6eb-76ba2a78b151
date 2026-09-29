import { useRef, useState } from 'react';
import type { Cue } from '../lib/srt';
import { formatTimecode } from '../lib/srt';

interface ImportPanelProps {
  nameA: string;
  nameB: string;
  textA: string;
  textB: string;
  cuesA: Cue[];
  cuesB: Cue[];
  busy: boolean;
  /** Worker 创建或对齐计算失败时的原因 */
  error: string | null;
  onText(side: 'A' | 'B', text: string, name?: string): void;
  /** 进入时间轴校准步骤 */
  onCalibrate(): void;
  /** 跳过校准，直接用原始 B 时间顺序对齐 */
  onSkipCalibrate(): void;
  /** 取消正在进行的对齐计算 */
  onCancel(): void;
  onSample(): void;
}

export function ImportPanel(props: ImportPanelProps) {
  const canAlign = props.cuesA.length > 0 && props.cuesB.length > 0 && !props.busy;
  return (
    <section className="import">
      <div className="import-grid">
        <SourceCard
          side="A"
          title="字幕版本 A"
          name={props.nameA}
          text={props.textA}
          cues={props.cuesA}
          busy={props.busy}
          onText={props.onText}
        />
        <div className="import-vs">⇄</div>
        <SourceCard
          side="B"
          title="字幕版本 B"
          name={props.nameB}
          text={props.textB}
          cues={props.cuesB}
          busy={props.busy}
          onText={props.onText}
        />
      </div>
      <div className="import-actions">
        <button className="btn primary lg" disabled={!canAlign} onClick={props.onCalibrate}>
          {props.busy ? '处理中…' : '下一步：时间轴校准'}
        </button>
        <button className="btn ghost lg" disabled={!canAlign} onClick={props.onSkipCalibrate}>
          跳过校准，直接对齐
        </button>
        {props.busy ? (
          <button className="btn warn lg" onClick={props.onCancel}>
            取消对齐
          </button>
        ) : (
          <button className="btn ghost lg" onClick={props.onSample}>
            加载示例数据
          </button>
        )}
        {props.busy ? (
          <span className="hint busy-hint">
            <span className="spinner" aria-hidden="true" />
            正在后台对齐，页面可继续操作；结果返回前可取消。
          </span>
        ) : props.error ? (
          <span className="hint error-hint" role="alert">
            对齐失败：{props.error}。请调整字幕后重试。
          </span>
        ) : (
          !canAlign && <span className="hint">请先为两个版本各导入一份 SRT（文件选择 / 拖拽 / 粘贴）</span>
        )}
      </div>
    </section>
  );
}

interface SourceCardProps {
  side: 'A' | 'B';
  title: string;
  name: string;
  text: string;
  cues: Cue[];
  /** 对齐计算进行中：禁用字幕编辑（改动会终止当前计算），页面其余部分仍可操作 */
  busy?: boolean;
  onText(side: 'A' | 'B', text: string, name?: string): void;
}

function SourceCard({ side, title, name, text, cues, busy, onText }: SourceCardProps) {
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => onText(side, String(reader.result ?? ''), file.name);
    reader.readAsText(file);
  };

  const range =
    cues.length > 0
      ? `${formatTimecode(cues[0].start)} ~ ${formatTimecode(cues[cues.length - 1].end)}`
      : '';

  return (
    <div
      className={`source-card ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) readFile(f);
      }}
    >
      <header>
        <span className={`side-badge side-${side.toLowerCase()}`}>{side}</span>
        <strong>{title}</strong>
        <span className="file-name" title={name}>
          {name}
        </span>
      </header>
      <button type="button" className="drop" onClick={() => fileRef.current?.click()} disabled={busy}>
        {cues.length > 0 ? (
          <>
            <span className="drop-ok">✓ 已解析 {cues.length} 条字幕</span>
            <span className="drop-range">{range}</span>
          </>
        ) : (
          <>
            <span className="drop-icon">⬆</span>
            <span>点击选择或拖入 .srt 文件</span>
          </>
        )}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".srt,.txt"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) readFile(f);
          e.target.value = '';
        }}
      />
      <textarea
        className="paste"
        placeholder="…或直接粘贴 SRT 内容"
        value={text}
        spellCheck={false}
        disabled={busy}
        onChange={(e) => onText(side, e.target.value)}
      />
    </div>
  );
}
