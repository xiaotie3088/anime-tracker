/**
 * 命令行入口。
 *
 *   node src/server/cli.ts season                 当季新番清单（只读，不落库）
 *   node src/server/cli.ts season --season=2026-10
 *   node src/server/cli.ts sync                   当季清单抓取并写入数据库
 *   node src/server/cli.ts search "药屋少女"       搜索任意番剧（补番库靠它加老番）
 *   node src/server/cli.ts add "药屋少女"          搜索并加入追番
 *   node src/server/cli.ts add "某老番" --backlog  搜索并放进补番库
 *   node src/server/cli.ts list [--category=backlog]
 *   node src/server/cli.ts week [--rule=broadcast-calendar]
 *   node src/server/cli.ts archive                手动触发季度自动归档
 *   node src/server/cli.ts stats
 *
 * 目前只有 AniList 一个 Provider（Phase 1 会补上 bangumi-data / Bangumi / B站）。
 * 所以本阶段的能力边界很明确：**能列出番、能搜索、能加追番，但中文标题和国内平台还缺。**
 */

import { groupByDayJst, padWindow } from '../core/calendar.ts';
import type { DayRule } from '../core/calendar.ts';
import {
  countdown,
  estimateWatchDuration,
  formatInZoneLabeled,
  formatShortInZone,
  jstWeekRange,
  seasonFromId,
  seasonOf,
} from '../core/time.ts';
import type { SeasonInfo } from '../core/time.ts';
import { remainingEpisodes, SOURCE_LABELS, TRACK_CATEGORY_LABELS } from '../core/types.ts';
import type { SourceId, Subject, TrackCategory } from '../core/types.ts';
import { anilistProvider } from '../providers/anilist.ts';
import { mergeSubjects } from '../core/merge.ts';
import {
  acknowledgeChanges,
  addMyAnime,
  autoArchiveFinished,
  availableSeasons,
  BACKUP_DIR,
  clearChanges,
  clearFetchedData,
  clearMyAnime,
  countMachineTitles,
  findSubjectByExternalId,
  getMyAnime,
  listBackups,
  listChanges,
  listMyAnime,
  listSchedule,
  migrate,
  openDb,
  searchLocalSubjects,
  stats,
  upsertSubjects,
} from './db.ts';
import { changeKindLabel, describeChangeItem } from './changes.ts';
import { fetchSeason, runFullUpdate, syncArchive, syncSeason, translateMissingTitles } from './sync.ts';
import type { ArchiveSyncResult, ProviderReport } from './sync.ts';


// ---------------------------------------------------------------------------
// 终端表格（中文按 2 列宽计算，否则表格会歪）
// ---------------------------------------------------------------------------

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

function truncateWidth(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const char of text) {
    const w = displayWidth(char);
    if (width + w > max - 1) break;
    out += char;
    width += w;
  }
  return `${out}…`;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  );
  const renderRow = (cells: string[]) =>
    cells.map((cell, index) => pad(cell ?? '', widths[index] ?? 0)).join('  ');
  console.log(renderRow(headers));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(renderRow(row));
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
};

function parseArgv(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) flags.set(arg.slice(2), true);
      else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      positional.push(arg);
    }
  }
  const [command = 'help', ...rest] = positional;
  return { command, positional: rest, flags };
}

function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// 输出格式化（抓取与融合逻辑在 sync.ts，CLI 与 Web 共用）
// ---------------------------------------------------------------------------

function printProviderReports(reports: readonly ProviderReport[]): void {
  for (const report of reports) {
    const label = SOURCE_LABELS[report.provider];
    if (report.ok) {
      console.log(`  ✓ ${label}：${report.items} 部（${report.elapsedMs}ms）`);
    } else {
      console.log(`  ✗ ${label}：失败 —— ${report.error?.split('\n')[0] ?? '未知错误'}`);
    }
  }
}

