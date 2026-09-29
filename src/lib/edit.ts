/**
 * 剪辑版字幕（独立模块）：读取现有最终合并字幕（finalCues），按用户逐行填写的
 * 源片段区间（起止毫秒）把原片时间轴裁切、重排成成片时间轴。
 *
 * 规则：
 *   - 每行两个非负整数（起点 终点，空格/逗号/Tab 等分隔），且起点 < 终点；
 *   - 行序即成片顺序，允许重复、重叠、倒序片段（不排序、不去重）；
 *   - 片段按各自原时长首尾拼接：片段 k 在成片时间轴上的起点 = 此前片段时长之和；
 *   - 对每条字幕与每个半开区间 [start, end) 求交，仅保留正时长交集；
 *     裁切后的时间 = 交集起点 − 片段起点 + 此前片段总时长，文本原样复制；
 *   - 跨片段字幕在每个命中片段分别输出，重复片段重复输出；
 *   - 空白片段（没有任何字幕与之相交）仍占时长；
 *   - 不合并相邻同文字幕，输出顺序 = 片段顺序 × 原字幕顺序。
 *
 * 本模块只读取上游结果，绝不修改合并结果本身。
 */
import type { MergedCue } from './merge';

export interface Segment {
  /** 行号（物理行，从 1 起，空行也计入，与文本框行号一致） */
  line: number;
  /** 源片段起点（毫秒） */
  start: number;
  /** 源片段终点（毫秒，严格大于起点） */
  end: number;
}

export interface BadSegmentLine {
  /** 物理行号（从 1 起） */
  line: number;
  raw: string;
  /** 错误原因 */
  reason: string;
}

export interface SegmentParseResult {
  /** 解析成功的片段（保持填写顺序，允许重复、倒序） */
  segments: Segment[];
  /** 格式错误的行 */
  invalid: BadSegmentLine[];
  /** 非空物理行总数（含错误行） */
  totalLines: number;
}

/**
 * 解析片段列表：每行两个非负整数，分隔符为空白、逗号、分号、Tab、
 * 中文逗号/分号、箭头等；要求恰好两列且起点 < 终点。空行忽略。
 */
export function parseSegments(text: string): SegmentParseResult {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const segments: Segment[] = [];
  const invalid: BadSegmentLine[] = [];
  let totalLines = 0;

  normalized.split('\n').forEach((rawLine, idx) => {
    const raw = rawLine.trim();
    if (!raw) return;
    totalLines++;
    const line = idx + 1;
    // 常见分隔：连续空白（含 Tab）、逗号/中文逗号、分号/中文分号、箭头 --> / ~ / ～。
    // 故意不把单横线 “-” 当分隔符：负数（如 -1000）必须判为非法。
    const parts = raw
      .split(/\s+|[,，;；]|-->|~|～/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (parts.length !== 2) {
      invalid.push({
        line,
        raw,
        reason: parts.length < 2 ? '需要两个数字（起点 终点）' : '每行只能填写起点与终点两个数字',
      });
      return;
    }
    const [a, b] = parts;
    const intRe = /^(?:0|[1-9][0-9]*)$/;
    if (!intRe.test(a) || !intRe.test(b)) {
      invalid.push({ line, raw, reason: '起止必须是非负整数（毫秒）' });
      return;
    }
    const start = Number(a);
    const end = Number(b);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      invalid.push({ line, raw, reason: '数值超出安全整数范围' });
      return;
    }
    if (start >= end) {
      invalid.push({ line, raw, reason: `起点必须小于终点（${start} ≥ ${end}）` });
      return;
    }
    segments.push({ line, start, end });
  });

  return { segments, invalid, totalLines };
}

export interface EditedCue {
  /** 成片时间轴起点（毫秒） */
  start: number;
  /** 成片时间轴终点（毫秒） */
  end: number;
  /** 文本（自上游原样复制） */
  text: string;
  /** 来源片段在填写列表中的序号（0 基） */
  segIndex: number;
  /** 来源片段的物理行号 */
  segLine: number;
}

/**
 * 按片段把上游字幕裁切、重排为剪辑版时间轴。
 * 输入片段允许重复、重叠、倒序；调用方通常先经 parseSegments 校验。
 */
export function buildEditedCues(cues: MergedCue[], segments: Segment[]): EditedCue[] {
  const out: EditedCue[] = [];
  let offset = 0;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const segDur = seg.end - seg.start;
    for (const c of cues) {
      // 半开区间 [seg.start, seg.end) 与 [c.start, c.end) 求交
      const s = Math.max(c.start, seg.start);
      const e = Math.min(c.end, seg.end);
      if (s < e) {
        // 仅保留正时长交集；减去片段起点、加上此前片段总时长
        out.push({
          start: s - seg.start + offset,
          end: e - seg.start + offset,
          text: c.text,
          segIndex: si,
          segLine: seg.line,
        });
      }
    }
    offset += segDur; // 空白片段同样累加时长
  }
  return out;
}

/** 成片总时长（毫秒）：各片段原时长之和，与是否有字幕无关。 */
export function editedTotalDuration(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/** 每个片段在成片中的落点与命中条数（供界面展示空白片段）。 */
export interface SegmentSpan {
  segIndex: number;
  segLine: number;
  srcStart: number;
  srcEnd: number;
  /** 成片时间轴上的起止 */
  outStart: number;
  outEnd: number;
  /** 命中的剪辑版字幕条数（0 即空白片段） */
  hits: number;
}

/** 计算各片段的成片落点与命中条数。 */
export function buildSegmentSpans(segments: Segment[], edited: EditedCue[]): SegmentSpan[] {
  const hitCounts = new Array(segments.length).fill(0);
  for (const c of edited) hitCounts[c.segIndex]++;
  let offset = 0;
  return segments.map((seg, i) => {
    const dur = seg.end - seg.start;
    const span: SegmentSpan = {
      segIndex: i,
      segLine: seg.line,
      srcStart: seg.start,
      srcEnd: seg.end,
      outStart: offset,
      outEnd: offset + dur,
      hits: hitCounts[i],
    };
    offset += dur;
    return span;
  });
}
