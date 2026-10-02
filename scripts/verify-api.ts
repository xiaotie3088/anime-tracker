/**
 * 接口自检：用 Node 直接打本机服务，逐个验证 Web 界面依赖的接口。
 *
 *   node src/server/server.ts        # 先在一个终端启动服务
 *   node scripts/verify-api.ts       # 另一个终端跑这个
 *
 * 为什么需要它：界面出问题时，第一步要能分清是「接口没数据」还是「前端渲染错」。
 * 覆盖静态资源与目录穿越防护、同步、总览、追番动作、周视图两种口径、
 * 搜索与导入、.ics 导出（含 RFC 换行与 75 字节折行校验）。
 *
 * 注意：其中的「同步」一项会真实请求源站。
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

// 接口响应的最小类型：只声明断言脚本用到的字段，
// 这样「接口悄悄改了结构」会被断言直接抓到。
type ProviderReport = { provider: string; ok: boolean; items: number; elapsedMs: number; error?: string };
type SyncResponse = {
  written: number;
  episodeCount: number;
  mergedAway: number;
  singleSourceCount: number;
  reports: ProviderReport[];
  changes: { kind: string; message: string }[];
};
type OverviewSubject = {
  key: string;
  titleCn: string | null;
  titleCnSource: string;
  titleOriginal: string | null;
  broadcastWeekdayJst: number | null;
  broadcastTimeJst: string | null;
  episodeCount: number;
  totalEps: number | null;
  status: string;
};type OverviewResponse = {
  season: { id: string; label: string };
  seasons?: string[];
  sort?: string;
  availableSeasons: string[];
  seasonSummaries: { season: string; subjects: number; episodes: number; updatedAt: string | null }[];
  totals: {
    all: number;
    tracking: number;
    backlog: number;
    upcoming: number;
    withoutChineseTitle: number;
    machineTranslatedTitle: number;
  };
  byWeekday: { weekday: number; count: number }[];
  byPlatform: { key: string; count: number }[];
  subjects: OverviewSubject[];
};
type DetailResponse = {
  subject: { key: string; episodes: unknown[]; my: { category: string; watchedEps: number } | null };
};
type MyResponse = { groups: Record<string, { remaining: number | null }[]> };
type WeekResponse = {
  rule: string;
  offset: number;
  week: { startDateJst: string; endDateJst: string };
  days: { items: unknown[] }[];
  upcoming: unknown[];
};
type SearchResponse = { local: { titleOriginal: string | null }[]; remote: { raw: unknown }[]; remoteError?: string };
type ImportResponse = { subjectKey: string; reused: boolean; title?: string; season?: string | null };
type UpdateResponse = {
  summary: {
    written: number;
    episodes: number;
    officialReplaced: number;
    machineFilled: number;
    movedToBacklog: number;
    changeCount: number;
    failedProviders: string[];
    translationFailures: number;
  };
  current: { written: number; episodeCount: number; moved: unknown[]; reports: ProviderReport[] };
  archive: { seasons: { season: string; status: string; written: number }[]; totalWritten: number; totalEpisodes: number };
  healed: { replaced: number; kept: number };
  translated: { count: number; skipped: number; titles: unknown[]; failed: unknown[] };
  backup: { path: string; bytes: number } | null;
};
type TranslateResponse = {
  translatedCount: number;
  skipped: number;
  candidates: number;
  translated: { key: string; titleOriginal: string; titleCn: string; engine: string }[];
  failed: { key: string; error: string }[];
  remaining: number;
};
type ExportResponse = {
  exportedAt: string;
  counts: { myAnime: number; overrides: number; changes: number };
  myAnime: { subjectKey: string; title: string | null; category: string; watchedEps: number }[];
  overrides: unknown[];
  changes: unknown[];
};

let pass = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.log(`  ✗ ${name}\n      ${message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  const text = await response.text();
  assert(response.ok, `HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  assert(response.ok, `HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert(response.ok, `HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

console.log(`接口自检 · ${BASE}\n`);

// ---------------------------------------------------------------------------
console.log('静态资源');
// ---------------------------------------------------------------------------

await check('GET / 返回界面 HTML', async () => {
  const response = await fetch(`${BASE}/`);
  const html = await response.text();
  assert(response.ok, `HTTP ${response.status}`);
  assert(html.includes('新番追番日历'), 'HTML 里没有标题');
  assert(html.includes('/app.js'), 'HTML 没有引用 app.js');
});

await check('GET /app.js 返回 JS', async () => {
  const response = await fetch(`${BASE}/app.js`);
  const text = await response.text();
  assert(response.ok, `HTTP ${response.status}`);
  assert(response.headers.get('content-type')?.includes('javascript') === true, 'content-type 不对');
  assert(text.length > 1000, '内容太短');
});

await check('GET /styles.css 返回 CSS', async () => {
  const response = await fetch(`${BASE}/styles.css`);
  assert(response.ok, `HTTP ${response.status}`);
  assert((await response.text()).includes('.week-grid'), 'CSS 内容不对');
});

await check('目录穿越被拒绝', async () => {
  const response = await fetch(`${BASE}/../package.json`);
  assert(response.status === 403 || response.status === 404, `期望 403/404，实际 ${response.status}`);
});

// ---------------------------------------------------------------------------
console.log('\n基础接口');
// ---------------------------------------------------------------------------

await check('GET /api/health', async () => {
  const data = await getJson<{ ok: boolean }>('/api/health');
  assert(data.ok === true, 'ok 不为 true');
});

// ---------------------------------------------------------------------------
console.log('\n同步（真实打源站）');
// ---------------------------------------------------------------------------

let syncResult: SyncResponse | undefined;
await check('POST /api/sync 抓取当季并落库', async () => {
  syncResult = await postJson<SyncResponse>('/api/sync?season=2026-10');
  assert(syncResult.written > 50, `只写入 ${syncResult.written} 部，太少`);
  assert(syncResult.episodeCount > 100, `只写入 ${syncResult.episodeCount} 条分集，太少`);
  assert(
    syncResult.reports.some((report) => report.ok),
    '没有任何数据源成功',
  );
});

if (syncResult) {
  console.log(
    `      写入 ${syncResult.written} 部 / ${syncResult.episodeCount} 集，` +
      `融合掉 ${syncResult.mergedAway} 条重复，单源条目 ${syncResult.singleSourceCount}`,
  );
  for (const report of syncResult.reports) {
    console.log(`      ${report.ok ? '✓' : '✗'} ${report.provider}: ${report.items} 部 ${report.elapsedMs}ms`);
  }
  if (syncResult.changes.length > 0) {
    console.log(`      检测到 ${syncResult.changes.length} 条变更：`);
    for (const change of syncResult.changes.slice(0, 6)) {
      console.log(`        [${change.kind}] ${change.message}`);
    }
  }
}

/**
 * 这是「会不会报假警」的核心测试：
 * 刚同步完立刻再同步一次，数据源没变，就**不应该**产生任何变更。
 * 如果这里失败，说明有字段在两次抓取之间抖动（源切换、秒级差异、排期补全），
 * 那真实使用中就会天天弹假警报。
 */
