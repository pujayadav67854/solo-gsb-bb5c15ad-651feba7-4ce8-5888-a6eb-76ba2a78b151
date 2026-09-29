interface CalibStatusChipProps {
  /** 当前生效的对齐链路是否使用校准后的 B 时间轴 */
  calibrated: boolean;
  /** 生效校准确认提交时的启用锚点数（仅 calibrated 时有意义） */
  anchorCount: number;
}

/**
 * 工作区顶部的 B 时间轴状态标识。
 * 只反映“已提交生效”的校准信息：迁移预览计算中 / 失败 / 取消，以及校准页
 * 上尚未提交的锚点草稿都不会改变这里的显示；确认改用原始 B 时间时显示未校准。
 */
export function CalibStatusChip({ calibrated, anchorCount }: CalibStatusChipProps) {
  if (!calibrated) {
    return <span className="calib-chip off">使用原始 B 时间</span>;
  }
  return (
    <span className="calib-chip on" title={`${anchorCount} 个锚点 · 分段线性映射`}>
      ✓ 时间轴已校准（{anchorCount} 锚点）
    </span>
  );
}