function subjectRow(subject: Subject): string[] {
  const title = subject.titleCn ?? '';
  const original = subject.titleOriginal ?? subject.titleEn ?? '—';
  const weekday =
    subject.broadcastWeekdayJst === undefined
      ? '—'
      : `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][subject.broadcastWeekdayJst]} ${subject.broadcastTimeJst ?? ''}`.trim();
  const platforms = subject.platforms.map((p) => p.name).filter((name, i, all) => all.indexOf(name) === i);
  return [
    truncateWidth(title, 26) || '（无中文名）',
    truncateWidth(original, 30),
    subject.mediaType,
    subject.totalEps === undefined ? '—' : String(subject.totalEps),
    weekday,
    platforms.join('/') || '—',
    subject.firstAirAtUtc ? formatShortInZone(subject.firstAirAtUtc, 'jst') : '—',
  ];
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

async function cmdSeason(args: ParsedArgs): Promise<void> {
  const seasonId = flagString(args, 'season');
  const season = seasonId ? seasonFromId(seasonId) : seasonOf(new Date());

  console.log(`\x1b[1m${season.label}（${season.id}）\x1b[0m  抓取中…\n`);
  const outcome = await fetchSeason(season);
  printProviderReports(outcome.reports);

  if (outcome.subjects.length === 0) {
    console.log('\n没有抓到任何番剧 —— 先检查网络，或运行 node scripts/probe-sources.ts 定位问题。');
    return;
  }

  console.log('');
  printTable(
    ['中文名', '原名', '类型', '集数', '放送', '平台', '首播(JST)'],
    outcome.subjects.map(subjectRow),
  );
  console.log(`\n共 ${outcome.subjects.length} 部。`);
  if (outcome.singleSourceCount > 0) {
    console.log(
      `\x1b[33m其中 ${outcome.singleSourceCount} 部只有单一数据源覆盖 —— 这些条目没有中文名，` +
        `是接入 Bangumi API 后会改善的部分（当前该域名在本机被 DNS 污染，需代理）。\x1b[0m`,
    );
  }
  console.log('\n提示：这只是预览，没有写入数据库。要落库请运行 sync。');
}

async function cmdSync(args: ParsedArgs): Promise<void> {
  const seasonId = flagString(args, 'season');
  const seasonsFlag = flagString(args, 'seasons');
  const backfillFlag = flagString(args, 'backfill');
  const force = args.flags.has('force');

  const db = openDb();
  migrate(db);

  // 支持一次回填多个季度：--seasons=2026-04,2026-07 或 --backfill=4
  if (seasonsFlag || backfillFlag) {
    if (seasonsFlag) {
      const ids = seasonsFlag
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        console.log('--seasons 是空的，示例：--seasons=2026-04,2026-07');
        db.close();
        return;
      }
      const sorted = [...ids].sort();
      const fromSeason = sorted[0] as string;
      const toSeason = sorted[sorted.length - 1] as string;
      console.log(`\x1b[1m回填历史季度\x1b[0m ${fromSeason} ~ ${toSeason}${force ? '（强制重抓）' : '（增量）'}\n`);
      const result = await syncArchive(db, { fromSeason, toSeason, force, intervalMs: 1_000 });
      printArchiveResult(result);
      db.close();
      return;
    }

    const backfill = Number(backfillFlag);
    const count = Number.isFinite(backfill) && backfill > 0 ? Math.floor(backfill) : 4;
    const toSeason = seasonId ?? seasonOf(new Date()).id;
    console.log(
      `\x1b[1m回填历史季度\x1b[0m 最近 ${count} 个季度（到 ${toSeason}）${force ? '（强制重抓）' : '（增量）'}\n`,
    );
    const result = await syncArchive(db, { toSeason, backfill: count, force, intervalMs: 1_000 });
    printArchiveResult(result);
    db.close();
    return;
  }

  const season = seasonId ? seasonFromId(seasonId) : seasonOf(new Date());

  console.log(`\x1b[1m${season.label}（${season.id}）\x1b[0m  同步中…\n`);
  const result = await syncSeason(db, season);
  printProviderReports(result.outcome.reports);

  if (result.written === 0) {
    console.log('\n没有数据可写入。');
    db.close();
    return;
  }

  const { archive } = result;
  console.log(`\n写入 ${result.written} 部番剧与 ${result.episodeCount} 条分集。`);
  printMoved(archive);
  const summary = stats(db);
  console.log(
    `当前：番剧 ${summary.subjects} · 分集 ${summary.episodes} · 追番 ${summary.tracking} · 补番 ${summary.backlog}`,
  );
  db.close();
}

