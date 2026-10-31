import { Notice, Plugin } from "obsidian";
import { randomBytes } from "crypto";
import { AuthManager, openExternal } from "./feishu/auth";
import { describeError, Logger } from "./log";
import { FeishuAuthRequiredError, FeishuError } from "./feishu/client";
import type { SettingsHost, SyncEngineHandle } from "./settings-tab";
import { FeishuWikiSyncSettingTab } from "./settings-tab";
import type { PlanDecision, SyncMode } from "./sync/engine";
import { SyncEngine } from "./sync/engine";
import { DocSyncEngine } from "./sync/docEngine";
import type { PluginSettings, SyncAction, SyncState } from "./sync/types";
import { DEFAULT_SETTINGS, ensureOAuthScopes } from "./sync/types";
import { AuthCodeModal } from "./ui/auth-modal";
import { PlanModal } from "./ui/plan-modal";
import { ReportModal } from "./ui/report-modal";
import { AddWikiModal } from "./ui/add-wiki-modal";
import { BatchPullResultModal, WikiPanelModal } from "./ui/wiki-panel-modal";
import type { BatchPullOutcome, PanelAction } from "./ui/wiki-panel-modal";
import { activateProfile, deleteProfile, directionLabel, ensureProfilesMigrated, syncSettingsIntoActiveProfile } from "./sync/profileStore";
import { checkAllKnowledgeBases, checkOneKnowledgeBase, profileUpdateCount } from "./sync/updateCheck";

const CHANGE_ACTIONS = new Set<SyncAction>(["push", "create-remote", "pull", "create-local", "link", "delete-remote", "delete-local"]);

function setNoticeMessage(notice: Notice, message: string): void {
  const candidate = notice as Notice & { setMessage?: (value: string) => void };
  if (typeof candidate.setMessage === "function") candidate.setMessage(message);
}

export default class FeishuWikiSyncPlugin extends Plugin implements SettingsHost {
  settings: PluginSettings = DEFAULT_SETTINGS;
  logger!: Logger;
  auth!: AuthManager;
  mdEngine!: SyncEngine;
  docEngine!: DocSyncEngine;

  private statusBar: HTMLElement | null = null;
  private autoSyncHandle: number | null = null;
  private syncInFlight = false;

  /** 按设置里的同步模式选引擎，4 条命令与侧栏按钮都走这里。 */
  get engine(): SyncEngineHandle {
    return this.settings.syncMode === "doc" ? this.docEngine : this.mdEngine;
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    // 二开：旧配置迁移出默认同步目标（幂等）
    if (ensureProfilesMigrated(this.settings)) await this.saveSettings();

    this.logger = new Logger(
      () => this.app,
      () => this.settings.debugLog,
    );
    this.auth = new AuthManager(
      () => ({
        mode: this.settings.authMode,
        appId: this.settings.appId,
        appSecret: this.settings.appSecret,
        oauthScope: this.settings.oauthScope,
        redirectUri: this.settings.redirectUri,
      }),
      () => this.settings.userTokens,
      async (tokens) => {
        this.settings.userTokens = tokens;
        await this.saveSettings();
      },
      this.logger,
    );
    this.mdEngine = new SyncEngine({
      app: this.app,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      auth: this.auth,
      logger: this.logger,
    });
    this.docEngine = new DocSyncEngine({
      app: this.app,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      auth: this.auth,
      logger: this.logger,
    });

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    // 二开：状态栏点击 = 打开知识库面板（选知识库、看更新标识、再决定动作），不再一键直同步
    this.registerDomEvent(this.statusBar, "click", () => this.openWikiPanel());
    this.updateStatusBar();

    this.addSettingTab(new FeishuWikiSyncSettingTab(this.app, this));

    // 二开：同步类命令都先进知识库面板选目标，确认后才会执行；方向由面板动作决定
    this.addCommand({ id: "preview-plan", name: "管理知识库（列表、检查更新与操作）", callback: () => this.openWikiPanel() });
    this.addCommand({ id: "sync-both", name: "同步知识库（先选知识库，预览确认后执行）", callback: () => this.openWikiPanel("both") });
    this.addCommand({ id: "sync-pull", name: "从飞书拉取到本地（先选知识库）", callback: () => this.openWikiPanel("pull") });
    this.addCommand({ id: "sync-push", name: "把本地推送到飞书（先选知识库）", callback: () => this.openWikiPanel("push") });
    this.addCommand({
      id: "force-push",
      name: "强制重推（忽略基线，刷新所有本地笔记）",
      callback: () => void this.runSync("push", { forcePush: true }),
    });
    this.addCommand({
      id: "check-updates",
      name: "检查全部知识库的更新（只探测，不拉取）",
      callback: () => void this.checkAllUpdates(),
    });
    this.addCommand({
      id: "reauthorize",
      name: "重新授权飞书账号",
      callback: () => void this.reauthorize(),
    });
    this.addCommand({
      id: "add-wiki",
      name: "添加知识库（粘贴链接，自动解析空间/目录/档位）",
      callback: () => this.openAddWikiWizard(),
    });
    this.addCommand({
      id: "switch-target",
      name: "管理知识库（列表、检查更新与操作）",
      callback: () => this.openWikiPanel(),
    });

    this.addRibbonIcon("list", "Feishu Wiki Sync：知识库面板", () => this.openWikiPanel());

    this.refreshAutoSync();
  }

