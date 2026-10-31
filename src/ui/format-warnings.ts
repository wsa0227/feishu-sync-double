import type { SyncPlan } from "../sync/types";
import { OBJ_TYPE_LABELS } from "../sync/types";

export function renderFormatWarnings(container: HTMLElement, plan: SyncPlan): void {
  if (!plan.warnings?.length) return;
  const section = container.createEl("div", { cls: "feishu-sync-section" });
  section.createEl("h4", { text: `原稿格式提示（${plan.warnings.length}）` });
  for (const warning of plan.warnings.slice(0, 100)) {
    section.createEl("div", { cls: "feishu-sync-reason", text: `${warning.relPath}：${warning.message}` });
  }
  if (plan.warnings.length > 100) section.createEl("div", { text: "仅显示前 100 条格式提示" });
}

const UNSYNC_HINTS: Record<string, string> = {
  docx: "文档模式可同步飞书文档",
  file: "文件镜像模式可同步 .md 文件节点",
};

/** 二开：覆盖面明示——远端存在但不参与当前模式同步的内容，按类型汇总提示。 */
export function renderUnsyncedSummary(container: HTMLElement, plan: SyncPlan): void {
  const groups = plan.unsynced;
  if (!groups?.length) return;
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const detail = groups.map((group) => `${OBJ_TYPE_LABELS[group.objType] ?? group.objType} ${group.count}`).join(" · ");
  const hints = groups.map((group) => UNSYNC_HINTS[group.objType]).filter((hint): hint is string => Boolean(hint));
  const suffix = hints.length > 0 ? `（${hints.join("；")}）` : "";
  container.createEl("div", {
    cls: "feishu-sync-reason",
    text: `另有 ${total} 个远端内容不参与此模式同步：${detail}${suffix}`,
  });
}