await check('连续两次同步，第二次不产生变更（防假警）', async () => {
  const second = await postJson<SyncResponse>('/api/sync?season=2026-10');
  const changes = second.changes ?? [];
  assert(
    changes.length === 0,
    `第二次同步仍报了 ${changes.length} 条变更，说明存在假变更：\n` +
      changes
        .slice(0, 5)
        .map((change) => `        [${change.kind}] ${change.message}`)
        .join('\n'),
  );
});

// ---------------------------------------------------------------------------
console.log('\n变更列表接口');
// ---------------------------------------------------------------------------

await check('GET /api/changes 返回带标签与说明的列表', async () => {
  const data = await getJson<{ changes: { kindLabel: string; message: string }[]; pending: number }>(
    '/api/changes?all=1',
  );
  assert(Array.isArray(data.changes), '缺少 changes');
  assert(typeof data.pending === 'number', '缺少 pending');
  console.log(`      共 ${data.changes.length} 条历史变更，待处理 ${data.pending} 条`);
});

await check('POST /api/changes/ack 能把变更标记为已读', async () => {
  const acknowledged = await postJson<{ acknowledged: number }>('/api/changes/ack', {});
  const after = await getJson<{ changes: unknown[]; pending: number }>('/api/changes');
  assert(after.pending === 0, `确认后仍有 ${after.pending} 条待处理`);
  console.log(`      已确认 ${acknowledged.acknowledged} 条`);
});

