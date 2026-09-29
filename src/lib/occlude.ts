/**
 * 字幕遮挡避让（独立模块）：读取现有最终合并字幕（finalCues）的时间与文本，
 * 按用户逐行填写的遮挡区间（起点毫秒 终点毫秒 上/下）为每条字幕在上、下两条
 * 轨道中选择一条，并独立导出轨道分配 CSV（不改变 SRT 本身）。
 *
 * 规则：
 *   - 遮挡列表每行三列：起点毫秒、终点毫秒、位置（上/下，兼容 上轨/下轨/top/bottom）；
 *     起止必须是非负整数且起点 < 终点，格式错误按物理行号逐行标出；
 *   - 遮挡区间与字幕按半开区间 [start, end) 求交，有正时长交集时该位置（轨道）
 *     对这条字幕不可用；端点相接不算遮挡；
 *   - 每条字幕默认下轨；全局动态规划按字典序依次优化：
 *       ① 最小化相邻字幕切换轨道的次数；
 *       ② 最小化改到上轨的条数；
 *       ③ 仍有并列时按字幕顺序优先下轨（位置靠前的字幕尽量放下轨）；
 *   - 任一字幕上、下两轨均被遮挡时整体无解：只展示第一条无解字幕的原因，
 *     不产出、也不导出任何部分方案。
 *
 * 本模块只读取上游结果，绝不修改合并结果本身。
 */
import type { MergedCue } from './merge';
import { formatTimecode } from './srt';

/** 轨道：上 / 下。 */
export type Track = 'top' | 'bottom';

export interface Occlusion {
  /** 行号（物理行，从 1 起，空行也计入，与文本框行号一致） */
  line: number;
  /** 遮挡起点（毫秒） */
  start: number;
  /** 遮挡终点（毫秒，严格大于起点） */
  end: number;
  /** 被遮挡的轨道 */
  track: Track;
}

export interface BadOcclusionLine {
  /** 物理行号（从 1 起） */
  line: number;
  raw: string;
  /** 错误原因 */
  reason: string;
}

export interface OcclusionParseResult {
  /** 解析成功的遮挡区间（保持填写顺序） */
  occlusions: Occlusion[];
  /** 格式错误的行 */
  invalid: BadOcclusionLine[];
  /** 非空物理行总数（含错误行） */
  totalLines: number;
}

/** 位置别称 → 轨道。 */
const TRACK_ALIASES: Record<string, Track> = {
  上: 'top',
  上轨: 'top',
  top: 'top',
  下: 'bottom',
  下轨: 'bottom',
  bottom: 'bottom',
};

/**
 * 解析遮挡列表：每行三列（起点毫秒 终点毫秒 位置），分隔符为空白、逗号、
 * 分号、Tab、中文逗号/分号、箭头等；起止为非负整数且起点 < 终点；
 * 位置为 上/下（兼容 上轨/下轨/top/bottom，英文不区分大小写）。空行忽略。
 */
