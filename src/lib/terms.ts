/**
 * 术语统一（独立模块）：读取现有最终合并字幕（finalCues），按用户逐行填写的
 * 术语表（Tab 分隔「原词 → 替换词」）生成一份**规范化字幕副本**。
 *
 * 术语表规则：
 *   - 每行恰好两列，以 Tab（\t）分隔：原词 + 替换词；两列均须非空；
 *   - 原词与替换词均不得包含形如 <...> 的标签；
 *   - 列数错误（多于或少于两列）、空列、含标签均按物理行号逐行提示；
 *   - 原词重复时仅保留首行规则，后续重复行逐行提示（不覆盖首行）；
 *   - 空行忽略；不做大小写归一，行内除行尾换行外不做 trim。
 *
 * 匹配规则：
 *   - 匹配**区分大小写**，按**字面量**与 **Unicode 字素簇**处理（不做任何归一化）；
 *   - 形如 <...> 的标签以及换行符不参与匹配，从匹配序列中跳过，但原样保留；
 *   - 自左向右扫描：在当前起点选择能命中的**最长原词**；命中后整段越过
 *     （不重叠、不嵌套），替换内容不再参与后续匹配；
 *   - 命中段处理：在**首个命中字素处插入替换词**，删去其余命中字素；
 *     段内标签与换行仍在原位置保留；
 *   - 未命中任何规则时文本逐字素原样输出。
 *
 * 本模块只读取上游结果，绝不修改合并结果本身：时间、条数与原合并结果完全一致。
 */
import type { MergedCue } from './merge';
import { graphemes } from './wrap';

/** 形如 <...> 的标签（HTML/ASS 内联样式等）；不带 > 的孤立尖括号按普通字符处理。 */
const TAG_RE = /<[^>]*>/g;

export interface TermRule {
  /** 原词（字面量，区分大小写） */
  from: string;
  /** 替换词 */
  to: string;
  /** 规则首次出现的物理行号（从 1 起） */
  line: number;
}

export interface BadTermLine {
  /** 物理行号（从 1 起） */
  line: number;
  raw: string;
  /** 错误原因 */
  reason: string;
}

export interface TermParseResult {
  /** 解析成功的规则（保持首次出现顺序；重复原词仅保留首行） */
  rules: TermRule[];
  /** 错误行（列数错误 / 空列 / 含标签 / 重复原词） */
  invalid: BadTermLine[];
  /** 非空物理行总数（含错误行） */
  totalLines: number;
}

/**
 * 解析术语表：每行用 Tab 分成恰好两列（原词 替换词）。
 * 严格按字面量处理：仅剥离开头的 BOM 与统一换行，不 trim、不转换大小写。
 */
export function parseTerms(text: string): TermParseResult {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rules: TermRule[] = [];
  const invalid: BadTermLine[] = [];
  const seen = new Map<string, number>();
  let totalLines = 0;

  normalized.split('\n').forEach((raw, idx) => {
    if (raw.length === 0) return;
    totalLines++;
    const line = idx + 1;
    const cols = raw.split('\t');
    if (cols.length !== 2) {
      invalid.push({
        line,
        raw,
        reason:
          cols.length < 2
            ? '需要用 Tab 分隔的两列（原词⇥替换词）'
            : `每行只能有两列（发现 ${cols.length} 列）`,
      });
      return;
    }
    const [from, to] = cols;
    if (from.length === 0 || to.length === 0) {
      invalid.push({ line, raw, reason: '原词与替换词均不能为空' });
      return;
    }
    if (TAG_PATTERN.test(from) || TAG_PATTERN.test(to)) {
      invalid.push({ line, raw, reason: '原词与替换词均不能包含标签（<...>）' });
      return;
    }
    if (seen.has(from)) {
      invalid.push({
        line,
        raw,
        reason: `原词与第 ${seen.get(from)} 行重复（重复行不生效）`,
      });
      return;
    }
    seen.set(from, line);
    rules.push({ from, to, line });
  });

  return { rules, invalid, totalLines };
}

const TAG_PATTERN = /<[^>]*>/;

/* ---------------- 匹配序列（跳过标签与换行） ---------------- */

/**
 * 文本原子：标签 / 换行是不参与匹配、原样保留的「跳过段」；
 * 普通字素是匹配序列的基本单位（Unicode 字素簇，整体比较）。
 */