/** 打印被自动归档移动的番 —— 只印内部 key 用户看不懂。 */
function printMoved(archive: { moved: Array<{ key: string; title: string; to: 'backlog' | 'finished' }> }): void {
  const toBacklog = archive.moved.filter((item) => item.to === 'backlog');
  const toFinished = archive.moved.filter((item) => item.to === 'finished');
  if (toBacklog.length > 0) {
    console.log(`\n自动移入补番库（播完了但没看完）${toBacklog.length} 部：`);
    for (const item of toBacklog) console.log(`  → ${item.title}   \x1b[2m${item.key}\x1b[0m`);
  }
  if (toFinished.length > 0) {
    console.log(`\n自动标记已看完 ${toFinished.length} 部：`);
    for (const item of toFinished) console.log(`  → ${item.title}   \x1b[2m${item.key}\x1b[0m`);
  }
}

function printArchiveResult(result: ArchiveSyncResult): void {
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of result.seasons) {
    const note = item.note ? `  \x1b[2m${item.note}\x1b[0m` : '';
    const error = item.error ? `  \x1b[31m${item.error}\x1b[0m` : '';
    switch (item.status) {
      case 'fetched':
        fetched += 1;
        console.log(
          `  \x1b[32m✓\x1b[0m ${item.season}  写入 ${item.written} 部 / ${item.episodeCount} 集`,
        );
        break;
      case 'skipped':
        skipped += 1;
        console.log(`  \x1b[2m·\x1b[0m ${item.season}  跳过${note}`);
        break;
      case 'empty':
        console.log(`  \x1b[33m!\x1b[0m ${item.season}  源站没有这个季度的数据${note}`);
        break;
      default:
        failed += 1;
        console.log(`  \x1b[31m✗\x1b[0m ${item.season}  失败${note}${error}`);
    }
  }
  console.log(
    `\n回填完成：抓取 ${fetched} 季、跳过 ${skipped} 季${failed ? `、失败 ${failed} 季` : ''}` +
      `，共写入 ${result.totalWritten} 部 / ${result.totalEpisodes} 集。`,
  );
  console.log('提示：历史季度一旦落库就会一直保留，之后的同步不会删除它们。');
}

/**
 * 一键更新数据：当季抓取 + 历史季度回填 + 官方名替换机翻 + 缺中文名的机翻。
 * 与 Web 界面的「更新数据」按钮走的是同一条链路（runFullUpdate）。
 */
