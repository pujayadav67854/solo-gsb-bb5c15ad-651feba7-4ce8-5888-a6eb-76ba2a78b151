/**
 * 对齐 / 迁移预览计算 Worker：接收 JobRequest，回送 JobResponse 或 JobError。
 * 每个消息独立计算，任务取消由主线程 terminate() 完成，Worker 内部无需中断点。
 */
import { runAlignJob, type JobError, type JobRequest, type JobResponse } from './alignJob';

// 仅做安全的类型收窄，不引入 "WebWorker" lib（避免与 DOM lib 的全局声明冲突）
const ctx = globalThis as unknown as {
  postMessage(message: JobResponse | JobError): void;
};

self.onmessage = (e: MessageEvent<JobRequest>) => {
  const req = e.data;
  try {
    ctx.postMessage(runAlignJob(req));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ kind: 'error', id: req.id, message });
  }
};
