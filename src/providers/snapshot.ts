/**
 * 原始抓取快照。
 *
 * 落盘保存每次抓取的原始响应，带来三个能力：
 *   1. 可回溯：解析逻辑写错了，可以离线重放，不用再打源站。
 *   2. 可对比：新旧快照 diff 出「延期 / 改档 / 新增」，这是延期提醒的数据基础。
 *   3. 省请求：调试期间反复跑解析不会触发源站限速。
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本文件位于 <root>/src/providers/）。 */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');

export type SnapshotMeta = {
  path: string;
  /** 内容 sha256，用于快速判断「源站是否给了同样的东西」 */
  hash: string;
  bytes: number;
  source: string;
  kind: string;
  fetchedAt: string;
};

function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
}

function slugify(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'snapshot';
}

/**
 * 保存快照。ext 决定后缀，json 会自动美化。
 * 返回落盘路径与内容哈希。
 */
export async function saveSnapshot(
  source: string,
  kind: string,
  body: string | Uint8Array,
  options: { ext?: string; prettyJson?: boolean; dir?: string } = {},
): Promise<SnapshotMeta> {
  const { ext = 'json', prettyJson = false, dir = SNAPSHOT_DIR } = options;

  let payload: string;
  if (typeof body === 'string') {
    if (prettyJson && ext === 'json') {
      try {
        payload = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        payload = body;
      }
    } else {
      payload = body;
    }
  } else {
    payload = Buffer.from(body).toString('utf8');
  }

  const targetDir = path.join(dir, source);
  await mkdir(targetDir, { recursive: true });

  const fileName = `${timestampForFilename()}-${slugify(kind)}.${ext}`;
  const filePath = path.join(targetDir, fileName);
  await writeFile(filePath, payload, 'utf8');

  return {
    path: filePath,
    hash: createHash('sha256').update(payload).digest('hex'),
    bytes: Buffer.byteLength(payload, 'utf8'),
    source,
    kind,
    fetchedAt: new Date().toISOString(),
  };
}

/** 列出某个源的快照文件（按文件名倒序 = 新的在前）。 */
export async function listSnapshots(source: string, dir = SNAPSHOT_DIR): Promise<string[]> {
  const targetDir = path.join(dir, source);
  try {
    const files = await readdir(targetDir);
    return files.sort().reverse();
  } catch {
    return [];
  }
}

/** 读取快照内容。 */
export async function readSnapshot(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

/** 找出最近的两次快照，用于变更检测。 */
export async function lastTwoSnapshots(source: string, dir = SNAPSHOT_DIR): Promise<[string, string] | null> {
  const files = await listSnapshots(source, dir);
  if (files.length < 2) return null;
  const [newest, previous] = files as [string, string];
  return [path.join(dir, source, previous), path.join(dir, source, newest)];
}
