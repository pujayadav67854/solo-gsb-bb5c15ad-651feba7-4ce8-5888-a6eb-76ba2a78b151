import { useEffect, useMemo, useRef, useState } from 'react';
import type { AlignGroup } from './lib/align';
import type { JobResponse } from './lib/alignJob';
import { AlignTaskRegistry } from './lib/alignTask';
import {
  DEFAULT_CALIB_OPTIONS,
  fitCalibration,
  selectAnchors,
  type CalibOptions,
} from './lib/calibrate';
import { migrateStates, type MigrationPlan } from './lib/migrate';
import {
  autoFixTimes,
  buildMergedCues,
  defaultStateFor,
  suggestTextChoice,
  TIME_FIXABLE,
  type GroupState,
  type Resolution,
  type TimeChoice,
} from './lib/merge';
import {
  buildEditedCues,
  buildSegmentSpans,
  editedTotalDuration,
  parseSegments,
} from './lib/edit';
import {
  analyzePace,
  applyPaceFixes,
  DEFAULT_PACE_OPTIONS,
  type PaceOptions,
} from './lib/pace';
import { buildTrackCsv, parseOcclusions, planTracks } from './lib/occlude';
import { SAMPLE_A, SAMPLE_B } from './lib/samples';
import { parseSrt, serializeSrt, type Cue } from './lib/srt';
import {
  applyScrollChains,
  findScrollChains,
  pruneScrollAcceptance,
  type ScrollAcceptance,
  type ScrollOptions,
} from './lib/scroll';
import {
  applySnaps,
  DEFAULT_SNAP_OPTIONS,
  parseCutList,
  planSnaps,
  type SnapOptions,
} from './lib/snap';
import { normalizeCues, parseTerms } from './lib/terms';
import { buildLocateIndex, searchPhrases } from './lib/locate';
import { smartWrap, type WrapOptions } from './lib/wrap';
import { CalibratePanel } from './components/CalibratePanel';
import { CalibStatusChip } from './components/CalibStatusChip';
import { DedupePanel } from './components/DedupePanel';
import { EditPanel } from './components/EditPanel';
import { ExportPanel } from './components/ExportPanel';
import { GroupCard } from './components/GroupCard';
import { ImportPanel } from './components/ImportPanel';
import { LocatePanel } from './components/LocatePanel';
import { OccludePanel } from './components/OccludePanel';
import { PacePanel } from './components/PacePanel';
import { RecalibrateMigrateDialog } from './components/RecalibrateMigrateDialog';
import { SnapPanel } from './components/SnapPanel';
import { StatsBar } from './components/StatsBar';
import { TermsPanel } from './components/TermsPanel';
import { Toolbar, type Filter } from './components/Toolbar';
import { WrapPanel } from './components/WrapPanel';

const PAGE_SIZE = 80;
const STEP_LABELS = ['导入双版本', '时间轴校准', '顺序对齐', '解决冲突', '校验导出'];

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type Phase = 'import' | 'calibrate' | 'workspace';