async function cmdUpdate(args: ParsedArgs): Promise<void> {
  const seasonId = flagString(args, 'season');
  const season = seasonId ? seasonFromId(seasonId) : seasonOf(new Date());
  const backfillFlag = Number(flagString(args, 'backfill') ?? 3);
  const backfill = Number.isFinite(backfillFlag) ? Math.max(0, Math.floor(backfillFlag)) : 3;
  const mustTranslate = args.flags.has('translate');
  const noTranslate = args.flags.has('no-translate');
  const translate = mustTranslate || !noTranslate;
  const limitFlag = Number(flagString(args, 'limit') ?? 0);
  const limit = Number.isFinite(limitFlag) ? Math.max(0, Math.floor(limitFlag)) : 0;

  const db = openDb();
  migrate(db);

  console.log(`\x1b[1m一键更新数据\x1b[0m  ${season.label}（${season.id}）`);
  console.log(
    `回填最近 ${backfill} 个季度${args.flags.has('force') ? '（强制重抓）' : '（增量）'}，` +
      `${translate ? `机翻${limit > 0 ? ` 上限 ${limit} 条` : '（不限条数）'}` : '不做机翻'}\n`,
  );

  const result = await runFullUpdate(db, {
    season,
    backfill,
    force: args.flags.has('force'),
    translate,
    translateLimit: limit,
    onProgress: (message) => console.log(`  \x1b[2m${message}\x1b[0m`),
  });

  console.log('');
  printProviderReports(result.current.reports);
  console.log(
    `\n当季写入 ${result.current.written} 部 / ${result.current.episodeCount} 集` +
      (result.current.changes.length ? `，检测到 ${result.current.changes.length} 条改档` : ''),
  );
  printMoved(result.current.archive);
  if (backfill > 0) {
    console.log('');
    printArchiveResult(result.archive);
  }
  if (result.healed.replaced > 0) {
    console.log(`\n官方中文名替换掉临时机翻名：${result.healed.replaced} 部`);
  }
  if (translate) {
    console.log(
      `临时机翻补齐中文名：${result.translated.translated.length} 部` +
        (result.translated.skipped ? `（跳过 ${result.translated.skipped} 部：不需要翻的类型）` : '') +
        (result.translated.failed.length ? `；\x1b[31m失败 ${result.translated.failed.length} 部\x1b[0m` : ''),
    );
    for (const item of result.translated.translated) {
      console.log(`  ${pad(truncateWidth(item.titleOriginal, 34), 36)} → ${item.titleCn}  \x1b[2m[${item.engine}]\x1b[0m`);
    }
    for (const item of result.translated.failed.slice(0, 10)) {
      console.log(`  \x1b[31m✗\x1b[0m ${truncateWidth(item.titleOriginal || item.key, 40)}：${item.error}`);
    }
  }
  if (result.backup) {
    console.log(`\n更新前已自动备份：${result.backup.path}`);
  }

  const summary = stats(db);
  console.log(
    `\n\x1b[1m汇总\x1b[0m：写入 ${result.summary.written} 部 / ${result.summary.episodes} 集 · ` +
      `官方名替换 ${result.summary.officialReplaced} · 机翻补齐 ${result.summary.machineFilled} · ` +
      `移入补番库 ${result.summary.movedToBacklog} · 改档 ${result.summary.changeCount}`,
  );
  console.log(
    `当前：番剧 ${summary.subjects} · 分集 ${summary.episodes} · 追番 ${summary.tracking} · 补番 ${summary.backlog}` +
      ` · 临时机翻名 ${countMachineTitles(db)} 部`,
  );
  db.close();
}

/** 只补中文名（机翻），不动其它数据。 */
async function cmdTranslate(args: ParsedArgs): Promise<void> {
  const seasonFlag = flagString(args, 'season');
  const all = args.flags.has('all');
  const season = all ? null : seasonFlag ? seasonFromId(seasonFlag).id : seasonOf(new Date()).id;
  const limitFlag = Number(flagString(args, 'limit') ?? 0);
  const limit = Number.isFinite(limitFlag) ? Math.max(0, Math.floor(limitFlag)) : 0;

  const db = openDb();
  migrate(db);

  console.log(`为缺中文名的番做临时机翻（范围：${season ?? '全库'}）…\n`);
  const result = await translateMissingTitles(db, {
    season,
    limit,
    onProgress: (done, total, title) => {
      if (done % 5 === 0 || done === total) console.log(`  \x1b[2m${done}/${total}\x1b[0m ${truncateWidth(title, 40)}`);
    },
  });

  console.log(
    `\n机翻完成：成功 ${result.translated.length} 部，跳过 ${result.skipped} 部（不需要翻的类型），失败 ${result.failed.length} 部。`,
  );
  for (const item of result.translated) {
    console.log(`  ${pad(truncateWidth(item.titleOriginal, 34), 36)} → ${item.titleCn}  \x1b[2m[${item.engine}]\x1b[0m`);
  }
  for (const item of result.failed) {
    console.log(`  \x1b[31m✗\x1b[0m ${truncateWidth(item.titleOriginal || item.key, 40)}：${item.error}`);
  }
  console.log(
    `\n这些是\x1b[33m临时\x1b[0m译名：官方译名一出现，运行 update 就会被自动替换（库里标记为 machine）。` +
      `\n当前库里临时机翻名共 ${countMachineTitles(db)} 部。`,
  );
  db.close();
}

