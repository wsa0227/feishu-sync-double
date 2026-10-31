import { Notice, Setting, App, Modal } from "obsidian";
import { getNodeByToken, listSpaces } from "../feishu/wiki";
import { batchQueryMetas } from "../feishu/files";
import type { FeishuClient } from "../feishu/client";
import type { PluginSettings, SyncDirectionProfile } from "../sync/types";
import {
  createAndActivateProfile,
  findFolderConflict,
  newProfileId,
  parseWikiInput,
  sanitizeDirName,
  suggestLocalFolder,
  type ParsedWikiInput,
} from "../sync/profileStore";

/**
 * 二开：添加知识库向导。
 * 粘贴任意 /wiki/ 链接（节点页、空间页）、/docx/ 单篇文档链接或裸节点令牌 →
 * 解析出空间与节点（或单篇文档）→ 一次确认同步范围、本地目录与档位 → 建目标并切换，可选直接进入首次预览。
 */
export interface AddWikiModalDeps {
  settings: () => PluginSettings;
  createClient: () => FeishuClient;
  /** 目标建好后的回调（切换设置页显示 / 触发首次同步）。 */
  onFinish?: (result: { profileId: string; direction: SyncDirectionProfile }) => void | Promise<void>;
}

interface ResolvedTarget {
  spaceId: string;
  nodeToken: string;
  name: string;
  nodeTitle: string;
  hasChildren: boolean;
  spaceOnly: boolean;
  /** 二开：/docx/ 单篇云文档（不在任何知识库里），仅拉取 */
  documentId?: string;
}

export class AddWikiModal extends Modal {
  private readonly deps: AddWikiModalDeps;
  private resolved: ResolvedTarget | null = null;
  private scopeChoice: "node" | "space" = "node";
  private direction: SyncDirectionProfile = "pull";
  private localFolder = "";
  private busy = false;

  constructor(app: App, deps: AddWikiModalDeps) {
    super(app);
    this.deps = deps;
  }

