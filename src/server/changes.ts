/**
 * 延期 / 改档检测。
 *
 * 这是让日历「长期不失真」的关键：数据源只会告诉你**现在**的时间，
 * 不会告诉你「第 5 话从 10/21 挪到了 10/28」。只有自己保存历史、每次同步做对比，
 * 才能发现这件事。
 *
 * 难点不在对比本身，而在**别报假警**：
 *
 *   1. 源切换造成的假变更
 *      某个源这次超时/失败，字段就会落到优先级更低的源上，时间自然不一样。
 *      对策：只有当「新值来自同一个源」或「新值来自优先级更高的源」时才算变更。
 *
 *   2. 排期逐步公布造成的假变更
 *      AniList 的 airingSchedule 会随着季度推进慢慢补全，
 *      一次同步里冒出 11 集「新增」并不是改档。
 *      对策：把新增分集**聚合成一条**（「新增 3 集排期（第 5~7 话）」），而不是每集一条。
 *
 *   3. 微小的浮点/秒级差异
 *      对策：小于 minSeconds（默认 60 秒）的差异直接忽略。
 */

import type { DatabaseSync } from 'node:sqlite';

import { EPISODE_AIR_PRIORITY } from '../core/merge.ts';
import { formatShortInZone } from '../core/time.ts';
import type { SourceId, Subject } from '../core/types.ts';

export type ChangeKind = 'delayed' | 'advanced' | 'episode-added' | 'episode-removed' | 'total-eps-changed';

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  delayed: '延期',
  advanced: '提前',
  'episode-added': '新增排期',
  'episode-removed': '排期消失',
  'total-eps-changed': '集数变化',
};

export type DetectedChange = {
  subjectKey: string;
  title: string;
  epNumber: number | null;
  kind: ChangeKind;
  /** 写进 change_log.field 的字段名 */
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** 给人看的一句话 */
  message: string;
};

type ExistingEpisode = { ep_number: number; air_at_utc: string | null; air_source: string | null };

function sourceRank(source: string | null): number {
  const index = EPISODE_AIR_PRIORITY.indexOf(source as SourceId);
  return index === -1 ? 999 : index;
}