/** 列出备份与库里的季度（用户数据安全性的可见化）。 */
function cmdBackups(): void {
  const items = listBackups();
  if (items.length === 0) {
    console.log('还没有备份。启动服务或运行 sync / update 时会自动备份。');
    return;
  }
  const db = openDb();
  migrate(db);
  console.log('数据库备份（新的在前）：\n');
  printTable(
    ['备份文件', '大小(KB)', '时间'],
    items.map((item) => [item.name, String(Math.round(item.bytes / 1024)), item.at.slice(0, 19).replace('T', ' ')]),
  );
  console.log(`\n备份目录：${BACKUP_DIR}`);
  console.log(`库里的季度：${availableSeasons(db).join('、') || '（空）'}`);
  console.log(`临时机翻名：${countMachineTitles(db)} 部`);
  db.close();
}

async function cmdSearch(args: ParsedArgs): Promise<void> {
  const keyword = args.positional.join(' ').trim();
  if (!keyword) {
    console.log('用法：node src/server/cli.ts search "番剧名" [--local]');
    return;
  }

  const db = openDb();
  migrate(db);

  // 先搜本地库：这里能按中文名/别名命中，是补番库最好用的入口
  const local = searchLocalSubjects(db, keyword, 15);
  if (local.length > 0) {
    console.log(`\x1b[1m本地库命中 ${local.length} 条\x1b[0m（中文名/原名/别名都参与匹配）\n`);
    printTable(
      ['中文名', '原名', '集数', '状态', '季度', 'key'],
      local.map((item) => [
        truncateWidth(item.titleCn ?? '—', 24),
        truncateWidth(item.titleOriginal ?? '—', 28),
        item.totalEps === null ? '—' : String(item.totalEps),
        item.status,
        item.season ?? '—',
        item.key,
      ]),
    );
    console.log('\n用 add 添加时若命中本地条目，会自动复用它（保留中文名与分集时刻）。\n');
  }

  if (args.flags.has('local')) {
    if (local.length === 0) console.log('本地库没有匹配项。');
    db.close();
    return;
  }

  const provider = anilistProvider;
  if (!provider.search) {
    console.log('当前 Provider 不支持搜索。');
    db.close();
    return;
  }

  console.log(`远程搜索「${keyword}」…\n`);
  const results = await provider.search(keyword, { limit: 15 });
  if (results.length === 0) {
    console.log('没有结果。');
    db.close();
    return;
  }

  console.log(
    '注意：AniList 没有中文标题，所以这里搜的是日文原名/英文名。\n' +
      '接入 Bangumi 之后可以直接用中文名搜索，这也是补番库用起来顺不顺手的关键。\n',
  );
  printTable(
    ['原名', '英文名', '类型', '集数', '状态', 'ID'],
    results.map((item) => [
      truncateWidth(item.titleOriginal ?? '—', 34),
      truncateWidth(item.titleEn ?? '—', 26),
      item.mediaType,
      item.totalEps === undefined ? '—' : String(item.totalEps),
      item.status,
      String(item.anilistId ?? item.sourceId),
    ]),
  );
  db.close();
}

