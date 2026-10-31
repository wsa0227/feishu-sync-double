import { assertSafeVaultPath } from "./scanner";
import type { RulesFile } from "../convert/rules";
import { applyRules, normalizeImagesForCompare, publishRulesFingerprint, pullRulesFingerprint, ruleEnabled, sourceFormatWarnings } from "../convert/rules";
import type { WikiTreeEntry } from "../feishu/wiki";
import type { LocalNote, PlanItem, SyncPlan, SyncState } from "./types";
import { basenameOf, dirnameOf, joinPath, prefixLocalPath, stripLocalFolder, summarize } from "./types";

export interface DocRemoteNote {
  relPath: string;
  documentId: string;
  nodeToken: string;
  parentNodeToken?: string;
  title: string;
  /**
   * 二开：该节点同时是目录容器（有子级），且映射表里没有它的既有记录。
   * 它可能是"真文档挂子页面"（应作为笔记拉取），也可能是空目录页面（应跳过）。
   * 计划期由 pruneEmptyContainerNotes 取回正文判定，空则从索引移除。
   */
  containerUnverified?: boolean;
}

export interface DocRemoteContainer {
  nodeToken: string;
  title: string;
  parentNodeToken?: string;
}

export interface DocRemoteIndex {
  /** 候选笔记：标题即笔记名 */
  notes: Map<string, DocRemoteNote>;
  /** 容器：relDir -> 节点（含空间顶层/根容器） */
  containers: Map<string, DocRemoteContainer>;
  containerTitles: Set<string>;
  warnings: string[];
}

export interface DocIndexOptions {
  entries: WikiTreeEntry[];
  state: SyncState;
  folderMode: "nodes" | "flat";
  flatSeparator: string;
  rootContainerNode?: string;
  /** 根节点正文作为笔记时，不能因为它有子节点而被识别成目录容器。 */
  rootDocumentNode?: string;
  /** vault 内的本地同步目录前缀。 */
  localFolder?: string;
  isExcluded: (relPath: string) => boolean;
}

/** 笔记名去掉 .md；扁平模式把目录编码进标题，与 md 模式的远端文件名约定一致。 */
export function documentTitleFor(
  relPath: string,
  settings: { folderMode: "nodes" | "flat"; flatSeparator: string; localFolder?: string },
): string {
  const name = basenameOf(relPath).replace(/\.md$/i, "");
  if (settings.folderMode !== "flat") return name;
  const dir = stripLocalFolder(settings.localFolder ?? "", dirnameOf(relPath));
  if (!dir) return name;
  return `${dir.split("/").join(settings.flatSeparator)}${settings.flatSeparator}${name}`;
}

