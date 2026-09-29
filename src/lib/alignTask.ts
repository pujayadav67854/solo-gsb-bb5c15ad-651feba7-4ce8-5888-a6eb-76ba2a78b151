/**
 * 对齐 / 迁移预览计算的 Worker 任务管理器（主线程）。
 *
 * 职责：
 *  - 每次发起计算都新建一个 module Worker，任务结束（成功 / 失败 / 取消 / 被新任务顶替）
 *    时立即 terminate() 释放；
 *  - 串行单槽：发起新计算前终止并丢弃旧计算，旧 Worker 迟到的成功或失败一律忽略，
 *    不会切换页面、覆盖结果或清除新任务的忙碌状态；
 *  - Worker 创建失败（环境不支持等）时同步回传错误，调用方展示原因并可再次发起。
 */
import AlignWorker from './align.worker.ts?worker';
import type { JobError, JobRequest, JobResponse } from './alignJob';

export interface JobHandlers {
  onSuccess(res: JobResponse): void;
  onError(message: string): void;
}

/** 对联合类型逐成员做 Omit，保留 AlignRequest / MigrateRequest 各自的必填字段判别。 */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type JobInput = WithoutId<JobRequest>;

export class AlignTaskRegistry {
  private worker: Worker | null = null;
  /** 当前任务编号；旧任务的回调中比对编号即可识别迟到消息 */
  private nextId = 1;

  /**
   * 发起一次计算。调用前若已有在跑任务，先终止并丢弃（旧回调不再触发）。
   * Worker 创建失败时直接调用 onError，且不会留下存活的 Worker。
   */
  start(req: JobInput, handlers: JobHandlers): () => void {
    this.stop();
    const id = this.nextId++;
    let worker: Worker;
    try {
      worker = new AlignWorker();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      handlers.onError(message);
      return () => {};
    }
    this.worker = worker;

    const isCurrent = () => this.worker === worker;

    worker.onmessage = (e: MessageEvent<JobResponse | JobError>) => {
      const msg = e.data;
      // 任务已被取消 / 顶替，或回执属于更早的任务：一律忽略，不结束当前忙碌
      if (!isCurrent() || msg.id !== id) return;
      this.worker = null;
      worker.terminate();
      if (msg.kind === 'error') handlers.onError(msg.message);
      else handlers.onSuccess(msg);
    };
    worker.onerror = (e: ErrorEvent) => {
      if (!isCurrent()) return;
      this.worker = null;
      worker.terminate();
      handlers.onError(e.message || '对齐计算失败');
    };

    worker.postMessage({ ...req, id } as JobRequest);

    return () => {
      // 仅当本任务仍是当前任务时取消；被顶替时不影响新任务的忙碌状态
      if (!isCurrent()) return;
      this.worker = null;
      worker.terminate();
    };
  }

  /** 终止并丢弃当前任务（不触发任何回调）。 */
  stop(): void {
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    w.terminate();
  }

  get running(): boolean {
    return this.worker !== null;
  }
}