  onunload(): void {
    if (this.autoSyncHandle !== null) window.clearInterval(this.autoSyncHandle);
    this.autoSyncHandle = null;
    this.statusBar = null;
    this.auth?.cancelAuthorization();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as (Partial<PluginSettings> & { state?: Partial<SyncState> }) | null;
    const state: Partial<SyncState> = raw?.state ?? {};
    const rawScope = typeof raw?.oauthScope === "string" ? raw.oauthScope : DEFAULT_SETTINGS.oauthScope;
    const oauthScope = ensureOAuthScopes(rawScope);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(raw ?? {}),
      oauthScope,
      state: {
        records: state.records ?? {},
        folders: state.folders ?? {},
        conflicts: state.conflicts ?? {},
        docRecords: state.docRecords ?? {},
        images: state.images ?? {},
        imageUploads: state.imageUploads ?? {},
        target: state.target,
        lastSyncAt: state.lastSyncAt,
      },
    };
    // 旧版 token 不会因为设置字符串变化而自动获得新权限。
    // 自动补齐范围并清除旧用户授权，避免后续同步继续使用无权限 token。
    if (oauthScope !== rawScope && this.settings.authMode === "user" && this.settings.userTokens) {
      this.settings.userTokens = undefined;
    }
    if (oauthScope !== rawScope || !raw) await this.saveSettings();
  }

  isSyncBusy(): boolean {
    return this.syncInFlight || this.mdEngine?.isSyncing() || this.docEngine?.isSyncing();
  }

  async saveSettings(): Promise<void> {
    // 二开：平铺的目标字段与状态是激活目标的活视图，写盘前收回快照
    syncSettingsIntoActiveProfile(this.settings);
    await this.saveData(this.settings);
  }

  refreshAutoSync(): void {
    if (this.autoSyncHandle !== null) {
      window.clearInterval(this.autoSyncHandle);
      this.autoSyncHandle = null;
    }
    const minutes = this.settings.autoSyncMinutes;
    if (!minutes || minutes <= 0) return;
    // 二开：定时任务只做 git 式更新检查（只探测、标记，不拉取）；
    // 用户在知识库面板里看到更新标识后自行选择拉取。
    this.autoSyncHandle = this.registerInterval(window.setInterval(() => {
      if (this.isSyncBusy()) return;
      if (this.settings.authMode === "user" && !this.auth.hasValidUserGrant()) return;
      void this.checkAllUpdates({ quiet: true });
    }, minutes * 60_000));
  }

  async startAuthorization(): Promise<void> {
    const state = randomBytes(24).toString("hex");
    const server = this.auth.startCallbackServer(state);
    const authorizeUrl = this.auth.buildAuthorizeUrl(state);
    openExternal(authorizeUrl);
    new Notice("已打开浏览器，请在飞书里完成授权");
    try {
      const code = await server.waitForCode();
      await this.auth.exchangeCode(code);
      new Notice("飞书授权成功");
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async startManualAuthorization(): Promise<void> {
    const state = randomBytes(24).toString("hex");
    const authorizeUrl = this.auth.buildAuthorizeUrl(state);
    openExternal(authorizeUrl);
    await new Promise<void>((resolve) => {
      new AuthCodeModal(
        this.app,
        authorizeUrl,
        async (codeOrUrl) => {
          try {
            await this.auth.exchangeCode(codeOrUrl);
            new Notice("飞书授权成功");
          } catch (error) {
            new Notice(`授权失败：${describeError(error)}`, 10000);
          }
          resolve();
        },
        () => resolve(),
      ).open();
    });
  }

  async revokeAuthorization(): Promise<void> {
    this.settings.userTokens = undefined;
    await this.saveSettings();
    new Notice("已清除本地保存的飞书授权");
  }

  /** 二开：重新授权快捷入口（命令面板/警示条共用）。自动授权失败时回落手动粘贴授权码。 */
  async reauthorize(): Promise<void> {
    if (!this.settings.appId || !this.settings.appSecret) {
      new Notice("请先在插件设置里填写飞书应用的 App ID 与 App Secret");
      return;
    }
    try {
      await this.startAuthorization();
      this.updateStatusBar();
    } catch {
      new Notice("自动授权未完成，改用手动粘贴授权码流程", 6000);
      await this.startManualAuthorization();
      this.updateStatusBar();
    }
  }

  async runSync(
    requestedMode: SyncMode,
    options: { preview?: boolean; quiet?: boolean; forcePush?: boolean } = {},
  ): Promise<void> {
    if (this.engine.isSyncing() || this.syncInFlight) {
      new Notice("飞书同步：已有任务在执行中");
      return;
    }
    if (!this.settings.appId || !this.settings.appSecret) {
      new Notice("请先在插件设置里填写飞书应用的 App ID 与 App Secret");
      return;
    }
    // 二开：按当前目标的档位（方向）拦截/改写请求
    let mode = requestedMode;
    const direction = this.settings.syncDirection ?? "both";
    const quiet = options.quiet === true;
    if (direction === "pull") {
      if (options.forcePush) {
        new Notice("当前知识库为「仅拉取（只读）」，强制重推不可用；如确需推送请先在设置里改回双向协作");
        return;
      }
      if (mode === "push") {
        new Notice("当前知识库为「仅拉取（只读）」，已跳过推送");
        return;
      }
      if (mode === "both") {
        mode = "pull";
        if (!quiet) new Notice("当前知识库为「仅拉取（只读）」，已按仅拉取执行", 4000);
      }
    } else if (direction === "push") {
      if (mode === "pull") {
        new Notice("当前知识库为「仅推送」，已跳过拉取");
        return;
      }
      if (mode === "both") {
        mode = "push";
        if (!quiet) new Notice("当前知识库为「仅推送」，已按仅推送执行", 4000);
      }
    }
    if (options.forcePush && this.settings.syncMode !== "doc") {
      new Notice("强制重推仅用于文档模式；文件镜像模式请使用普通同步");
      return;
    }

    this.syncInFlight = true;
    const engine = this.engine;
    const label = this.settings.syncMode === "doc" ? "飞书文档同步" : "飞书文件同步";
    // 二开：弹窗标题带上知识库名，多库场景下不会认错操作对象
    const activeProfile = (this.settings.profiles ?? []).find((item) => item.id === this.settings.activeProfileId);
    const titleSuffix = activeProfile ? ` — ${activeProfile.name}（${directionLabel(activeProfile.direction)}）` : "";
    const wantPreview = !options.quiet && (this.settings.propagateLocalDelete || this.settings.propagateRemoteDelete ||
      options.forcePush === true || (options.preview ?? this.settings.showPlanBeforeSync));
    const forcePush = options.forcePush === true;
    const notice = new Notice(`${label}：准备中…`, 0);
    let running: Notice | undefined;
    const progress = (message: string) => setNoticeMessage(notice, `${label}：${message}`);

    try {
      if (wantPreview) {
        const preview = await engine.run({ mode, dryRun: true, forcePush, onProgress: progress });
        notice.hide();
        const decision = await new Promise<PlanDecision>((resolve) => new PlanModal(this.app, preview.plan, resolve, titleSuffix).open());
        if (decision === "cancel") return;
        running = new Notice(`${label}：执行中…`, 0);
        // 执行的就是用户刚刚确认的那份计划；写盘前执行器还会复核本地是否又有改动
        const result = await engine.run({
          mode,
          preApprovedPlan: preview.plan,
          onProgress: (message) => setNoticeMessage(running!, `${label}：${message}`),
          confirm: async () => decision,
        });
        running.hide();
        new ReportModal(this.app, result.plan, result.report, result.executed, titleSuffix).open();
        return;
      }

      const result = await engine.run({ mode, forcePush, allowDeletes: !options.quiet, onProgress: progress, confirm: async () => "all" });
      notice.hide();
      const failures = result.report.filter((entry) => !entry.ok).length;
      const conflicts = result.report.filter((entry) => entry.action === "conflict").length;
      const changes = result.report.filter((entry) => entry.ok && CHANGE_ACTIONS.has(entry.action)).length;
      const pendingDeletes = result.report.some(entry => entry.action === "local-deleted" || entry.action === "remote-deleted");
      if (options.quiet && failures === 0 && conflicts === 0 && !pendingDeletes && !result.plan.warnings?.length) {
        if (changes > 0) new Notice(`${label}完成：${changes} 项变更`);
      } else {
        new ReportModal(this.app, result.plan, result.report, result.executed, titleSuffix).open();
      }
    } catch (error) {
      notice.hide();
      this.logger.error(`同步失败：${describeError(error)}`);
      // 二开：鉴权类错误直接指路重新授权命令，不让用户去翻设置
      const authRequired = error instanceof FeishuAuthRequiredError || (error instanceof FeishuError && error.authRelated);
      new Notice(
        authRequired
          ? "飞书授权已失效：运行命令「重新授权飞书账号」，或点状态栏打开知识库面板。"
          : `${label}失败：${describeError(error)}`,
        12000,
      );
    } finally {
      running?.hide();
      notice.hide();
      this.syncInFlight = false;
      await this.logger.flush();
      this.updateStatusBar();
    }
  }

  updateStatusBar(): void {
    if (!this.statusBar) return;
    const last = this.settings.state.lastSyncAt;
    const docMode = this.settings.syncMode === "doc";
    const count = Object.keys(docMode ? this.settings.state.docRecords : this.settings.state.records).length;
    const stamp = last ? new Date(last).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未同步";
    const direction = this.settings.syncDirection ?? "both";
    const profileName = this.settings.localFolder ? this.settings.localFolder.split("/").filter(Boolean).pop() : "";
    const suffix = direction === "pull" ? " ↓" : direction === "push" ? " ↑" : "";
    const nameSuffix = profileName ? ` · ${profileName}` : "";
    // 二开：git 式更新标识——有更新的知识库个数（来自最近一次检查，只提示不自动拉取）
    const withUpdates = (this.settings.profiles ?? []).filter((profile) => profileUpdateCount(profile) > 0).length;
    const updateSuffix = withUpdates > 0 ? ` · ⬇${withUpdates}库有更新` : "";
    this.statusBar.setText(`飞书${docMode ? "文档" : ""}${suffix} ${stamp} · ${count} 篇${nameSuffix}${updateSuffix}`);
    this.statusBar.setAttr("aria-label", "点击打开知识库面板：查看更新、选择知识库执行拉取/推送/预览");
  }

  /** 二开：添加知识库向导（粘贴链接 → 解析空间/范围/目录/档位 → 建目标并可选首次同步）。 */
  openAddWikiWizard(): void {
    if (!this.settings.appId || !this.settings.appSecret) {
      new Notice("请先在插件设置里填写飞书应用的 App ID 与 App Secret");
      return;
    }
    new AddWikiModal(this.app, {
      settings: () => this.settings,
      createClient: () => this.engine.createClient(),
      onFinish: async (result) => {
        this.updateStatusBar();
        this.refreshAutoSync();
        await this.runSync(result.direction, { preview: true });
      },
    }).open();
  }

  /** 二开：知识库功能面板（列表、更新标识、拉取/推送/预览/删除）。状态栏与同步命令的入口。 */
  openWikiPanel(pendingAction?: PanelAction): void {
    if (!this.settings.appId || !this.settings.appSecret) {
      new Notice("请先在插件设置里填写飞书应用的 App ID 与 App Secret");
      return;
    }
    const profiles = this.settings.profiles ?? [];
    if (profiles.length === 0 && !pendingAction) {
      this.openAddWikiWizard();
      return;
    }
    new WikiPanelModal(this.app, {
      getProfiles: () => this.settings.profiles ?? [],
      getActiveId: () => this.settings.activeProfileId ?? "",
      isBusy: () => this.isSyncBusy(),
      pendingAction,
      onRun: (profileId, action) => void this.runForProfile(profileId, action),
      onCheckOne: async (profileId) => {
        await this.checkUpdatesFor([profileId]);
      },
      onCheckAll: () => this.checkAllUpdates(),
      onPullAll: (profileIds) => void this.pullAllUpdates(profileIds),
      onAdd: () => this.openAddWikiWizard(),
      onDelete: (profileId) => void this.deleteKnowledgeBase(profileId),
      onOpenSettings: () => (this.app as unknown as { setting: { open(): void } }).setting.open(),
    }).open();
  }

  /** 二开：选中某个知识库执行某个方向的同步（先激活目标，再走带预览的 runSync）。 */
  private async runForProfile(profileId: string, action: PanelAction): Promise<void> {
    const profile = (this.settings.profiles ?? []).find((item) => item.id === profileId);
    if (!profile) return;
    if (this.isSyncBusy()) {
      new Notice("飞书同步：已有任务在执行中");
      return;
    }
    activateProfile(this.settings, profileId);
    await this.saveSettings();
    this.updateStatusBar();
    this.refreshAutoSync();
    await this.runSync(action, { preview: true });
  }

  /** 二开：检查知识库更新（git fetch 语义：只探测并标记，绝不拉取正文）。 */
  private async checkAllUpdates(options: { quiet?: boolean } = {}): Promise<void> {
    if (this.isSyncBusy()) {
      new Notice("飞书同步：已有任务在执行中");
      return;
    }
    if (!this.settings.appId || !this.settings.appSecret) {
      new Notice("请先在插件设置里填写飞书应用的 App ID 与 App Secret");
      return;
    }
    if (this.settings.authMode === "user" && !this.auth.hasValidUserGrant()) {
      new Notice("飞书授权已失效：运行命令「重新授权飞书账号」后再检查更新");
      return;
    }
    const notice = new Notice("飞书：检查知识库更新…", 0);
    try {
      const result = await checkAllKnowledgeBases(
        this.settings,
        {
          createClient: () => this.engine.createClient(),
          logger: this.logger,
          saveSettings: () => this.saveSettings(),
        },
        { onProgress: (message) => setNoticeMessage(notice, `飞书：${message}`) },
      );
      this.updateStatusBar();
      if (result.totalUpdates > 0) {
        new Notice(`检查完成：${result.profilesWithUpdates} 个知识库有更新（共 ${result.totalUpdates} 篇）。点状态栏打开知识库面板选择拉取。`, 8000);
      } else if (!options.quiet) {
        new Notice(result.failures > 0 ? "检查完成：没有发现更新（部分知识库检查失败，详见日志）" : "检查完成：所有知识库都是最新", 6000);
      }
      if (result.failures > 0 && result.totalUpdates > 0) {
        new Notice(`另有 ${result.failures} 个知识库检查失败，详见日志`, 8000);
      }
    } catch (error) {
      new Notice(`检查更新失败：${describeError(error)}`, 8000);
    } finally {
      notice.hide();
      await this.logger.flush();
    }
  }

  /** 二开：只检查指定知识库（面板行内按钮）。 */
  private async checkUpdatesFor(profileIds: string[]): Promise<void> {
    if (this.isSyncBusy()) {
      new Notice("飞书同步：已有任务在执行中");
      return;
    }
    const notice = new Notice("飞书：检查更新…", 0);
    let updated = 0;
    try {
      for (const profileId of profileIds) {
        const info = await checkOneKnowledgeBase(this.settings, profileId, {
          createClient: () => this.engine.createClient(),
          logger: this.logger,
          saveSettings: () => this.saveSettings(),
        });
        if (info && info.changed + info.added > 0) updated += 1;
      }
      await this.saveSettings();
      this.updateStatusBar();
      new Notice(updated > 0 ? `有 ${updated} 个知识库存在更新，已在面板中标记` : "没有发现更新", 5000);
    } catch (error) {
      new Notice(`检查更新失败：${describeError(error)}`, 8000);
    } finally {
      notice.hide();
      await this.logger.flush();
    }
  }

  /**
   * 二开：一键拉取全部有更新的知识库。
   * 范围：只读库与双向库（推送库的"更新"方向是推送，不参与）；逐库执行仅拉取；
   * 不做逐库预览（面板的汇总确认就是这一步的确认），但保留全部执行期安全检查：
   * 写盘前复核本地改动、只读库远端覆盖前另存副本、双向库生成冲突副本、不执行任何删除。
   */
  private async pullAllUpdates(profileIds: string[]): Promise<void> {
    if (this.isSyncBusy()) {
      new Notice("飞书同步：已有任务在执行中");
      return;
    }
    if (!this.settings.appId || !this.settings.appSecret) {
      new Notice("请先在插件设置里填写飞书应用的 App ID 与 App Secret");
      return;
    }
    if (this.settings.authMode === "user" && !this.auth.hasValidUserGrant()) {
      new Notice("飞书授权已失效：运行命令「重新授权飞书账号」后再试");
      return;
    }
    const profiles = this.settings.profiles ?? [];
    const targets = profileIds
      .map((id) => profiles.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item) && item!.direction !== "push");
    if (targets.length === 0) {
      new Notice("没有可拉取的知识库（推送类知识库不参与一键拉取）");
      return;
    }
    const originalId = this.settings.activeProfileId;
    const outcomes: BatchPullOutcome[] = [];
    const notice = new Notice("飞书：一键拉取更新…", 0);
    let index = 0;
    for (const profile of targets) {
      index += 1;
      setNoticeMessage(notice, `飞书：一键拉取（${index}/${targets.length}）：${profile.name}…`);
      activateProfile(this.settings, profile.id);
      await this.saveSettings();
      this.updateStatusBar();
      try {
        const result = await this.engine.run({
          mode: "pull",
          allowDeletes: false,
          onProgress: (message) => setNoticeMessage(notice, `飞书：${profile.name} ${message}`),
          confirm: async () => "all",
        });
        const updated = result.report.filter((entry) => entry.ok && ["pull", "create-local", "link"].includes(entry.action)).length;
        const conflicts = result.report.filter((entry) => entry.action === "conflict").length;
        const failures = result.report.filter((entry) => !entry.ok).length;
        outcomes.push({ name: profile.name, ok: failures === 0, updated, conflicts, failures });
        // 拉取成功即清除该库的更新标识（失败的保留，下次检查会刷新）
        if (failures === 0) {
          const pulled = profiles.find((item) => item.id === profile.id);
          if (pulled) pulled.updateInfo = undefined;
        }
      } catch (error) {
        this.logger.error(`一键拉取 ${profile.name} 失败：${describeError(error)}`);
        outcomes.push({ name: profile.name, ok: false, updated: 0, conflicts: 0, failures: 0, message: describeError(error) });
      }
    }
    // 恢复原本激活的知识库
    if (originalId && profiles.some((item) => item.id === originalId)) {
      activateProfile(this.settings, originalId);
    }
    await this.saveSettings();
    this.updateStatusBar();
    notice.hide();
    await this.logger.flush();
    new BatchPullResultModal(this.app, outcomes).open();
  }

  /** 二开：删除一个知识库条目（只清配置与映射，不动本地文件）。 */
  private async deleteKnowledgeBase(profileId: string): Promise<void> {    const profile = (this.settings.profiles ?? []).find((item) => item.id === profileId);
    if (!profile) return;
    const removed = deleteProfile(this.settings, profileId);
    if (removed) {
      await this.saveSettings();
      this.updateStatusBar();
      this.refreshAutoSync();
      new Notice(`已移除知识库「${profile.name}」（本地文件与飞书内容都不受影响）`);
    }
  }
}