async function cmdAdd(args: ParsedArgs): Promise<void> {
  const keyword = args.positional.filter((p) => !p.startsWith('--')).join(' ').trim();
  if (!keyword) {
    console.log('用法：node src/server/cli.ts add "番剧名" [--backlog] [--index=0] [--watched=0]');
    return;
  }

  const provider = anilistProvider;
  if (!provider.search) {
    console.log('当前 Provider 不支持搜索。');
    return;
  }

  const results = await provider.search(keyword, { limit: 10 });
  if (results.length === 0) {
    console.log(`没搜到「${keyword}」。`);
    return;
  }

  const index = Number(flagString(args, 'index') ?? 0);
  const chosen = results[index];
  if (!chosen) {
    console.log(`--index=${index} 超出范围（共 ${results.length} 条）。`);
    return;
  }

  const category: TrackCategory = args.flags.has('backlog') ? 'backlog' : 'tracking';
  const watched = Number(flagString(args, 'watched') ?? 0);
  const watchedEps = Number.isFinite(watched) ? watched : 0;

  const db = openDb();
  migrate(db);

  // 关键：先查库里有没有同一部番。
  // 季度同步落库的是多源融合后的「富记录」（有中文名、有分集时刻），
  // 如果直接写入搜索结果的单源记录，同一部番就会变成两份。
  const existing = findSubjectByExternalId(db, {
    bgmId: chosen.bgmId,
    anilistId: chosen.anilistId,
    malId: chosen.malId,
  });

  if (existing) {
    addMyAnime(db, existing.key, { category, watchedEps });
    console.log(`\n已加入「${TRACK_CATEGORY_LABELS[category]}」：${existing.titleCn ?? existing.titleOriginal ?? existing.key}`);
    console.log('（复用了季度同步已落库的条目，因此保留了中文名与分集时刻）');
    reportBacklog(db, existing.key, category, watchedEps);
    db.close();
    return;
  }

  const merged = mergeSubjects([[chosen]]);
  const subject = merged.subjects[0];
  if (!subject) {
    console.log('融合结果为空，放弃。');
    db.close();
    return;
  }

  upsertSubjects(db, [subject], null);
  addMyAnime(db, subject.key, { category, watchedEps });

  console.log(`\n已加入「${TRACK_CATEGORY_LABELS[category]}」：${subject.titleCn ?? subject.titleOriginal ?? subject.key}`);
  console.log('（本地库中原本没有这部番，已单独写入；因此可能缺中文名 —— 接上 Bangumi 后会补全）');
  reportBacklog(db, subject.key, category, watchedEps);

  if (results.length > 1) {
    console.log(`\n（共 ${results.length} 条结果，若选错了可加 --index=N 重试）`);
    printTable(
      ['#', '原名', '集数', '状态'],
      results.slice(0, 10).map((item, i) => [
        String(i),
        truncateWidth(item.titleOriginal ?? item.titleEn ?? '—', 40),
        item.totalEps === undefined ? '—' : String(item.totalEps),
        item.status,
      ]),
    );
  }
  db.close();
}

/** 加入补番库时顺手告诉你「还剩多少」—— 这是补番库最核心的信息。 */
function reportBacklog(db: ReturnType<typeof openDb>, subjectKey: string, category: TrackCategory, watchedEps: number): void {
  if (category !== 'backlog') return;
  const item = getMyAnime(db, subjectKey);
  const remaining = remainingEpisodes(item?.totalEps ?? undefined, watchedEps);
  console.log(
    remaining === undefined
      ? '剩余集数：未知（总集数缺失，UI 会显示「集数未知」而不是 0）'
      : `剩余 ${remaining} 集，约 ${estimateWatchDuration(remaining, item?.durationMin ?? 24)}`,
  );
}