export function parseOcclusions(text: string): OcclusionParseResult {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const occlusions: Occlusion[] = [];
  const invalid: BadOcclusionLine[] = [];
  let totalLines = 0;

  normalized.split('\n').forEach((rawLine, idx) => {
    const raw = rawLine.trim();
    if (!raw) return;
    totalLines++;
    const line = idx + 1;
    // 与片段列表一致的分隔口径；故意不把单横线 “-” 当分隔符：负数必须判为非法。
    const parts = raw
      .split(/\s+|[,，;；]|-->|~|～/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (parts.length !== 3) {
      invalid.push({
        line,
        raw,
        reason:
          parts.length < 3
            ? '需要起点、终点与位置（上/下）三项'
            : '每行只能填写起点、终点与位置三项',
      });
      return;
    }
    const [a, b, posRaw] = parts;
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
    // 中文不受大小写转换影响，英文别名统一小写后查表
    const track = TRACK_ALIASES[posRaw.toLowerCase()];
    if (!track) {
      invalid.push({ line, raw, reason: `位置必须是 上 或 下（收到「${posRaw}」）` });
      return;
    }
    occlusions.push({ line, start, end, track });
  });

  return { occlusions, invalid, totalLines };
}

/** 半开区间 [aStart, aEnd) 与 [bStart, bEnd) 是否有正时长交集（端点相接不算）。 */
export function overlapsHalfOpen(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

/** 单条字幕的轨道可用性与遮挡依据。 */
export interface CueBlock {
  topOk: boolean;
  bottomOk: boolean;
  /** 遮挡上轨的区间（按填写顺序） */
  topHits: Occlusion[];
  /** 遮挡下轨的区间 */
  bottomHits: Occlusion[];
}

export interface TrackPlan {
  /** 是否存在完整方案（所有字幕至少有一条可用轨道） */
  ok: boolean;
  /** 无解时第一条两轨均被遮挡的字幕下标（0 基）；有解时为 -1 */
  failIndex: number;
  /** 每条字幕的轨道可用性与遮挡区间（供界面展示依据） */
  blocks: CueBlock[];
  /** 每条字幕的分配结果（与 cues 同序；无解时为空数组） */
  tracks: Track[];
  /** 相邻字幕切换轨道的次数 */
  switches: number;
  /** 改到上轨的条数 */
  topCount: number;
}

const INF = Number.POSITIVE_INFINITY;

/**
 * 为每条字幕选择上/下轨道。先整体判定无解（任一字幕两轨均被遮挡，取第一条），
 * 再用动态规划求字典序最优：① 相邻切换次数最少；② 上轨条数最少；
 * 重建时同分优先下轨，实现“并列时按字幕顺序优先下轨”。
 */
export function planTracks(cues: MergedCue[], occlusions: Occlusion[]): TrackPlan {
  const blocks: CueBlock[] = cues.map((c) => {
    const topHits: Occlusion[] = [];
    const bottomHits: Occlusion[] = [];
    for (const o of occlusions) {
      if (overlapsHalfOpen(c.start, c.end, o.start, o.end)) {
        (o.track === 'top' ? topHits : bottomHits).push(o);
      }
    }
    return { topOk: topHits.length === 0, bottomOk: bottomHits.length === 0, topHits, bottomHits };
  });

  // 任一字幕两轨均被遮挡 → 整体无解，只报告第一条
  for (let i = 0; i < cues.length; i++) {
    if (!blocks[i].topOk && !blocks[i].bottomOk) {
      return { ok: false, failIndex: i, blocks, tracks: [], switches: 0, topCount: 0 };
    }
  }

  const n = cues.length;
  if (n === 0) {
    return { ok: true, failIndex: -1, blocks, tracks: [], switches: 0, topCount: 0 };
  }

  // 轨道编号：0 = 下轨，1 = 上轨（下标小者优先，天然对应“同分优先下轨”）
  const avail = (i: number, t: number) => (t === 0 ? blocks[i].bottomOk : blocks[i].topOk);

  // dp：sw[t][i] / tp[t][i] = 第 i 条放在轨道 t 时，i..n-1 的最优（切换次数, 上轨条数），
  // 切换次数只统计 i 与 i+1 及之后的相邻对，上轨条数含第 i 条本身。
  const sw: number[][] = [new Array(n + 1).fill(0), new Array(n + 1).fill(0)];
  const tp: number[][] = [new Array(n + 1).fill(0), new Array(n + 1).fill(0)];
  for (let i = n - 1; i >= 0; i--) {
    for (let t = 0; t <= 1; t++) {
      if (!avail(i, t)) {
        sw[t][i] = INF;
        tp[t][i] = INF;
        continue;
      }
      let bestSw = INF;
      let bestTp = INF;
      for (let u = 0; u <= 1; u++) {
        if (sw[u][i + 1] === INF) continue;
        const cSw = (u !== t ? 1 : 0) + sw[u][i + 1];
        const cTp = tp[u][i + 1];
        if (cSw < bestSw || (cSw === bestSw && cTp < bestTp)) {
          bestSw = cSw;
          bestTp = cTp;
        }
      }
      sw[t][i] = bestSw;
      tp[t][i] = bestTp + (t === 1 ? 1 : 0);
    }
  }

  // 重建：逐条在“仍能达到全局最优”的轨道中优先选下轨
  const tracks: Track[] = [];
  let prev = -1;
  for (let i = 0; i < n; i++) {
    let bestSw = INF;
    let bestTp = INF;
    for (let t = 0; t <= 1; t++) {
      if (sw[t][i] === INF) continue;
      const cSw = (prev !== -1 && prev !== t ? 1 : 0) + sw[t][i];
      const cTp = tp[t][i];
      if (cSw < bestSw || (cSw === bestSw && cTp < bestTp)) {
        bestSw = cSw;
        bestTp = cTp;
      }
    }
    let chosen = -1;
    for (let t = 0; t <= 1; t++) {
      if (sw[t][i] === INF) continue;
      const cSw = (prev !== -1 && prev !== t ? 1 : 0) + sw[t][i];
      const cTp = tp[t][i];
      if (cSw === bestSw && cTp === bestTp) {
        chosen = t;
        break;
      }
    }
    tracks.push(chosen === 1 ? 'top' : 'bottom');
    prev = chosen;
  }

  let switches = 0;
  let topCount = 0;
  for (let i = 0; i < n; i++) {
    if (tracks[i] === 'top') topCount++;
    if (i > 0 && tracks[i] !== tracks[i - 1]) switches++;
  }
  return { ok: true, failIndex: -1, blocks, tracks, switches, topCount };
}

/**
 * 生成轨道分配 CSV：含字幕序号（从 1 起）、起止时间（HH:MM:SS,mmm）与轨道（上/下）。
 * 时间码含逗号，按 CSV 规则加引号；调用方负责加 BOM 与命名下载。
 */
export function buildTrackCsv(cues: MergedCue[], tracks: Track[]): string {
  const header = '序号,开始时间,结束时间,轨道';
  const rows = cues.map(
    (c, i) =>
      `${i + 1},"${formatTimecode(c.start)}","${formatTimecode(c.end)}",${
        tracks[i] === 'top' ? '上' : '下'
      }`,
  );
  return `${header}\n${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`;
}
