import type { App } from "obsidian";
import { Modal, Setting } from "obsidian";
import type { SyncTargetProfile } from "../sync/types";
import { directionLabel } from "../sync/profileStore";
import { profileUpdateCount } from "../sync/updateCheck";

/** 二开：面板动作。"both" = 按知识库自己的同步方式执行双向。 */
export type PanelAction = "pull" | "push" | "both";

export interface WikiPanelDeps {
  getProfiles: () => SyncTargetProfile[];
  getActiveId: () => string;
  isBusy: () => boolean;
  /** 对某个知识库执行某个方向的同步（先预览，确认后才执行）。 */
  onRun: (profileId: string, action: PanelAction) => void;
  /** 只检查这个知识库有没有更新（不拉取）。完成后刷新面板。 */
  onCheckOne: (profileId: string) => Promise<void>;
  /** 检查全部知识库的更新（不拉取）。完成后刷新面板。 */
  onCheckAll: () => Promise<void>;
  /** 一键拉取：对给定的知识库逐个执行仅拉取（不做逐库预览，执行前有汇总确认）。 */
  onPullAll: (profileIds: string[]) => void;
  onAdd: () => void;
  onDelete: (profileId: string) => void;
  onOpenSettings: () => void;
  /** 从命令面板进来时预设的动作，只影响提示文案与默认强调；undefined = 纯管理视图。 */
  pendingAction?: PanelAction;
}

const ACTION_VERB: Record<PanelAction, string> = { pull: "拉取", push: "推送", both: "同步" };

/**
 * 二开：知识库功能面板。
 *
 * 列出所有被管理的知识库：名称、同步方式、本地目录、上次同步、有更新标识；
 * 每行可直接执行操作（先预览再执行），或只检查更新。状态栏点击打开本面板。
 */
export class WikiPanelModal extends Modal {
  private readonly armedDelete = new Set<string>();

  constructor(
    app: App,
    private readonly deps: WikiPanelDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("飞书知识库");
    this.renderContent();
  }

  onClose(): void {
    this.contentEl.empty();
    this.armedDelete.clear();
  }

