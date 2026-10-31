import type { UserTokens, AuthMode } from "../feishu/auth";
import type { WikiTreeEntry } from "../feishu/wiki";

export type SyncAction =
  | "skip"
  | "push"
  | "create-remote"
  | "pull"
  | "create-local"
  | "link"
  | "conflict"
  | "delete-remote"
  | "delete-local"
  | "local-deleted"
  | "remote-deleted"
  | "empty-local"
  | "dirty-editor"
  | "forget";

export interface PlanItem {
  relPath: string;
  action: SyncAction;
  reason?: string;
  parentDir: string;
  remoteTitle?: string;
  fileToken?: string;
  nodeToken?: string;
  remoteModifiedTime?: string;
  remoteVersion?: string;
  localHash?: string;
  remoteHash?: string;
  localSize?: number;
  localMtime?: number;
  duplicateConflict?: boolean;
  /** 文档模式：远端 docx 文档 id */
  documentId?: string;
  /** Rule-only refresh: recheck the remote content before overwriting a previewed plan. */
  rulesRefresh?: boolean;
  /** 二开：镜像档远端覆盖本地时，覆盖前把本地旧版另存副本 */
  backupLocal?: boolean;
}

export interface SyncPlan {
  settingsFingerprint?: string;
  items: PlanItem[];
  counts: Record<string, number>;
  localNoteCount: number;
  remoteNoteCount: number;
  publishRulesFingerprint?: string;
  pullRulesFingerprint?: string;
  warnings?: { relPath: string; message: string }[];
  /** 二开：覆盖面明示——远端存在但不参与当前同步模式的节点，按 obj_type 聚合 */
  unsynced?: UnsyncedNodeGroup[];
}

/** 二开：一类不参与当前同步模式的远端内容（按 obj_type 聚合），用于覆盖面明示 */
export interface UnsyncedNodeGroup {
  objType: string;
  count: number;
}

export const OBJ_TYPE_LABELS: Record<string, string> = {
  docx: "飞书文档",
  doc: "旧版文档",
  sheet: "电子表格",
  bitable: "多维表格",
  mindnote: "思维笔记",
  slides: "幻灯片",
  file: "文件",
};

/**
 * 二开：从知识库树里统计"叶子节点中不参与同步"的内容。
 * 有子级的节点按目录处理（其正文是否导出是另一个已知边界，这里不统计）。
 * syncedObjTypes：当前模式会同步的 obj_type（md 模式 = file，doc 模式 = docx）。
 */
export function countUnsyncedLeafNodes(entries: WikiTreeEntry[], syncedObjTypes: string[]): UnsyncedNodeGroup[] {
  const parentTokens = new Set<string>();
  for (const entry of entries) {
    if (entry.parentNodeToken) parentTokens.add(entry.parentNodeToken);
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (syncedObjTypes.includes(entry.objType)) continue;
    if (parentTokens.has(entry.nodeToken)) continue;
    counts.set(entry.objType, (counts.get(entry.objType) ?? 0) + 1);
  }
  return [...counts.entries()].map(([objType, count]) => ({ objType, count })).sort((a, b) => b.count - a.count);
}

export const ACTION_LABELS: Record<SyncAction, string> = {
  skip: "已同步",
  push: "上传覆盖",
  "create-remote": "上传新建",
  pull: "拉取覆盖",
  "create-local": "拉取新建",
  link: "建立映射",
  conflict: "冲突",
  "delete-remote": "删除远端",
  "delete-local": "删除本地",
  "local-deleted": "本地已删除",
  "remote-deleted": "远端已删除",
  "empty-local": "跳过空文件",
  "dirty-editor": "跳过（编辑中）",
  forget: "清理映射",
};

export interface FileRecord {
  fileToken: string;
  nodeToken?: string;
  parentNodeToken?: string;
  baseHash: string;
  localSize: number;
  localMtime: number;
  remoteModifiedTime?: string;
  remoteVersion?: string;
  lastSyncedAt: number;
}

export interface ConflictRecord {
  remoteHash: string;
  localHash: string;
  copyPath: string;
  at: number;
}

/** 远端图片 token → 本地附件文件（避免每次拉取都新增副本） */
export interface ImageDownloadRecord {
  path: string;
  token: string;
  /** 附件内容的哈希，用来按内容复用已存在的本地文件 */
  hash?: string;
  at: number;
}

/** 已上传图片的复用缓存：同一文档 + 同一内容哈希，不重复上传 */
export interface ImageUploadRecord {
  fileToken: string;
  documentId: string;
  hash: string;
  /** 上传来源的本地文件，下行遇到同样内容时可以直接复用 */
  path?: string;
  at: number;
}