  onOpen(): void {
    this.titleEl.setText("添加飞书知识库");
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "粘贴知识库里任意页面的 /wiki/ 链接、别人分享的单篇文档 /docx/ 链接，或 /wiki/space/<id> 空间页链接。插件会自动解析出空间与目录，不需要你去找 space_id。",
    });

    const inputRow = new Setting(this.contentEl).setName("知识库地址").setHeading();
    inputRow.addText((text) => {
      text.setPlaceholder("https://xxx.feishu.cn/wiki/… 或 /docx/… 或 /wiki/space/…").onChange(() => {
        this.resolved = null;
        this.renderResult();
      });
      this.urlInput = text.inputEl;
    });
    inputRow.addButton((button) => button.setButtonText("解析").setCta().onClick(() => void this.resolveInput()));

    this.resultEl = this.contentEl.createDiv();
    this.renderResult();
  }

  private urlInput!: HTMLInputElement;
  private resultEl!: HTMLElement;

  private renderResult(): void {
    this.resultEl.empty();
    if (!this.resolved) return;
    const target = this.resolved;

    const summary = this.resultEl.createDiv({ cls: "setting-item-description" });
    if (target.documentId) {
      summary.createEl("div", { text: `单篇文档：${target.name}` });
      summary.createEl("div", { text: "这是不在任何知识库里的独立云文档，只同步这一篇（仅拉取）。作者更新后，用「检查更新」即可跟进。" });
    } else {
      summary.createEl("div", { text: `空间：${target.name}（${target.spaceId}）` });
      if (target.nodeTitle) {
        summary.createEl("div", { text: `节点：${target.nodeTitle}${target.hasChildren ? "（含子页面）" : "（无子页面）"}` });
      }
    }

    // 同步范围（单篇文档没有范围概念）
    const scopeArea = this.resultEl.createDiv();
    if (target.documentId) {
      // 单篇：无范围选择，方向锁定只读，在下方档位区体现
    } else {
      new Setting(scopeArea).setName("同步范围").setHeading();
      if (target.spaceOnly) {
        scopeArea.createEl("div", { cls: "setting-item-description", text: "空间页链接：以整个空间顶层为同步根（该形态没有单节点概念）。" });
        this.scopeChoice = "space";
      } else {
        const preferSpace = !target.hasChildren;
        this.scopeChoice = preferSpace ? "space" : "node";
        const options: Array<{ value: "node" | "space"; label: string; hint: string }> = [
          { value: "node", label: "仅该节点子树", hint: "把这个页面（含正文，可选）和它的子页面拉到本地；推送也只发生在这个子树里" },
          { value: "space", label: "整个空间顶层", hint: "以空间顶层为同步根；页面本身是首页或没有子页面时更合适" },
        ];
        for (const option of options) {
          const row = scopeArea.createDiv({ cls: "feishu-wiki-option-row" });
          const radio = row.createEl("input", { type: "radio" });
          radio.name = "feishu-add-scope";
          radio.value = option.value;
          radio.checked = this.scopeChoice === option.value;
          radio.addEventListener("change", () => {
            if (radio.checked) this.scopeChoice = option.value;
          });
          const box = row.createDiv();
          box.createEl("div", { text: option.label });
          box.createEl("div", { cls: "setting-item-description", text: option.hint });
        }
        if (preferSpace) {
          scopeArea.createEl("div", {
            cls: "setting-item-description",
            text: "提示：该节点没有子页面，以它为根会拉到空内容，已默认选「整个空间顶层」。",
          });
        }
      }
    }

    // 本地目录（单篇文档建议落一个以文档名命名的子目录，附件也随之隔离）
    this.localFolder = suggestLocalFolder(this.deps.settings().localFolder, target.name);
    new Setting(this.resultEl)
      .setName("本地同步目录")
      .setDesc("相对 vault 根目录；目录已有内容时，首次同步会按「两边内容一致才建映射」处理")
      .addText((text) => {
        text.setValue(this.localFolder).onChange((value) => {
          this.localFolder = value.trim();
        });
      });

    // 档位（单篇文档固定只读拉取）
    new Setting(this.resultEl).setName("同步方式").setHeading();
    if (target.documentId) {
      this.direction = "pull";
      this.resultEl.createEl("div", {
        cls: "setting-item-description",
        text: "仅拉取（只读）：把这篇文档拉到本地并跟进作者更新。单篇分享文档不支持推送。",
      });
    } else {
      const directionOptions: Array<{ value: SyncDirectionProfile; label: string; hint: string }> = [
        { value: "pull", label: "仅拉取（只读）", hint: "只把远端内容拉到本地学习；冲突默认远端覆盖本地，本地旧版自动另存副本" },
        { value: "both", label: "双向协作", hint: "本地与远端互相同步；适合你自己有编辑权限、两边都要写的库" },
        { value: "push", label: "仅推送", hint: "把本地内容定期发布到远端；不拉取远端改动" },
      ];
      this.direction = "pull";
      for (const option of directionOptions) {
        const row = this.resultEl.createDiv({ cls: "feishu-wiki-option-row" });
        const radio = row.createEl("input", { type: "radio" });
        radio.name = "feishu-add-direction";
        radio.value = option.value;
        radio.checked = this.direction === option.value;
        radio.addEventListener("change", () => {
          if (radio.checked) this.direction = option.value;
        });
        const box = row.createDiv();
        box.createEl("div", { text: option.label });
        box.createEl("div", { cls: "setting-item-description", text: option.hint });
      }
      this.resultEl.createEl("div", {
        cls: "setting-item-description",
        text: "不确定权限时选「仅拉取（只读）」最安全：如果之后发现有编辑权限，随时可以在设置里改成双向协作。",
      });
    }

    new Setting(this.resultEl)
      .addButton((button) =>
        button
          .setButtonText("完成并开始首次同步（预览）")
          .setCta()
          .onClick(() => void this.confirm()),
      )
      .addExtraButton((button) => button.setIcon("cross").setTooltip("取消").onClick(() => this.close()));
  }

  private async resolveInput(): Promise<void> {
    if (this.busy) return;
    const parsed: ParsedWikiInput = parseWikiInput(this.urlInput?.value ?? "");
    if (parsed.kind === "invalid") {
      new Notice(parsed.reason, 5000);
      return;
    }
    this.busy = true;
    try {
      const client = this.deps.createClient();
      // 二开：/docx/ 单篇云文档——用元数据接口拿标题（该形态不在知识库树里，node_by_token 会报 131014）
      if (parsed.kind === "docx") {
        const metas = await batchQueryMetas(client, [parsed.documentId], "docx");
        const meta = metas.get(parsed.documentId);
        if (!meta) {
          new Notice("解析失败：取不到这篇文档的信息。请确认链接是新版文档（/docx/）且你的账号有读取权限（先在飞书里打开一次再试）。", 8000);
          return;
        }
        this.resolved = {
          spaceId: "",
          nodeToken: "",
          name: meta.title?.trim() || `文档 ${parsed.documentId}`,
          nodeTitle: "",
          hasChildren: false,
          spaceOnly: false,
          documentId: parsed.documentId,
        };
        this.renderResult();
        return;
      }
      if (parsed.kind === "node") {
        const node = await getNodeByToken(client, parsed.token, "wiki");
        const spaceId = ((node?.node_type === "shortcut" ? node?.origin_space_id : node?.space_id) ?? "").trim();
        if (!spaceId) {
          new Notice("解析失败：当前账号可能无权访问该节点。请先在飞书里打开一次这个页面，再回来重试。", 8000);
          return;
        }
        const nodeToken = ((node?.node_type === "shortcut" ? node?.origin_node_token : node?.node_token) ?? "").trim();
        const nodeTitle = (node?.title ?? "").trim();
        let spaceName = "";
        try {
          const spaces = await listSpaces(client);
          spaceName = spaces.find((item) => item.space_id === spaceId)?.name ?? "";
        } catch {
          // 空间列表拉不到不影响添加；名字用节点标题兜底
        }
        this.resolved = {
          spaceId,
          nodeToken,
          name: spaceName || nodeTitle || `空间 ${spaceId}`,
          nodeTitle,
          hasChildren: node?.has_child === true,
          spaceOnly: false,
        };
      } else {
        let spaceName = "";
        try {
          const spaces = await listSpaces(client);
          spaceName = spaces.find((item) => item.space_id === parsed.spaceId)?.name ?? "";
        } catch {
          // 同上
        }
        this.resolved = {
          spaceId: parsed.spaceId,
          nodeToken: "",
          name: spaceName || `空间 ${parsed.spaceId}`,
          nodeTitle: "",
          hasChildren: false,
          spaceOnly: true,
        };
      }
      this.renderResult();
    } catch (error) {
      new Notice(`解析失败：${error instanceof Error ? error.message : String(error)}`, 8000);
    } finally {
      this.busy = false;
    }
  }

  private async confirm(): Promise<void> {
    if (!this.resolved) {
      new Notice("请先解析知识库地址");
      return;
    }
    const settings = this.deps.settings();
    const cleanDir = sanitizeDirName(this.localFolder);
    if (this.localFolder && cleanDir !== this.localFolder) {
      this.localFolder = this.localFolder
        .split("/")
        .map((segment) => sanitizeDirName(segment))
        .filter(Boolean)
        .join("/");
    }
    const name = this.resolved.name;
    // 二开：本地目录不能与其他知识库重叠，否则两个知识库会互相覆盖对方的映射状态
    const conflictName = findFolderConflict(settings, this.localFolder);
    if (conflictName) {
      new Notice(`本地目录与知识库「${conflictName}」重叠，两个知识库会互相覆盖。请换一个目录再添加。`, 8000);
      return;
    }
    const profileId = newProfileId();
    const isSingleDoc = Boolean(this.resolved.documentId);
    createAndActivateProfile(settings, {
      id: profileId,
      name: name,
      direction: isSingleDoc ? "pull" : this.direction,
      conflictPolicy: isSingleDoc || this.direction === "pull" ? "remote-wins" : "keep-both",
      docSource: this.resolved.documentId ? { documentId: this.resolved.documentId } : undefined,
      target: {
        spaceId: isSingleDoc ? "" : this.resolved.spaceId,
        rootNodeToken: !isSingleDoc && this.scopeChoice === "node" ? this.resolved.nodeToken : "",
        rootPageTitle: "",
        includeRootPage: !isSingleDoc && this.scopeChoice === "node",
        localFolder: this.localFolder,
        syncMode: isSingleDoc ? "doc" : settings.syncMode,
        folderMode: settings.folderMode,
        flatSeparator: settings.flatSeparator,
        excludePatterns: settings.excludePatterns,
        attachmentFolder: settings.attachmentFolder,
        attachmentLinkStyle: settings.attachmentLinkStyle,
        docVerifyRemoteByContent: settings.docVerifyRemoteByContent,
        restoreLocalDeleted: isSingleDoc || this.direction === "pull" ? true : settings.restoreLocalDeleted,
        recreateRemoteIfDeleted: false,
        propagateLocalDelete: false,
        propagateRemoteDelete: false,
        showPlanBeforeSync: true,
      },
    });
    await this.deps.onFinish?.({ profileId, direction: isSingleDoc ? "pull" : this.direction });
    this.close();
  }
}