interface Atom {
  /** 该原子在原文中的 [start, end) 偏移 */
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

/* ---------------- 最长原词前缀（字素 Trie） ---------------- */

interface TrieNode {
  children: Map<string, TrieNode>;
  /** 终节点：命中的规则 */
  rule: TermRule | null;
}

/** 按规则原词（字素簇序列）构建 Trie；重复原词已在解析层拦截，首个写入者为终节点。 */
export function buildTermTrie(rules: readonly TermRule[]): TrieNode {
  const root: TrieNode = { children: new Map(), rule: null };
  for (const rule of rules) {
    let node = root;
    for (const g of graphemes(rule.from)) {
      let next = node.children.get(g);
      if (!next) {
        next = { children: new Map(), rule: null };
        node.children.set(g, next);
      }
      node = next;
    }
    if (!node.rule) node.rule = rule;
  }
  return root;
}

export interface TermHit {
  /** 命中规则原词 */
  from: string;
  /** 命中规则替换词 */
  to: string;
  /** 规则所在术语表物理行号 */
  line: number;
}

export interface TermCueResult {
  start: number;
  end: number;
  /** 规范化前文本（上游原文） */
  before: string;
  /** 规范化后文本 */
  after: string;
  /** 本条命中的规则（按出现顺序） */
  hits: TermHit[];
}

/**
 * 对单条文本执行术语规范化：跳过标签与换行建立字素匹配序列，
 * 自左向右选当前起点最长原词；命中后越过该段，在首个命中字素处插入
 * 替换词并删去其余命中字素（段内标签/换行原样保留），替换内容不再匹配。
 */
export function normalizeText(
  text: string,
  rules: readonly TermRule[],
): { out: string; hits: TermHit[] } {
  return normalizeTextWithTrie(text, buildTermTrie(rules));
}

/** 与 normalizeText 相同，但允许调用方复用同一棵 Trie（批量处理时只构建一次）。 */
function normalizeTextWithTrie(
  text: string,
  root: TrieNode,
): { out: string; hits: TermHit[] } {
  const atoms = atomize(text);

  // 自左向右扫描：在每个字素起点沿 Trie 下行，取到达的最深终节点（最长原词）
  interface Hit {
    start: number;
    end: number;
    rule: TermRule;
  }
  const hits: Hit[] = [];
  let i = 0;
  while (i < atoms.length) {
    if (atoms[i].grapheme === null) {
      i++;
      continue;
    }
    let node: TrieNode | undefined = root.children.get(atoms[i].grapheme!);
    let j = i + 1;
    let best: { end: number; rule: TermRule } | null = null;
    while (node) {
      if (node.rule) best = { end: j, rule: node.rule };
      // 延伸到下一个参与匹配的字素（跨过中间的标签/换行）
      while (j < atoms.length && atoms[j].grapheme === null) j++;
      if (j >= atoms.length) break;
      node = node.children.get(atoms[j].grapheme!);
      j++;
    }
    if (best) {
      hits.push({ start: i, end: best.end, rule: best.rule });
      i = best.end; // 整段越过：不重叠、不嵌套，替换内容不再参与匹配
    } else {
      i++;
    }
  }

  // 重建输出：命中段首个命中字素换成替换词、其余命中字素删除；
  // 标签/换行（段内显式输出、段外包含在原文切片中）一律原样保留。
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    out += text.slice(cursor, atoms[h.start].start);
    out += h.rule.to;
    for (let k = h.start + 1; k < h.end; k++) {
      if (atoms[k].grapheme === null) out += text.slice(atoms[k].start, atoms[k].end);
    }
    cursor = atoms[h.end - 1].end;
  }
  out += text.slice(cursor);

  return {
    out,
    hits: hits.map((h) => ({ from: h.rule.from, to: h.rule.to, line: h.rule.line })),
  };
}

/** 对全部最终字幕生成规范化副本；时间、顺序、条数与输入完全一致。 */
export function normalizeCues(cues: readonly MergedCue[], rules: TermRule[]): TermCueResult[] {
  const root = buildTermTrie(rules); // 全部条目共用同一棵 Trie，只构建一次
  return cues.map((c) => {
    const { out, hits } = normalizeTextWithTrie(c.text, root);
    return { start: c.start, end: c.end, before: c.text, after: out, hits };
  });
}
