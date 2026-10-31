import type { ConflictPolicy, PluginSettings, SyncDirectionProfile, SyncState, SyncTargetProfile } from "./types";
import { emptyState, normalizeLocalFolder } from "./types";

/**
 * 二开：多目标 Profiles。
 *
 * 设计：`settings.profiles[]` 保存全部目标的快照（target 字段 + 各自的同步状态），
 * `settings.state` 与平铺的目标字段（spaceId/localFolder/…）始终是"当前激活目标"的活视图——
 * 引擎与既有代码只读平铺字段，不需要感知多目标。
 * - `syncSettingsIntoActiveProfile`：把平铺字段 + state 收回当前激活目标（saveSettings 前调用）；
 * - `activateProfile`：把目标快照铺回平铺字段并切换 state（切换目标时调用）；
 * - `ensureProfilesMigrated`：旧配置（无 profiles）首次加载时生成单一 default 目标，幂等。
 */

const TARGET_FIELD_KEYS = [
  "spaceId",
  "rootNodeToken",
  "rootPageTitle",
  "includeRootPage",
  "localFolder",
  "syncMode",
  "folderMode",
  "flatSeparator",
  "excludePatterns",
  "attachmentFolder",
  "attachmentLinkStyle",
  "docVerifyRemoteByContent",
  "restoreLocalDeleted",
  "recreateRemoteIfDeleted",
  "propagateLocalDelete",
  "propagateRemoteDelete",
  "showPlanBeforeSync",
] as const;

