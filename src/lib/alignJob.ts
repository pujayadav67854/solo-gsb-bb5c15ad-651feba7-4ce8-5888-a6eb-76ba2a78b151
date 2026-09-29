/**
 * 对齐 / 迁移预览计算的 Worker 消息协议与纯函数执行器。
 *
 * 首次对齐与重新校准的迁移预览都在 Web Worker 中执行：
 *  - 输入沿用本次 A/B 字幕、所选 B 时间轴（原始或校准后）以及旧对齐组；
 *  - 输出沿用现有对齐组（AlignGroup）与迁移方案（MigrationPlan）；
 *  - 算法、置信度与迁移判定规则与主线程原实现完全一致（直接复用 align.ts / migrate.ts）。
 *
 * 本文件只含无副作用的纯函数与类型，主线程和 Worker 均可导入；
 * Worker 入口（align.worker.ts）仅在此之上包一层 onmessage / postMessage。
 */
import { alignCues, type AlignGroup } from './align';
import { planMigration, type MigrationPlan } from './migrate';
import type { Cue } from './srt';

/** 首次对齐（或跳过校准直接对齐）：以给定 B 时间轴计算对齐组。 */
export interface AlignRequest {
  kind: 'align';
  id: number;
  cuesA: Cue[];
  cuesB: Cue[];
}

export interface AlignResponse {
  kind: 'align';
  id: number;
  groups: AlignGroup[];
}

/**
 * 重新校准后的迁移预览：用新 B 时间轴重新对齐，并与旧对齐组做全最优 LCS 迁移判定。
 * 内容比对统一使用原始 cuesB 文本（校准只改 B 的时间、不改文本且保持条数顺序）。
 */
export interface MigrateRequest {
  kind: 'migrate';
  id: number;
  cuesA: Cue[];
  /** 本次对齐实际使用的 B 时间轴（原始或校准后） */
  cuesBUsed: Cue[];
  /** 取 B 侧文本用的原始 B 字幕 */
  cuesBOriginal: Cue[];
  oldGroups: AlignGroup[];
}

export interface MigrateResponse {
  kind: 'migrate';
  id: number;
  newGroups: AlignGroup[];
  plan: MigrationPlan;
}

export type JobRequest = AlignRequest | MigrateRequest;
export type JobResponse = AlignResponse | MigrateResponse;

/** Worker 无法启动或计算抛错时的失败回执（id 与请求对应）。 */
export interface JobError {
  kind: 'error';
  id: number;
  message: string;
}

/** 在 Worker 内同步执行一次计算；异常由调用方捕获并回送 JobError。 */
export function runAlignJob(req: JobRequest): JobResponse {
  if (req.kind === 'align') {
    return { kind: 'align', id: req.id, groups: alignCues(req.cuesA, req.cuesB) };
  }
  const newGroups = alignCues(req.cuesA, req.cuesBUsed);
  const plan = planMigration(req.oldGroups, newGroups, req.cuesA, req.cuesBOriginal);
  return { kind: 'migrate', id: req.id, newGroups, plan };
}