// ---------------------------------------------------------------------------
console.log('\n总览接口');
// ---------------------------------------------------------------------------

let overview: OverviewResponse | undefined;
await check('GET /api/overview 返回统计与列表', async () => {
  overview = await getJson<OverviewResponse>('/api/overview?season=2026-10');
  assert(overview.totals.all > 50, `总数只有 ${overview.totals.all}`);
  assert(overview.subjects.length === overview.totals.all, '列表长度与总数不一致');
  assert(overview.byWeekday.length === 7, '星期分布不是 7 项');
  assert(overview.byPlatform.length > 0, '没有平台分布');
});

// ---------------------------------------------------------------------------
console.log('\n历史季度保留（用户诉求 4）');
// ---------------------------------------------------------------------------

await check('GET /api/overview 报告库里有哪些季度与各有多少部', async () => {
  const data = await getJson<OverviewResponse>('/api/overview?season=2026-10');
  assert(Array.isArray(data.availableSeasons), '缺少 availableSeasons');
  assert(data.availableSeasons.includes('2026-10'), 'availableSeasons 里没有当季');
  assert(Array.isArray(data.seasonSummaries), '缺少 seasonSummaries');

  const summary = data.seasonSummaries.find((item) => item.season === '2026-10');
  assert(summary, 'seasonSummaries 里没有 2026-10');
  assert(summary.subjects > 50, `2026-10 只有 ${summary.subjects} 部`);
  assert(summary.episodes > 100, `2026-10 只有 ${summary.episodes} 集`);
  console.log(
    `      库里季度：${data.seasonSummaries
      .map((item) => `${item.season}(${item.subjects}部/${item.episodes}集)`)
      .join(' ')}`,
  );
});

await check('切到另一个季度不会让当季数据消失（同步只 upsert，从不删历史）', async () => {
  const before = await getJson<OverviewResponse>('/api/overview?season=2026-10');
  // 切到一个库里大概率没有的季度：接口必须正常返回，而不是报错或清库
  const other = await getJson<OverviewResponse>('/api/overview?season=2026-07');
  assert(other.season.id === '2026-07', `季度不对：${other.season.id}`);
  assert(Array.isArray(other.subjects), '缺少 subjects');

  const after = await getJson<OverviewResponse>('/api/overview?season=2026-10');
  assert(
    after.totals.all === before.totals.all,
    `当季条目数被改变了：${before.totals.all} -> ${after.totals.all}`,
  );
  console.log(`      2026-07 有 ${other.totals.all} 部；切换后 2026-10 仍是 ${after.totals.all} 部`);
});

if (overview) {
  const withCn = overview.subjects.filter((subject) => subject.titleCn).length;
  const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
  console.log(
    `      共 ${overview.totals.all} 部；有中文名 ${withCn} 部；未开播 ${overview.totals.upcoming}；` +
      `缺中文名 ${overview.totals.withoutChineseTitle}`,
  );
  console.log(
    `      星期分布：${overview.byWeekday.map((row) => `${weekdayNames[row.weekday]}:${row.count}`).join(' ')}`,
  );
  console.log(`      平台：${overview.byPlatform.slice(0, 6).map((row) => `${row.key}=${row.count}`).join(' ')}`);
}

// ---------------------------------------------------------------------------
console.log('\n追番动作');
// ---------------------------------------------------------------------------

let deepNightKey: string | undefined;
await check('挑一部深夜番加入追番', async () => {
  const subjects = overview?.subjects ?? [];
  const target = subjects.find(
    (subject) =>
      subject.broadcastTimeJst !== null &&
      Number(subject.broadcastTimeJst.slice(0, 2)) >= 24 &&
      subject.episodeCount > 0,
  );
  assert(target, '没找到带深夜时刻（24:xx 之后）的番');
  deepNightKey = target.key;

  const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = target.broadcastWeekdayJst === null ? '?' : weekdayNames[target.broadcastWeekdayJst];
  console.log(`      选中：${target.titleCn ?? target.titleOriginal}（${weekday} ${target.broadcastTimeJst}）`);

  await postJson('/api/my', { subjectKey: target.key, category: 'tracking' });
});

