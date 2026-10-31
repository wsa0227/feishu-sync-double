import type { FeishuClient } from "../feishu/client";
import { batchQueryMetas } from "../feishu/files";
import type { ResolvedWikiRoot } from "../feishu/wiki";
import { resolveWikiRoot, walkWikiTree } from "../feishu/wiki";
import type { Logger } from "../log";
import { parseTokenFromInput } from "./engine";
import { buildDocRemoteIndex } from "./docPlanner";
import { activateProfile } from "./profileStore";
import { PathFilter } from "./scanner";
import type { PluginSettings, ProfileUpdateInfo, SyncTargetProfile } from "./types";
import { joinPath, prefixLocalPath } from "./types";

/**
 * 二开：git 式更新检查。
 *
 * 只做只读探测（知识库树 + 批量元数据），绝不拉取正文、绝不写本地——
 * 相当于 `git fetch`：把"哪个知识库有几篇更新"存成标识，等用户在知识库面板里
 * 自己选择拉取。这是定时任务唯一允许做的事。
 */

export interface UpdateCheckDeps {
  createClient: () => FeishuClient;
  logger: Logger;
  saveSettings: () => Promise<void>;
}

export interface UpdateCheckSummary {
  /** 有更新的知识库个数 */
  profilesWithUpdates: number;
  /** 更新总篇数（changed + added） */
  totalUpdates: number;
  /** 检查失败的知识库个数 */
  failures: number;
}

async function resolveSpace(
  client: FeishuClient,
  settings: PluginSettings,
): Promise<{ spaceId: string; rootNodeToken?: string; root?: ResolvedWikiRoot }> {
  let spaceId = parseTokenFromInput(settings.spaceId);
  let rootNodeToken = parseTokenFromInput(settings.rootNodeToken) || undefined;
  let root: ResolvedWikiRoot | undefined;
  if (rootNodeToken) {
    try {
      root = await resolveWikiRoot(client, rootNodeToken);
    } catch {
      // 解析失败按原配置探测（更新检查失败会被上层记录，不影响其他知识库）
    }
    if (root) {
      if (!spaceId) spaceId = root.spaceId;
      rootNodeToken = root.nodeToken;
    }
  }
  if (!spaceId) throw new Error("知识库缺少 space_id，无法检查更新");
  return { spaceId, rootNodeToken, root };
}

function hasBaselineChange(
  baseline: string | undefined,
  latest: string | undefined,
): boolean {
  // 基线缺失（旧记录没有时间戳）时不猜：宁可少报，也不把没变的算成有更新
  return Boolean(baseline && latest && baseline !== latest);
}

/** 文件镜像模式：知识库树里 .md 文件节点的更新探测。 */
async function countMdChanges(client: FeishuClient, settings: PluginSettings, logger: Logger): Promise<ProfileUpdateInfo> {
  const { spaceId, rootNodeToken } = await resolveSpace(client, settings);
  const filter = new PathFilter(settings.excludePatterns);
  const entries = await walkWikiTree(client, spaceId, rootNodeToken, {});
  let added = 0;
  const relPathByToken = new Map<string, string>();
  for (const entry of entries) {
    if (entry.objType !== "file") continue;
    if (entry.relDir && filter.isExcluded(entry.relDir)) continue;
    const raw = joinPath(entry.relDir, entry.title);
    const remoteRelPath = settings.folderMode === "flat" ? raw.split(settings.flatSeparator).join("/") : raw;
    const relPath = prefixLocalPath(settings.localFolder, remoteRelPath);
    if (filter.isExcluded(relPath)) continue;
    const record = settings.state.records[relPath];
    if (record?.fileToken) relPathByToken.set(record.fileToken, relPath);
    else added += 1;
  }
  let changed = 0;
  if (relPathByToken.size > 0) {
    try {
      const metas = await batchQueryMetas(client, [...relPathByToken.keys()]);
      for (const [token, meta] of metas) {
        const relPath = relPathByToken.get(token);
        const record = relPath ? settings.state.records[relPath] : undefined;
        if (hasBaselineChange(record?.remoteModifiedTime, meta.modifiedTime)) changed += 1;
      }
    } catch (error) {
      logger.debug(`更新检查：读取元数据失败，本轮只统计新增（${String(error)}）`);
    }
  }
  return { changed, added, at: Date.now() };
}