  private renderContent(): void {
    const { contentEl } = this;
    contentEl.empty();
    const profiles = this.deps.getProfiles();

    const pending = this.deps.pendingAction;
    const hint = pending
      ? `选择要${ACTION_VERB[pending]}的知识库：点击行先预览计划，确认后才会执行；也可以只点「检查更新」。`
      : "管理知识库：点击行按其同步方式执行（先预览），或只检查更新、删除知识库。";
    contentEl.createEl("p", { cls: "setting-item-description", text: hint });

    if (profiles.length === 0) {
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "还没有管理任何知识库。点下面的「➕ 添加知识库」，粘贴飞书页面链接即可。",
      });
    } else {
      const list = contentEl.createDiv({ cls: "feishu-wiki-list" });
      for (const profile of profiles) {
        this.buildRow(list, profile);
      }
    }

    const footer = contentEl.createDiv({ cls: "feishu-wiki-footer" });
    // 二开：检查发现有更新的知识库后，提供一键拉取（跳过推送类知识库；执行前还有汇总确认）
    const pullable = profiles.filter((profile) => profileUpdateCount(profile) > 0 && profile.direction !== "push");
    if (pullable.length > 0) {
      const pullAllBtn = footer.createEl("button", {
        text: `⬇ 一键拉取全部更新（${pullable.length}库）`,
        cls: "mod-cta",
      });
      pullAllBtn.disabled = this.deps.isBusy();
      pullAllBtn.onclick = () => {
        this.close();
        new BatchPullConfirmModal(
          this.app,
          pullable.map((profile) => ({ profile, count: profileUpdateCount(profile) })),
          () => this.deps.onPullAll(pullable.map((profile) => profile.id)),
        ).open();
      };
    }
    const addBtn = footer.createEl("button", { text: "➕ 添加知识库" });
    addBtn.onclick = () => {
      this.close();
      this.deps.onAdd();
    };
    const checkBtn = footer.createEl("button", { text: "检查全部更新" });
    checkBtn.disabled = this.deps.isBusy();
    checkBtn.onclick = () => void this.runCheck(() => this.deps.onCheckAll());
    const settingsBtn = footer.createEl("button", { text: "设置" });
    settingsBtn.onclick = () => {
      this.close();
      this.deps.onOpenSettings();
    };
  }

  private async runCheck(check: () => Promise<void>): Promise<void> {
    if (this.deps.isBusy()) {
      return;
    }
    (this.contentEl.querySelector<HTMLButtonElement>(".feishu-wiki-footer button:nth-child(2)") ?? null)?.setAttribute("disabled", "true");
    try {
      await check();
    } finally {
      this.renderContent();
    }
  }

  private buildRow(container: HTMLElement, profile: SyncTargetProfile): void {
    const active = profile.id === this.deps.getActiveId();
    const updates = profileUpdateCount(profile);
    const row = container.createDiv({ cls: `feishu-wiki-row${active ? " is-active" : ""}` });

    const info = row.createDiv({ cls: "feishu-wiki-row-info" });
    const titleLine = info.createDiv({ cls: "feishu-wiki-row-title" });
    titleLine.createEl("span", { text: profile.name, cls: "feishu-wiki-row-name" });
    titleLine.createEl("span", { text: directionLabel(profile.direction), cls: "feishu-wiki-row-direction" });
    if (active) titleLine.createEl("span", { text: "当前", cls: "feishu-wiki-row-active" });

    const meta: string[] = [];
    meta.push(profile.target.localFolder || "vault 根目录");
    meta.push(profile.docSource?.documentId ? "单篇文档（只读）" : profile.target.syncMode === "doc" ? "文档模式" : "文件镜像");
    const last = profile.state?.lastSyncAt
      ? new Date(profile.state.lastSyncAt).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "从未同步";
    meta.push(`上次同步 ${last}`);
    info.createDiv({ cls: "feishu-wiki-row-meta", text: meta.join(" · ") });

    if (updates > 0 && profile.updateInfo) {
      const parts: string[] = [];
      if (profile.updateInfo.added > 0) parts.push(`新增 ${profile.updateInfo.added}`);
      if (profile.updateInfo.changed > 0) parts.push(`更新 ${profile.updateInfo.changed}`);
      const badge = info.createDiv({ cls: "feishu-wiki-row-updates", text: `⬇ 有更新 ${updates} 篇（${parts.join(" · ")}）` });
      badge.setAttr("title", `检查于 ${new Date(profile.updateInfo.at).toLocaleString()}；点「拉取」先预览再执行`);
    }

    const actions = row.createDiv({ cls: "feishu-wiki-row-actions" });

    const primaryAction: PanelAction = profile.direction === "pull" ? "pull" : profile.direction === "push" ? "push" : "both";
    const primaryLabel = profile.direction === "pull" ? "拉取" : profile.direction === "push" ? "推送" : "同步";
    const primaryBtn = actions.createEl("button", { text: primaryLabel, cls: "mod-cta" });
    primaryBtn.disabled = this.deps.isBusy();
    primaryBtn.onclick = () => {
      this.close();
      this.deps.onRun(profile.id, primaryAction);
    };

    if (profile.direction === "both") {
      const pullBtn = actions.createEl("button", { text: "仅拉取" });
      pullBtn.disabled = this.deps.isBusy();
      pullBtn.onclick = () => {
        this.close();
        this.deps.onRun(profile.id, "pull");
      };
    }

    const checkBtn = actions.createEl("button", { text: "检查更新" });
    checkBtn.disabled = this.deps.isBusy();
    checkBtn.onclick = () => void this.runCheck(() => this.deps.onCheckOne(profile.id));

    const deleteBtn = actions.createEl("button", { text: "删除", cls: "feishu-wiki-row-delete" });
    deleteBtn.onclick = () => {
      // 二次确认：第一次点变成"确认删除"，再点才执行
      if (!this.armedDelete.has(profile.id)) {
        this.armedDelete.add(profile.id);
        deleteBtn.textContent = "确认删除";
        deleteBtn.addClass("mod-warning");
        return;
      }
      this.close();
      this.deps.onDelete(profile.id);
    };

    // 点行空白处 = 执行默认动作（与主按钮一致），让"选知识库→执行"一步完成
    row.onclick = (event) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      this.close();
      this.deps.onRun(profile.id, primaryAction);
    };
  }
}

