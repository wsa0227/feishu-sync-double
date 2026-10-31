import { App, FuzzySuggestModal, Notice } from "obsidian";
import type { SyncTargetProfile } from "../sync/types";
import { directionLabel } from "../sync/profileStore";

/** 二开：多目标之间切换（模糊搜索）。 */
export interface SwitchTargetDeps {
  profiles: SyncTargetProfile[];
  activeId: string;
  onSwitch: (profileId: string) => void | Promise<void>;
  onAdd: () => void;
}

export class SwitchTargetModal extends FuzzySuggestModal<SyncTargetProfile> {
  private readonly deps: SwitchTargetDeps;

  constructor(app: App, deps: SwitchTargetDeps) {
    super(app);
    this.deps = deps;
    this.setPlaceholder("切换飞书同步目标（新建目标选「➕ 添加知识库…」）");
  }

  getItems(): SyncTargetProfile[] {
    return this.deps.profiles;
  }

  getItemText(item: SyncTargetProfile): string {
    const active = item.id === this.deps.activeId ? "（当前）" : "";
    return `${item.name}${active} · ${directionLabel(item.direction)} · ${item.target.localFolder || "vault 根目录"}`;
  }

  onChooseItem(item: SyncTargetProfile): void {
    void this.deps.onSwitch(item.id);
  }

  /** 空结果时给出添加入口。 */
  onNoSuggestion(): void {
    this.openAdd();
  }

  private openAdd(): void {
    this.close();
    this.deps.onAdd();
    new Notice("在向导里粘贴知识库链接即可添加新目标");
  }
}