/** 文档标题与某个容器（往往是同名文件夹）撞名时加后缀，避免知识库里两个同名节点分不清。 */
export function uniqueDocumentTitle(title: string, taken: Set<string>): { title: string; renamed: boolean } {
  if (!taken.has(title)) return { title, renamed: false };
  let candidate = `${title} (note)`;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${title} (note ${index})`;
    index += 1;
  }
  return { title: candidate, renamed: true };
}

function illegalSegments(relPath: string): boolean {
  return relPath.split("/").some((segment) => segment === ".." || segment === "." || segment === "");
}

function deriveRelPath(entry: WikiTreeEntry, options: DocIndexOptions, warnings: string[], containerDoc = false): string | undefined {
  if (options.folderMode === "flat") {
    const relPath = prefixLocalPath(options.localFolder ?? "", `${entry.title.split(options.flatSeparator).join("/")}.md`);
    if (illegalSegments(relPath)) {
      warnings.push(`远端标题里的路径片段非法，已跳过：${entry.title}`);
      return undefined;
    }
    return relPath;
  }
  // 二开（folder-note 风格）：容器文档（有子级的 docx）的正文放进与它同名的文件夹里——
  // 文件夹 = 它的子页面，里面的同名 .md = 它自己的正文，树形与飞书一致。扁平模式没有目录概念，维持原样。
  const baseDir = containerDoc ? joinPath(entry.relDir, entry.title) : entry.relDir;
  const relPath = prefixLocalPath(options.localFolder ?? "", joinPath(baseDir, `${entry.title.replace(/\.md$/i, "")}.md`));
  if (illegalSegments(relPath)) {
    warnings.push(`远端标题包含非法路径片段，已跳过：${entry.title}`);
    return undefined;
  }
  return relPath;
}

/**
 * 把 wiki 树里的 docx 节点分成容器与候选笔记。
 * 容器判定：在 state.folders 里（我们建过的目录节点），或者是树里某个节点的父节点
 * （知识库里"有子页面的页面"就是目录；状态被清空后也能靠这条认出目录，不会把目录当笔记拉下来）。
 */
export function buildDocRemoteIndex(options: DocIndexOptions): DocRemoteIndex {
  const warnings: string[] = [];
  const containerTokens = new Set<string>();
  for (const folder of Object.values(options.state.folders)) {
    if (folder.nodeToken) containerTokens.add(folder.nodeToken);
  }
  if (options.rootContainerNode) containerTokens.add(options.rootContainerNode);
  const parentTokens = new Set<string>();
  for (const entry of options.entries) {
    if (entry.parentNodeToken) parentTokens.add(entry.parentNodeToken);
  }
  for (const entry of options.entries) {
    if (entry.objType === "file") continue;
    if (entry.nodeToken === options.rootDocumentNode) continue;
    if (containerTokens.has(entry.nodeToken) || parentTokens.has(entry.nodeToken)) containerTokens.add(entry.nodeToken);
  }

  const containers = new Map<string, DocRemoteContainer>();
  const containerTitles = new Set<string>();
  for (const entry of options.entries) {
    if (entry.nodeToken === options.rootDocumentNode) continue;
    if (!containerTokens.has(entry.nodeToken)) continue;
    const remoteRelDir = entry.nodeToken === options.rootContainerNode ? "" : joinPath(entry.relDir, entry.title);
    const relDir = prefixLocalPath(options.localFolder ?? "", remoteRelDir);
    if (options.folderMode === "nodes" && !containers.has(relDir)) {
      containers.set(relDir, { nodeToken: entry.nodeToken, title: entry.title, parentNodeToken: entry.parentNodeToken });
    }
    containerTitles.add(entry.title);
  }

  const knownDocumentPaths = new Map<string, string>();
  for (const [relPath, record] of Object.entries(options.state.docRecords)) {
    knownDocumentPaths.set(record.documentId, relPath);
  }

  const notes = new Map<string, DocRemoteNote>();
  for (const entry of options.entries) {
    if (entry.objType !== "docx") continue;
    // 二开：容器节点也可能是"真文档挂子页面"。没有既有映射的容器先带标记进候选，
    // 由 pruneEmptyContainerNotes 在计划期取回正文判定；有映射的容器照旧直接作为笔记。
    const isContainerDoc = containerTokens.has(entry.nodeToken) && entry.nodeToken !== options.rootDocumentNode;
    const containerUnverified = isContainerDoc && !knownDocumentPaths.has(entry.objToken);
    const relPath = knownDocumentPaths.get(entry.objToken) ?? deriveRelPath(entry, options, warnings, isContainerDoc);
    if (!relPath) continue;
    assertSafeVaultPath(relPath);
    if (options.isExcluded(relPath)) continue;
    const note: DocRemoteNote = {
      relPath,
      documentId: entry.objToken,
      nodeToken: entry.nodeToken,
      parentNodeToken: entry.parentNodeToken,
      title: entry.title,
    };
    if (containerUnverified) note.containerUnverified = true;
    notes.set(relPath, note);
  }

  return { notes, containers, containerTitles, warnings };
}

/**
 * 二开：候选笔记的路径撞车消解（macOS / Windows 的大小写不敏感与 NFC/NFD 差异会让两个不同标题
 * 落到同一个物理文件上）。必须在 pruneEmptyContainerNotes 之后调用——空容器尚未剔除时，
 * "目录与笔记同名"（容器被剔重、笔记走既有映射）会被误判成远端歧义。
 * 同一路径多个候选时先到先得，其余计入 warnings。
 */
export function resolveDocNotePathClashes(notes: Map<string, DocRemoteNote>): string[] {
  const warnings: string[] = [];
  const seenPaths = new Map<string, string>();
  for (const note of [...notes.values()]) {
    const normalized = note.relPath.normalize("NFC").toLowerCase();
    const clash = seenPaths.get(normalized);
    if (clash === undefined) {
      seenPaths.set(normalized, note.relPath);
      continue;
    }
    notes.delete(note.relPath);
    if (clash === note.relPath) {
      warnings.push(`远端存在多个同名文档，只处理其中一个：${note.relPath}`);
    } else {
      warnings.push(`远端存在仅大小写或 Unicode 形式不同的同名文档，已跳过其中一个：${note.relPath}（与 ${clash} 冲突）`);
    }
  }
  return warnings;
}

/**
 * docs_ai 取回的 Markdown 两种形态都可能出现：真实接口把标题放在最前面的 <title> 标签里，
 * 部分转换（含测试假服务器）会把标题取回成首行 H1。去掉标题后没有正文即视为空文档。
 * H1 只有在与文档标题完全一致时才剥离，避免误伤正文恰好以同名 H1 开头的文档。
 */
export function isEmptyDocumentMarkdown(text: string, title?: string): boolean {
  const body = text.replace(/<title>[\s\S]*?<\/title>/g, "").trim();
  if (body.length === 0) return true;
  if (title) {
    const first = body.split("\n", 1)[0] ?? "";
    const heading = /^#\s+(.*?)\s*$/.exec(first);
    if (heading && heading[1] === title.trim()) {
      const rest = body
        .split("\n")
        .slice(1)
        .join("\n")
        .trim();
      if (rest.length === 0) return true;
    }
  }
  return false;
}

/**
 * 二开：校验"容器文档"的正文，把空目录页面从候选笔记里移除。
 * - 判定结果缓存在 state.docEmptyContainers（documentId → 判定时的 latest_modify_time）：
 *   已知空容器只要元数据时间戳没变，本轮不再取回正文；
 *   时间戳变了（比如别人后来往空目录页面里写了内容）会重新取回，正文非空时转正为笔记。
 * - 取回走共享的计划缓存，与后续 buildDocPlan / 执行期不重复请求。
 * - 取回失败时按现有计划期语义直接抛错终止本轮同步，不做静默猜测。
 */
export async function pruneEmptyContainerNotes(options: {
  notes: Map<string, DocRemoteNote>;
  state: SyncState;
  modifyTimes: Map<string, string>;
  cache: DocPlanCache;
  fetcher: (documentId: string) => Promise<string>;
}): Promise<void> {
  const { notes, state, modifyTimes, cache, fetcher } = options;
  for (const note of [...notes.values()]) {
    if (!note.containerUnverified) continue;
    const cachedTime = state.docEmptyContainers?.[note.documentId];
    const currentTime = modifyTimes.get(note.documentId);
    if (cachedTime !== undefined && currentTime !== undefined && cachedTime === currentTime) {
      // 已判定为空且时间戳没变：仍按目录处理
      notes.delete(note.relPath);
      continue;
    }
    if (cachedTime === null) {
      // 插件自己创建的空目录页面：永久按目录处理
      notes.delete(note.relPath);
      continue;
    }
    let fetched = cache.fetched.get(note.documentId);
    if (fetched === undefined) {
      fetched = await fetcher(note.documentId);
      cache.fetched.set(note.documentId, fetched);
      cache.fetchCount += 1;
    }
    if (isEmptyDocumentMarkdown(fetched, note.title)) {
      if (currentTime !== undefined) {
        state.docEmptyContainers ??= {};
        state.docEmptyContainers[note.documentId] = currentTime;
      }
      notes.delete(note.relPath);
    } else {
      // 有正文（或从空变成了有正文）：转正为普通笔记参与同步，清掉过期的空判定
      if (state.docEmptyContainers) delete state.docEmptyContainers[note.documentId];
      delete note.containerUnverified;
    }
  }
}

export interface DocPlanCache {
  localText: Map<string, string>;
  localHash: Map<string, string>;
  fetched: Map<string, string>;
  fetchedHash: Map<string, string>;
  pulled: Map<string, string>;
  fetchCount: number;
}

export function createDocPlanCache(): DocPlanCache {
  return {
    localText: new Map(),
    localHash: new Map(),
    fetched: new Map(),
    fetchedHash: new Map(),
    pulled: new Map(),
    fetchCount: 0,
  };
}

export interface DocPlannerInput {
  state: SyncState;
  local: Map<string, LocalNote>;
  remote: DocRemoteIndex;
  settings: { folderMode: "nodes" | "flat"; flatSeparator: string; localFolder?: string };
  rules: RulesFile;
  isExcluded: (relPath: string) => boolean;
  readLocal: (relPath: string) => Promise<string>;
  hashText: (text: string) => Promise<string>;
  /** 取回形态（图片 URL 归一化后）的哈希，与执行期记基线时口径一致 */
  hashFetched: (text: string) => Promise<string>;
  fetchMarkdown: (documentId: string) => Promise<string>;
  recreateRemoteIfDeleted: boolean;
  propagateLocalDelete: boolean;
  propagateRemoteDelete: boolean;
  restoreLocalDeleted: boolean;
  cache: DocPlanCache;
  /** 文档 id → 飞书返回的最后修改时间（Unix 秒字符串），接口失败时为空 Map */
  remoteModifiedTimes: Map<string, string>;
  /** 安全阀：忽略时间戳，每轮都取回全文校验 */
  verifyRemoteByContent: boolean;
  /** 强制重推：忽略基线，把本地有内容的笔记都判成 push */
  forcePush: boolean;
}

function item(relPath: string, action: PlanItem["action"], reason?: string, extra: Partial<PlanItem> = {}): PlanItem {
  return { relPath, action, reason, parentDir: dirnameOf(relPath), ...extra };
}

function conflictItem(
  relPath: string,
  state: SyncState,
  reason: string,
  extra: Partial<PlanItem>,
  localHash: string,
  remoteHash: string,
): PlanItem {
  const previous = state.conflicts[relPath];
  const duplicate = !!previous && previous.remoteHash === remoteHash && previous.localHash === localHash;
  return item(relPath, "conflict", duplicate ? "与上次相同的冲突，未重复生成副本" : reason, {
    ...extra,
    localHash,
    remoteHash,
    duplicateConflict: duplicate,
  });
}

export async function readLocalCached(input: DocPlannerInput, relPath: string): Promise<string> {
  const cached = input.cache.localText.get(relPath);
  if (cached !== undefined) return cached;
  const text = await input.readLocal(relPath);
  input.cache.localText.set(relPath, text);
  return text;
}

async function hashLocalCached(input: DocPlannerInput, relPath: string): Promise<string> {
  const cached = input.cache.localHash.get(relPath);
  if (cached !== undefined) return cached;
  const hash = await input.hashText(await readLocalCached(input, relPath));
  input.cache.localHash.set(relPath, hash);
  return hash;
}

export async function fetchCached(input: DocPlannerInput, documentId: string): Promise<string> {
  const cached = input.cache.fetched.get(documentId);
  if (cached !== undefined) return cached;
  input.cache.fetchCount += 1;
  const text = await input.fetchMarkdown(documentId);
  input.cache.fetched.set(documentId, text);
  return text;
}

/**
 * 远端是否变了：先用批量元数据的时间戳快路径判断，时间戳对得上就不取回；
 * 时间戳缺失/不一致/被安全阀关掉时才取回算哈希。
 */
async function remoteChangedState(
  input: DocPlannerInput,
  record: { baseRemoteHash: string; remoteModifiedTime?: string },
  documentId: string,
  verifyContent = false,
): Promise<{ changed: boolean; hash?: string; metaTime?: string }> {
  const metaTime = input.remoteModifiedTimes.get(documentId);
  if (!verifyContent && !input.verifyRemoteByContent && record.remoteModifiedTime) {
    if (metaTime !== undefined && metaTime === record.remoteModifiedTime) return { changed: false, metaTime };
  }
  const hash = await fetchedHash(input, documentId);
  // 取回校验过的文档：把当前时间戳带出去，执行后写回记录，下一轮才能走快路径
  return { changed: hash !== record.baseRemoteHash, hash, metaTime };
}

async function fetchedHash(input: DocPlannerInput, documentId: string): Promise<string> {
  const cached = input.cache.fetchedHash.get(documentId);
  if (cached !== undefined) return cached;
  const hash = await input.hashFetched(await fetchCached(input, documentId));
  input.cache.fetchedHash.set(documentId, hash);
  return hash;
}

/** 取回内容过「下行规则」之后的样子——这正是 pull 会写进本地的内容。 */
export async function pulledContent(
  input: DocPlannerInput,
  relPath: string,
  remoteNote: DocRemoteNote,
  localNote: LocalNote | undefined,
): Promise<string> {
  const cached = input.cache.pulled.get(relPath);
  if (cached !== undefined) return cached;
  const fetched = await fetchCached(input, remoteNote.documentId);
  const localText = localNote ? await readLocalCached(input, relPath) : "";
  const pulled = applyRules(
    "toObsidian",
    fetched,
    { relPath, documentTitle: documentTitleFor(relPath, input.settings), localContent: localText },
    input.rules,
  );
  input.cache.pulled.set(relPath, pulled);
  return pulled;
}

async function isLocalChanged(
  input: DocPlannerInput,
  record: { baseLocalHash: string; localSize: number; localMtime: number },
  localNote: LocalNote,
): Promise<boolean> {
  if (record.localSize === localNote.size && record.localMtime === localNote.mtime && record.baseLocalHash) {
    return false;
  }
  const hash = await hashLocalCached(input, localNote.relPath);
  return hash !== record.baseLocalHash;
}

/**
 * 文档模式的四态判定。两条基线分开记：baseLocalHash 是本地笔记的哈希，baseRemoteHash 是 fetch
 * 回来那份 Markdown 的哈希（飞书会规范化格式，同一份内容发上去取回来不等于本地原文，
 * 拿本地形态当远端基线会永远判定"远端变了"，反复来回拉扯）。
 */
export async function buildDocPlan(input: DocPlannerInput): Promise<SyncPlan> {
  const { state, local, remote } = input;
  const items: PlanItem[] = [];
  const fingerprint = publishRulesFingerprint(input.rules);
  const warnings: { relPath: string; message: string }[] = [];
  const relPaths = new Set<string>([...local.keys(), ...remote.notes.keys(), ...Object.keys(state.docRecords)]);

  for (const relPath of Array.from(relPaths).sort()) {
    if (input.isExcluded(relPath)) continue;

    const localNote = local.get(relPath);
    const remoteNote = remote.notes.get(relPath);
    const record = state.docRecords[relPath];
    if (localNote && ruleEnabled(input.rules, "toFeishu", "source-format-diagnostics")) {
      for (const message of sourceFormatWarnings(await readLocalCached(input, relPath))) warnings.push({ relPath, message });
    }
    const remoteFields: Partial<PlanItem> = remoteNote
      ? { remoteTitle: remoteNote.title, nodeToken: remoteNote.nodeToken, documentId: remoteNote.documentId }
      : {};

    // 强制重推：只看本地有没有内容，忽略两边基线（改了上行规则后用来刷新历史文档）
    if (input.forcePush && localNote && localNote.size > 0) {
      items.push(
        item(relPath, remoteNote ? "push" : "create-remote", "强制重推：忽略基线", {
          ...remoteFields,
          remoteHash: remoteNote ? await fetchedHash(input, remoteNote.documentId) : undefined,
          localSize: localNote.size,
          localMtime: localNote.mtime,
        }),
      );
      continue;
    }

    if (!record) {
      if (localNote && remoteNote) {
        const [pulled, localText, localHash, hash] = await Promise.all([
          pulledContent(input, relPath, remoteNote, localNote),
          readLocalCached(input, relPath),
          hashLocalCached(input, relPath),
          fetchedHash(input, remoteNote.documentId),
        ]);
        const extra = { ...remoteFields, localHash, remoteHash: hash, localSize: localNote.size, localMtime: localNote.mtime };
        // 二开：计划期拿不到"图片已下载后的本地链接形态"，带图文档会和执行器写出的本地文件
        // 只有图片引用不同——按素材槽位归一后再比较，避免首次对接误报冲突。
        if (pulled === localText || normalizeImagesForCompare(pulled) === normalizeImagesForCompare(localText)) {
          items.push(item(relPath, "link", "两边内容一致，只建立映射", extra));
        } else {
          items.push(conflictItem(relPath, state, "首次对接：同名文档两边内容不同，已保留双方", extra, localHash, hash));
        }
        continue;
      }
      if (localNote) {
        items.push(
          item(
            relPath,
            "create-remote",
            localNote.size === 0 ? "空笔记在文档模式下也会同步（<title> 保证 content 非空）" : undefined,
          ),
        );
        continue;
      }
      if (remoteNote) {
        items.push(item(relPath, "create-local", undefined, remoteFields));
      }
      continue;
    }

    if (!localNote && !remoteNote) {
      items.push(item(relPath, "forget", "两边都已不存在，清理映射"));
      continue;
    }

    if (!localNote) {
      if (input.restoreLocalDeleted) {
        items.push(item(relPath, "create-local", "本地已删除，按设置从远端恢复最新内容", remoteFields));
        continue;
      }
      const remoteState = await remoteChangedState(input, record, remoteNote!.documentId);
      const hash = remoteState.hash ?? record.baseRemoteHash;
      const stamp = remoteState.metaTime ? { remoteModifiedTime: remoteState.metaTime } : {};
      if (remoteState.changed) {
        items.push(
          conflictItem(
            relPath,
            state,
            "本地已删除、远端被修改：为避免丢内容，未自动处理",
            { ...remoteFields, localHash: "", remoteHash: hash },
            "",
            hash,
          ),
        );
      } else if (input.propagateLocalDelete) {
        items.push(
          item(relPath, "delete-remote", "本地已删除，按设置删除远端文档（进飞书回收站，可恢复）", {
            ...remoteFields,
            ...stamp,
          }),
        );
      } else {
        items.push(item(relPath, "local-deleted", "本地已删除、远端未变（未自动删除远端）", { ...remoteFields, ...stamp }));
      }
      continue;
    }

    if (!remoteNote) {
      const localChanged = await isLocalChanged(input, record, localNote);
      if (!localChanged) {
        if (input.propagateRemoteDelete) {
          items.push(
            item(relPath, "delete-local", "远端已删除且本地未变，按设置把本地笔记移进 .trash", {
              localSize: localNote.size,
              localMtime: localNote.mtime,
            }),
          );
        } else {
          items.push(item(relPath, "remote-deleted", "远端已删除、本地未变（未自动删除本地）"));
        }
      } else if (input.recreateRemoteIfDeleted) {
        items.push(item(relPath, "create-remote", "远端已删除但本地有修改，按设置重新上传"));
      } else {
        items.push(item(relPath, "remote-deleted", "远端已删除、本地有修改：为避免误恢复，未自动重建"));
      }
      continue;
    }

    const localChanged = await isLocalChanged(input, record, localNote);
    const rulesChanged = record.publishRulesFingerprint !== fingerprint;
    // Rules upgrades must not trust second-resolution timestamps before overwriting old documents.
    const remoteState = await remoteChangedState(input, record, remoteNote.documentId, rulesChanged);
    const remoteChanged = remoteState.changed;
    const hash = remoteState.hash;
    const localHash = await hashLocalCached(input, relPath);
    const extra = {
      ...remoteFields,
      localHash,
      remoteHash: hash,
      localSize: localNote.size,
      localMtime: localNote.mtime,
      remoteModifiedTime: remoteState.metaTime,
    };

    if (!localChanged && !remoteChanged) {
      items.push(rulesChanged
        ? item(relPath, "push", "转换规则已更新：刷新飞书排版，本地正文不变", { ...extra, rulesRefresh: true })
        : item(relPath, "skip", undefined, extra));
      continue;
    }
    if (localChanged && !remoteChanged) {
      items.push(item(relPath, "push", undefined, extra));
      continue;
    }
    if (!localChanged && remoteChanged) {
      items.push(item(relPath, "pull", undefined, extra));
      continue;
    }
    const [pulled, localText] = await Promise.all([
      pulledContent(input, relPath, remoteNote, localNote),
      readLocalCached(input, relPath),
    ]);
    if (pulled === localText) {
      items.push(item(relPath, "link", "两边内容一致，只更新基线", extra));
      continue;
    }
    items.push(conflictItem(relPath, state, "两边都改过且内容不同，已保留双方", extra, localHash, hash ?? localHash));
  }

  // Bind every action to the local content actually inspected by this preview.
  for (const entry of items) {
    const note = local.get(entry.relPath);
    if (!note || entry.action === "skip") continue;
    entry.localSize = note.size;
    entry.localMtime = note.mtime;
    entry.localHash = await hashLocalCached(input, entry.relPath);
  }

  return {
    items,
    counts: summarize(items),
    localNoteCount: local.size,
    remoteNoteCount: remote.notes.size,
    publishRulesFingerprint: fingerprint,
    pullRulesFingerprint: pullRulesFingerprint(input.rules),
    warnings,
  };
}