function humanDayDiff(diffMs: number): string {
  const days = Math.abs(diffMs) / 86_400_000;
  if (days >= 1) return `${days % 1 === 0 ? days : days.toFixed(1)} 天`;
  const hours = Math.abs(diffMs) / 3_600_000;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)} 小时`;
}

/**
 * 对比「库里已有的分集」与「这次抓到的分集」，找出真正的变更。
 *
 * 必须在写入新数据**之前**调用 —— 写完之后就没有「旧值」可比了。
 */
export function detectChanges(
  db: DatabaseSync,
  subject: Subject,
  options: { minSeconds?: number; maxAddedPerSubject?: number } = {},
): DetectedChange[] {
  const { minSeconds = 60, maxAddedPerSubject = 1 } = options;

  const existing = db
    .prepare('SELECT ep_number, air_at_utc, air_source FROM episode WHERE subject_key = ?')
    .all(subject.key) as unknown as ExistingEpisode[];

  // 库里没有这部番的分集记录 —— 这是第一次见到它，不存在「变更」
  if (existing.length === 0) return [];

  const title = subject.titleCn ?? subject.titleOriginal ?? subject.key;
  const changes: DetectedChange[] = [];
  const freshByNumber = new Map(subject.episodes.map((episode) => [episode.epNumber, episode]));
  // 这次运行**实际参与了**的源（`mergeSubjects()` 由本次融合的原始条目算出，见 merge.ts:265）。
  // 实测教训（.scratch/duplicate-subjects/issues/01-票A）：yuc 只给第 1 话
  // （providers/yuc.ts:338-340），于是"只有 yuc 成功"的一次运行会把第 2..N 话
  // 全判成"消失了"—— 实测 2772 条 `episode-removed` **100% 是假报警**。
  const sourcesPresent = new Set<string>(subject.sources ?? []);

  for (const old of existing) {
    const fresh = freshByNumber.get(old.ep_number);

    // 原本有确定的时刻，这次却没了 —— 多半是撤档或时间被撤回
    if (!fresh) {
      if (old.air_at_utc) {
        // 关键：**源降级**造成的"消失"不是变更。
        // `delayed` / `advanced` 两个分支早就有这道过滤（见下面 sourceRank 的比较），
        // 删除分支以前没有 —— 那正是 2772 条假报警的成因。
        // 判据：库里这条时刻的源这次仍然在场才允许报删除；该源这次一条都没给
        // （或它本来就是 null，例如手动修正）时，这只是"这次没抓到"，不是"消失了"。
        if (old.air_source && !sourcesPresent.has(old.air_source)) continue;
        changes.push({
          subjectKey: subject.key,
          title,
          epNumber: old.ep_number,
          kind: 'episode-removed',
          field: 'airAtUtc',
          oldValue: old.air_at_utc,
          newValue: null,
          message: `第 ${old.ep_number} 话的放送时刻从数据源中消失了`,
        });
      }
      continue;
    }

    if (!fresh.airAtUtc || !old.air_at_utc) continue;

    const oldMs = Date.parse(old.air_at_utc);
    const newMs = Date.parse(fresh.airAtUtc);
    if (!Number.isFinite(oldMs) || !Number.isFinite(newMs)) continue;

    const diffMs = newMs - oldMs;
    if (Math.abs(diffMs) / 1000 < minSeconds) continue;

    // 关键：过滤掉「因为换了数据源」而产生的假变更
    const newSource = fresh.airSource ?? null;
    if (newSource !== old.air_source && sourceRank(newSource) > sourceRank(old.air_source)) continue;

    const kind: ChangeKind = diffMs > 0 ? 'delayed' : 'advanced';
    const verb = kind === 'delayed' ? '延期' : '提前';
    changes.push({
      subjectKey: subject.key,
      title,
      epNumber: fresh.epNumber,
      kind,
      field: 'airAtUtc',
      oldValue: old.air_at_utc,
      newValue: fresh.airAtUtc,
      message:
        `第 ${fresh.epNumber} 话${verb}：` +
        `${formatShortInZone(old.air_at_utc, 'jst')} → ${formatShortInZone(fresh.airAtUtc, 'jst')}（JST）` +
        `，相差 ${humanDayDiff(diffMs)}`,
    });
  }

  // 新增分集：聚合成最多 maxAddedPerSubject 条，避免「排期逐步公布」刷屏
  const existingNumbers = new Set(existing.map((row) => row.ep_number));
  const added = subject.episodes
    .filter((episode) => !existingNumbers.has(episode.epNumber) && episode.airAtUtc)
    .sort((a, b) => a.epNumber - b.epNumber);

  if (added.length > 0 && maxAddedPerSubject > 0) {
    const first = added[0];
    const last = added[added.length - 1];
    const range =
      added.length === 1
        ? `第 ${first?.epNumber} 话`
        : `第 ${first?.epNumber}~${last?.epNumber} 话（共 ${added.length} 集）`;
    changes.push({
      subjectKey: subject.key,
      title,
      epNumber: first?.epNumber ?? null,
      kind: 'episode-added',
      field: 'episodeAdded',
      oldValue: null,
      newValue: last?.airAtUtc ?? null,
      message: `新增排期：${range}，最早 ${first?.airAtUtc ? formatShortInZone(first.airAtUtc, 'jst') : '未知'}（JST）`,
    });
  }

  return changes;
}

/** 集数变化检测（Subject 级别的字段）。 */
export function detectTotalEpsChange(db: DatabaseSync, subject: Subject): DetectedChange | null {  const row = db.prepare('SELECT total_eps FROM subject WHERE key = ?').get(subject.key) as
    | { total_eps: number | null }
    | undefined;
  if (!row) return null;

  const oldValue = row.total_eps;
  const newValue = subject.totalEps ?? null;
  if (oldValue === newValue) return null;
  // 从「未知」到「已知」不算改档，那只是数据补全了
  if (oldValue === null && newValue !== null) return null;
  if (oldValue !== null && newValue === null) return null;

  const title = subject.titleCn ?? subject.titleOriginal ?? subject.key;
  return {
    subjectKey: subject.key,
    title,
    epNumber: null,
    kind: 'total-eps-changed',
    field: 'totalEps',
    oldValue: oldValue === null ? null : String(oldValue),
    newValue: newValue === null ? null : String(newValue),
    message: `总集数由 ${oldValue} 变为 ${newValue}`,
  };
}

/**
 * 把 change_log 里的一条记录还原成人话。
 *
 * 数据库里只存了 kind + old/new，展示层不该各自重写一遍措辞 —— 所以放在这里共用。
 */
export function describeChangeItem(item: {
  kind: string | null;
  epNumber: number | null;
  oldValue: string | null;
  newValue: string | null;
}): string {
  const { kind, epNumber, oldValue, newValue } = item;
  const ep = epNumber === null ? '' : `第 ${epNumber} 话`;

  switch (kind) {
    case 'delayed':
    case 'advanced': {
      if (!oldValue || !newValue) return `${ep} 的放送时刻发生变化`;
      const verb = kind === 'delayed' ? '延期' : '提前';
      const diffMs = Date.parse(newValue) - Date.parse(oldValue);
      const days = Math.abs(diffMs) / 86_400_000;
      const amount = days >= 1 ? `${days % 1 === 0 ? days : days.toFixed(1)} 天` : `${(Math.abs(diffMs) / 3_600_000).toFixed(1)} 小时`;
      return `${ep} ${verb}：${formatShortInZone(oldValue, 'jst')} → ${formatShortInZone(newValue, 'jst')}（JST），相差 ${amount}`;
    }
    case 'episode-removed':
      return `${ep} 的放送时刻从数据源中消失`;
    case 'episode-added':
      return `${ep} 起出现新的排期${newValue ? `（最晚 ${formatShortInZone(newValue, 'jst')} JST）` : ''}`;
    case 'total-eps-changed':
      return `总集数由 ${oldValue ?? '未知'} 变为 ${newValue ?? '未知'}`;
    default:
      return `${ep} 发生变化`;
  }
}

/** kind → 中文标签，未知种类也给出兜底文案。 */
export function changeKindLabel(kind: string | null): string {
  if (kind && kind in CHANGE_KIND_LABELS) return CHANGE_KIND_LABELS[kind as ChangeKind];
  return '变更';
}