function cmdList(args: ParsedArgs): void {
  const categoryFlag = flagString(args, 'category');
  const category = categoryFlag as TrackCategory | undefined;

  const db = openDb();
  migrate(db);
  const items = listMyAnime(db, category);
  if (items.length === 0) {
    console.log('列表为空。用 node src/server/cli.ts add "番剧名" 添加。');
    db.close();
    return;
  }

  printTable(
    ['分类', '中文名', '原名', '进度', '剩余', '状态'],
    items.map((item) => {
      const remaining = remainingEpisodes(item.totalEps ?? undefined, item.watchedEps);
      return [
        TRACK_CATEGORY_LABELS[item.category],
        truncateWidth(item.titleCn ?? '—', 24),
        truncateWidth(item.titleOriginal ?? '—', 28),
        item.totalEps ? `${item.watchedEps}/${item.totalEps}` : String(item.watchedEps),
        remaining === undefined ? '未知' : String(remaining),
        item.status,
      ];
    }),
  );
  db.close();
}

function cmdWeek(args: ParsedArgs): void {
  const rule = (flagString(args, 'rule') ?? 'clock') as DayRule;
  const db = openDb();
  migrate(db);

  const week = jstWeekRange(new Date());
  const padded = padWindow(week.startUtc, week.endUtc);
  const rows = listSchedule(db, padded.startUtc, padded.endUtc, { category: 'tracking' });

  console.log(
    `\x1b[1m本周更新\x1b[0m  ${week.startDateJst} ~ ${week.endDateJst}（JST）  归属口径：${
      rule === 'clock' ? '真实钟点' : '日本放送日历'
    }\n`,
  );

  const buckets = groupByDayJst(rows, rule).filter(
    (bucket) => bucket.dateJst >= week.startDateJst && bucket.dateJst <= week.endDateJst,
  );

  if (buckets.length === 0) {
    console.log('这一周没有你追的番更新。');
    db.close();
    return;
  }

  for (const bucket of buckets) {
    console.log(`\x1b[1m${bucket.weekdayLabel} ${bucket.dateJst}\x1b[0m`);
    for (const item of bucket.items) {
      const title = item.titleCn ?? item.titleOriginal ?? item.subjectKey;
      const air = item.airAtUtc ? formatInZoneLabeled(item.airAtUtc, 'jst') : '时刻未知';
      const timer = item.airAtUtc ? countdown(item.airAtUtc).text : '';
      const flags = [item.isOverridden ? '手动修正' : '', item.conflicting ? '源有分歧' : ''].filter(Boolean);
      console.log(
        `  ${pad(truncateWidth(title, 24), 26)} 第 ${pad(String(item.epNumber), 3)} 话  ${pad(air, 18)} ${pad(timer, 14)} ${
          flags.length > 0 ? `\x1b[33m[${flags.join('/')}]\x1b[0m` : ''
        }`,
      );
    }
    console.log('');
  }
  db.close();
}

function cmdArchive(): void {
  const db = openDb();
  migrate(db);
  const result = autoArchiveFinished(db);
  console.log(`自动归档完成：${result.toBacklog.length} 部进入补番库，${result.toFinished.length} 部标记为已看完。`);
  for (const item of result.moved) {
    console.log(`  → ${item.to === 'backlog' ? '补番库' : '已看完'}  ${item.title}   \x1b[2m${item.key}\x1b[0m`);
  }
  db.close();
}

function cmdChanges(args: ParsedArgs): void {
  const db = openDb();
  migrate(db);

  const onlyUnacknowledged = !args.flags.has('all');
  const changes = listChanges(db, 200, onlyUnacknowledged);

  if (args.flags.has('ack')) {
    const count = acknowledgeChanges(db, changes.map((change) => change.id));
    console.log(`已确认 ${count} 条变更。`);
    db.close();
    return;
  }

  if (changes.length === 0) {
    console.log(
      onlyUnacknowledged
        ? '没有待处理的变更。（延期/改档是在每次 sync 时通过对比历史数据发现的）'
        : '还没有任何变更记录。',
    );
    db.close();
    return;
  }

  console.log(
    `\x1b[1m${onlyUnacknowledged ? '待处理的' : '全部'}变更：${changes.length} 条\x1b[0m` +
      `${onlyUnacknowledged ? '（加 --all 看全部，加 --ack 标记已读）' : ''}\n`,
  );

  printTable(
    ['发现时间', '种类', '番剧', '说明'],
    changes.map((change) => [
      change.detectedAt.slice(5, 16).replace('T', ' '),
      changeKindLabel(change.kind),
      truncateWidth(change.title ?? change.subjectKey, 26),
      truncateWidth(describeChangeItem(change), 70),
    ]),
  );

  db.close();
}

function cmdReset(args: ParsedArgs): void {
  const db = openDb();
  migrate(db);

  if (args.flags.has('all')) {
    const result = clearFetchedData(db);
    console.log(`已清空全部抓取数据（原有 ${result.subjects} 部番剧）与追番列表。`);
    console.log('下次运行 sync 会重新抓取当季。');
    db.close();
    return;
  }

  if (args.flags.has('changes')) {
    console.log(`已清空 ${clearChanges(db)} 条变更记录。`);
    db.close();
    return;
  }

  const removed = clearMyAnime(db);
  console.log(`已清空追番列表（${removed} 条）。番剧数据保留，可随时重新加入。`);
  console.log('如需连番剧数据一起清空：node src/server/cli.ts reset --all');
  db.close();
}

function cmdStats(): void {
  const db = openDb();
  migrate(db);
  const summary = stats(db);
  console.log('数据库统计：');
  for (const [key, value] of Object.entries(summary)) console.log(`  ${pad(key, 16)} ${value}`);
  db.close();
}

function cmdHelp(): void {
  console.log(`新番追番日历 · CLI

  season [--season=2026-10]     当季新番清单（预览，不落库）
  sync   [--season=2026-10]     抓取当季并写入数据库（含季度自动归档）
         --backfill=4           顺便增量回填最近 4 个季度
         --seasons=2026-04,2026-07  只回填指定季度
         --force                已有数据的季度也重抓
  update [--season=2026-10]     一键更新数据（当季 + 历史回填 + 机翻 + 汇总报告）
         --backfill=3           回填几个季度（含当季，默认 3）
         --no-translate         跳过机翻阶段（更快）
         --limit=20             机翻条数上限
  translate [--season=2026-10 | --all] [--limit=N]
                                只给缺中文名的番做临时机翻（官方名一到会被自动替换）
  search <关键词>               搜索番剧（补番库加老番用）
  add <关键词> [--backlog] [--index=N] [--watched=N]
                                搜索并加入追番；--backlog 放进补番库
  list [--category=backlog]     查看我的追番 / 补番库
  week [--rule=broadcast-calendar]
                                本周更新日历（默认按真实钟点归属）
  changes [--all] [--ack]       延期/改档检测结果；--ack 标记已读
  backups                       查看数据库备份与库里的季度（追番列表是资产，必须有备份）
  reset [--all | --changes]     清空我的追番列表；--all 连番剧数据一起清空
  archive                       手动触发「播完没看完 -> 补番库」
  stats                          数据库统计

  「更新数据」与界面右上角的按钮是同一条链路：写库前会自动备份到 data/backups/。

离线自检（不需要联网、不需要装包）：
  node scripts/verify.ts

数据源探测（Phase 0，需要联网）：
  node scripts/probe-sources.ts
`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgv(process.argv.slice(2));

  switch (args.command) {
    case 'season':
      await cmdSeason(args);
      break;
    case 'sync':
      await cmdSync(args);
      break;
    case 'update':
      await cmdUpdate(args);
      break;
    case 'translate':
      await cmdTranslate(args);
      break;
    case 'search':
      await cmdSearch(args);
      break;
    case 'add':
      await cmdAdd(args);
      break;
    case 'list':
      cmdList(args);
      break;
    case 'week':
      cmdWeek(args);
      break;
    case 'archive':
      cmdArchive();
      break;
    case 'changes':
      cmdChanges(args);
      break;
    case 'backups':
      cmdBackups();
      break;
    case 'reset':
      cmdReset(args);
      break;
    case 'stats':
      cmdStats();
      break;
    default:
      cmdHelp();
  }
}

await main();