await check('GET /api/subject/:key 返回详情', async () => {
  assert(deepNightKey, 'deepNightKey 未设置');
  const { subject } = await getJson<DetailResponse>(`/api/subject/${encodeURIComponent(deepNightKey)}`);
  assert(subject.key === deepNightKey, 'key 不一致');
  assert(subject.episodes.length > 0, '没有分集');
  assert(subject.my?.category === 'tracking', '追番状态没写进去');
});

await check('PATCH /api/my/:key 记录看到第几集', async () => {
  assert(deepNightKey, 'deepNightKey 未设置');
  await patchJson(`/api/my/${encodeURIComponent(deepNightKey)}`, { watchedEps: 2 });
  const { subject } = await getJson<DetailResponse>(`/api/subject/${encodeURIComponent(deepNightKey)}`);
  assert(subject.my?.watchedEps === 2, `进度是 ${subject.my?.watchedEps}，期望 2`);
});

await check('加入补番库并返回剩余集数', async () => {
  const target = (overview?.subjects ?? []).find((subject) => subject.totalEps && subject.status === 'finished');
  if (!target) {
    console.log('      （本季没有已完结的番，跳过）');
    return;
  }
  await postJson('/api/my', { subjectKey: target.key, category: 'backlog' });
  const my = await getJson<MyResponse>('/api/my');
  assert((my.groups.backlog?.length ?? 0) >= 1, '补番库还是空的');
  assert(my.groups.backlog[0]?.remaining !== undefined, '缺剩余集数字段');
});

