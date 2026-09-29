/**
 * 审校短语定位（独立模块）：读取现有最终合并字幕（finalCues），按用户输入的
 * 原文短语在全部条目中逐字定位对白，支持跨相邻条目延续。
 *
 * 匹配规则：
 *   - 按 **Unicode 字素簇**逐字匹配，**区分大小写**，按字面量比较
 *     （不做大小写、标点或空白归一，标点与空格必须逐字相同）；
 *   - 字幕中的 `<...>` 标签与换行符（`\n`）不参与匹配、从匹配序列中跳过，
 *     但在结果中原样保留并可在界面按原样展示；
 *   - 短语可跨**相邻条目**延续：仅当 `下一条开始 − 上一条结束 ≤ 允许的最大间隔`
 *     （非负整数毫秒）时才允许跨过该边界；中间没有任何可匹配字素的空条目按
 *     相邻关系逐跳检查，任一跳超阈即中断；
 *   - 重复出现（含互相重叠）的命中全部列出，按开始位置排序；
 *   - 短语为空或间隔不是非负整数毫秒时，返回错误原因且不产出任何命中。
 *
 * 本模块只读取上游结果，绝不修改合并结果本身，也不写回合并 SRT。
 */
import type { MergedCue } from './merge';
import { graphemes } from './wrap';

/** 形如 <...> 的标签（HTML/ASS 内联样式等）；不带 > 的孤立尖括号按普通字符处理。 */
const TAG_RE = /<[^>]*>/g;

/* ---------------- 文本原子（标签 / 换行跳过，其余按字素簇） ---------------- */

/**
 * 文本原子：标签 / 换行是不参与匹配、原样保留的「跳过段」；
 * 普通字素是匹配序列的基本单位（Unicode 字素簇，整体比较）。
 */
export interface Atom {
  /** 该原子在原文中的 [start, end) 字符偏移 */
  start: number;
  end: number;
  /** 普通字素的文本；跳过段（标签/换行）为 null */
  grapheme: string | null;
}

/** 把文本切成原子序列：<...> 标签与 \n 作为跳过段，其余按字素簇切分。 */
function atomize(text: string): Atom[] {
  // 先按标签切出纯文本缺口，再在缺口内切字素（换行单独成跳过段），
  // 标签两侧的组合符因此不会被错误地跨标签粘成一个字素。
  const gaps: Array<[number, number]> = [];
  const tags: Array<[number, number]> = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m.index > last) gaps.push([last, m.index]);
    tags.push([m.index, m.index + m[0].length]);
    last = m.index + m[0].length;
  }
  if (last < text.length) gaps.push([last, text.length]);

  // 标签与缺口在原文中严格交替，按起点归并即可
  const atoms: Atom[] = [];
  let gi = 0;
  let ti = 0;
  while (gi < gaps.length || ti < tags.length) {
    if (ti >= tags.length || (gi < gaps.length && gaps[gi][0] < tags[ti][0])) {
      pushGap(atoms, text, gaps[gi][0], gaps[gi][1]);
      gi++;
    } else {
      atoms.push({ start: tags[ti][0], end: tags[ti][1], grapheme: null });
      ti++;
    }
  }
  return atoms;
}

/** 对一个纯文本缺口（不含标签）切字素；换行单独成跳过段。 */
function pushGap(out: Atom[], text: string, start: number, end: number): void {
  let segStart = start;
  const emitGraphemes = (s: number, e: number) => {
    for (const g of graphemes(text.slice(s, e))) {
      out.push({ start: s, end: s + g.length, grapheme: g });
      s += g.length;
    }
  };
  for (let i = start; i < end; i++) {
    if (text[i] === '\n') {
      emitGraphemes(segStart, i);
      out.push({ start: i, end: i + 1, grapheme: null });
      segStart = i + 1;
    }
  }
  emitGraphemes(segStart, end);
}

/* ---------------- 定位索引（仅 finalCues 变化时重建） ---------------- */

/** 匹配序列中的一个字素位置（标签/换行已剔除）。 */
interface StreamPos {
  /** 所属条目下标 */
  cue: number;
  /** 在该条目完整原子序列（含跳过段）中的下标 */
  ai: number;
  /** 字素文本 */
  g: string;
}