export default function App() {
  const [nameA, setNameA] = useState('版本A.srt');
  const [nameB, setNameB] = useState('版本B.srt');
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const cuesA = useMemo(() => parseSrt(textA), [textA]);
  const cuesB = useMemo(() => parseSrt(textB), [textB]);

  const [phase, setPhase] = useState<Phase>('import');

  // 时间轴校准：筛选参数、自动锚点、手动禁用集合，以及是否已应用
  const [calibOpts, setCalibOpts] = useState<CalibOptions>(DEFAULT_CALIB_OPTIONS);
  const calibAnchors = useMemo(
    () => (cuesA.length > 0 && cuesB.length > 0 ? selectAnchors(cuesA, cuesB, calibOpts) : []),
    [cuesA, cuesB, calibOpts],
  );
  const [calibDisabled, setCalibDisabled] = useState<ReadonlySet<string>>(new Set());
  /** 手动强制启用被自动剔除锚点的覆盖集合 */
  const [calibForced, setCalibForced] = useState<ReadonlySet<string>>(new Set());
  const calibFit = useMemo(
    () => fitCalibration(cuesA, cuesB, calibAnchors, calibDisabled, calibForced),
    [cuesA, cuesB, calibAnchors, calibDisabled, calibForced],
  );
  /** 已提交到对齐链路的 B 时间轴（null 表示使用原始 cuesB） */
  const [cuesBUsed, setCuesBUsed] = useState<Cue[] | null>(null);
  /**
   * 当前生效校准的锚点数快照：在“应用校准并对齐 / 确认迁移预览”提交时固化。
   * null 表示当前对齐使用原始 B 时间。工作区顶部标识只读此快照，不读校准页
   * 尚未提交的草稿（calibFit），因此预览计算中 / 失败 / 取消时显示保持原样。
   */
  const [appliedAnchorCount, setAppliedAnchorCount] = useState<number | null>(null);

  const [groups, setGroups] = useState<AlignGroup[] | null>(null);
  const [states, setStates] = useState<GroupState[]>([]);
  const [aligning, setAligning] = useState(false);
  /** 首次对齐的 Worker 错误信息（创建失败 / 计算抛错）；null 表示无错误 */
  const [alignError, setAlignError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [autoFix, setAutoFix] = useState(false);

  /** 当前对齐链路实际使用的 B：已校准提交时为校准后的时间轴，否则为原始 B。 */
  const cuesBEff: Cue[] = groups ? (cuesBUsed ?? cuesB) : cuesB;

  // 智能断行：视图切换、参数与逐条应用状态（key 为 groupIndex）
  const [view, setView] = useState<
    'groups' | 'dedupe' | 'wrap' | 'pace' | 'snap' | 'edit' | 'occlude' | 'terms' | 'locate'
  >('groups');
  const [wrapOpts, setWrapOpts] = useState<WrapOptions>({
    maxWidth: 42,
    maxLines: 2,
    lockManualBreaks: true,
  });
  const [wrapApplied, setWrapApplied] = useState<ReadonlySet<number>>(new Set());

  // 滚动字幕消重：参数（间隔毫秒 / 最小重叠字）与逐链采纳状态。
  // 采纳记录为“链 key（成员组序号）→ 采纳当时的链方案指纹”：只对确认时的
  // 链方案有效；原文/时间/重叠结果变化或链消失即清除（链重现也不自动恢复）。
  const [scrollOpts, setScrollOpts] = useState<ScrollOptions>({
    maxGapMs: 1000,
    minOverlap: 2,
  });
  const [scrollAccepted, setScrollAccepted] = useState<ScrollAcceptance>(new Map());

  // 阅读节奏：参数（最大字符/秒、最短/最长时长）与逐区段采纳状态（key 为区段 key）
  const [paceOpts, setPaceOpts] = useState<PaceOptions>(DEFAULT_PACE_OPTIONS);
  const [paceAccepted, setPaceAccepted] = useState<ReadonlySet<string>>(new Set());

  // 镜头切点吸附：切点文本、参数（吸附阈值、最短时长）与逐条采纳状态（key 为条目 key）
  const [cutText, setCutText] = useState('');
  const [snapOpts, setSnapOpts] = useState<SnapOptions>(DEFAULT_SNAP_OPTIONS);
  const [snapAccepted, setSnapAccepted] = useState<ReadonlySet<string>>(new Set());
  const cutParse = useMemo(() => parseCutList(cutText), [cutText]);

  // 剪辑版字幕（独立模块，只读 finalCues）：源片段列表文本（每行 起点ms 终点ms），
  // 输入或上游结果变化时通过 useMemo 立即重算，不写回合并结果
  const [segmentText, setSegmentText] = useState('');

  // 字幕遮挡避让（独立模块，只读 finalCues）：遮挡区间列表文本
  // （每行 起点ms 终点ms 上/下），输入或上游结果变化时立即重算轨道分配
  const [occText, setOccText] = useState('');

  // 术语统一（独立模块，只读 finalCues）：术语表文本（每行 原词⇥Tab⇥替换词），
  // 输入或上游 finalCues 变化时立即重算规范化副本，不写回合并结果
  const [termsText, setTermsText] = useState('');

  // 审校短语定位（独立模块，只读 finalCues）：短语与允许跨条的最大间隔
  // （非负整数毫秒）；输入或上游 finalCues 变化时立即重算，不写回合并结果
  const [locatePhraseText, setLocatePhraseText] = useState('');
  const [locateGapText, setLocateGapText] = useState('0');

  // 重新校准并迁移审校决定：从工作区进入校准页时保留旧 groups/states；
  // 新对齐算出后先在弹窗中预览迁移方案，确认后才一次提交，取消则旧工作区原封不动。
  const [migrateMode, setMigrateMode] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [migrateBusy, setMigrateBusy] = useState(false);
  /** 迁移预览的 Worker 错误信息（创建失败 / 计算抛错）；null 表示无错误 */
  const [migrateError, setMigrateError] = useState<string | null>(null);
  /**
   * 最近一次发起迁移预览时固化的参数（含发起当时草稿的启用锚点数），
   * 用于计算中 / 失败时弹窗文案与失败后的“重新计算”。绝不回写当前工作区，
   * 也不随校准页上之后的草稿修改而变化。
   */
  const [migratePending, setMigratePending] = useState<{
    b: Cue[];
    calibrated: boolean;
    anchorCount: number;
  } | null>(null);
  const [migrateData, setMigrateData] = useState<{
    oldGroups: AlignGroup[];
    oldStates: GroupState[];
    newGroups: AlignGroup[];
    newCuesB: Cue[];
    calibrated: boolean;
    /** 发起本次预览时草稿的启用锚点数；确认提交后据此更新工作区生效标识 */
    anchorCount: number;
    plan: MigrationPlan;
  } | null>(null);

  // 对齐 / 迁移预览的 Worker 任务槽：同时只允许一个任务，发起新任务或离开相关页面
  // （返回导入、修改字幕、加载示例等）时终止旧任务；任务结束即释放 Worker。
  const taskRef = useRef<AlignTaskRegistry | null>(null);
  if (!taskRef.current) taskRef.current = new AlignTaskRegistry();
  useEffect(() => () => taskRef.current?.stop(), []);

  /** 用指定的 B 时间轴在 Worker 中执行顺序对齐；完成后一次性进入工作区。 */
  const runAlign = (b: Cue[]) => {
    // 输入固定为本次 A/B 字幕与所选 B 时间轴，迟到回调只使用闭包内的这一份
    const a = cuesA;
    setAligning(true);
    setAlignError(null);
    taskRef.current?.start(
      { kind: 'align', cuesA: a, cuesB: b },
      {
        onSuccess: (res: JobResponse) => {
          if (res.kind !== 'align') return;
          const gs = res.groups;
          setGroups(gs);
          setStates(gs.map((g) => defaultStateFor(g, a, b)));
          setAligning(false);
          setFilter('all');
          setVisibleCount(PAGE_SIZE);
          setAutoFix(false);
          setView('groups');
          setWrapApplied(new Set());
          setScrollAccepted(new Map());
          setPaceAccepted(new Set());
          setSnapAccepted(new Set());
          setPhase('workspace');
        },
        onError: (message) => {
          // 展示原因、结束忙碌并允许再次发起；不切换页面、不清空已有工作区
          setAlignError(message);
          setAligning(false);
        },
      },
    );
  };

  /** 取消首次对齐：终止 Worker、结束忙碌并留在当前页面（导入 / 校准页）。 */
  const cancelAlign = () => {
    taskRef.current?.stop();
    setAligning(false);
  };

  const startCalibrate = () => {
    if (cuesA.length === 0 || cuesB.length === 0) return;
    setPhase('calibrate');
  };

  const skipCalibrate = () => {
    if (cuesA.length === 0 || cuesB.length === 0) return;
    setCuesBUsed(null);
    setAppliedAnchorCount(null);
    runAlign(cuesB);
  };

  const applyCalibration = () => {
    if (!calibFit.ok) return;
    if (migrateMode) {
      // 只固化发起时的草稿参数生成预览，不触碰当前生效校准信息
      previewMigration(calibFit.mappedCues, true, calibFit.active.length);
      return;
    }
    // 提交校准后的 B 时间作为对齐输入（仅此处替换），同时固化生效锚点数
    setCuesBUsed(calibFit.mappedCues);
    setAppliedAnchorCount(calibFit.active.length);
    runAlign(calibFit.mappedCues);
  };

  const restoreOriginalB = () => {
    if (migrateMode) {
      // 只固化“改用原始 B 时间”的预览参数；取消返回时生效信息仍是旧的
      previewMigration(cuesB, false, calibFit.active.length);
      return;
    }
    setCuesBUsed(null);
    setAppliedAnchorCount(null);
    runAlign(cuesB);
  };

  /** 工作区入口：进入校准页并保留当前对齐组与人工决定。 */
  const startRecalibrateMigrate = () => {
    if (!groups) return;
    setMigrateMode(true);
    setMigrateData(null);
    setMigratePending(null);
    setMigrateError(null);
    setPhase('calibrate');
  };

  /** 校准页返回：迁移模式下取消迁移并保留旧工作区；首次流程下返回导入页并终止计算。 */
  const backFromCalibrate = () => {
    if (migrateMode) {
      cancelMigration();
      return;
    }
    taskRef.current?.stop();
    setAligning(false);
    setAlignError(null);
    setPhase('import');
  };

  /** 取消迁移：终止计算、关闭预览、退出迁移校准页，旧工作区（groups/states/生效校准）原封不动。 */
  const cancelMigration = () => {
    taskRef.current?.stop();
    setMigrateOpen(false);
    setMigrateBusy(false);
    setMigrateError(null);
    setMigratePending(null);
    setMigrateData(null);
    setMigrateMode(false);
    setPhase('workspace');
  };

  /**
   * 用新校准（或原始 B 时间）在 Worker 中重新对齐并计算迁移预览；不改动当前工作区。
   * anchorCount 为发起当时校准草稿的启用锚点数，随预览一起固化，供弹窗在计算中 /
   * 失败时展示，并在确认提交后写入工作区生效标识。
   */
  const previewMigration = (b: Cue[], calibrated: boolean, anchorCount: number) => {
    if (!groups) return;
    const oldGroups = groups;
    const oldStates = states;
    const a = cuesA;
    const bOrig = cuesB;
    setMigratePending({ b, calibrated, anchorCount });
    setMigrateOpen(true);
    setMigrateBusy(true);
    setMigrateError(null);
    setMigrateData(null);
    taskRef.current?.start(
      { kind: 'migrate', cuesA: a, cuesBUsed: b, cuesBOriginal: bOrig, oldGroups },
      {
        onSuccess: (res: JobResponse) => {
          if (res.kind !== 'migrate') return;
          // 迟到结果只写入本次闭包固定的旧组与 B 时间轴；确认前绝不触碰当前工作区
          setMigrateData({
            oldGroups,
            oldStates,
            newGroups: res.newGroups,
            newCuesB: b,
            calibrated,
            anchorCount,
            plan: res.plan,
          });
          setMigrateBusy(false);
        },
        onError: (message) => {
          // 展示原因、结束忙碌并允许重新发起；旧工作区保持原样
          setMigrateError(message);
          setMigrateBusy(false);
        },
      },
    );
  };

  /** 迁移预览 Worker 失败后，用相同参数（同一发起快照）再次发起计算。 */
  const retryMigration = () => {
    const args = migratePending;
    if (args) previewMigration(args.b, args.calibrated, args.anchorCount);
  };

  /** 确认预览：一次提交新对齐、迁移决定，并清空时间/消重/断行/节奏/吸附相关采纳。 */
  const confirmMigration = () => {
    const data = migrateData;
    if (!data || !data.plan.ok) return;
    const { oldStates, newGroups, newCuesB, calibrated, anchorCount, plan } = data;
    const newBase = newGroups.map((g) => defaultStateFor(g, cuesA, newCuesB));
    const newStates = migrateStates(newGroups, newBase, oldStates, plan);
    // 校准后的 B 时间轴与锚点数快照随提交一起生效；使用原始时间时明确置空（显示未校准）
    setCuesBUsed(calibrated ? newCuesB : null);
    setAppliedAnchorCount(calibrated ? anchorCount : null);
    setGroups(newGroups);
    setStates(newStates);
    // 时间选择一律使用新组默认值（newBase 已保证）；清空所有下游采纳
    setFilter('all');
    setVisibleCount(PAGE_SIZE);
    setAutoFix(false);
    setView('groups');
    setWrapApplied(new Set());
    setScrollAccepted(new Map());
    setPaceAccepted(new Set());
    setSnapAccepted(new Set());
    setMigrateOpen(false);
    setMigrateData(null);
    setMigratePending(null);
    setMigrateError(null);
    setMigrateMode(false);
    setAligning(false);
    setPhase('workspace');
  };

  const toggleAnchor = (key: string) => {
    const anchor = calibAnchors.find((a) => a.key === key);
    if (!anchor) return;
    if (anchor.autoKept) {
      // 自动保留：勾选框控制禁用
      setCalibForced((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setCalibDisabled((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    } else {
      // 自动剔除：勾选框控制强制启用
      setCalibDisabled((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setCalibForced((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }
  };

  const resetAnchors = () => {
    setCalibDisabled(new Set());
    setCalibForced(new Set());
  };

  const handleText = (side: 'A' | 'B', text: string, name?: string) => {
    // 修改字幕即终止可能在跑的对齐计算，并清掉其忙碌/错误状态
    taskRef.current?.stop();
    setAligning(false);
    setAlignError(null);
    if (side === 'A') {
      setTextA(text);
      if (name) setNameA(name);
    } else {
      setTextB(text);
      if (name) setNameB(name);
    }
  };

  const loadSample = () => {
    taskRef.current?.stop();
    setAligning(false);
    setAlignError(null);
    setNameA('示例A.srt');
    setNameB('示例B.srt');
    setTextA(SAMPLE_A);
    setTextB(SAMPLE_B);
    setCuesBUsed(null);
    setAppliedAnchorCount(null);
    setCalibDisabled(new Set());
    setCalibForced(new Set());
    setCalibOpts(DEFAULT_CALIB_OPTIONS);
    setGroups(null);
    setStates([]);
    setMigrateMode(false);
    setMigrateOpen(false);
    setMigrateBusy(false);
    setMigrateError(null);
    setMigratePending(null);
    setMigrateData(null);
    setPhase('calibrate');
  };

  const resetAll = () => {
    taskRef.current?.stop();
    setAligning(false);
    setAlignError(null);
    setGroups(null);
    setStates([]);
    setCuesBUsed(null);
    setAppliedAnchorCount(null);
    setCalibDisabled(new Set());
    setCalibForced(new Set());
    setView('groups');
    setWrapApplied(new Set());
    setScrollAccepted(new Map());
    setPaceAccepted(new Set());
    setSnapAccepted(new Set());
    setMigrateMode(false);
    setMigrateOpen(false);
    setMigrateBusy(false);
    setMigrateError(null);
    setMigratePending(null);
    setMigrateData(null);
    setPhase('import');
  };

  const recalibrate = () => {
    taskRef.current?.stop();
    setAligning(false);
    setAlignError(null);
    setGroups(null);
    setStates([]);
    setCuesBUsed(null);
    setAppliedAnchorCount(null);
    setCalibDisabled(new Set());
    setCalibForced(new Set());
    setView('groups');
    setWrapApplied(new Set());
    setScrollAccepted(new Map());
    setPaceAccepted(new Set());
    setSnapAccepted(new Set());
    setMigrateMode(false);
    setMigrateOpen(false);
    setMigrateBusy(false);
    setMigrateError(null);
    setMigratePending(null);
    setMigrateData(null);
    setPhase('calibrate');
  };

  const updateResolution = (gi: number, patch: Partial<Resolution>) => {
    setStates((prev) =>
      prev.map((s, i) => {
        if (i !== gi) return s;
        let resolution = { ...s.resolution, ...patch };
        // 改选整组 A/B/自定义/局部混编（或重新对齐）时清除旧的逐片段选择，
        // 避免片段边界变化后旧选择错位；新选择由调用方在 patch.mixChoices 中给出
        if (patch.text && patch.text !== s.resolution.text) {
          resolution = { ...resolution, mixChoices: patch.mixChoices ?? [] };
        }
        return { ...s, resolved: true, resolution };
      }),
    );
  };

  const bulkText = (choice: 'A' | 'B' | 'longer') => {
    if (!groups) return;
    setStates((prev) =>
      prev.map((s, i) => {
        const g = groups[i];
        if (g.aIdx.length === 0 || g.bIdx.length === 0) return s;
        const text = choice === 'longer' ? suggestTextChoice(g, cuesA, cuesBEff) : choice;
        return { ...s, resolved: true, resolution: { ...s.resolution, text, mixChoices: [] } };
      }),
    );
  };

  const bulkTime = (choice: TimeChoice) => {
    if (!groups) return;
    setStates((prev) =>
      prev.map((s, i) => {
        const g = groups[i];
        if (g.aIdx.length === 0 || g.bIdx.length === 0) return s;
        return { ...s, resolved: true, resolution: { ...s.resolution, time: choice } };
      }),
    );
  };

  const resolveSuggested = () => {
    if (!groups) return;
    setStates((prev) =>
      prev.map((s, i) =>
        s.isConflict
          ? {
              ...s,
              resolved: true,
              resolution: {
                ...s.resolution,
                text: suggestTextChoice(groups[i], cuesA, cuesBEff),
                time: 'union',
                mixChoices: [],
              },
            }
          : s,
      ),
    );
  };

  const setOnlyKeep = (side: 'A' | 'B', keep: boolean) => {
    if (!groups) return;
    const kind = side === 'A' ? 'A-only' : 'B-only';
    setStates((prev) =>
      prev.map((s, i) =>
        groups[i].kind === kind
          ? { ...s, resolved: true, resolution: { ...s.resolution, keep } }
          : s,
      ),
    );
  };

  const merged = useMemo(
    () => (groups ? buildMergedCues(groups, states, cuesA, cuesBEff) : null),
    [groups, states, cuesA, cuesBEff],
  );

  // 滚动字幕消重：在合并结果上识别滚动链，按已采纳链折叠后再进入断行/导出。
  // 采纳记录为“链 key（成员组序号）→ 采纳当时的链方案指纹”：链随上游/参数重算后，
  // 指纹变化或已消失的采纳被物理清除（链之后以相同内容重现也不恢复），
  // 未变化的其他采纳继续生效。
  const scrollChains = useMemo(
    () => (merged ? findScrollChains(merged.cues, scrollOpts) : []),
    [merged, scrollOpts],
  );
  useEffect(() => {
    setScrollAccepted((prev) => {
      if (prev.size === 0) return prev;
      const { next, changed } = pruneScrollAcceptance(scrollChains, prev);
      return changed ? next : prev;
    });
  }, [scrollChains]);
  const dedupedCues = useMemo(() => {
    if (!merged) return [];
    // applyScrollChains 同时比对 key 与指纹；清除 effect 尚未提交的瞬间也不会
    // 误折叠任何已变化的链（预览/导出始终只折叠“已确认方案”）。
    return applyScrollChains(merged.cues, scrollChains, scrollAccepted);
  }, [merged, scrollChains, scrollAccepted]);
  const dedupStats = useMemo(() => {
    let appliedChains = 0;
    let saved = 0;
    let totalSaved = 0;
    for (const ch of scrollChains) {
      totalSaved += ch.saved;
      if (scrollAccepted.get(ch.key) === ch.signature) {
        appliedChains++;
        saved += ch.saved;
      }
    }
    return { chainCount: scrollChains.length, appliedChains, saved, totalSaved };
  }, [scrollChains, scrollAccepted]);

  const acceptChain = (key: string) => {
    const ch = scrollChains.find((c) => c.key === key);
    if (!ch) return;
    setScrollAccepted((prev) => new Map(prev).set(key, ch.signature));
  };
  const restoreChain = (key: string) =>
    setScrollAccepted((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  const acceptAllChains = (keys: string[]) =>
    setScrollAccepted((prev) => {
      const next = new Map(prev);
      keys.forEach((k) => {
        const ch = scrollChains.find((c) => c.key === k);
        if (ch) next.set(k, ch.signature);
      });
      return next;
    });
  const restoreAllChains = () => setScrollAccepted(new Map());

  // 智能断行：对每条（消重后）结果按当前参数试算；已应用且可满足限制的条目使用断行文本
  const wrapResults = useMemo(
    () => dedupedCues.map((c) => smartWrap(c.text, wrapOpts)),
    [dedupedCues, wrapOpts],
  );
  const wrappedCues = useMemo(() => {
    return dedupedCues.map((c, i) => {
      const r = wrapResults[i];
      return r.ok && wrapApplied.has(c.groupIndex) ? { ...c, text: r.text } : c;
    });
  }, [dedupedCues, wrapResults, wrapApplied]);
  const wrapStats = useMemo(() => {
    let appliedCount = 0;
    let failed = 0;
    dedupedCues.forEach((c, i) => {
      const r = wrapResults[i];
      if (!r.ok) failed++;
      else if (r.changed && wrapApplied.has(c.groupIndex)) appliedCount++;
    });
    return { appliedCount, failed };
  }, [dedupedCues, wrapResults, wrapApplied]);

  const applyWrap = (gi: number) => setWrapApplied((prev) => new Set(prev).add(gi));
  const restoreWrap = (gi: number) =>
    setWrapApplied((prev) => {
      const next = new Set(prev);
      next.delete(gi);
      return next;
    });
  const applyAllWrap = () => {
    const next = new Set<number>();
    dedupedCues.forEach((c, i) => {
      const r = wrapResults[i];
      if (r.ok && r.changed) next.add(c.groupIndex);
    });
    setWrapApplied(next);
  };
  const restoreAllWrap = () => setWrapApplied(new Set());

  // 阅读节奏：在已采纳消重、已应用断行的当前结果上统计字/秒并划分超限区段；
  // 已采纳区段只替换时间，文本、顺序与 groupIndex 不变，随后进入预览与导出
  const paceAnalysis = useMemo(
    () => analyzePace(wrappedCues, paceOpts),
    [wrappedCues, paceOpts],
  );
  const pacedCues = useMemo(
    () => applyPaceFixes(wrappedCues, paceAnalysis.segments, paceAccepted),
    [wrappedCues, paceAnalysis, paceAccepted],
  );
  const paceStats = useMemo(() => {
    let applied = 0;
    let unsolvable = 0;
    for (const seg of paceAnalysis.segments) {
      if (!seg.ok) unsolvable++;
      else if (paceAccepted.has(seg.key)) applied++;
    }
    const violating = paceAnalysis.stats.reduce((n, s) => n + (s.violating ? 1 : 0), 0);
    return { segments: paceAnalysis.segments.length, applied, unsolvable, violating };
  }, [paceAnalysis, paceAccepted]);

  const acceptPace = (key: string) => setPaceAccepted((prev) => new Set(prev).add(key));
  const restorePace = (key: string) =>
    setPaceAccepted((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  const acceptAllPace = (keys: string[]) =>
    setPaceAccepted((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
  const restoreAllPace = () => setPaceAccepted(new Set());

  // 镜头切点吸附：在已采纳消重、断行与节奏修复的结果上，用全局动态规划为切点
  // 附近的字幕边界选择吸附/保留；已采纳条目只替换时间，随后进入预览与导出
  const snapPlan = useMemo(
    () => planSnaps(pacedCues, cutParse.cuts, snapOpts),
    [pacedCues, cutParse, snapOpts],
  );
  const snappedCues = useMemo(
    () => applySnaps(pacedCues, snapPlan.items, snapAccepted),
    [pacedCues, snapPlan, snapAccepted],
  );
  const snapStats = useMemo(() => {
    const movable = snapPlan.items.filter((it) => it.changed).length;
    const liveKeys = new Set(snapPlan.items.map((it) => it.key));
    let applied = 0;
    snapAccepted.forEach((k) => {
      if (liveKeys.has(k)) applied++;
    });
    return {
      ok: snapPlan.ok,
      cuts: cutParse.cuts.length,
      invalid: cutParse.invalid.length,
      movable,
      applied,
      originalCrossing: snapPlan.originalCrossing,
      crossing: snapPlan.cost.crossing,
      displacement: snapPlan.cost.displacement,
    };
  }, [snapPlan, snapAccepted, cutParse]);

  const acceptSnap = (key: string) => setSnapAccepted((prev) => new Set(prev).add(key));
  const restoreSnap = (key: string) =>
    setSnapAccepted((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  const acceptAllSnaps = (keys: string[]) =>
    setSnapAccepted((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
  const restoreAllSnaps = () => setSnapAccepted(new Set());

  const finalCues = useMemo(
    () => (autoFix ? autoFixTimes(snappedCues) : snappedCues),
    [snappedCues, autoFix],
  );
  const issues = useMemo(
    () =>
      merged
        ? autoFix
          ? merged.issues.filter((i) => !TIME_FIXABLE.includes(i.kind))
          : merged.issues
        : [],
    [merged, autoFix],
  );

  const conflictCount = states.filter((s) => s.isConflict).length;
  const resolvedCount = states.filter((s) => s.isConflict && s.resolved).length;
  const unresolved = states.filter((s) => !s.resolved).length;
  const canExport = !!groups && unresolved === 0 && issues.length === 0 && finalCues.length > 0;

  // 剪辑版字幕：解析片段列表 → 在最终合并结果上裁切重排。输入或上游 finalCues
  // 变化立即重算；仅读取 finalCues，绝不修改合并结果。
  const segParse = useMemo(() => parseSegments(segmentText), [segmentText]);
  const editedCues = useMemo(
    () => buildEditedCues(finalCues, segParse.segments),
    [finalCues, segParse],
  );
  const editedSpans = useMemo(
    () => buildSegmentSpans(segParse.segments, editedCues),
    [segParse, editedCues],
  );
  const editedDuration = useMemo(
    () => editedTotalDuration(segParse.segments),
    [segParse],
  );
  const editedSrt = useMemo(() => serializeSrt(editedCues), [editedCues]);
  const editedPreview = useMemo(() => {
    const full = editedSrt;
    return full.length > 20000
      ? `${full.slice(0, 20000)}\n…（共 ${editedCues.length} 条，预览已截断）`
      : full;
  }, [editedSrt, editedCues.length]);
  // 下载门槛：片段无格式错误、上游可导出、剪辑结果非空
  const editedReason =
    !groups
      ? '尚无上游结果'
      : unresolved > 0
        ? `上游还有 ${unresolved} 个未解决冲突`
        : issues.length > 0
          ? `上游存在 ${issues.length} 个校验错误`
          : finalCues.length === 0
            ? '上游结果为空'
            : segParse.invalid.length > 0
              ? `片段列表第 ${segParse.invalid.map((b) => b.line).join('、')} 行格式错误`
              : segParse.segments.length === 0
                ? '请先填写源片段列表'
                : editedCues.length === 0
                  ? '所有片段均未与字幕相交，剪辑结果为空'
                  : '';
  const canDownloadEdited = editedReason === '';

  // 字幕遮挡避让：解析遮挡列表 → 在最终合并结果上做全局轨道分配。输入或上游
  // finalCues 变化立即重算；仅读取 finalCues，绝不修改合并结果，也不改变 SRT。
  const occParse = useMemo(() => parseOcclusions(occText), [occText]);
  const occPlan = useMemo(
    () => planTracks(finalCues, occParse.occlusions),
    [finalCues, occParse],
  );
  const occCsv = useMemo(
    () => (occPlan.ok ? buildTrackCsv(finalCues, occPlan.tracks) : ''),
    [finalCues, occPlan],
  );
  // 下载门槛：遮挡列表无格式错误、上游可导出、存在完整方案（无两轨均被遮挡的字幕）
  const occReason =
    !groups
      ? '尚无上游结果'
      : unresolved > 0
        ? `上游还有 ${unresolved} 个未解决冲突`
        : issues.length > 0
          ? `上游存在 ${issues.length} 个校验错误`
          : finalCues.length === 0
            ? '上游结果为空'
            : occParse.invalid.length > 0
              ? `遮挡列表第 ${occParse.invalid.map((b) => b.line).join('、')} 行格式错误`
              : !occPlan.ok
                ? `第 ${occPlan.failIndex + 1} 条字幕两轨均被遮挡，无完整方案`
                : '';
  const canDownloadOcc = occReason === '';

  // 术语统一：解析术语表 → 在最终合并结果上做字素级最长匹配替换。输入或上游
  // finalCues 变化立即重算；仅读取 finalCues，绝不修改合并结果，时间与条数不变。
  const termsParse = useMemo(() => parseTerms(termsText), [termsText]);
  const termsResults = useMemo(
    () => normalizeCues(finalCues, termsParse.rules),
    [finalCues, termsParse],
  );
  const termsSrt = useMemo(
    () => serializeSrt(termsResults.map((c) => ({ start: c.start, end: c.end, text: c.after }))),
    [termsResults],
  );
  const termsPreview = useMemo(() => {
    return termsSrt.length > 20000
      ? `${termsSrt.slice(0, 20000)}\n…（共 ${termsResults.length} 条，预览已截断）`
      : termsSrt;
  }, [termsSrt, termsResults.length]);
  const termsHitCount = useMemo(
    () => termsResults.reduce((n, c) => n + c.hits.length, 0),
    [termsResults],
  );
  const termsChangedCount = useMemo(
    () => termsResults.filter((c) => c.hits.length > 0).length,
    [termsResults],
  );
  // 下载门槛：术语表无任何错误行且至少一条有效规则、上游可导出
  const termsReason =
    !groups
      ? '尚无上游结果'
      : unresolved > 0
        ? `上游还有 ${unresolved} 个未解决冲突`
        : issues.length > 0
          ? `上游存在 ${issues.length} 个校验错误`
          : finalCues.length === 0
            ? '上游结果为空'
            : termsParse.totalLines === 0
              ? '请先填写术语表（每行用 Tab 分隔原词与替换词）'
              : termsParse.invalid.length > 0
                ? `术语表第 ${termsParse.invalid.map((b) => b.line).join('、')} 行有误`
                : termsParse.rules.length === 0
                  ? '术语表没有有效规则'
                  : '';
  const canDownloadTerms = termsReason === '';

  // 审校短语定位：最终字幕变化时重建索引，短语 / 间隔变化时即时重算命中；只读
  const locateIndex = useMemo(() => buildLocateIndex(finalCues), [finalCues]);
  const locateResult = useMemo(
    () => searchPhrases(locateIndex, locatePhraseText, locateGapText),
    [locateIndex, locatePhraseText, locateGapText],
  );

  const preview = useMemo(() => {
    if (!groups) return '';
    const full = serializeSrt(finalCues);
    return full.length > 20000
      ? `${full.slice(0, 20000)}\n…（共 ${finalCues.length} 条，预览已截断）`
      : full;
  }, [groups, finalCues]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, unresolved: 0, low: 0, aonly: 0, bonly: 0 };
    if (!groups) return c;
    groups.forEach((g, i) => {
      c.all++;
      if (!states[i].resolved) c.unresolved++;
      if (g.aIdx.length > 0 && g.bIdx.length > 0 && g.confidence < 0.5) c.low++;
      if (g.kind === 'A-only') c.aonly++;
      if (g.kind === 'B-only') c.bonly++;
    });
    return c;
  }, [groups, states]);

  const filtered = useMemo(() => {
    if (!groups) return [];
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const matched = g.aIdx.length > 0 && g.bIdx.length > 0;
      const ok =
        filter === 'all' ||
        (filter === 'unresolved' && !states[i].resolved) ||
        (filter === 'low' && matched && g.confidence < 0.5) ||
        (filter === 'aonly' && g.kind === 'A-only') ||
        (filter === 'bonly' && g.kind === 'B-only');
      if (ok) out.push(i);
    }
    return out;
  }, [groups, states, filter]);

  // 顶部步骤条：导入(0) / 校准(1) 为当前页；进入工作区后对齐(2) 已完成，
  // 未解决冲突时停在“解决冲突”(3)，否则进入“校验导出”(4)
  const step =
    phase === 'import' ? 0 : phase === 'calibrate' ? 1 : groups ? (unresolved > 0 ? 3 : 4) : 1;

  const jumpToGroup = (gi: number) => {
    document.getElementById(`group-${gi}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span>
          <div>
            <h1>字幕对齐合并工具</h1>
            <p>双版本 SRT 时间轴校准 · 顺序对齐 · 冲突决策 · 合并导出</p>
          </div>
        </div>
        <ol className="steps">
          {STEP_LABELS.map((label, i) => (
            <li key={label} className={i < step ? 'done' : i === step ? 'active' : ''}>
              <span className="step-n">{i < step ? '✓' : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </header>

      {phase === 'import' ? (
        <ImportPanel
          nameA={nameA}
          nameB={nameB}
          textA={textA}
          textB={textB}
          cuesA={cuesA}
          cuesB={cuesB}
          busy={aligning}
          error={alignError}
          onText={handleText}
          onCalibrate={startCalibrate}
          onSkipCalibrate={skipCalibrate}
          onCancel={cancelAlign}
          onSample={loadSample}
        />
      ) : phase === 'calibrate' ? (
        <CalibratePanel
          nameA={nameA}
          nameB={nameB}
          cuesA={cuesA}
          cuesB={cuesB}
          anchors={calibAnchors}
          fit={calibFit}
          options={calibOpts}
          onOptions={setCalibOpts}
          disabled={calibDisabled}
          forced={calibForced}
          onToggle={toggleAnchor}
          onReset={resetAnchors}
          applied={false}
          aligning={aligning}
          alignError={alignError}
          migrateMode={migrateMode}
          onApply={applyCalibration}
          onUseOriginal={restoreOriginalB}
          onCancel={cancelAlign}
          onBack={backFromCalibrate}
        />
      ) : (
        groups && (
          <>
            <div className="import-summary">
              <span className="file-chip a">{nameA} · {cuesA.length} 条</span>
              <span className="swap">⇄</span>
              <span className="file-chip b">{nameB} · {cuesBEff.length} 条</span>
              <CalibStatusChip
                calibrated={appliedAnchorCount !== null}
                anchorCount={appliedAnchorCount ?? 0}
              />
              <span className="spacer" />
              <button
                className="btn sm accent"
                onClick={startRecalibrateMigrate}
                title="保留旧对齐组与人工文本选择，重新校准并重新对齐，再预览可迁移的审校决定"
              >
                重新校准并迁移决定
              </button>
              <button className="btn sm" onClick={recalibrate}>
                时间轴校准
              </button>
              <button className="btn sm" onClick={resetAll}>
                重新导入
              </button>
            </div>

            <div className="layout">
              <main className="main-col">
                <StatsBar groups={groups} states={states} />
                <div className="tabs view-tabs">
                  <button
                    className={`tab ${view === 'groups' ? 'active' : ''}`}
                    onClick={() => setView('groups')}
                  >
                    对齐分组
                    <span className="tab-count">{groups.length}</span>
                  </button>
                  <button
                    className={`tab ${view === 'dedupe' ? 'active' : ''}`}
                    onClick={() => setView('dedupe')}
                  >
                    滚动字幕消重
                    <span className="tab-count">{dedupStats.appliedChains}</span>
                  </button>
                  <button
                    className={`tab ${view === 'wrap' ? 'active' : ''}`}
                    onClick={() => setView('wrap')}
                  >
                    智能断行
                    <span className="tab-count">{wrapStats.appliedCount}</span>
                  </button>
                  <button
                    className={`tab ${view === 'pace' ? 'active' : ''}`}
                    onClick={() => setView('pace')}
                  >
                    阅读节奏
                    <span className="tab-count">{paceStats.violating}</span>
                  </button>
                  <button
                    className={`tab ${view === 'snap' ? 'active' : ''}`}
                    onClick={() => setView('snap')}
                  >
                    镜头切点吸附
                    <span className="tab-count">{snapStats.applied}</span>
                  </button>
                  <button
                    className={`tab ${view === 'edit' ? 'active' : ''}`}
                    onClick={() => setView('edit')}
                  >
                    剪辑版字幕
                    <span className="tab-count">{editedCues.length}</span>
                  </button>
                  <button
                    className={`tab ${view === 'occlude' ? 'active' : ''}`}
                    onClick={() => setView('occlude')}
                  >
                    字幕遮挡避让
                    <span className="tab-count">{occPlan.ok ? occPlan.topCount : '✗'}</span>
                  </button>
                  <button
                    className={`tab ${view === 'terms' ? 'active' : ''}`}
                    onClick={() => setView('terms')}
                  >
                    术语统一
                    <span className="tab-count">{termsChangedCount}</span>
                  </button>
                  <button
                    className={`tab ${view === 'locate' ? 'active' : ''}`}
                    onClick={() => setView('locate')}
                  >
                    审校定位
                    <span className="tab-count">{locateResult.error ? '✗' : locateResult.hits.length}</span>
                  </button>
                </div>
                {view === 'groups' ? (
                  <>
                    <Toolbar
                      filter={filter}
                      counts={counts}
                      onFilter={(f) => {
                        setFilter(f);
                        setVisibleCount(PAGE_SIZE);
                      }}
                      onBulkText={bulkText}
                      onBulkTime={bulkTime}
                      onResolveSuggested={resolveSuggested}
                      onOnlyKeep={setOnlyKeep}
                    />
                    <div className="group-list">
                      {filtered.slice(0, visibleCount).map((gi) => (
                        <GroupCard
                          key={groups[gi].id}
                          index={gi}
                          group={groups[gi]}
                          state={states[gi]}
                          cuesA={cuesA}
                          cuesB={cuesBEff}
                          suggestion={suggestTextChoice(groups[gi], cuesA, cuesBEff)}
                          onResolve={(patch) => updateResolution(gi, patch)}
                        />
                      ))}
                      {filtered.length === 0 && (
                        <div className="empty">当前筛选条件下没有对齐组。</div>
                      )}
                      {filtered.length > visibleCount && (
                        <button className="btn more" onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
                          显示更多（剩余 {filtered.length - visibleCount} 组）
                        </button>
                      )}
                    </div>
                  </>
                ) : view === 'dedupe' ? (
                  <DedupePanel
                    cues={merged?.cues ?? []}
                    options={scrollOpts}
                    onOptions={setScrollOpts}
                    accepted={scrollAccepted}
                    onAccept={acceptChain}
                    onRestore={restoreChain}
                    onAcceptAll={acceptAllChains}
                    onRestoreAll={restoreAllChains}
                  />
                ) : view === 'wrap' ? (
                  <WrapPanel
                    cues={dedupedCues}
                    results={wrapResults}
                    applied={wrapApplied}
                    options={wrapOpts}
                    onOptions={setWrapOpts}
                    onApply={applyWrap}
                    onRestore={restoreWrap}
                    onApplyAll={applyAllWrap}
                    onRestoreAll={restoreAllWrap}
                  />
                ) : view === 'pace' ? (
                  <PacePanel
                    cues={wrappedCues}
                    analysis={paceAnalysis}
                    accepted={paceAccepted}
                    options={paceOpts}
                    onOptions={setPaceOpts}
                    onAccept={acceptPace}
                    onRestore={restorePace}
                    onAcceptAll={acceptAllPace}
                    onRestoreAll={restoreAllPace}
                  />
                ) : view === 'snap' ? (
                  <SnapPanel
                    cues={pacedCues}
                    plan={snapPlan}
                    parsed={cutParse}
                    accepted={snapAccepted}
                    cutText={cutText}
                    onCutText={setCutText}
                    options={snapOpts}
                    onOptions={setSnapOpts}
                    onAccept={acceptSnap}
                    onRestore={restoreSnap}
                    onAcceptAll={acceptAllSnaps}
                    onRestoreAll={restoreAllSnaps}
                  />
                ) : view === 'edit' ? (
                  <EditPanel
                    sourceCount={finalCues.length}
                    sourceReady={canExport}
                    segmentText={segmentText}
                    onSegmentText={setSegmentText}
                    parsed={segParse}
                    edited={editedCues}
                    spans={editedSpans}
                    totalDuration={editedDuration}
                    preview={editedPreview}
                    canDownload={canDownloadEdited}
                    downloadReason={editedReason}
                    onDownload={() => download('edited.srt', '\uFEFF' + editedSrt)}
                  />
                ) : view === 'occlude' ? (
                  <OccludePanel
                    sourceCount={finalCues.length}
                    sourceReady={canExport}
                    occText={occText}
                    onOccText={setOccText}
                    parsed={occParse}
                    cues={finalCues}
                    plan={occPlan}
                    canDownload={canDownloadOcc}
                    downloadReason={occReason}
                    onDownload={() => download('tracks.csv', '\uFEFF' + occCsv)}
                  />
                ) : view === 'locate' ? (
                  <LocatePanel
                    sourceCount={finalCues.length}
                    index={locateIndex}
                    phraseText={locatePhraseText}
                    onPhraseText={setLocatePhraseText}
                    gapText={locateGapText}
                    onGapText={setLocateGapText}
                    result={locateResult}
                  />
                ) : (
                  <TermsPanel
                    sourceCount={finalCues.length}
                    sourceReady={canExport}
                    termsText={termsText}
                    onTermsText={setTermsText}
                    parsed={termsParse}
                    results={termsResults}
                    hitCount={termsHitCount}
                    changedCount={termsChangedCount}
                    preview={termsPreview}
                    canDownload={canDownloadTerms}
                    downloadReason={termsReason}
                    onDownload={() => download('terms.srt', '\uFEFF' + termsSrt)}
                  />
                )}
              </main>

              <ExportPanel
                conflictCount={conflictCount}
                resolvedCount={resolvedCount}
                unresolved={unresolved}
                issues={issues}
                autoFix={autoFix}
                onAutoFix={setAutoFix}
                cueCount={finalCues.length}
                dedupChains={dedupStats.chainCount}
                dedupApplied={dedupStats.appliedChains}
                dedupSaved={dedupStats.saved}
                wrapApplied={wrapStats.appliedCount}
                wrapFailed={wrapStats.failed}
                paceSegments={paceStats.segments}
                paceApplied={paceStats.applied}
                paceUnsolvable={paceStats.unsolvable}
                snapCuts={snapStats.cuts}
                snapMovable={snapStats.movable}
                snapApplied={snapStats.applied}
                snapOk={snapStats.ok}
                snapCrossingBefore={snapStats.originalCrossing}
                snapCrossingAfter={snapStats.crossing}
                preview={preview}
                canExport={canExport}
                onExport={() => download('merged.srt', '\uFEFF' + serializeSrt(finalCues))}
                onJump={jumpToGroup}
              />
            </div>
          </>
        )
      )}

      <RecalibrateMigrateDialog
        open={migrateOpen}
        busy={migrateBusy}
        error={migrateError}
        oldGroupCount={migrateData?.oldGroups.length ?? groups?.length ?? 0}
        newGroups={migrateData?.newGroups ?? null}
        newCuesA={cuesA}
        newCuesB={migrateData?.newCuesB ?? migratePending?.b ?? cuesB}
        plan={migrateData?.plan ?? null}
        calibrated={migrateData?.calibrated ?? migratePending?.calibrated ?? false}
        anchorCount={migrateData?.anchorCount ?? migratePending?.anchorCount ?? 0}
        onClose={cancelMigration}
        onRetry={retryMigration}
        onConfirm={confirmMigration}
      />

      <footer className="foot">纯前端本地运行 · 字幕数据不会离开浏览器 · 校准、对齐与校验均在本地完成</footer>
    </div>
  );
}