/** 文档模式：知识库树里飞书文档（docx）的更新探测。 */
async function countDocChanges(client: FeishuClient, settings: PluginSettings, logger: Logger): Promise<ProfileUpdateInfo> {
  const { spaceId, rootNodeToken, root } = await resolveSpace(client, settings);
  const filter = new PathFilter(settings.excludePatterns);
  const rootEntry = settings.includeRootPage && root && root.objType === "docx" && root.title
    ? {
        nodeToken: root.nodeToken,
        objToken: root.objToken,
        objType: root.objType,
        parentNodeToken: root.parentNodeToken,
        title: root.title,
        relDir: "",
        depth: 0,
      }
    : undefined;
  const entries = await walkWikiTree(client, spaceId, rootNodeToken, { rootEntry });
  const index = buildDocRemoteIndex({
    entries,
    state: settings.state,
    folderMode: settings.folderMode,
    flatSeparator: settings.flatSeparator,
    rootContainerNode: settings.state.folders[""]?.nodeToken,
    rootDocumentNode: rootEntry?.nodeToken,
    localFolder: settings.localFolder,
    isExcluded: (relPath) => filter.isExcluded(relPath),
  });
  let added = 0;
  const knownIds: string[] = [];
  for (const note of index.notes.values()) {
    const record = settings.state.docRecords[note.relPath];
    if (record?.documentId) knownIds.push(record.documentId);
    else if (!note.containerUnverified) added += 1;
    // containerUnverified：有子级但没映射的节点多半是空目录页面，检查期不取回正文、不计入新增，
    // 真正的判定留给用户拉取时的完整计划。
  }
  let changed = 0;
  if (knownIds.length > 0) {
    try {
      const metas = await batchQueryMetas(client, knownIds, "docx");
      for (const [token, meta] of metas) {
        const record = Object.values(settings.state.docRecords).find((item) => item.documentId === token);
        if (hasBaselineChange(record?.remoteModifiedTime, meta.modifiedTime)) changed += 1;
      }
    } catch (error) {
      logger.debug(`更新检查：读取文档元数据失败，本轮只统计新增（${String(error)}）`);
    }
  }
  return { changed, added, at: Date.now() };
}

/** 单篇云文档源：一篇文档就是全部远端，探测 = 一次批量元数据。 */
async function countSingleDocChanges(client: FeishuClient, settings: PluginSettings): Promise<ProfileUpdateInfo> {
  const documentId = settings.docSource!.documentId;
  const record = Object.values(settings.state.docRecords).find((item) => item.documentId === documentId);
  if (!record) return { changed: 0, added: 1, at: Date.now() };
  try {
    const metas = await batchQueryMetas(client, [documentId], "docx");
    const meta = metas.get(documentId);
    return { changed: hasBaselineChange(record.remoteModifiedTime, meta?.modifiedTime) ? 1 : 0, added: 0, at: Date.now() };
  } catch {
    // 元数据拿不到时不猜：维持"无更新"，下次完整同步会以取回内容为准
    return { changed: 0, added: 0, at: Date.now() };
  }
}

/**
 * 检查单个知识库的更新：临时激活该知识库（复用平铺字段与排除规则），结果写回它的 updateInfo。
 * 不落盘、不恢复激活状态——由调用方决定。
 */
export async function checkOneKnowledgeBase(
  settings: PluginSettings,
  profileId: string,
  deps: UpdateCheckDeps,
): Promise<ProfileUpdateInfo | undefined> {
  const profile = (settings.profiles ?? []).find((item) => item.id === profileId);
  if (!profile) return undefined;
  activateProfile(settings, profileId);
  const client = deps.createClient();
  const info = settings.docSource?.documentId
    ? await countSingleDocChanges(client, settings)
    : settings.syncMode === "doc"
      ? await countDocChanges(client, settings, deps.logger)
      : await countMdChanges(client, settings, deps.logger);
  profile.updateInfo = info;
  return info;
}

/** 检查全部知识库的更新；结束时恢复原来的激活知识库并落盘。 */
export async function checkAllKnowledgeBases(
  settings: PluginSettings,
  deps: UpdateCheckDeps,
  options: { onProgress?: (message: string) => void } = {},
): Promise<UpdateCheckSummary> {
  const profiles: SyncTargetProfile[] = settings.profiles ?? [];
  if (profiles.length === 0) return { profilesWithUpdates: 0, totalUpdates: 0, failures: 0 };
  const originalId = settings.activeProfileId;
  let profilesWithUpdates = 0;
  let totalUpdates = 0;
  let failures = 0;
  let index = 0;
  for (const profile of profiles) {
    index += 1;
    options.onProgress?.(`检查更新（${index}/${profiles.length}）：${profile.name}`);
    try {
      const info = await checkOneKnowledgeBase(settings, profile.id, deps);
      if (info && info.changed + info.added > 0) {
        profilesWithUpdates += 1;
        totalUpdates += info.changed + info.added;
      }
    } catch (error) {
      failures += 1;
      profile.updateInfo = undefined;
      deps.logger.warn(`更新检查失败（${profile.name}）：${String(error)}`);
    }
  }
  if (originalId && profiles.some((profile) => profile.id === originalId)) {
    activateProfile(settings, originalId);
  }
  await deps.saveSettings();
  return { profilesWithUpdates, totalUpdates, failures };
}

export function profileUpdateCount(profile: SyncTargetProfile): number {
  return profile.updateInfo ? profile.updateInfo.changed + profile.updateInfo.added : 0;
}