export interface CueAtoms {
  start: number;
  end: number;
  text: string;
  /** 完整原子序列（含标签/换行跳过段），按原文位置排列且覆盖整条文本 */
  atoms: Atom[];
}

export interface LocateIndex {
  cues: CueAtoms[];
  /** 按条目顺序拼接的纯字素匹配序列（不含标签/换行） */
  stream: StreamPos[];
}

/** 为最终字幕建立定位索引：逐条原子化并拼出纯字素匹配序列。 */
export function buildLocateIndex(
  cues: readonly Pick<MergedCue, 'start' | 'end' | 'text'>[],
): LocateIndex {
  const built: CueAtoms[] = cues.map((c) => ({
    start: c.start,
    end: c.end,
    text: c.text,
    atoms: atomize(c.text),
  }));
  const stream: StreamPos[] = [];
  built.forEach((c, ci) => {
    c.atoms.forEach((a, ai) => {
      if (a.grapheme !== null) stream.push({ cue: ci, ai, g: a.grapheme });
    });
  });
  return { cues: built, stream };
}

/* ---------------- 输入校验与检索 ---------------- */

export type LocateErrorKind = 'empty-phrase' | 'bad-gap';

export interface LocateError {
  kind: LocateErrorKind;
  message: string;
}

/** 短语在某一条内命中的部分。 */
export interface PhraseCueHit {
  /** 条目下标（0 基，界面展示 +1） */
  cueIndex: number;
  start: number;
  end: number;
  text: string;
  /** 命中的首个原子在该条完整原子序列中的下标（含标签/换行跳过段） */
  atomStart: number;
  /** 命中的末个原子下标（含） */
  atomEnd: number;
}

/** 一次完整短语命中：可落在单条内，也可连续跨多条。 */
export interface PhraseHit {
  /** 起始条目下标（0 基） */
  startCue: number;
  /** 结束条目下标（0 基，含） */
  endCue: number;
  /** 命中整体时间范围：起始条开始 → 结束条结束 */
  start: number;
  end: number;
  /** 各条命中部分（按条目顺序，单条命中时长度为 1） */
  parts: PhraseCueHit[];
}

export interface LocateResult {
  hits: PhraseHit[];
  error: LocateError | null;
  /** 校验通过的跨条最大间隔（毫秒）；无效时为 null */
  maxGap: number | null;
  /** 短语字素数 */
  phraseGraphemes: number;
}

/**
 * 解析跨条最大间隔：去空白后必须是非负整数（毫秒），且在安全整数范围内。
 * 空串按无效处理（调用方应给出默认值）。
 */
export function parseMaxGap(raw: string): { value: number | null; message: string | null } {
  const t = raw.trim();
  if (t === '') return { value: null, message: '请填写允许跨条的最大时间间隔（非负整数毫秒）' };
  if (!/^(?:0|[1-9][0-9]*)$/.test(t)) {
    return { value: null, message: '跨条最大间隔必须是非负整数毫秒（例如 0 或 500）' };
  }
  const v = Number(t);
  if (!Number.isSafeInteger(v)) {
    return { value: null, message: '跨条最大间隔数值超出安全整数范围' };
  }
  return { value: v, message: null };
}

/**
 * 在定位索引上检索短语：区分大小写按 Unicode 字素逐字匹配，标签与换行跳过；
 * 相邻条目间隔（下一条开始 − 上一条结束）超过 maxGap 处作为不可跨越的断点。
 * 使用 KMP 在线性扫描中枚举全部命中（含互相重叠的命中）。
 */