/** 文档模式：一篇笔记对应一篇飞书新版文档（docx）。 */
export interface DocRecord {
  documentId: string;
  nodeToken?: string;
  parentNodeToken?: string;
  /** 实际用的文档标题（笔记名与目录同名时会带 (note) 后缀） */
  documentTitle?: string;
  baseLocalHash: string;
  /** 取回形态（fetch 回来的 Markdown）的哈希，飞书会做格式规范化，不能用本地形态当远端基线 */
  baseRemoteHash: string;
  publishRulesFingerprint?: string;
  /** 飞书返回的最后修改时间（Unix 秒字符串），用来跳过每轮的全文取回 */
  remoteModifiedTime?: string;
  localSize: number;
  localMtime: number;
  lastSyncedAt: number;
  conflict?: boolean;
}

export interface FolderRecord {
  nodeToken: string;
  parentNodeToken?: string;
}

export interface SyncTarget {
  spaceId: string;
  rootNodeToken: string;
  /** 上次同步用的模式，用于发现模式切换后重按「首次对接」判定 */
  syncMode?: SyncModeSetting;
  /** 文档模式是否把填写的根节点正文也作为一篇笔记拉取 */
  includeRootPage?: boolean;
  /** vault 内的本地同步目录，空字符串表示 vault 根目录 */
  localFolder?: string;
  folderMode?: "nodes" | "flat";
  flatSeparator?: string;
  rootPageTitle?: string;
}

export interface SyncState {
  records: Record<string, FileRecord>;
  folders: Record<string, FolderRecord>;
  conflicts: Record<string, ConflictRecord>;
  docRecords: Record<string, DocRecord>;
  /** 远端图片 token → 本地附件（文档模式下行） */
  images: Record<string, ImageDownloadRecord>;
  /** 图片内容哈希 + 文档 id → 已上传素材（文档模式上行复用） */
  imageUploads: Record<string, ImageUploadRecord>;
  /**
   * 文档模式：已知"正文为空"的容器文档（有子级、但自身没有正文的目录页面）。
   * documentId → 判定为空时的 latest_modify_time，时间戳变了就重新取回校验；
   * null = 插件自己创建的空目录页面，永久按目录处理，不参与取回校验。
   */
  docEmptyContainers?: Record<string, string | null>;
  target?: SyncTarget;
  lastSyncAt?: number;
}

export function emptyState(): SyncState {
  return { records: {}, folders: {}, conflicts: {}, docRecords: {}, images: {}, imageUploads: {} };
}

/** 笔记同步形态：md 为原生 Markdown 文件镜像，doc 为飞书新版文档 */
export type SyncModeSetting = "md" | "doc";

/** 二开：同步档位（方向）。pull = 仅拉取镜像；both = 双向协作；push = 仅推送 */
export type SyncDirectionProfile = "pull" | "both" | "push";

/** 二开：冲突策略。keep-both = 保留双方（上游行为）；remote-wins = 远端覆盖本地，本地旧版另存副本 */
export type ConflictPolicy = "keep-both" | "remote-wins";

/** 二开：一次"检查更新"（只探测，不拉取）的结果快照 */
export interface ProfileUpdateInfo {
  /** 已映射且远端修改时间有变化的篇数 */
  changed: number;
  /** 远端新增、本地尚未映射的篇数 */
  added: number;
  /** 检查完成时间 */
  at: number;
}

/** 二开：一个同步目标（知识库 × 本地目录 × 方向档位）的完整快照 */
export interface SyncTargetProfile {
  id: string;
  name: string;
  direction: SyncDirectionProfile;
  conflictPolicy: ConflictPolicy;
  target: {
    spaceId: string;
    rootNodeToken: string;
    rootPageTitle: string;
    includeRootPage: boolean;
    localFolder: string;
    syncMode: "md" | "doc";
    folderMode: "nodes" | "flat";
    flatSeparator: string;
    excludePatterns: string;
    attachmentFolder: string;
    attachmentLinkStyle: "shortest" | "path";
    docVerifyRemoteByContent: boolean;
    restoreLocalDeleted: boolean;
    recreateRemoteIfDeleted: boolean;
    propagateLocalDelete: boolean;
    propagateRemoteDelete: boolean;
    showPlanBeforeSync: boolean;
  };
  /** 该目标上次激活时的同步状态；settings.state 始终是当前激活目标的活状态 */
  state?: SyncState;
  /** 二开：最近一次"检查更新"的结果（只探测不拉取），知识库面板与状态栏据此显示更新标识 */
  updateInfo?: ProfileUpdateInfo;
}