export function newProfileId(): string {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function snapshotTarget(settings: PluginSettings): SyncTargetProfile["target"] {
  return {
    spaceId: settings.spaceId,
    rootNodeToken: settings.rootNodeToken,
    rootPageTitle: settings.rootPageTitle,
    includeRootPage: settings.includeRootPage,
    localFolder: settings.localFolder,
    syncMode: settings.syncMode,
    folderMode: settings.folderMode,
    flatSeparator: settings.flatSeparator,
    excludePatterns: settings.excludePatterns,
    attachmentFolder: settings.attachmentFolder,
    attachmentLinkStyle: settings.attachmentLinkStyle,
    docVerifyRemoteByContent: settings.docVerifyRemoteByContent,
    restoreLocalDeleted: settings.restoreLocalDeleted,
    recreateRemoteIfDeleted: settings.recreateRemoteIfDeleted,
    propagateLocalDelete: settings.propagateLocalDelete,
    propagateRemoteDelete: settings.propagateRemoteDelete,
    showPlanBeforeSync: settings.showPlanBeforeSync,
  };
}

function applyTarget(settings: PluginSettings, target: SyncTargetProfile["target"]): void {
  for (const key of TARGET_FIELD_KEYS) {
    // 类型系统层面这些键在两侧都存在且类型一致；运行时逐键覆盖
    (settings as unknown as Record<string, unknown>)[key] = target[key];
  }
}

function defaultProfileName(settings: PluginSettings): string {
  if (settings.localFolder) return settings.localFolder.split("/").filter(Boolean).pop() as string;
  if (settings.spaceId) return `空间 ${settings.spaceId}`;
  return "默认目标";
}

/** 旧配置迁移：生成覆盖当前全部设置的单一 default 目标。已迁移时不动。 */
export function ensureProfilesMigrated(settings: PluginSettings): boolean {
  if (settings.profiles && settings.activeProfileId && settings.profiles.some((item) => item.id === settings.activeProfileId)) {
    return false;
  }
  const existing = settings.profiles ?? [];
  const profile: SyncTargetProfile = {
    id: "default",
    name: defaultProfileName(settings),
    direction: settings.syncDirection ?? "both",
    conflictPolicy: settings.conflictPolicy ?? "keep-both",
    target: snapshotTarget(settings),
    state: settings.state,
  };
  const merged = existing.some((item) => item.id === "default")
    ? existing.map((item) => (item.id === "default" ? profile : item))
    : [profile, ...existing];
  settings.profiles = merged;
  settings.activeProfileId = "default";
  settings.syncDirection = profile.direction;
  settings.conflictPolicy = profile.conflictPolicy;
  return true;
}

export function activeProfile(settings: PluginSettings): SyncTargetProfile | undefined {
  return settings.profiles?.find((item) => item.id === settings.activeProfileId);
}

/** saveSettings 前调用：把平铺的目标字段与活状态收回当前激活目标。 */
export function syncSettingsIntoActiveProfile(settings: PluginSettings): void {
  const profile = activeProfile(settings);
  if (!profile) return;
  profile.target = snapshotTarget(settings);
  profile.state = settings.state;
  profile.direction = settings.syncDirection ?? profile.direction;
  profile.conflictPolicy = settings.conflictPolicy ?? profile.conflictPolicy;
}

/** 切换激活目标：当前平铺字段与状态先收回旧目标，再把新目标快照铺开。 */
export function activateProfile(settings: PluginSettings, profileId: string): boolean {
  const profiles = settings.profiles ?? [];
  const next = profiles.find((item) => item.id === profileId);
  if (!next) return false;
  if (next.id === settings.activeProfileId) return true;
  syncSettingsIntoActiveProfile(settings);
  applyTarget(settings, next.target);
  settings.state = next.state ?? emptyState();
  settings.activeProfileId = next.id;
  settings.syncDirection = next.direction;
  settings.conflictPolicy = next.conflictPolicy;
  return true;
}

/** 新建目标并切换为激活（添加知识库向导用）。 */
export function createAndActivateProfile(
  settings: PluginSettings,
  profile: Omit<SyncTargetProfile, "state"> & { state?: SyncState },
): SyncTargetProfile {
  const created: SyncTargetProfile = { ...profile, state: profile.state ?? emptyState() };
  settings.profiles = [...(settings.profiles ?? []), created];
  settings.activeProfileId = created.id;
  applyTarget(settings, created.target);
  settings.state = created.state as SyncState;
  settings.syncDirection = created.direction;
  settings.conflictPolicy = created.conflictPolicy;
  return created;
}

/**
 * 二开：校验本地目录不与其他知识库重叠（相等或父子包含都算冲突）。
 * 两个知识库管理同一批本地文件会让映射状态互相覆盖，必须在配置期拒绝。
 * 返回冲突知识库的名称；无冲突返回 undefined。
 */
export function findFolderConflict(settings: PluginSettings, folder: string, excludeProfileId?: string): string | undefined {
  const candidate = normalizeLocalFolder(folder);
  for (const profile of settings.profiles ?? []) {
    if (excludeProfileId && profile.id === excludeProfileId) continue;
    const other = normalizeLocalFolder(profile.target.localFolder);
    if (candidate === other) return profile.name;
    // vault 根目录（空）包含一切非空目录；非空目录之间做父子包含判断
    if (!candidate && other) return profile.name;
    if (candidate && other && (candidate.startsWith(`${other}/`) || other.startsWith(`${candidate}/`))) {
      return profile.name;
    }
  }
  return undefined;
}

/** 删除一个目标；删的是激活目标时切到剩余的第一个（没有则重建空的 default）。 */export function deleteProfile(settings: PluginSettings, profileId: string): boolean {
  const profiles = settings.profiles ?? [];
  const remaining = profiles.filter((item) => item.id !== profileId);
  if (remaining.length === profiles.length) return false;
  settings.profiles = remaining;
  if (settings.activeProfileId !== profileId) return true;
  const fallback = remaining[0];
  if (fallback) {
    activateProfile(settings, fallback.id);
  } else {
    settings.activeProfileId = "default";
    settings.syncDirection = "both";
    settings.conflictPolicy = "keep-both";
    settings.state = emptyState();
    applyTarget(settings, { ...snapshotTarget(settings), spaceId: "", rootNodeToken: "", localFolder: "" });
  }
  return true;
}

// ---------------------------------------------------------------- 向导纯函数

export type ParsedWikiInput =
  | { kind: "space"; spaceId: string }
  | { kind: "node"; token: string }
  | { kind: "invalid"; reason: string };

/** 解析用户粘贴的知识库地址：支持 /wiki/space/<id>、/wiki/<node>、裸节点令牌。 */
export function parseWikiInput(raw: string): ParsedWikiInput {
  const value = raw.trim();
  if (!value) return { kind: "invalid", reason: "请先粘贴知识库链接或节点令牌" };
  if (/^https?:\/\//i.test(value) || value.includes("/wiki/")) {
    const spaceMatch = /\/wiki\/space\/([0-9]+)/.exec(value);
    if (spaceMatch) return { kind: "space", spaceId: spaceMatch[1] };
    const nodeMatch = /\/wiki\/([A-Za-z0-9_-]+)/.exec(value);
    if (nodeMatch && nodeMatch[1] !== "space") return { kind: "node", token: nodeMatch[1] };
    return { kind: "invalid", reason: "无法从链接里识别节点或空间，请确认复制的是 /wiki/ 页面链接" };
  }
  if (/\s/.test(value) || value.length < 8) return { kind: "invalid", reason: "内容不像节点令牌，请粘贴 /wiki/ 页面链接" };
  return { kind: "node", token: value };
}

const ILLEGAL_DIR_CHARS = /[\\/:*?"<>|#^[\]]/g;

/** 清洗目录名：去掉文件系统/路径非法字符与多余空白。 */
export function sanitizeDirName(name: string): string {
  return name.replace(ILLEGAL_DIR_CHARS, "").replace(/\s+/g, " ").trim();
}

/** 建议本地目录：沿用当前同步根（第一段），加上新知识库的名称。 */
export function suggestLocalFolder(currentLocalFolder: string, knowledgeBaseName: string): string {
  const cleanName = sanitizeDirName(knowledgeBaseName) || "知识库";
  const segments = currentLocalFolder.split("/").filter(Boolean);
  const base = segments.length > 0 ? segments[0] : "飞书同步";
  return `${base}/${cleanName}`;
}

export function directionLabel(direction: SyncDirectionProfile): string {
  return direction === "pull" ? "仅拉取（只读）" : direction === "push" ? "仅推送" : "双向协作";
}

export function conflictPolicyLabel(policy: ConflictPolicy): string {
  return policy === "remote-wins" ? "远端覆盖本地（本地旧版另存副本）" : "保留双方";
}
