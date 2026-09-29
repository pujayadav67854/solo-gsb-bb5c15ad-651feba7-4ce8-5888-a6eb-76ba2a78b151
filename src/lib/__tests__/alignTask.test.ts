import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlignTaskRegistry } from '../alignTask';
import type { JobError, JobRequest, JobResponse } from '../alignJob';
import { runAlignJob } from '../alignJob';
import { SAMPLE_A, SAMPLE_B } from '../samples';
import { parseSrt } from '../srt';

/** 可控的假 Worker：记录消息、支持手动派发成功 / 失败，并统计 terminate 次数。 */
class MockWorker {
  static instances: MockWorker[] = [];
  static lastCtor: (() => void) | null = null;

  onmessage: ((e: MessageEvent<JobResponse | JobError>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: JobRequest[] = [];
  terminated = 0;

  constructor() {
    MockWorker.instances.push(this);
    MockWorker.lastCtor?.();
  }

  postMessage(req: JobRequest) {
    this.posted.push(req);
  }

  terminate() {
    this.terminated++;
  }

  emit(msg: JobResponse | JobError) {
    this.onmessage?.({ data: msg } as MessageEvent);
  }

  emitError(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }
}

describe('runAlignJob（Worker 内执行器）', () => {
  it('align：输出与现有 alignCues 一致的对齐组', () => {
    const a = parseSrt(SAMPLE_A);
    const b = parseSrt(SAMPLE_B);
    const res = runAlignJob({ kind: 'align', id: 7, cuesA: a, cuesB: b });
    expect(res.kind).toBe('align');
    if (res.kind !== 'align') return;
    expect(res.id).toBe(7);
    expect(res.groups.length).toBeGreaterThan(0);
  });

  it('migrate：重新对齐并产出迁移方案（同方案全部可迁移）', () => {
    const a = parseSrt(SAMPLE_A);
    const b = parseSrt(SAMPLE_B);
    const oldGroups = runAlignJob({ kind: 'align', id: 1, cuesA: a, cuesB: b });
    if (oldGroups.kind !== 'align') throw new Error('impossible');
    const res = runAlignJob({
      kind: 'migrate',
      id: 9,
      cuesA: a,
      cuesBUsed: b,
      cuesBOriginal: b,
      oldGroups: oldGroups.groups,
    });
    expect(res.kind).toBe('migrate');
    if (res.kind !== 'migrate') return;
    expect(res.id).toBe(9);
    expect(res.plan.ok).toBe(true);
    expect(res.plan.ambiguous).toHaveLength(0);
    expect(res.plan.transfer.length).toBe(oldGroups.groups.length);
  });
});

describe('AlignTaskRegistry（Worker 任务管理）', () => {
  beforeEach(() => {
    MockWorker.instances = [];
    MockWorker.lastCtor = null;
    vi.stubGlobal('Worker', MockWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cues = () => ({ cuesA: parseSrt(SAMPLE_A), cuesB: parseSrt(SAMPLE_B) });

  it('成功回执：触发 onSuccess，任务结束后 Worker 被释放', () => {
    const reg = new AlignTaskRegistry();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    reg.start({ kind: 'align', ...cues() }, { onSuccess, onError });
    expect(reg.running).toBe(true);
    const w = MockWorker.instances[0];
    expect(w.posted[0]).toMatchObject({ kind: 'align' });
    w.emit({ kind: 'align', id: w.posted[0].id, groups: [] });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(reg.running).toBe(false);
    expect(w.terminated).toBe(1);
  });

  it('失败回执：触发 onError 并结束忙碌，Worker 被释放', () => {
    const reg = new AlignTaskRegistry();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    reg.start({ kind: 'align', ...cues() }, { onSuccess, onError });
    const w = MockWorker.instances[0];
    w.emit({ kind: 'error', id: w.posted[0].id, message: 'boom' });
    expect(onError).toHaveBeenCalledWith('boom');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(reg.running).toBe(false);
    expect(w.terminated).toBe(1);
  });

  it('取消：terminate 当前 Worker，且不触发任何回调', () => {
    const reg = new AlignTaskRegistry();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const cancel = reg.start({ kind: 'align', ...cues() }, { onSuccess, onError });
    const w = MockWorker.instances[0];
    cancel();
    expect(w.terminated).toBe(1);
    expect(reg.running).toBe(false);
    // 迟到消息（terminate 后若仍有排队回调）不得产生任何效果
    w.emit({ kind: 'align', id: w.posted[0].id, groups: [] });
    w.emit({ kind: 'error', id: w.posted[0].id, message: 'late' });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('发起新任务顶替旧任务：旧任务迟到的成功/失败均被忽略，新任务忙碌不受影响', () => {
    const reg = new AlignTaskRegistry();
    const oldHandlers = { onSuccess: vi.fn(), onError: vi.fn() };
    reg.start({ kind: 'align', ...cues() }, oldHandlers);
    const oldW = MockWorker.instances[0];

    const newHandlers = { onSuccess: vi.fn(), onError: vi.fn() };
    reg.start({ kind: 'align', ...cues() }, newHandlers);
    expect(oldW.terminated).toBe(1); // 旧 Worker 已终止释放
    expect(reg.running).toBe(true); // 新任务仍忙碌

    // 旧任务迟到的成功与失败：均不得覆盖结果或结束新忙碌
    oldW.emit({ kind: 'align', id: oldW.posted[0].id, groups: [] });
    oldW.emitError('late-fail');
    expect(oldHandlers.onSuccess).not.toHaveBeenCalled();
    expect(oldHandlers.onError).not.toHaveBeenCalled();
    expect(reg.running).toBe(true);

    const newW = MockWorker.instances[1];
    newW.emit({ kind: 'align', id: newW.posted[0].id, groups: [] });
    expect(newHandlers.onSuccess).toHaveBeenCalledTimes(1);
    expect(reg.running).toBe(false);
  });

  it('stop() 终止旧任务后，旧任务迟到回执不触发回调', () => {
    const reg = new AlignTaskRegistry();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    reg.start({ kind: 'align', ...cues() }, { onSuccess, onError });
    const w = MockWorker.instances[0];
    reg.stop();
    expect(w.terminated).toBe(1);
    w.emit({ kind: 'align', id: w.posted[0].id, groups: [] });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('Worker 创建失败：同步回调 onError、不留存活任务，可再次发起', () => {
    MockWorker.lastCtor = () => {
      throw new Error('worker blocked');
    };
    const reg = new AlignTaskRegistry();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const cancel = reg.start({ kind: 'align', ...cues() }, { onSuccess, onError });
    expect(onError).toHaveBeenCalledWith('worker blocked');
    expect(reg.running).toBe(false);
    expect(typeof cancel).toBe('function');

    // 恢复构造后可再次发起
    MockWorker.lastCtor = null;
    reg.start({ kind: 'align', ...cues() }, { onSuccess, onError });
    expect(reg.running).toBe(true);
    const w2 = MockWorker.instances[MockWorker.instances.length - 1];
    w2.emit({ kind: 'align', id: w2.posted[0].id, groups: [] });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('id 不匹配的迟到回执也被忽略，且不结束当前任务', () => {
    const reg = new AlignTaskRegistry();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    reg.start({ kind: 'align', ...cues() }, { onSuccess, onError });
    const w = MockWorker.instances[0];
    const myId = w.posted[0].id;
    // 伪造其它任务 id 的回执：忽略，任务保持忙碌、Worker 不释放
    w.emit({ kind: 'align', id: myId + 999, groups: [] });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(reg.running).toBe(true);
    expect(w.terminated).toBe(0);
    // 本任务正确回执仍正常处理
    w.emit({ kind: 'align', id: myId, groups: [] });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(reg.running).toBe(false);
  });
});