/** 一键拉取确认弹窗的一行：知识库 + 待拉取篇数 */
export interface BatchPullEntry {
  profile: SyncTargetProfile;
  count: number;
}

/** 二开：一键拉取前的汇总确认。这里是批量动作的"预览"——列出每个库要拉多少篇。 */
export class BatchPullConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly entries: BatchPullEntry[],
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("一键拉取更新");
    const total = this.entries.reduce((sum, entry) => sum + entry.count, 0);
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `将对 ${this.entries.length} 个知识库执行仅拉取，共约 ${total} 篇：`,
    });
    const list = this.contentEl.createDiv({ cls: "feishu-sync-list" });
    for (const entry of this.entries) {
      const row = list.createDiv({ cls: "feishu-sync-plan-item" });
      row.createEl("span", { cls: "feishu-sync-badge is-pull", text: `⬇ ${entry.count}` });
      row.createEl("span", { cls: "feishu-sync-path", text: entry.profile.name });
      row.createEl("span", { cls: "feishu-sync-reason", text: directionLabel(entry.profile.direction) });
    }
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "逐库拉取到各自目录，不会删除任何内容、不会推送；本地有改动的笔记会另存副本（只读库）或生成冲突副本（双向库）。",
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) =>
        button.setButtonText(`拉取 ${this.entries.length} 个知识库`).setCta().onClick(() => {
          this.close();
          this.onConfirm();
        }),
      );
  }
}

/** 一键拉取的单库结果 */
export interface BatchPullOutcome {
  name: string;
  ok: boolean;
  /** 实际更新的篇数（拉取覆盖 + 拉取新建 + 建立映射） */
  updated: number;
  conflicts: number;
  failures: number;
  message?: string;
}

/** 二开：一键拉取完成后的汇总结果。 */
export class BatchPullResultModal extends Modal {
  constructor(
    app: App,
    private readonly outcomes: BatchPullOutcome[],
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("一键拉取结果");
    const totalUpdated = this.outcomes.reduce((sum, item) => sum + item.updated, 0);
    const failed = this.outcomes.filter((item) => !item.ok).length;
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `共更新 ${totalUpdated} 篇 · ${failed > 0 ? `${failed} 个知识库有失败项` : "全部成功"}`,
    });
    const list = this.contentEl.createDiv({ cls: "feishu-sync-list" });
    for (const outcome of this.outcomes) {
      const row = list.createDiv({ cls: "feishu-sync-plan-item" });
      row.createEl("span", {
        cls: `feishu-sync-badge is-${outcome.ok ? "pull" : "conflict"}`,
        text: outcome.ok ? "完成" : "失败",
      });
      const text = [`更新 ${outcome.updated} 篇`];
      if (outcome.conflicts > 0) text.push(`冲突副本 ${outcome.conflicts}`);
      if (outcome.failures > 0) text.push(`失败 ${outcome.failures}`);
      if (outcome.message) text.push(outcome.message);
      const body = row.createEl("span", { cls: "feishu-sync-path", text: `${outcome.name}：${text.join(" · ")}` });
      body.setAttr("style", "font-family: var(--font-interface);");
    }
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "冲突副本在 .obsidian/feishu-sync/conflicts/ 下，本地与远端内容都未被改动。",
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("关闭").setCta().onClick(() => this.close()));
  }
}