await check('GET /api/my 四个分类都在', async () => {
  const my = await getJson<MyResponse>('/api/my');
  for (const key of ['tracking', 'backlog', 'finished', 'dropped']) {
    assert(Array.isArray(my.groups[key]), `缺少分类 ${key}`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n周视图');
// ---------------------------------------------------------------------------

await check('GET /api/week 两种口径都能返回', async () => {
  const clock = await getJson<WeekResponse>('/api/week?season=2026-10&rule=clock&offset=0');
  const broadcast = await getJson<WeekResponse>('/api/week?season=2026-10&rule=broadcast-calendar&offset=0');
  assert(clock.days.length === 7, '不是 7 天');
  assert(broadcast.days.length === 7, '不是 7 天');

  const total = (data: WeekResponse) => data.days.reduce((sum, day) => sum + day.items.length, 0);
  console.log(`      本周区间 ${clock.week.startDateJst} ~ ${clock.week.endDateJst}`);
  console.log(`      真实钟点口径 ${total(clock)} 集，放送日历口径 ${total(broadcast)} 集`);
  assert(Array.isArray(clock.upcoming), '缺少 upcoming');
});

await check('周边界：上一周 / 下一周可切换', async () => {
  const previous = await getJson<WeekResponse>('/api/week?season=2026-10&offset=-1');
  const next = await getJson<WeekResponse>('/api/week?season=2026-10&offset=1');
  assert(previous.week.startDateJst !== next.week.startDateJst, '前后周区间相同');
  assert(next.offset === 1, 'offset 没回传');
});

// ---------------------------------------------------------------------------
console.log('\n搜索');
// ---------------------------------------------------------------------------

await check('GET /api/search 本地 + 远程', async () => {
  const data = await getJson<SearchResponse>(`/api/search?q=${encodeURIComponent('药屋')}`);
  assert(Array.isArray(data.local), '缺少 local');
  assert(data.local.length > 0, '本地没搜到「药屋」');
  assert(Array.isArray(data.remote), '缺少 remote');
  console.log(`      本地 ${data.local.length} 条，远程 ${data.remote.length} 条`);
});

await check('POST /api/search/import 能落库且避免重复', async () => {
  const data = await getJson<SearchResponse>(`/api/search?q=${encodeURIComponent('薬屋のひとりごと')}`);
  const first = data.remote[0];
  if (!first) {
    console.log('      （远程无结果，跳过）');
    return;
  }
  const imported = await postJson<ImportResponse>('/api/search/import?season=2026-10', { raw: first.raw });
  assert(imported.subjectKey, '没返回 subjectKey');
  // 季度字段必须**存在**（复用的条目可能确实没有季度，那是真实状态，不能编一个）
  assert(
    'season' in imported,
    '导入响应缺少 season 字段（界面要靠它告诉用户"归到了哪一季"）',
  );
  if (!imported.reused) {
    assert(
      typeof imported.season === 'string' && imported.season !== '',
      `新建条目没有季度归属（season=${imported.season}）—— 它会在全季总览里消失`,
    );
  }
  console.log(
    `      ${imported.reused ? '复用已有条目' : '新建条目'} → ${imported.subjectKey}（季度 ${imported.season ?? '无'}）`,
  );
});

await check('导入的番能被对应季度的总览查到（「加进去的番没了」的回归）', async () => {
  const data = await getJson<SearchResponse>(`/api/search?q=${encodeURIComponent('魔法使いの夜')}&remote=1`);
  const first = data.remote[0];
  if (!first) {
    console.log('      （远程无结果，跳过）');
    return;
  }
  const imported = await postJson<ImportResponse>('/api/search/import?season=2026-10', { raw: first.raw });
  assert(imported.season, `没有季度归属（season=${imported.season}）`);

  const overview = await getJson<OverviewResponse>(`/api/overview?season=${encodeURIComponent(imported.season)}`);
  assert(
    overview.subjects.some((subject) => subject.key === imported.subjectKey),
    `导入的 ${imported.subjectKey} 在 ${imported.season} 的总览里找不到 —— 用户会以为"加进去的番没了"`,
  );
  console.log(`      ${imported.subjectKey} 出现在 ${imported.season} 总览里（共 ${overview.totals.all} 部）`);
});

// ---------------------------------------------------------------------------
console.log('\n日历导出');
// ---------------------------------------------------------------------------

await check('GET /api/ics 返回合法日历', async () => {
  const response = await fetch(`${BASE}/api/ics?season=2026-10&rule=broadcast-calendar`);
  assert(response.ok, `HTTP ${response.status}`);
  const ics = await response.text();

  assert(ics.startsWith('BEGIN:VCALENDAR'), '开头不对');
  assert(ics.trimEnd().endsWith('END:VCALENDAR'), '结尾不对');
  assert(ics.includes('BEGIN:VEVENT'), '没有事件');
  assert(ics.includes('\r\n'), '没有用 CRLF 换行（RFC 5545 要求）');

  const events = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
  const maxLine = Math.max(...ics.split('\r\n').map((line) => Buffer.byteLength(line, 'utf8')));
  console.log(`      ${events} 个事件，最长行 ${maxLine} 字节（RFC 上限 75）`);
  assert(maxLine <= 75, `有行超过 75 字节：${maxLine}`);
  assert(response.headers.get('content-disposition')?.includes('.ics') === true, '缺少下载文件名');
});

// ---------------------------------------------------------------------------
console.log('\n导出我的数据（用户诉求 5：追番列表是资产）');
// ---------------------------------------------------------------------------

await check('GET /api/export 返回可下载的 JSON 且包含全部追番', async () => {
  const response = await fetch(`${BASE}/api/export`);
  assert(response.ok, `HTTP ${response.status}`);
  assert(
    response.headers.get('content-type')?.includes('json') === true,
    `content-type 不对：${response.headers.get('content-type')}`,
  );
  assert(
    response.headers.get('content-disposition')?.includes('attachment') === true,
    '没有以附件形式下载（缺少 content-disposition）',
  );

  const data = JSON.parse(await response.text()) as ExportResponse;
  assert(typeof data.exportedAt === 'string', '缺少 exportedAt');
  assert(Array.isArray(data.myAnime), '缺少 myAnime');
  assert(Array.isArray(data.overrides), '缺少 overrides');
  assert(Array.isArray(data.changes), '缺少 changes');
  assert(data.counts.myAnime === data.myAnime.length, 'counts.myAnime 与数组长度不一致');

  // 与 GET /api/my 对账：导出的条目数必须等于四个分类之和
  const my = await getJson<{ groups: Record<string, unknown[]> }>('/api/my');
  const total = Object.values(my.groups).reduce((sum, list) => sum + list.length, 0);
  assert(
    data.myAnime.length === total,
    `导出 ${data.myAnime.length} 条，但 /api/my 共有 ${total} 条`,
  );

  const sample = data.myAnime[0];
  if (sample) {
    assert(typeof sample.subjectKey === 'string' && sample.subjectKey.length > 0, '导出的条缺少 subjectKey');
    assert(typeof sample.category === 'string', '导出的条缺少 category');
  }
  console.log(
    `      追番 ${data.counts.myAnime} 条 · 手动修正 ${data.counts.overrides} 条 · 变更 ${data.counts.changes} 条`,
  );
});

// ---------------------------------------------------------------------------
console.log('\n临时机翻译名（用户诉求 3）');
// ---------------------------------------------------------------------------

await check('POST /api/translate 能补中文名，且标记为 machine（不是 official）', async () => {
  const before = await getJson<OverviewResponse>('/api/overview?season=2026-10');
  const missingBefore = before.totals.withoutChineseTitle;

  // limit=1：只翻一条，别把整批都跑掉（这个接口是真实的免费翻译接口，要爱惜）
  const result = await postJson<TranslateResponse>('/api/translate?season=2026-10&limit=1');
  assert(Array.isArray(result.translated), '缺少 translated');
  assert(Array.isArray(result.failed), '缺少 failed');
  assert(typeof result.remaining === 'number', '缺少 remaining');
  assert(result.translatedCount + result.failed.length <= 1, 'limit=1 却处理了多条');

  if (result.translatedCount === 0) {
    console.log(`      （这次没有翻成：${result.failed[0]?.error ?? '没有候选'}，跳过后续断言）`);
    return;
  }

  const item = result.translated[0];
  assert(item, '没有翻译结果');
  assert(item.titleCn && item.titleCn.trim() !== '', '译文是空的');
  assert(item.key && item.titleOriginal, '结果缺少 key / titleOriginal');

  // 关键断言：机翻名必须被标成 machine，UI 才可能提示「临时」
  const { subject } = await getJson<{ subject: { titleCn: string; titleCnSource: string } }>(
    `/api/subject/${encodeURIComponent(item.key)}`,
  );
  assert(subject.titleCn === item.titleCn, `详情里的 titleCn 是 ${subject.titleCn}，期望 ${item.titleCn}`);
  assert(subject.titleCnSource === 'machine', `titleCnSource 应为 machine，实际 ${subject.titleCnSource}`);

  // 机翻名不能伪装成官方来源
  const detail = await getJson<{ subject: { fieldSources: Record<string, string> } }>(
    `/api/subject/${encodeURIComponent(item.key)}`,
  );
  assert(
    detail.subject.fieldSources.titleCn === undefined,
    `机翻名不该进 fieldSources（那是官方源的字段级出处），实际是 ${detail.subject.fieldSources.titleCn}`,
  );

  // 原名必须仍然能搜到
  const search = await getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(item.titleOriginal)}&remote=0`);
  assert(
    search.local.some((hit) => hit.titleOriginal === item.titleOriginal),
    '写了机翻名之后，用原名就搜不到了（别名没保住）',
  );

  const after = await getJson<OverviewResponse>('/api/overview?season=2026-10');
  assert(after.totals.withoutChineseTitle < missingBefore, '缺中文名的数量没有下降');
  assert(
    after.totals.machineTranslatedTitle >= 1,
    `overview 没有统计到临时机翻名（machineTranslatedTitle=${after.totals.machineTranslatedTitle}）`,
  );
  console.log(
    `      ${item.titleOriginal} → ${item.titleCn} [${item.engine}]；缺中文名 ${missingBefore} → ${after.totals.withoutChineseTitle}`,
  );
});

await check('POST /api/translate 不会覆盖已有的官方中文名', async () => {
  const before = await getJson<OverviewResponse>('/api/overview?season=2026-10');
  // ⚠ 必须挑一个**出处确实是 official** 的条目。
  //   这里曾经只写 `find(s => s.titleCn)` —— 那只保证"有中文名"，而中文名可能是上一轮机翻的
  //   （title_cn_source='machine'），随后第 594 行的 `=== 'official'` 断言必然失败。
  //   2026-10 库里 machine 名有 30 多条，能不能撞上完全取决于列表顺序：
  //   默认排序从"按放送星期"改成"按首集放送时间"之后，第一个有中文名的条目就变成了机翻名，
  //   这个隐藏很久的选择器缺陷才暴露出来。
  const official = before.subjects.find((subject) => subject.titleCn && subject.titleCnSource === 'official');
  assert(official, '本季没有带官方中文名的番，无法验证');
  const titleBefore = official.titleCn;

  // 用「强制全量翻」的方式打一遍：涉及到的条目必须是**没有**中文名的那些
  const result = await postJson<TranslateResponse>('/api/translate?season=2026-10&limit=0');
  const touched = result.translated.map((item) => item.key);
  assert(
    !touched.includes(official.key),
    `已有官方中文名的 ${official.key}（${titleBefore}）被动过了`,
  );

  const { subject } = await getJson<{ subject: { titleCn: string; titleCnSource: string } }>(
    `/api/subject/${encodeURIComponent(official.key)}`,
  );
  assert(subject.titleCn === titleBefore, `官方中文名被改成了 ${subject.titleCn}`);
  assert(subject.titleCnSource === 'official', `已有官方名的条目出处被改成了 ${subject.titleCnSource}`);
  console.log(`      本次共补 ${result.translatedCount} 条；「${titleBefore}」保持 official 未被动`);
});

// ---------------------------------------------------------------------------
console.log('\n一键更新数据（用户诉求 2）');
// ---------------------------------------------------------------------------

await check('POST /api/update 全流程返回逐阶段报告', async () => {
  // backfill=1 表示只处理当季（历史回填很慢，接口自检不重复跑）；
  // translate=0 关掉机翻（上面的 translate 检查已经真实打过翻译接口了）。
  const result = await postJson<UpdateResponse>('/api/update?season=2026-10&backfill=1&translate=0');

  assert(result.summary, '缺少 summary');
  assert(result.current, '缺少 current');
  assert(result.archive, '缺少 archive');
  assert(result.healed, '缺少 healed');
  assert(result.translated, '缺少 translated');

  assert(result.current.written > 50, `当季只写入 ${result.current.written} 部，太少`);
  assert(result.current.episodeCount > 100, `当季只有 ${result.current.episodeCount} 条分集，太少`);
  assert(
    result.current.reports.some((report) => report.ok),
    '没有任何数据源成功',
  );

  // 汇总必须与明细对得上，否则界面上的「一句话总结」会说谎
  assert(
    result.summary.written === result.current.written + result.archive.totalWritten,
    `summary.written=${result.summary.written} 与明细（${result.current.written}+${result.archive.totalWritten}）不一致`,
  );
  assert(
    result.summary.episodes === result.current.episodeCount + result.archive.totalEpisodes,
    'summary.episodes 与明细不一致',
  );
  assert(Array.isArray(result.current.moved), '缺少 current.moved（用户要靠它知道番被移到哪里了）');

  assert(Array.isArray(result.archive.seasons) && result.archive.seasons.length === 1, 'backfill=1 应只处理 1 个季度');
  assert(result.archive.seasons[0]?.season === '2026-10', `处理的季度不对：${result.archive.seasons[0]?.season}`);

  console.log(
    `      汇总：写入 ${result.summary.written} 部 / ${result.summary.episodes} 集 · ` +
      `官方名替换 ${result.summary.officialReplaced} · 移入补番库 ${result.summary.movedToBacklog} · ` +
      `失败源 ${result.summary.failedProviders.length}`,
  );
});

await check('更新数据前会自动备份（用户数据不可重建）', async () => {
  const result = await postJson<UpdateResponse>('/api/update?season=2026-10&backfill=1&translate=0');
  assert(result.backup, '没有返回备份信息 —— 写库前必须先备份');
  assert(typeof result.backup.path === 'string' && result.backup.path.includes('backups'), `备份路径可疑：${result.backup.path}`);
  assert(result.backup.bytes > 10_000, `备份文件只有 ${result.backup.bytes} 字节，可疑`);
  console.log(`      ${result.backup.path.split(/[\\/]/).pop()}（${Math.round(result.backup.bytes / 1024)} KB）`);
});

// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项接口检查`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