export function locatePhrase(index: LocateIndex, phrase: string, maxGap: number): PhraseHit[] {
  const pattern: string[] = [];
  for (const g of graphemes(phrase)) pattern.push(g);
  const m = pattern.length;
  if (m === 0 || index.stream.length === 0) return [];

  // KMP 前缀函数
  const pi = new Array<number>(m).fill(0);
  let k = 0;
  for (let i = 1; i < m; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = pi[k - 1];
    if (pattern[i] === pattern[k]) k++;
    pi[i] = k;
  }

  const { cues, stream } = index;

  /** 从上一字素条目跨越到当前条目（下标 cur）是否允许：沿途每对相邻条目都不得超阈。 */
  const crossingBroken = (prevCue: number, curCue: number): boolean => {
    for (let c = prevCue + 1; c <= curCue; c++) {
      if (cues[c].start - cues[c - 1].end > maxGap) return true;
    }
    return false;
  };

  const hits: PhraseHit[] = [];
  let matched = 0;
  let lastCue = -1;
  for (let i = 0; i < stream.length; i++) {
    const pos = stream[i];
    // 跨条目边界：相邻间隔超阈（含穿过空条目时任一跳超阈）必须中断
    if (lastCue >= 0 && pos.cue !== lastCue) {
      if (crossingBroken(lastCue, pos.cue)) matched = 0;
    }
    while (matched > 0 && pos.g !== pattern[matched]) matched = pi[matched - 1];
    if (pos.g === pattern[matched]) matched++;
    lastCue = pos.cue;
    if (matched < m) continue;

    const startPos = i - m + 1;
    const from = stream[startPos];
    const to = stream[i];
    const parts: PhraseCueHit[] = [];
    for (let p = startPos; p <= i; ) {
      const cue = stream[p].cue;
      let q = p;
      while (q + 1 <= i && stream[q + 1].cue === cue) q++;
      parts.push({
        cueIndex: cue,
        start: cues[cue].start,
        end: cues[cue].end,
        text: cues[cue].text,
        atomStart: stream[p].ai,
        atomEnd: stream[q].ai,
      });
      p = q + 1;
    }
    hits.push({
      startCue: from.cue,
      endCue: to.cue,
      start: cues[from.cue].start,
      end: cues[to.cue].end,
      parts,
    });
    matched = pi[matched - 1];
  }
  return hits;
}

/** 校验输入并检索；短语为空或间隔无效时返回错误原因并清空命中。 */
export function searchPhrases(
  index: LocateIndex,
  phraseRaw: string,
  maxGapText: string,
): LocateResult {
  // 与其他只读模块一致：剥离开头 BOM、统一 CRLF；不 trim、不做其他归一
  const phrase = phraseRaw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const phraseGraphemes = graphemes(phrase).length;
  if (phrase === '') {
    return {
      hits: [],
      error: { kind: 'empty-phrase', message: '短语为空，请输入要定位的原文短语' },
      maxGap: null,
      phraseGraphemes: 0,
    };
  }
  const gap = parseMaxGap(maxGapText);
  if (gap.value === null) {
    return { hits: [], error: { kind: 'bad-gap', message: gap.message! }, maxGap: null, phraseGraphemes };
  }
  return {
    hits: locatePhrase(index, phrase, gap.value),
    error: null,
    maxGap: gap.value,
    phraseGraphemes,
  };
}

/* ---------------- 命中高亮分段（标签/换行原样、仅命中字素高亮） ---------------- */

export interface HighlightSegment {
  text: string;
  /** 该段是否属于命中的字素（标签/换行即使夹在命中之间也不标记） */
  hit: boolean;
}

/**
 * 按原子下标范围把条目文本切成高亮段。原子序列覆盖整条文本，逐原子取原文切片，
 * 仅 [atomStart, atomEnd] 内的普通字素（非标签/换行）标记为命中；标签、换行与
 * 未命中字素原样输出（同一标记的相邻原子合并为一段）。
 */
export function cueSegments(cue: CueAtoms, atomStart: number, atomEnd: number): HighlightSegment[] {
  const segs: HighlightSegment[] = [];
  let cursor = 0;
  const push = (text: string, hit: boolean) => {
    if (text.length === 0) return;
    const last = segs[segs.length - 1];
    if (last && last.hit === hit) last.text += text;
    else segs.push({ text, hit });
  };
  cue.atoms.forEach((a, ai) => {
    if (a.start > cursor) push(cue.text.slice(cursor, a.start), false);
    const isHit = ai >= atomStart && ai <= atomEnd && a.grapheme !== null;
    push(cue.text.slice(a.start, a.end), isHit);
    cursor = a.end;
  });
  if (cursor < cue.text.length) push(cue.text.slice(cursor), false);
  return segs;
}

/** 为一次命中取回各条对应的原子化条目（用于界面渲染高亮）。 */
export function hitCueAtoms(index: LocateIndex, hit: PhraseHit): CueAtoms[] {
  return hit.parts.map((p) => index.cues[p.cueIndex]);
}