export interface PluginSettings {
  authMode: AuthMode;
  appId: string;
  appSecret: string;
  oauthScope: string;
  redirectUri: string;
  spaceId: string;
  rootNodeToken: string;
  rootPageTitle: string;
  /** 文档模式：把填写的根节点正文作为一篇同名 Markdown 笔记拉取 */
  includeRootPage: boolean;
  /** vault 内的本地同步目录，空字符串表示 vault 根目录 */
  localFolder: string;
  /** 本地文件缺失且远端仍存在时，是否允许拉取最新版本恢复 */
  restoreLocalDeleted: boolean;
  /** md：把笔记当原生 Markdown 文件镜像；doc：把笔记同步成飞书新版文档 */
  syncMode: SyncModeSetting;
  folderMode: "nodes" | "flat";
  flatSeparator: string;
  excludePatterns: string;
  recreateRemoteIfDeleted: boolean;
  /** 本地已删除的笔记，同步时把远端一起删掉（飞书进回收站，可恢复） */
  propagateLocalDelete: boolean;
  /** 远端已删除的文件/文档，同步时把本地笔记移进 .trash */
  propagateRemoteDelete: boolean;
  /** 远程图片下载到本地的附件目录（相对 vault 根） */
  attachmentFolder: string;
  /** 文档模式安全阀：忽略远端修改时间戳，每轮都取回全文校验 */
  docVerifyRemoteByContent: boolean;
  attachmentLinkStyle: "shortest" | "path";
  showPlanBeforeSync: boolean;
  autoSyncMinutes: number;
  debugLog: boolean;
  userTokens?: UserTokens;
  state: SyncState;
  /** 二开：当前激活目标的同步档位（方向）。缺省 both = 上游行为 */
  syncDirection?: SyncDirectionProfile;
  /** 二开：冲突策略。缺省 keep-both = 上游行为 */
  conflictPolicy?: ConflictPolicy;
  /** 二开：全部同步目标；缺省（旧配置）由 profileStore 迁移生成单一 default 目标 */
  profiles?: SyncTargetProfile[];
  /** 二开：当前激活的目标 id */
  activeProfileId?: string;
}

/**
 * 读取知识库节点并解析公开 /wiki/<token> 链接所需的用户权限。
 * 这两个权限不会由旧版的 wiki:wiki 范围自动替代，必须随 OAuth 请求显式申请。
 */
export const REQUIRED_OAUTH_SCOPES = ["wiki:node:read", "wiki:node:retrieve"] as const;

export function ensureOAuthScopes(scope: string): string {
  const scopes = scope.split(/\s+/).filter(Boolean);
  for (const required of REQUIRED_OAUTH_SCOPES) {
    if (!scopes.includes(required)) scopes.push(required);
  }
  return scopes.join(" ");
}

export const CONFLICT_DIR = ".obsidian/feishu-sync/conflicts";

export const DEFAULT_SETTINGS: PluginSettings = {
  authMode: "user",
  appId: "",
  appSecret: "",
  oauthScope: ensureOAuthScopes("drive:drive wiki:wiki docs:document.media:download docs:document.media:upload docx:document offline_access"),
  redirectUri: "http://localhost:7634/callback",
  spaceId: "",
  rootNodeToken: "",
  rootPageTitle: "",
  includeRootPage: true,
  localFolder: "",
  restoreLocalDeleted: false,
  syncMode: "md",
  folderMode: "nodes",
  flatSeparator: "__",
  excludePatterns: ".trash/**",
  recreateRemoteIfDeleted: false,
  propagateLocalDelete: false,
  propagateRemoteDelete: false,
  attachmentFolder: "attachments",
  docVerifyRemoteByContent: false,
  attachmentLinkStyle: "shortest",
  showPlanBeforeSync: true,
  autoSyncMinutes: 0,
  debugLog: false,
  state: emptyState(),
  syncDirection: "both",
  conflictPolicy: "keep-both",
};

export interface RemoteNote {
  relPath: string;
  entry: WikiTreeEntry;
  modifiedTime?: string;
}

export interface LocalNote {
  relPath: string;
  size: number;
  mtime: number;
}

export function summarize(items: PlanItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.action] = (counts[item.action] ?? 0) + 1;
  }
  return counts;
}

export function dirnameOf(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? "" : relPath.slice(0, index);
}

export function basenameOf(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? relPath : relPath.slice(index + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function normalizeLocalFolder(folder: string): string {
  return folder.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

export function prefixLocalPath(folder: string, relPath: string): string {
  const prefix = normalizeLocalFolder(folder);
  return prefix ? joinPath(prefix, relPath) : relPath;
}

export function stripLocalFolder(folder: string, relPath: string): string {
  const prefix = normalizeLocalFolder(folder);
  if (!prefix) return relPath;
  if (relPath === prefix) return "";
  const marker = `${prefix}/`;
  return relPath.startsWith(marker) ? relPath.slice(marker.length) : relPath;
}
