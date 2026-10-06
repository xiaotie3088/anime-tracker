/**
 * 新番追番日历 · 前端（原生 ES 模块，无构建步骤）
 *
 * 结构很简单：state + 每个视图一个渲染函数 + 用事件委托处理点击。
 * 刻意的取舍：
 *   - 不用框架：这个界面只有 4 个视图，引入 React/Vite 会带来构建步骤与几百个依赖，
 *     而收益（组件复用）在这里并不明显。
 *   - 倒计时在客户端算：页面开着的时候秒/分钟级地变，不能只依赖服务端返回的文本。
 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 类型标签的中文显示（第五轮需求 3）。
 *
 * ⚠ 刻意**只做显示映射**，不改数据库里的值：
 *   - `genre` 是抓取来的原始数据（AniList 给英文、yuc.wiki 给中文），
 *     写回中文会让「融合字段优先级」和下次同步互相打架（见交接文档第五节第 3 条）。
 *   - 库里已经是中文的标签（恋爱/机战/转生…）不在表里，原样显示。
 * 所以这里是"翻译表"，不是"数据字典"。
 */
const GENRE_CN = {
  Action: '动作',
  Adventure: '冒险',
  Comedy: '喜剧',
  Drama: '剧情',
  Ecchi: '擦边',
  Fantasy: '奇幻',
  Hentai: '成人',
  Horror: '恐怖',
  'Mahou Shoujo': '魔法少女',
  Mecha: '机甲',
  Music: '音乐',
  Mystery: '悬疑',
  Psychological: '心理',
  Romance: '恋爱',
  'Sci-Fi': '科幻',
  'Slice of Life': '日常',
  Sports: '运动',
  Supernatural: '超自然',
  Thriller: '惊悚',
};

/** 类型标签的中文显示名（没有映射的原样返回）。 */
function genreLabel(genre) {
  return GENRE_CN[genre] ?? genre;
}

/** 媒体类型的中文显示名。 */
const MEDIA_TYPE_CN = { TV: 'TV 动画', MOVIE: '剧场版', OVA: 'OVA', ONA: '网络动画', WEB: '网络动画', SPECIAL: '特别篇' };
function mediaTypeLabel(mediaType) {
  return MEDIA_TYPE_CN[mediaType] ?? mediaType;
}

/** 总览列表的排序口径（与服务端 resolveSeasonSort 的白名单一致）。 */
const SORT_OPTIONS = [
  { key: 'firstAir', label: '首集放送时间（早→晚）' },
  { key: 'firstAirDesc', label: '首集放送时间（晚→早）' },
  { key: 'weekday', label: '按放送星期 / 时刻' },
  { key: 'titleCn', label: '按中文名' },
  { key: 'totalEps', label: '按集数（多→少）' },
];

/** 番剧列表每行几部（第五轮需求 4）。只在 3~7 之间取值。 */
const PER_ROW_OPTIONS = [3, 4, 5, 6, 7];
const PER_ROW_DEFAULT = 4;
const PER_ROW_MIN = 3;
const PER_ROW_MAX = 7;

/**
 * 总览里可筛选的四个维度，**顺序就是面板第 3 层的顺序**
 * （放送星期 / 媒体类型 / 国内平台 / 类型标签）。
 */
const FACET_DIMENSIONS = ['weekdays', 'mediaTypes', 'platforms', 'genres'];

/** 四个维度的中文标题（折叠栏标题要用）。 */
const FACET_TITLES = {
  weekdays: '放送星期',
  mediaTypes: '媒体类型',
  platforms: '国内平台',
  genres: '类型标签',
};

/**
 * 第 2 层的状态预设：**不是标签**，是"我这边"的条件（我追的 / 补番库 /…），
 * 所以刻意和三态分开、只有"选 / 不选"两态。顺序就是界面上的顺序。
 */
const STATUS_CHIPS = [
  ['mine', '我追的'],
  ['backlog', '补番库'],
  ['airing', '放送中'],
  ['upcoming', '未开播'],
  ['bilibili', 'B站有版权'],
  ['nozh', '缺中文名'],
];

/** localStorage 的键：布局偏好要跨刷新记住，否则每次打开都得重设一遍。 */
const LS_PER_ROW = 'anime-tracker.perRow';
const LS_SORT = 'anime-tracker.sort';
const LS_STATUS_AND = 'anime-tracker.statusAnd';
const LS_FILTERS_COLLAPSED = 'anime-tracker.filtersCollapsed';

function readStoredNumber(key, options, fallback) {
  const raw = Number(localStorage.getItem(key));
  return options.includes(raw) ? raw : fallback;
}

function readStoredString(key, allowed, fallback) {
  const raw = localStorage.getItem(key);
  return raw && allowed.includes(raw) ? raw : fallback;
}

function store(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* 隐私模式下写不了 localStorage，忽略即可（只是记不住偏好） */
  }
}

/**
 * 空的筛选条件。
 *
 * 四个维度都是 `{ include, exclude }` 两份 —— 三态（不选 / 含 / 不含）循环出来的结果。
 * ⚠ 排除**必须**有自己的一份数组：混进 include 之后，"同一维度里选多个 = 满足任意一个"
 *   立刻变成"满足任意一个（含或不含）"，排除项会被并集吃掉，用户点"不含成人"根本不起作用。
 * `side` 是第 2 层的状态预设，只有选与不选两态，所以仍是普通数组。
 */
function emptyFilters() {
  const filters = { side: [] };
  for (const dimension of FACET_DIMENSIONS) filters[dimension] = { include: [], exclude: [] };
  return filters;
}

const state = {
  view: 'week',
  season: null,
  /** 同时选中的季度（多选，第一个是主季 —— 周视图 / .ics 用它） */
  selectedSeasons: [],
  rule: 'clock',
  offset: 0,
  myCategory: 'tracking',
  overview: null,
  /**
   * 总览的筛选条件（四个维度三态 + 第 2 层的状态预设），见 emptyFilters 的注释。
   */
  filters: emptyFilters(),
  /** 第 2 层多个状态 chip 之间：true = 且（同时满足，线上老行为），false = 或（满足任意一个） */
  statusAnd: true,
  /**
   * 面板整体收起（只留第 1 层的搜索框 + 那个开关）。
   *
   * 收起的是**第 2~5 层**，不是整个面板：搜索框与"显示 N / M 部"留在原地，
   * 已选条件条本来就在面板外面、也一直可见 —— 所以收起来之后不会出现"不知道被什么筛过"。
   */
  filtersCollapsed: false,
  /** 四个折叠栏 + 「显示方式」各自展开着没有（点选后会重绘面板正文，得把展开状态记住） */
  facetsOpen: {},
  sort: 'firstAir',
  perRow: PER_ROW_DEFAULT,
  showAllChanges: false,
  searchQuery: '',
  detailKey: null,
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

let statusTimer = null;
function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status${kind ? ` is-${kind}` : ''}`;
  if (statusTimer) clearTimeout(statusTimer);
  if (text && kind !== 'error') {
    statusTimer = setTimeout(() => {
      el.textContent = '';
      el.className = 'status';
    }, 6000);
  }
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

/** 与服务端一致的放送展示：JST 下的星期与时刻。 */
function formatJst(iso) {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms + 9 * 3_600_000);
  return `${WEEKDAYS[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function formatCn(iso) {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.toISOString().slice(5, 10)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function humanDuration(ms) {
  const abs = Math.abs(ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return '不到 1 分钟';
  const days = Math.floor(abs / day);
  const hours = Math.floor((abs % day) / hour);
  const minutes = Math.floor((abs % hour) / minute);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  return `${minutes} 分`;
}

function countdownText(iso) {
  if (!iso) return '';
  const diff = Date.parse(iso) - Date.now();
  return diff > 0 ? `${humanDuration(diff)}后` : '已更新';
}

function isPast(iso) {
  return Boolean(iso) && Date.parse(iso) <= Date.now();
}

/**
 * 海报。
 *
 * `onerror` 是必需的：封面来自远程 CDN，偶发会加载失败（限流 / 网络抖动 / 图被删）。
 * 失败时 `<img>` 会留下一个空白或**纯黑**的框 —— 用户看到的就是"预览图黑掉了"。
 * 这里在加载失败时把它换成占位块，至少形状和颜色是对的，不会突兀地黑一块。
 * （`background` 给的是加载期间的颜色，也在 --cover-bg / --surface-2 里定义，两套主题都协调。）
 */
function coverHtml(url, className) {
  return url
    ? `<img class="${className}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.className='${esc(
        className,
      )} ep-cover-ph';this.removeAttribute('src');this.textContent='◈';" />`
    : `<div class="${className} ep-cover-ph">◈</div>`;
}

function subjectTitle(item) {
  return item.titleCn || item.titleOriginal || item.titleEn || item.key;
}

// ---------------------------------------------------------------------------
// 视图：周视图
// ---------------------------------------------------------------------------

function renderWeekLoading() {
  $('#app').innerHTML = '<div class="loading">正在加载本周安排…</div>';
}

function weekCard(item) {
  const past = isPast(item.airAtUtc);
  const tags = [];
  if (item.broadcastTimeJst && Number(item.broadcastTimeJst.slice(0, 2)) >= 24) {
    tags.push('<span class="tag tag-purple" title="日本排期表写作前一天的 24:xx 档">深夜番</span>');
  }
  if (item.pubAtUtc) tags.push(`<span class="tag tag-ok">国内 ${esc(formatCn(item.pubAtUtc))}</span>`);
  if (item.isOverridden) tags.push('<span class="tag tag-warn">手动修正</span>');
  if (item.conflicting) tags.push('<span class="tag tag-warn">源有分歧</span>');

  return `
    <div class="ep-card${past ? ' is-past' : ''}" data-key="${esc(item.subjectKey)}">
      ${coverHtml(item.coverUrl, 'ep-cover')}
      <div class="ep-main">
        <div class="ep-title">${esc(subjectTitle(item))}</div>
        <div class="ep-sub">第 ${esc(item.epNumber)} 话${
          item.totalEps ? ` / 共 ${esc(item.totalEps)}` : ''
        } · 已看 ${esc(item.watchedEps ?? 0)}</div>
        <div class="ep-time">放送 ${esc(formatJst(item.airAtUtc))}</div>
        <div class="ep-count" data-countdown="${esc(item.airAtUtc ?? '')}">${esc(countdownText(item.airAtUtc))}</div>
        ${tags.length ? `<div class="ep-tags">${tags.join('')}</div>` : ''}
      </div>
    </div>`;
}

async function renderWeek() {
  renderWeekLoading();
  const data = await api(`/api/week?season=${encodeURIComponent(state.season)}&rule=${state.rule}&offset=${state.offset}`);

  const weekTotal = data.days.reduce((sum, day) => sum + day.items.length, 0);

  const upcomingHtml = data.upcoming.length
    ? `<div class="card dist upcoming">
         <h3 class="section-title">接下来要更新的</h3>
         ${data.upcoming
           .map(
             (item) => `
           <div class="bar-row upcoming-row">
             <span class="name is-strong">${esc(subjectTitle(item))} 第${esc(item.epNumber)}话</span>
             <span class="num">${esc(formatJst(item.airAtUtc))}</span>
             <span class="num is-accent" data-countdown="${esc(item.airAtUtc ?? '')}">${esc(
               countdownText(item.airAtUtc),
             )}</span>
           </div>`,
           )
           .join('')}
       </div>`
    : '';

  // ⚠ 顺序是刻意的（第五轮需求 1）：用户主要看的是下面这排「周一~周日」的格子，
  //   所以周格子必须在最上面，「接下来要更新的」倒计时列表挪到它下面。
  $('#app').innerHTML = `
    <div class="week-nav">
      <button class="btn btn-sm" data-week-offset="-1">‹ 上一周</button>
      <button class="btn btn-sm" data-week-offset="0">本周</button>
      <button class="btn btn-sm" data-week-offset="1">下一周 ›</button>
      <span class="range">${esc(data.week.startDateJst)} ~ ${esc(data.week.endDateJst)}</span>
      <span class="hint">共 ${weekTotal} 集 · 归属口径：${
        data.rule === 'clock' ? '真实钟点' : '日本放送日历'
      }（可切换）</span>
    </div>
    <div class="week-grid">
      ${data.days
        .map(
          (day) => `
        <div class="day-col card${day.isToday ? ' is-today' : ''}">
          <div class="day-head">
            <span class="wd">${esc(day.weekdayLabel)}</span>
            <span class="dt">${esc(String(day.dateJst).slice(5))} · ${day.items.length} 集</span>
          </div>
          <div class="day-body">
            ${day.items.length ? day.items.map(weekCard).join('') : '<div class="empty day-empty">—</div>'}
          </div>
        </div>`,
        )
        .join('')}
    </div>
    ${
      weekTotal === 0
        ? `<div class="empty">这一周没有你追的番更新。<br />
             如果是第一次用，先去「全季总览」或「搜索 / 加番」把要追的番加进来；
             也可以点右上角「更新数据」抓取当季清单并回填历史季度。</div>`
        : ''
    }
    ${upcomingHtml}`;
}

// ---------------------------------------------------------------------------
// 视图：全季总览
// ---------------------------------------------------------------------------

function subjectRow(item) {
  const inList =
    item.myCategory === 'tracking'
      ? '<span class="tag tag-ok">追番中</span>'
      : item.myCategory === 'backlog'
        ? '<span class="tag tag-purple">补番库</span>'
        : item.myCategory === 'finished'
          ? '<span class="tag">已看完</span>'
          : item.myCategory === 'dropped'
            ? '<span class="tag">已弃番</span>'
            : '';

  const weekday = item.broadcastWeekdayJst === null ? null : WEEKDAYS[item.broadcastWeekdayJst];
  const platforms = [...new Set(item.platforms.map((p) => p.name))];
  const genres = [...new Set(item.genres)];

  return `
    <div class="subject-row" data-key="${esc(item.key)}" data-subject-row="1"${cardClickAttrs()}>
      ${coverHtml(item.coverUrl, 'cover')}
      <div class="info">
        <div class="t-cn">${esc(item.titleCn ?? '（无中文名）')} ${machineTag(item.titleCnSource)} ${inList}${copyNameHtml(
          item,
        )}</div>
        <div class="t-orig">${esc(item.titleOriginal ?? '')}</div>
        <div class="meta">
          <span class="tag">${esc(mediaTypeLabel(item.mediaType))}</span>
          ${item.totalEps ? `<span class="tag">${esc(item.totalEps)} 话</span>` : '<span class="tag tag-warn">集数未知</span>'}
          ${
            item.firstAirAtUtc
              ? `<span class="tag" title="首集放送时刻（JST），列表默认就按这个排">首播 ${esc(
                  formatJst(item.firstAirAtUtc),
                )}</span>`
              : ''
          }
          ${weekday ? `<span class="tag">${esc(weekday)} ${esc(item.broadcastTimeJst ?? '')}</span>` : ''}
          ${genres
            .map(
              (genre) =>
                `<span class="tag" title="原始标签：${esc(genre)}">${esc(genreLabel(genre))}</span>`,
            )
            .join('')}
          ${platforms.map((name) => `<span class="tag tag-ok">${esc(name)}</span>`).join('')}
        </div>
      </div>
      <div class="actions">
        ${
          item.myCategory
            ? `<button class="btn btn-sm btn-danger" data-remove="${esc(item.key)}">移除</button>`
            : // 追番 / 补番两个按钮：总得先看看是什么番、什么时候放，再决定追还是补 ——
              // 想看详情**点整张卡片**即可（原来这里还有个「详情」按钮，已按需求去掉）
              `<button class="btn btn-sm btn-primary" data-add="${esc(item.key)}" data-category="tracking">追番</button>
               <button class="btn btn-sm" data-add="${esc(item.key)}" data-category="backlog">补番</button>`
        }
      </div>
    </div>`;
}

/**
 * 卡片可点：交给 `web/styles.css` 的 `[data-interactive]` 规则上指针光标与悬停反馈。
 *
 * 为什么不把 `style="cursor:pointer"` 直接写在元素上：这个项目有条硬约束 ——
 * 样式只能来自 `styles.css` 的设计令牌，组件里不写死。（内联 cursor 虽不是色值，
 * 但也属于"绕开样式表"，一旦哪天换了视觉方向就找不到出处。）
 */
function cardClickAttrs() {
  return ' data-interactive="1" tabindex="0"';
}

/**
 * 复制用的名字：**优先只给中文名**，没有中文名时才退回日文原名。
 *
 * 为什么不把"中文名 + 原名"拼起来：用户复制是为了**拿去别处搜这部番**
 * （Bing / 番剧站）。搜索引擎会把整串当成一个短语，混了两种语言的查询通常一条也匹配不到，
 * 用户还得手动删掉一半 —— 比只给一个名字更差。贴回本页搜索框虽然能命中
 * （前端是 `includes` 匹配），但那不是这个按钮的主场景。
 */
function copyTextFor(item) {
  const cn = String(item.titleCn ?? '').trim();
  if (cn) return cn;
  return String(item.titleOriginal ?? '').trim();
}

/**
 * 「复制番剧名」按钮。
 *
 * 为什么要带 `data-copy="${key}"`：卡片改成整块可点之后，按钮必须能独立识别出来，
 * 否则点击会冒泡到卡片、连带弹出详情（这是本改动最容易出的 bug）。
 */
function copyNameHtml(item) {
  const text = copyTextFor(item);
  if (!text) return '';
  return `<button class="copy-name" data-copy="${esc(item.key)}" title="复制番剧名（去找番看的时候直接粘贴）" aria-label="复制番剧名">复制</button>`;
}

/**
 * 复制文本到剪贴板。
 *
 * 页面是 `http://127.0.0.1:8787`，属安全上下文，`navigator.clipboard` 正常可用；
 * 但要兜住"浏览器不支持 / 用户拒绝权限"两种失败 —— 退回 `execCommand`，
 * 再不行就把名字显示出来让用户手动复制。**不要静默失败**。
 */
async function copyTextToClipboard(text) {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      /* 落到下面的兜底路径 */
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    // ⚠ remove() 必须放 finally：execCommand 可能抛（权限策略等），
    //   只放 try 里会让那个 textarea 永久留在页面上，而且它刚被 select() 过 ——
    //   页面上会出现可见的选区异常。
    try {
      return document.execCommand?.('copy') ?? false;
    } finally {
      area.remove();
    }
  } catch {
    /* 继续落到最后的提示 */
  }
  toast(`复制失败，名字是：${text}`);
  return false;
}

/** 点卡片上的「复制」：复制番剧名，方便去别处搜这部番。 */
async function copySubjectTitle(key) {
  const item = (state.overview?.subjects ?? []).find((entry) => entry.key === key);
  const text = item ? copyTextFor(item) : '';
  if (!text) {
    toast('这部番还没有名字可以复制', true);
    return;
  }
  if (await copyTextToClipboard(text)) toast(`已复制：${text}`);
}

/**
 * 「临时机翻」标记。
 *
 * 用户明确要求：机翻名必须是**可区分**的 ——「官方译名出来后一键更新改成官方名」。
 * 所以不能只写一个中文名就完事，要让人一眼看出这个名字是临时的。
 */
function machineTag(source) {
  if (source !== 'machine') return '';
  return '<span class="tag tag-warn" title="这是机器翻译的临时译名；官方译名一到，「更新数据」会自动替换成官方名">临时机翻</span>';
}

/**
 * 总览里的"状态"预设：我追的 / 补番库 / 放送中 / 未开播 / B站有版权 / 缺中文名。
 *
 * 它们在面板里是**第 2 层**，刻意和第 3 层的四个标签维度分开：语义不同（"我追的"是预设条件，
 * 不是标签），混在一起就是原来那套面板难用的原因之一。
 */
function overviewSideFilter() {
  return state.filters.side ?? [];
}

/** 一个番剧满足某个状态预设吗。 */
function sideMatch(item, value) {
  if (value === 'mine') return Boolean(item.myCategory);
  if (value === 'backlog') return item.myCategory === 'backlog';
  if (value === 'airing') return item.status === 'airing';
  if (value === 'upcoming') return item.status === 'upcoming';
  if (value === 'nozh') return !item.titleCn;
  if (value === 'bilibili') return item.platforms.some((platform) => platform.name.includes('哔哩哔哩'));
  return false;
}

/**
 * 只应用"搜索框 + 第 2 层状态"这些不在第 3 层里的条件。
 *
 * 第 2 层多个状态之间用"且"还是"或"，由面板上那个小切换键决定（`state.statusAnd`）：
 *   - 且（默认，线上老行为）：同时点「放送中」+「未开播」= 一部都不剩，但"我追的 + 放送中"这种收窄很好用；
 *   - 或：两个状态取并集，适合"我追的 或 补番库"这种看法。
 * 两边都说得通，所以交给用户切，而不是替他定一个。
 */
function baseFilteredSubjects() {
  const overview = state.overview;
  if (!overview) return [];
  const query = state.searchQuery.trim().toLowerCase();
  const side = overviewSideFilter();
  const sideOk = (item) =>
    state.statusAnd ? side.every((value) => sideMatch(item, value)) : side.some((value) => sideMatch(item, value));
  return overview.subjects.filter((item) => {
    if (side.length && !sideOk(item)) return false;
    if (!query) return true;
    return [item.titleCn, item.titleOriginal, item.titleEn]
      .filter(Boolean)
      .some((title) => String(title).toLowerCase().includes(query));
  });
}

/** 某一维度的全部候选值及部数（用于把各部数写在筛选项旁边，替代原来的分布图）。 */
function dimensionEntries(dimension, items) {
  if (dimension === 'weekdays') {
    return WEEKDAYS.map((label, weekday) => ({
      value: weekday,
      label,
      count: items.filter((item) => item.broadcastWeekdayJst === weekday).length,
    })).filter((entry) => entry.count > 0);
  }
  if (dimension === 'mediaTypes') {
    const counter = new Map();
    for (const item of items) counter.set(item.mediaType, (counter.get(item.mediaType) ?? 0) + 1);
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: mediaTypeLabel(value), count }));
  }
  if (dimension === 'genres') {
    const counter = new Map();
    for (const item of items) {
      for (const genre of new Set(item.genres)) counter.set(genre, (counter.get(genre) ?? 0) + 1);
    }
    // 排序用原文（稳定），显示用中文 —— 否则翻译后的中文排序会让同一个标签跳来跳去
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([value, count]) => ({ value, label: genreLabel(value), count }));
  }
  const counter = new Map();
  for (const item of items) {
    for (const name of new Set(item.platforms.map((p) => p.name))) {
      counter.set(name, (counter.get(name) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, label: value, count }));
}

/** 某一维度里"含"的值（统一成字符串，避免 dataset 的 number/string 混用）。 */
function includedValues(dimension) {
  return (state.filters[dimension]?.include ?? []).map(String);
}

/** 某一维度里"不含"的值。 */
function excludedValues(dimension) {
  return (state.filters[dimension]?.exclude ?? []).map(String);
}

/** 某一维度里被选中的值（含 + 不含）—— 摘要、置顶判断、取消都要用。 */
function pickedValues(dimension) {
  return [...includedValues(dimension), ...excludedValues(dimension)];
}

/**
 * 一个番剧在某个维度上有哪些值（一律字符串）。
 * 放送星期可能没数据（`null`），这时返回空数组 —— 不能写成 `String(null)` 得到一个 'null'。
 */
function dimensionValues(dimension, item) {
  if (dimension === 'weekdays') {
    return item.broadcastWeekdayJst === null ? [] : [String(item.broadcastWeekdayJst)];
  }
  if (dimension === 'mediaTypes') return [item.mediaType];
  if (dimension === 'platforms') return [...new Set(item.platforms.map((p) => p.name))];
  return [...new Set(item.genres)];
}

/**
 * 把第 3 层的四个维度套到一批番剧上。三条规则（票里 §三 的前三条）：
 *
 *   1. **组内并集**：同一维度里选多个"含" = 满足其中任意一个就行。
 *   2. **组间交集**：不同维度之间 = 每个维度都要满足。
 *   3. **排除一票否决**：只要命中任一维度的任一"不含"，整条直接丢掉，不再看其他条件。
 *
 * 第 4 条（同一项不可能同时被"含"与"不含"）由三态循环天然保证 —— 一个值只会待在
 * include 或 exclude 之一里，所以下面两段判断不会打架（这也是选三态、而不是
 * "另加一个排除按钮"的主要原因）。
 */
function applyFilters(items) {
  return items.filter((item) => {
    for (const dimension of FACET_DIMENSIONS) {
      const values = dimensionValues(dimension, item);
      const excluded = excludedValues(dimension);
      if (excluded.length && values.some((value) => excluded.includes(value))) return false;
      const included = includedValues(dimension);
      if (included.length && !values.some((value) => included.includes(value))) return false;
    }
    return true;
  });
}

/**
 * 三态循环：不选 → 含 → 不含 → 不选。
 *
 * 为什么不给"排除"单独做一个按钮：那样同一项就可能同时被"含"与"不含"选中，
 * 得再写一套互斥规则；循环只有一条状态线，天然互斥。
 */
function cycleFilterValue(dimension, value) {
  const filter = state.filters[dimension];
  if (!filter) return;
  if (filter.exclude.includes(value)) {
    // 不含 → 不选
    filter.exclude = filter.exclude.filter((item) => item !== value);
    return;
  }
  if (filter.include.includes(value)) {
    // 含 → 不含
    filter.include = filter.include.filter((item) => item !== value);
    filter.exclude = [...filter.exclude, value];
    return;
  }
  // 不选 → 含
  filter.include = [...filter.include, value];
}

/** 把某一项从"含"和"不含"两侧一起清掉（条件条上点 ✕ 走这里，不是三态循环）。 */
function clearFilterValue(dimension, value) {
  const filter = state.filters[dimension];
  if (!filter) return;
  filter.include = filter.include.filter((item) => item !== value);
  filter.exclude = filter.exclude.filter((item) => item !== value);
}

/**
 * 分布面板里的部数口径：**固定基数**（用户看过原型后定的）。
 *
 * 基数是「搜索框 + 第 2 层状态」的结果，**不叠加第 3 层自己的选择**。
 * 为什么不用"点它之后会剩多少"：那个口径下，已经"含"着的项要显示"改成不含之后"的部数，
 * 于是同一排数字里混着两种含义 —— 实测含「奇幻」时列表 31 部，而它自己写着 141
 * （172 − 31），旁边的「科幻」写着 15（含它剩 15），141 和 15 并排会被读成"奇幻有 141 部"。
 * 固定基数的代价是"点下去会剩多少"要自己反推，换来的是数字稳定、含义唯一。
 */
function facetEntries(dimension, base) {
  return dimensionEntries(dimension, base);
}

function filteredSubjects() {
  return applyFilters(baseFilteredSubjects());
}

/** 维度 + 取值 → 给人看的标签（折叠标题的摘要、条件条都要用）。 */
function dimensionLabel(dimension, value) {
  if (dimension === 'weekdays') return WEEKDAYS[Number(value)] ?? `星期 ${value}`;
  if (dimension === 'mediaTypes') return mediaTypeLabel(value);
  if (dimension === 'genres') return genreLabel(value);
  return value;
}

/**
 * 已选条件条里的一枚 chip。
 *
 * "含"与"不含"必须是两种东西：含 = 实心强调色 + `✓`，不含 = 危险色 + **删除线** + `⊘`。
 * 删除线是刻意加的 —— 只靠红色的话，色觉障碍用户（以及单色屏）分不出这两种。
 */
function filterChipHtml(dimension, value, side) {
  const label = esc(dimensionLabel(dimension, value));
  const excluded = side === 'exclude';
  return `<button class="chip ${excluded ? 'is-excluded' : 'is-active'}"
      data-clear-filter="${esc(dimension)}" data-clear-value="${esc(value)}"
      title="${excluded ? '不含它：列表里看不到含它的番。点一下取消' : '含它：只看有它的。点一下取消'}">${
        excluded ? '⊘ 不含 ' : '含 '
      }${label} ✕</button>`;
}

/**
 * 已选条件的提示条（可单删 / 一键清空）。
 * 面板收起时也必须看得见 —— 否则"怎么列表只剩 3 部"会变成未解之谜。
 */
function activeFilterChips() {
  const chips = [];
  for (const dimension of FACET_DIMENSIONS) {
    for (const value of includedValues(dimension)) chips.push(filterChipHtml(dimension, value, 'include'));
    for (const value of excludedValues(dimension)) chips.push(filterChipHtml(dimension, value, 'exclude'));
  }
  for (const [value, label] of STATUS_CHIPS) {
    if (overviewSideFilter().includes(value)) {
      chips.push(
        `<button class="chip is-active" data-quick-filter="${value}" title="点一下取消这个筛选">${label} ✕</button>`,
      );
    }
  }
  if (chips.length === 0) return '';
  return `<div class="active-filters">
      <span class="af-label">已选条件</span>
      ${chips.join('')}
      <button class="btn btn-sm" data-clear-filters="1" title="含与不含两侧一起清掉（状态也一起）">全部清空</button>
    </div>`;
}

/** 现在一共筛了几项（含 + 不含 + 状态）—— 面板开关上的徽标用它，收起时也看得见"我筛了几项"。 */
function filterConditionCount() {
  let count = overviewSideFilter().length;
  for (const dimension of FACET_DIMENSIONS) {
    count += includedValues(dimension).length + excludedValues(dimension).length;
  }
  return count;
}

/**
 * 面板**第 1 层**：搜索框 + 「筛选」开关 + "显示 N / M 部"。
 *
 * ⚠ 这一层是**常驻节点**（`#filter-panel-head`），点筛选时只重绘 `#filter-panel-body`。
 *   票的验收里有一条「搜索框焦点不因点筛选而丢失」—— 线上原来把搜索框放在面板外的工具栏里，
 *   新设计按票的图把它挪进面板第 1 层，能不能保住焦点就全靠这条拆法
 *   （见 renderFilterPanelBody 与 refreshSubjectList 的老原则）。
 */
function filterPanelHeadHtml(base) {
  const count = filterConditionCount();
  return `
    <div class="filter-layer">
      <div class="toolbar">
        <input type="search" id="season-search" placeholder="搜索中文名 / 原名（也可以直接搜别名）" value="${esc(
          state.searchQuery,
        )}" />
        <button class="btn btn-sm" id="filter-toggle" data-filter-collapse="1"
          aria-expanded="${state.filtersCollapsed ? 'false' : 'true'}"
          title="${
            state.filtersCollapsed ? '展开筛选面板' : '收起筛选面板'
          }（搜索框留在原地，已选条件也一直在下面看得见）"
          >筛选${count ? ` <span class="pill">${count}</span>` : ''} ${
            state.filtersCollapsed ? '▼' : '▲'
          }</button>
        <span class="hint" id="subject-count">显示 ${applyFilters(base).length} / ${base.length} 部</span>
      </div>
    </div>`;
}

/**
 * 面板**第 2~5 层**（会被重绘的那一半），从上到下就是"一路收窄"：
 *
 *   第 2 层 状态 —— 我追的 / 补番库 / …（预设条件，不是标签，所以只有选与不选两态）
 *   第 3 层 四个维度 —— 放送星期 / 媒体类型 / 国内平台 / 类型标签：**唯一做筛选的地方**，
 *                       默认全部收起（收起 = 全部）；只有这一层有"含 / 不含"三态
 *   第 4、5 层 显示方式 —— 排序与每行几部：**不是筛选**，收进一个默认收起的折叠栏（用户选的 B 方案）
 */
function filterPanelBodyHtml(base) {
  return `
    ${filterStatusLayerHtml(base)}
    ${filterFacetsLayerHtml(base)}
    ${filterDisplayLayerHtml()}
    <div class="filter-note">
      同一维度里选多个「含」= 满足任意一个；不同维度之间 = 同时满足；标了「不含」的只要命中就整条丢掉。
      选项右边的部数按「搜索框 + 状态」这个固定基数算，不随这里的筛选跳动。
    </div>`;
}

/** 第 2 层：状态预设（只有选 / 不选两态），右上角是"多个之间：且 / 或"那个小切换键。 */
function filterStatusLayerHtml(base) {
  const options = STATUS_CHIPS.map(([value, label]) => {
    const active = overviewSideFilter().includes(value);
    const count = base.filter((item) => sideMatch(item, value)).length;
    return `<button class="filter-opt${active ? ' is-active' : ''}" data-quick-filter="${value}"
        aria-pressed="${active ? 'true' : 'false'}"
        title="点一下选中，再点取消（可多选）">${active ? '✓ ' : ''}${label}<span class="c">${count}</span></button>`;
  }).join('');
  const modeTitle = state.statusAnd
    ? '现在：多选要同时满足（且）。点一下改成"满足任意一个（或）"'
    : '现在：多选满足任意一个（或）。点一下改成"同时满足（且）"';
  return `
    <div class="filter-layer">
      <div class="filter-group">
        <div class="filter-group-head is-row">
          <span>状态</span>
          <button class="btn btn-sm" data-status-mode="1" aria-pressed="${state.statusAnd ? 'true' : 'false'}"
            title="${esc(modeTitle)}">多选之间：${state.statusAnd ? '且' : '或'}</button>
        </div>
        <div class="filter-opts">${options}</div>
      </div>
    </div>`;
}

/** 第 3 层：四个可折叠的维度（顺序见 FACET_DIMENSIONS）。 */
function filterFacetsLayerHtml(base) {
  return `<div class="filter-layer filter-facets">${FACET_DIMENSIONS.map((dimension) =>
    // 类型标签有 101 项，展开后给它自己一块可滚的区域（其它维度最多十几项，不需要）
    filterGroupHtml(dimension, base, { scroll: dimension === 'genres' }),
  ).join('')}</div>`;
}

/**
 * 第 4、5 层：排序方式 + 每行几部。
 *
 * 这两层**不是筛选**，是"显示方式"，所以按用户选的方案收进一个默认收起的折叠栏：
 * 面板平时只剩 状态 + 四个维度，短一截。展开状态同样记在 `state.facetsOpen` 里，
 * 点筛选导致的重绘不会把它收回去（键名用 'display'，与四个维度区分开）。
 */
function filterDisplayLayerHtml() {
  const sortLabel = (SORT_OPTIONS.find((option) => option.key === state.sort) ?? SORT_OPTIONS[0]).label;
  const open = state.facetsOpen.display === true;
  const sortOptions = SORT_OPTIONS.map(
    (option) =>
      `<button class="filter-opt${state.sort === option.key ? ' is-active' : ''}" data-sort="${esc(
        option.key,
      )}">${state.sort === option.key ? '✓ ' : ''}${esc(option.label)}</button>`,
  ).join('');
  const perRowOptions = PER_ROW_OPTIONS.map(
    (n) =>
      `<button class="filter-opt${state.perRow === n ? ' is-active' : ''}" data-per-row="${n}">${
        state.perRow === n ? '✓ ' : ''
      }${n} 部</button>`,
  ).join('');
  return `
    <div class="filter-layer">
      <details class="filter-facet" data-facet="display"${open ? ' open' : ''}>
        <summary class="facet-head">
          <span class="facet-title">显示方式</span>
          <span class="facet-count">${state.perRow} 部 / 行</span>
          <span class="facet-picked">${esc(sortLabel)}</span>
          <span class="facet-caret">▾</span>
        </summary>
        <div class="facet-body">
          <div class="filter-group">
            <div class="filter-group-head">排序方式</div>
            <div class="filter-opts">${sortOptions}</div>
          </div>
          <div class="filter-group">
            <div class="filter-group-head">每行几部</div>
            <div class="filter-opts">${perRowOptions}</div>
            <div class="filter-note">现在的卡片太挤的话，调小一点</div>
          </div>
        </div>
      </details>
    </div>`;
}

/**
 * 筛选面板第 3 层里的一栏（放送星期 / 媒体类型 / 国内平台 / 类型标签）。
 *
 * 用 `<details>` 做成可折叠：**默认全部收起**（只显示标题 + 「已选 2 · 排除 1」+ 选中项名字），
 * 否则四栏全铺开会把这个面板顶得很长（类型标签有 101 项），反而看不清"我到底筛了什么"。
 *
 * 用 `<details>` 而不是自己写开合：浏览器原生支持键盘（Tab 到标题、Enter 展开），
 * 也不用担心和点击委托互相干扰（summary 不是 button，委托不会命中它）。
 *
 * ⚠ 选项的顺序**不动**（按部数降序）：用户看过原型后明确选了"选中项不置顶、保持原位置不动"，
 *   所以这里刻意不做"把选中的挪到最前面"——列表会跳位置反而让人找不到刚才点的那一项。
 */
function filterGroupHtml(dimension, base, { scroll = false } = {}) {
  const all = facetEntries(dimension, base);
  if (all.length === 0) return '';
  const include = includedValues(dimension);
  const exclude = excludedValues(dimension);
  const picked = [...include, ...exclude];

  // 固定基数下"被排除"不会让部数变成 0，所以它一定还在候选里；但基数本身可能把它筛掉
  // （例如搜索词只命中别处），这时也要留着 —— 否则它只能绕到下面的条件条去取消。
  const options = all
    .filter((entry) => entry.count > 0 || picked.includes(String(entry.value)))
    .map((entry) => {
      const value = String(entry.value);
      const isInclude = include.includes(value);
      const isExclude = exclude.includes(value);
      const marker = isInclude ? '✓ ' : isExclude ? '⊘ ' : '';
      const next = isInclude
        ? '现在：含它。再点一下 → 不含'
        : isExclude
          ? '现在：不含它。再点一下 → 不管它'
          : '现在：不管它。点一下 → 只看含它的';
      return `<button class="filter-opt${isInclude ? ' is-active' : ''}${isExclude ? ' is-excluded' : ''}"
                data-toggle-filter="${esc(dimension)}"
                data-toggle-value="${esc(value)}"
                aria-pressed="${isInclude ? 'true' : 'false'}"
                title="${esc(`${next}（原始值：${value}）`)}">${marker}${esc(entry.label)}<span class="c">${
                  entry.count
                }</span></button>`;
    })
    .join('');

  // 标题右侧的摘要：含与不含分开报，各自看得见（票里画的就是「已选 2 · 排除 1」）
  const summary = include.length
    ? exclude.length
      ? `已选 ${include.length} · 排除 ${exclude.length}`
      : `已选 ${include.length}`
    : exclude.length
      ? `排除 ${exclude.length}`
      : `${all.length} 项`;
  const pickedText = [
    ...include.map((value) => esc(dimensionLabel(dimension, value))),
    ...exclude.map((value) => `<span class="is-excluded">⊘${esc(dimensionLabel(dimension, value))}</span>`),
  ].join('、');

  // 有选中/排除、或用户自己展开过，就保持展开 —— 点选导致的重绘不会把它收回去
  const open = include.length > 0 || exclude.length > 0 || state.facetsOpen[dimension] === true;
  return `
    <details class="filter-facet" data-facet="${esc(dimension)}"${open ? ' open' : ''}>
      <summary class="facet-head">
        <span class="facet-title">${esc(FACET_TITLES[dimension] ?? dimension)}</span>
        <span class="facet-count">${summary}</span>
        <span class="facet-picked">${pickedText}</span>
        <span class="facet-caret">▾</span>
      </summary>
      <div class="filter-opts${scroll ? ' is-scroll' : ''}">${options}</div>
    </details>`;
}

/**
 * 「历史季度会一直保留」的显式说明（用户诉求 4）。
 *
 * 数据库层面本来就保留历史季度 —— 但用户看不到这件事，所以要在界面上说出来：
 * 库里有哪些季度、各有多少部、最后一次更新是什么时候。
 * 第五轮起这里同时是**多选器**：点一下选中/取消，选多个季度会合并查询。
 */
function seasonLibraryNotice(overview) {
  const summaries = overview.seasonSummaries ?? [];
  if (summaries.length === 0) return '';

  const selected = state.selectedSeasons.length > 0 ? state.selectedSeasons : [state.season];
  // 「全选」按钮：放在季度标签**最前面**（用户诉求 2 —— 全选之后再逐个点掉 8 个标签太麻烦）。
  // 再点一次的含义是"回到只选当季"：不这么设计的话，全选之后想回到单季没有任何快捷出路。
  // ⚠ 判定"是否已全选"只看**每个季度是否都在选中集合里**，不要额外比长度：
  //   选中集合里可能还含 `state.season`（若它不在 seasonSummaries 里），比长度会得出"没全选"，
  //   而界面上看起来明明全选了 —— 按钮状态与点击行为就会不一致。
  const allSelected = summaries.every((item) => selected.includes(item.season));
  const allButton = `<button class="chip chip-all ${allSelected ? 'is-active' : ''}" data-season-all="1"
      aria-pressed="${allSelected ? 'true' : 'false'}"
      title="点一下选中库里所有季度（主季仍是当季）；再点一次回到只选当季">${
        allSelected ? '✓ ' : ''
      }全选${allSelected ? ' · 全部季度' : ''}</button>`;

  const chips = summaries
    .map((item) => {
      const active = selected.includes(item.season);
      return `<button class="chip ${active ? 'is-active' : ''}" data-season-toggle="${esc(
        item.season,
      )}" aria-pressed="${active ? 'true' : 'false'}" title="点一下选中/取消；选多个季度会合并查询。最后更新：${esc(
        String(item.updatedAt ?? '').slice(0, 16).replace('T', ' '),
      )}">${active ? '✓ ' : ''}${esc(item.season)} · ${item.subjects} 部</button>`;
    })
    .join('');

  const isMulti = selected.length > 1;
  return `
    <div class="card dist card-block">
      <h3 class="section-title">库里已有的季度（可多选，历史数据会一直保留）</h3>
      <p class="muted">
        点季度标签可以<b>同时选多个</b>，下面的番剧列表就是这几季的合集（共 <b>${
          overview.totals.all
        }</b> 部），分布与筛选也一起算。
        同步只写入当季，<b>从不删除</b>任何历史季度 —— 过季的番仍然在库里，随时可以切过去回看。
        想让更早的季度也进库，点右上角「更新数据」，它会增量回填最近几个季度。
        ${isMulti ? '<br />⚠ 周视图与 .ics 导出按<b>主季</b>（第一个选中的季度）计算。' : ''}
      </p>
      <div class="my-tabs">${allButton}${chips}</div>
    </div>`;
}

function emptyListHtml() {
  return '<div class="empty">没有匹配的番剧 —— 换个关键词，或点「筛选」把条件放宽</div>';
}

function subjectListHtml() {
  const items = filteredSubjects();
  return items.length ? items.map(subjectRow).join('') : emptyListHtml();
}

/**
 * 「每行几部」→ 加在列表容器上的类名（`.per-row-N`），列数由 `web/styles.css` 给出。
 *
 * 为什么是类名而不是"目标宽度"：以前这里写的是
 * `--per-row-w: calc((100% - (N-1)*10px) / N)`，配合 CSS 里的
 * `repeat(auto-fill, minmax(..., 1fr))`。`auto-fill` 的语义是"能放几列就放几列"，
 * 于是**列数由浏览器按窗口宽度自己决定，用户选的值根本没有约束力** ——
 * 窗口一宽就会自己多排一列（选 4 部排出 5、6 部）。
 *
 * 为什么不是"写成 CSS 变量再 repeat(var(--x), …)"：`repeat()` 的第一个参数**只能是整数**，
 * 一旦包上 min()/calc() 就不再是字面量整数，整条声明会被浏览器丢弃
 * （列表会塌成单列）。所以列数必须由样式表写成字面量，这里只负责挂类名。
 * 这条约束有静态守卫：`scripts/verify.ts` 会检查 styles.css 里每个 repeat() 的首参。
 *
 * 窄屏降档（1500px→最多 5 列 / 1100px→3 列 / 760px→2 列 / 420px→1 列）
 * 由 CSS 的媒体查询负责，见 `web/styles.css` 第 10 节。
 */
function perRowStyle() {
  const perRow = PER_ROW_OPTIONS.includes(state.perRow) ? state.perRow : PER_ROW_DEFAULT;
  return `per-row-${perRow}`;
}

/**
 * 只重绘"会被筛选/排序影响的部分" + 筛选面板的正文，**不碰面板第 1 层**。
 *
 * 为什么分开：第 1 层是搜索框，面板整体重绘会把它的焦点弄丢（在里面打字时尤其明显）。
 * 这条原则从第五轮起就在（原来靠"搜索框放在面板外"实现），现在搜索框进了面板，
 * 就靠 `#filter-panel-head` / `#filter-panel-body` 的拆分继续成立。
 */
function refreshSubjectList() {
  const container = $('#subject-list');
  if (container) {
    // 只重设"每行几部"这个类，不能整体重写 style / class：
    // 那会把列表上别的状态一起抹掉，也让以后新增的类莫名失效。
    container.classList.remove('per-row-3', 'per-row-4', 'per-row-5', 'per-row-6', 'per-row-7');
    container.classList.add(perRowStyle());
    container.innerHTML = subjectListHtml();
  }
  const shown = $('#subject-count');
  if (shown) {
    shown.textContent = `显示 ${filteredSubjects().length} / ${baseFilteredSubjects().length} 部`;
  }
  const active = $('#active-filters');
  if (active) active.innerHTML = activeFilterChips();
  // 开关上的徽标（筛了几项）要跟着变；收起时它是"我筛了东西"的唯一可见提示之一
  syncFilterToggle();
}

/**
 * 总览视图。
 *
 * 面板拆成两个槽，是这一版最容易改坏的地方：
 *   `#filter-panel-head` 第 1 层（搜索框 + 部数）—— **常驻**，只有整个视图重绘时才换；
 *   `#filter-panel-body` 第 2~5 层 —— 每次点筛选/排序/每行几部都重绘（`renderFilterPanelBody`）。
 * 把搜索框画进 body 里，就等于把"打字时光标不丢"这条一起画没了。
 */
function renderSeason() {
  const overview = state.overview;

  if (state.selectedSeasons.length === 0) state.selectedSeasons = [state.season];

  const base = baseFilteredSubjects();

  $('#app').innerHTML = `
    ${seasonLibraryNotice(overview)}

    <div class="filter-panel" id="filter-panel">
      <div id="filter-panel-head">${filterPanelHeadHtml(base)}</div>
      <div id="filter-panel-body"${state.filtersCollapsed ? ' hidden' : ''}>${filterPanelBodyHtml(base)}</div>
    </div>

    <div id="active-filters">${activeFilterChips()}</div>

    <div id="subject-list" class="subject-list ${perRowStyle()}">${subjectListHtml()}</div>`;

  const search = $('#season-search');
  if (search) {
    search.addEventListener('input', (event) => {
      state.searchQuery = event.target.value;
      refreshSubjectList();
      // 搜索词会改变候选与部数，所以面板正文要跟着刷新 —— 但**不能**碰第 1 层自己，
      // 否则每打一个字就换一次输入框节点，光标直接飞走。
      renderFilterPanelBody();
    });
  }
}

// ---------------------------------------------------------------------------
// 视图：我的追番 / 补番库
// ---------------------------------------------------------------------------

async function renderMy() {
  const data = await api('/api/my');
  const groups = data.groups;
  const labels = { tracking: '追番中', backlog: '补番库', finished: '已看完', dropped: '已弃番' };

  const totalMine = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
  $('#tab-my-count').textContent = String(groups.tracking.length + groups.backlog.length);

  const items = groups[state.myCategory] ?? [];

  const rows = items
    .map((item) => {
      const total = item.totalEps;
      const watched = item.watchedEps;
      const percent = total ? Math.min(100, Math.round((watched / total) * 100)) : 0;
      const remainingText =
        item.remaining === null ? '剩余集数未知' : `还剩 ${item.remaining} 集 · 约 ${humanDuration(item.remaining * (item.durationMin ?? 24) * 60_000)}`;

      const buttons = [];
      if (state.myCategory === 'tracking' || state.myCategory === 'backlog') {
        buttons.push(`<button class="btn btn-sm" data-watched="${esc(item.subjectKey)}" data-delta="1">+1 集</button>`);
        if (watched > 0) buttons.push(`<button class="btn btn-sm" data-watched="${esc(item.subjectKey)}" data-delta="-1">-1</button>`);
      }
      if (state.myCategory === 'backlog') {
        buttons.push(`<button class="btn btn-sm btn-primary" data-category="${esc(item.subjectKey)}" data-to="tracking">移到追番</button>`);
      } else if (state.myCategory === 'tracking') {
        buttons.push(`<button class="btn btn-sm" data-category="${esc(item.subjectKey)}" data-to="backlog">移入补番库</button>`);
      } else {
        buttons.push(`<button class="btn btn-sm" data-category="${esc(item.subjectKey)}" data-to="tracking">重新追番</button>`);
      }
      buttons.push(`<button class="btn btn-sm" data-open="${esc(item.subjectKey)}">详情</button>`);
      buttons.push(`<button class="btn btn-sm btn-danger" data-remove="${esc(item.subjectKey)}">移除</button>`);

      return `
        <div class="subject-row">
          ${coverHtml(item.coverUrl, 'cover')}
          <div class="info">
            <div class="t-cn">${esc(item.titleCn ?? '（无中文名）')} ${machineTag(item.titleCnSource)}</div>
            <div class="t-orig">${esc(item.titleOriginal ?? '')}</div>
            <div class="progress-wrap">
              <span class="progress-track"><span class="progress-fill" style="width:${percent}%"></span></span>
              <span class="progress-text">${esc(watched)}${total ? ` / ${esc(total)}` : ''}</span>
            </div>
            <div class="meta">
              <span class="tag">${esc(item.status)}</span>
              <span class="tag">${esc(item.season ?? '—')}</span>
              ${item.category === 'backlog' ? `<span class="tag tag-purple">${esc(remainingText)}</span>` : ''}
            </div>
          </div>
          <div class="actions">${buttons.join('')}</div>
        </div>`;
    })
    .join('');

  $('#app').innerHTML = `
    <div class="my-tabs">
      ${Object.entries(labels)
        .map(
          ([key, label]) =>
            `<button class="chip ${state.myCategory === key ? 'is-active' : ''}" data-my-category="${key}">${label} ${
              groups[key]?.length ?? 0
            }</button>`,
        )
        .join('')}
      <span class="spacer"></span>
      <span class="hint search-hint">
        共 ${totalMine} 部在列表中 ·
        「更新数据」时会把<b>已播完但没看完</b>的自动移入补番库（并当场告诉你移了哪几部），
        一集没看的不动
      </span>
    </div>
    ${state.myCategory === 'backlog' ? '<div class="section-title">补番库：没看完的当季番与想看的老番都在这里。⚠ 界面里没有「加番」入口 —— 想加没在库里的番，用命令行：<code>pnpm add "番剧名"</code></div>' : ''}
    <div class="subject-list">${rows || '<div class="empty">这个分类还是空的</div>'}</div>`;
}

// ---------------------------------------------------------------------------
// 视图：搜索 / 加番
// ---------------------------------------------------------------------------

function renderSearch() {
  $('#app').innerHTML = `
    <div class="toolbar">
      <input type="search" id="search-input" placeholder="输入中文名 / 日文原名 / 别名，例如「药屋」「芙莉莲」「薬屋」" value="${esc(
        state.searchQuery,
      )}" />
      <button class="btn btn-primary" id="search-go">搜索</button>
    </div>
    <div id="search-results"><div class="empty">本地库会先被搜索（支持中文名与别名），随后再从 AniList 远程搜索。</div></div>`;

  const input = $('#search-input');
  const go = () => {
    state.searchQuery = input.value.trim();
    if (state.searchQuery) void doSearch(state.searchQuery);
  };
  $('#search-go').addEventListener('click', go);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') go();
  });
  if (state.searchQuery) void doSearch(state.searchQuery);
}

async function doSearch(keyword) {
  const container = $('#search-results');
  container.innerHTML = '<div class="loading">搜索中…</div>';
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(keyword)}`);
    const localHtml = data.local.length
      ? `<h3 class="section-title">本地库（已有中文名与分集时刻）</h3>
         <div class="subject-list">${data.local
           .map(
             (item) => `
           <div class="subject-row">
             ${coverHtml(item.coverUrl, 'cover')}
             <div class="info">
               <div class="t-cn">${esc(item.titleCn ?? '（无中文名）')}</div>
               <div class="t-orig">${esc(item.titleOriginal ?? '')}</div>
               <div class="meta">
                 <span class="tag">${esc(item.status)}</span>
                 <span class="tag">${esc(item.season ?? '—')}</span>
                 ${item.totalEps ? `<span class="tag">${esc(item.totalEps)} 话</span>` : ''}
               </div>
             </div>
             <div class="actions">
               <button class="btn btn-sm btn-primary" data-add="${esc(item.key)}" data-category="tracking">加入追番</button>
               <button class="btn btn-sm" data-add="${esc(item.key)}" data-category="backlog">加入补番库</button>
             </div>
           </div>`,
           )
           .join('')}</div>`
      : '<div class="empty empty-inline">本地库没有匹配项</div>';

    const remoteHtml = data.remote.length
      ? `<h3 class="section-title section-title-spaced">AniList 远程结果（没有中文名，加入后需等季度同步补全）</h3>
         <p class="muted">
           加入时会自动归到它的季度，所以之后能在「全季总览」的对应季度里找到它
           （也可以用「补全中文名（机翻）」给它一个临时译名）。
         </p>
         <div class="subject-list">${data.remote
           .map(
             (item, index) => `
           <div class="subject-row">
             ${coverHtml(item.coverUrl, 'cover')}
             <div class="info">
               <div class="t-cn">${esc(item.titleEn ?? '—')}</div>
               <div class="t-orig">${esc(item.titleOriginal ?? '')}</div>
               <div class="meta">
                 <span class="tag">${esc(item.mediaType)}</span>
                 <span class="tag">${esc(item.status)}</span>
                 ${item.totalEps ? `<span class="tag">${esc(item.totalEps)} 话</span>` : ''}
               </div>
             </div>
             <div class="actions">
               <button class="btn btn-sm btn-primary" data-add-remote="${index}" data-category="tracking">加入追番</button>
               <button class="btn btn-sm" data-add-remote="${index}" data-category="backlog">加入补番库</button>
             </div>
           </div>`,
           )
           .join('')}</div>`
      : '<div class="empty empty-inline">远程没有结果（AniList 只认日文/英文名，试试原名）</div>';

    container.innerHTML = `${localHtml}${remoteHtml}${
      data.remoteError ? `<div class="empty" style="color:var(--warn)">远程搜索失败：${esc(data.remoteError)}</div>` : ''
    }`;

    // 远程结果需要先把原始条目写入本地库才能加入列表
    state._remoteCache = data.remote;
  } catch (error) {
    container.innerHTML = `<div class="empty" style="color:var(--danger)">搜索失败：${esc(error.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// 视图：变更（延期 / 改档检测结果）
// ---------------------------------------------------------------------------

async function refreshChangeBadge() {
  try {
    const data = await api('/api/changes');
    const pill = $('#tab-changes-count');
    pill.textContent = String(data.changes.length);
    pill.style.borderColor = data.changes.length > 0 ? 'var(--warn)' : '';
    pill.style.color = data.changes.length > 0 ? 'var(--warn)' : '';
  } catch {
    // 徽标失败不该打断界面
  }
}

async function renderChanges() {
  const data = await api('/api/changes?all=' + (state.showAllChanges ? '1' : '0'));
  const changes = data.changes;

  const kindClass = (kind) =>
    kind === 'delayed'
      ? 'tag-warn'
      : kind === 'advanced'
        ? 'tag-accent'
        : kind === 'episode-added'
          ? 'tag-ok'
          : 'tag-purple';

  $('#app').innerHTML = `
    <div class="toolbar">
      <button class="btn btn-sm ${state.showAllChanges ? '' : 'btn-primary'}" data-changes-filter="pending">待处理 ${data.pending}</button>
      <button class="btn btn-sm ${state.showAllChanges ? 'btn-primary' : ''}" data-changes-filter="all">全部</button>
      <span class="spacer"></span>
      ${
        changes.some((change) => !change.acknowledged)
          ? '<button class="btn btn-sm" data-ack-all="1">全部标记已读</button>'
          : ''
      }
    </div>
    <div class="card dist">
      <h3 class="section-title">变更记录</h3>
      <p class="muted">
        每次「同步当季」时会与库里的历史时刻做对比。同一部番的时间被改动才会记在这里 ——
        因数据源切换或秒级抖动造成的差异会被自动过滤。
      </p>
      ${
        changes.length === 0
          ? '<div class="empty empty-inline">没有变更记录。改档/延期是在同步时通过对比历史发现的，多同步几次就会积累出来。</div>'
          : changes
              .map(
                (change) => `
        <div class="ep-line" style="align-items:center">
          <span class="no" style="width:74px">
            <span class="tag ${kindClass(change.kind)}">${esc(change.kindLabel)}</span>
          </span>
          <span class="t">
            <b>${esc(change.title ?? change.subjectKey)}</b>
            <div class="change-msg">${esc(change.message)}</div>
          </span>
          <span class="at change-at">${esc(change.detectedAt.slice(5, 16).replace('T', ' '))}</span>
          <button class="btn btn-sm" data-open="${esc(change.subjectKey)}">详情</button>
        </div>`,
              )
              .join('')
      }
    </div>`;

  await refreshChangeBadge();
}

// ---------------------------------------------------------------------------
// 番剧详情卡
// ---------------------------------------------------------------------------

async function openDetail(key) {
  const backdrop = $('#modal-backdrop');
  const modal = $('#modal');
  state.detailKey = key;
  modal.innerHTML = '<div class="loading">加载中…</div>';
  backdrop.hidden = false;

  try {
    const { subject } = await api(`/api/subject/${encodeURIComponent(key)}`);
    const my = subject.my;
    const watched = my?.watchedEps ?? 0;

    const fields = [
      ['放送', subject.broadcastWeekdayJst === null ? '—' : `${WEEKDAYS[subject.broadcastWeekdayJst]} ${subject.broadcastTimeJst ?? ''}（JST）`],
      ['首播', subject.firstAirAtUtc ? `${formatJst(subject.firstAirAtUtc)}（JST）` : '—'],
      ['集数', subject.totalEps ? `${subject.totalEps} 话` : '未知'],
      ['制作', subject.studios.length ? subject.studios.join(' / ') : '—'],
      ['类型', subject.genres.length ? subject.genres.join(' / ') : '—'],
      ['平台', [...new Set(subject.platforms.map((p) => p.name))].join(' / ') || '—'],
      ['状态', subject.status],
      ['数据源', subject.sources.join(' + ') || '—'],
    ];

    if (my) {
      const remaining = subject.totalEps ? Math.max(0, subject.totalEps - watched) : null;
      fields.push([
        '我的进度',
        `${watched}${subject.totalEps ? ` / ${subject.totalEps}` : ''}${
          remaining === null ? '（总集数未知）' : `　还剩 ${remaining} 集 · 约 ${humanDuration(remaining * (subject.durationMin ?? 24) * 60_000)}`
        }`,
      ]);
    }

    modal.innerHTML = `
      <div class="modal-head">
        ${coverHtml(subject.coverUrl, '')}
        <div class="h-info">
          <h2>${esc(subject.titleCn ?? subject.titleOriginal ?? subject.key)}</h2>
          <div class="orig">${esc(subject.titleOriginal ?? '')}${subject.titleEn ? ` · ${esc(subject.titleEn)}` : ''}</div>
          <div class="meta">
            <span class="tag">${esc(subject.mediaType)}</span>
            <span class="tag">${esc(subject.season ?? '—')}</span>
            ${my ? `<span class="tag tag-ok">${esc({ tracking: '追番中', backlog: '补番库', finished: '已看完', dropped: '已弃番' }[my.category] ?? my.category)}</span>` : ''}
          </div>
        </div>
        <button class="close-x" data-close="1">×</button>
      </div>
      <div class="modal-body">
        <div class="kv">
          ${fields.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('')}
        </div>
        ${
          subject.episodes.length
            ? `<h3 class="section-title">分集（共 ${subject.episodes.length} 集已知）</h3>
               <div class="ep-list">
                 ${subject.episodes
                   .map(
                     (ep) => `
                   <div class="ep-line${ep.epNumber <= watched ? ' is-watched' : ''}${ep.airAtUtc && ep.airAtUtc >= new Date().toISOString() && ep.epNumber === subject.episodes.find((x) => x.airAtUtc && x.airAtUtc >= new Date().toISOString())?.epNumber ? ' is-next' : ''}">
                     <span class="no">${ep.epNumber <= watched ? '✓' : ''} ${esc(ep.epNumber)}</span>
                     <span class="t">${esc(ep.titleCn ?? ep.title ?? '')}</span>
                     <span class="at">${esc(formatJst(ep.airAtUtc))}</span>
                     <span class="at ep-line-source">${esc(ep.airSource ?? '')}</span>
                   </div>`,
                   )
                   .join('')}
               </div>`
            : '<div class="empty empty-inline">还没有分集数据 —— 在周视图里加进追番后，同步一次就会有了</div>'
        }
      </div>
      <div class="modal-actions">
        ${
          my
            ? `<button class="btn btn-primary" data-watched="${esc(key)}" data-delta="1" data-reload="1">看了一集 (+1)</button>
               <button class="btn" data-category="${esc(key)}" data-to="${my.category === 'backlog' ? 'tracking' : 'backlog'}" data-reload="1">${
                 my.category === 'backlog' ? '移到追番中' : '移入补番库'
               }</button>
               <button class="btn btn-danger" data-remove="${esc(key)}" data-reload="1">移除</button>`
            : `<button class="btn btn-primary" data-add="${esc(key)}" data-category="tracking" data-reload="1">加入追番</button>
               <button class="btn" data-add="${esc(key)}" data-category="backlog" data-reload="1">加入补番库</button>`
        }
        ${subject.siteUrl ? `<a class="btn" href="${esc(subject.siteUrl)}" target="_blank" rel="noreferrer">打开 Bangumi 页面</a>` : ''}
        ${
          subject.platforms.find((p) => p.url)
            ? `<a class="btn" href="${esc(subject.platforms.find((p) => p.url).url)}" target="_blank" rel="noreferrer">去 ${esc(
                subject.platforms.find((p) => p.url).name,
              )} 看</a>`
            : ''
        }
      </div>
      ${
        subject.fieldSources && Object.keys(subject.fieldSources).length
          ? `<div class="modal-body modal-sources">
               字段来源：${Object.entries(subject.fieldSources)
                 .map(([field, source]) => `${esc(field)} ← ${esc(source)}`)
                 .join('　')}
             </div>`
          : ''
      }`;
  } catch (error) {
    modal.innerHTML = `<div class="modal-body"><div class="empty" style="color:var(--danger)">加载失败：${esc(
      error.message,
    )}</div></div>`;
  }
}

function closeDetail() {
  $('#modal-backdrop').hidden = true;
  state.detailKey = null;
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function addToList(subjectKey, category, reloadDetail = false) {
  await api('/api/my', { method: 'POST', body: JSON.stringify({ subjectKey, category }) });
  toast(category === 'backlog' ? '已加入补番库' : '已加入追番');
  await refresh(reloadDetail);
}

async function patchMy(subjectKey, patch, reloadDetail = false) {
  await api(`/api/my/${encodeURIComponent(subjectKey)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  await refresh(reloadDetail);
}

async function removeFromList(subjectKey, reloadDetail = false) {
  await api(`/api/my/${encodeURIComponent(subjectKey)}`, { method: 'DELETE' });
  toast('已从列表移除');
  await refresh(reloadDetail);
}

async function syncSeason() {
  const button = $('#sync-btn');
  button.disabled = true;
  setStatus('正在同步本季数据…');
  try {
    const result = await api(`/api/sync?season=${encodeURIComponent(state.season)}`, { method: 'POST' });
    const failed = result.reports.filter((report) => !report.ok);
    const changeCount = (result.changes ?? []).length;
    setStatus(
      `同步完成：写入 ${result.written} 部 / ${result.episodeCount} 集` +
        (result.archive.toBacklog.length ? ` · ${result.archive.toBacklog.length} 部移入补番库` : '') +
        (changeCount ? ` · 检测到 ${changeCount} 条改档` : '') +
        (failed.length ? ` · ${failed.length} 个源失败` : ''),
      failed.length ? 'error' : 'ok',
    );
    reportArchiveMove(result.moved ?? result.archive.moved ?? []);
    if (changeCount) toast(`检测到 ${changeCount} 条延期/改档，已记入「变更」`);
    for (const report of failed) toast(`${report.provider} 失败：${(report.error ?? '').split('\n')[0]}`, true);
    await refresh();
    await refreshChangeBadge();
  } catch (error) {
    setStatus(`同步失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

/**
 * 把「哪几部番被自动移进了补番库/已看完」明确告诉用户。
 *
 * 这一步很重要：自动归档本身是 D6/T8 要的行为，不能删；
 * 但它会让番从「追番中」消失，用户会以为记录丢了（见 docs/交接说明-第二轮.md P0-5）。
 * 所以必须主动说出来 —— 沉默的自动搬运就是「记录消失」。
 */
function reportArchiveMove(moved) {
  if (!moved || moved.length === 0) return;
  const names = moved.map((item) => `${item.title}（${item.to === 'backlog' ? '补番库' : '已看完'}）`);
  toast(`已自动移动 ${moved.length} 部：${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}`);
}

/** 一键更新数据：当季 + 历史回填 + 官方名替换机翻 + 缺中文名的机翻。 */
async function updateData() {
  const button = $('#update-btn');
  button.disabled = true;
  setStatus('正在更新数据：抓取当季 → 回填历史季度 → 补中文名…（可能要 1~2 分钟）');

  // 机翻是逐条串行的，进度只能靠轮询状态文案；先给一个会变的提示
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    setStatus(`正在更新数据…已等待 ${tick * 2} 秒（回填历史季度与机翻都比较慢，请勿关闭页面）`);
  }, 2000);

  try {
    const result = await api(`/api/update?season=${encodeURIComponent(state.season)}&backfill=3`, { method: 'POST' });
    const summary = result.summary;

    const parts = [
      `写入 ${summary.written} 部 / ${summary.episodes} 集`,
      summary.machineFilled ? `机翻补齐 ${summary.machineFilled} 个中文名` : '',
      summary.officialReplaced ? `官方名替换 ${summary.officialReplaced} 个` : '',
      summary.movedToBacklog ? `${summary.movedToBacklog} 部移入补番库` : '',
      summary.changeCount ? `检测到 ${summary.changeCount} 条改档` : '',
      summary.failedProviders.length ? `${summary.failedProviders.length} 个源失败` : '',
    ].filter(Boolean);

    setStatus(`更新完成：${parts.join(' · ')}`, summary.failedProviders.length ? 'error' : 'ok');

    reportArchiveMove(result.current?.moved ?? []);
    if (summary.machineFilled) {
      toast(
        `已用机翻补上 ${summary.machineFilled} 个临时中文名（标了「临时机翻」）；` +
          `官方译名一到，再点一次「更新数据」就会自动替换`,
      );
    }
    if (summary.officialReplaced) {
      toast(`官方译名替换掉了 ${summary.officialReplaced} 个临时机翻名`);
    }
    for (const provider of summary.failedProviders) toast(`${provider} 失败`, true);
    if (summary.translationFailures) toast(`有 ${summary.translationFailures} 条机翻失败（不影响其它数据）`, true);

    showUpdateDetail(result);
    await refresh();
    await refreshChangeBadge();
  } catch (error) {
    setStatus(`更新失败：${error.message}`, 'error');
  } finally {
    clearInterval(timer);
    button.disabled = false;
  }
}

/** 更新完成后把明细摊在界面上 —— 汇总成一句话会说谎，明细不会。 */
function showUpdateDetail(result) {
  const summary = result.summary;
  const lines = [];

  lines.push(
    `<b>当季</b>：写入 ${summary.written - (result.archive?.totalWritten ?? 0)} 部 / ${
      summary.episodes - (result.archive?.totalEpisodes ?? 0)
    } 集`,
  );

  const seasons = result.archive?.seasons ?? [];
  if (seasons.length > 0) {
    const detail = seasons
      .map((item) => {
        const mark = item.status === 'fetched' ? '✓' : item.status === 'skipped' ? '·' : '!';
        return `${mark} ${item.season}${item.status === 'fetched' ? `（${item.written} 部）` : item.note ? `（${item.note}）` : ''}`;
      })
      .join('　');
    lines.push(`<b>历史回填</b>：${detail}`);
  }

  if (result.seasonsRepaired) {
    lines.push(`<b>季度归属纠正</b>：${result.seasonsRepaired} 条（按各自的放送时刻重新归到正确的季度）`);
  }
  if (result.healed?.replaced) lines.push(`<b>官方译名替换临时机翻</b>：${result.healed.replaced} 部`);
  if (result.translated?.count) {
    const samples = (result.translated.titles ?? [])
      .slice(0, 6)
      .map((item) => `${esc(item.titleOriginal)} → ${esc(item.titleCn)}`)
      .join('　');
    lines.push(`<b>临时机翻补齐</b>：${result.translated.count} 部　<span class="change-msg">${samples}</span>`);
  }
  if (result.translated?.failed?.length) {
    lines.push(
      `<span style="color:var(--warn)"><b>机翻失败</b>：${result.translated.failed.length} 条（${
        result.translated.failed[0]?.error ?? ''
      }）</span>`,
    );
  }
  if (result.backup) lines.push(`<b>更新前已自动备份</b>：<code>${esc(String(result.backup.path).split('\\').pop())}</code>`);

  const panel = document.createElement('div');
  panel.className = 'card dist';
  panel.style.marginTop = '16px';
  panel.innerHTML = `
    <h3 class="section-title">上次「更新数据」的明细</h3>
    <div class="update-lines">${lines.join('<br />')}</div>
    <div class="update-actions">
      <a class="btn btn-sm" href="/api/export" title="导出追番列表与进度">导出我的数据</a>
      <button class="btn btn-sm" data-dismiss-update="1">知道了</button>
    </div>`;
  $('#app').prepend(panel);
}

/** 只补中文名（机翻）。官方译名一到，更新数据会自动替换。 */
async function translateMissing() {
  const button = $('#translate-btn');
  button.disabled = true;
  setStatus('正在为缺中文名的番做临时机翻…（逐条串行，可能要一会儿）');
  try {
    const result = await api(`/api/translate?season=${encodeURIComponent(state.season)}`, { method: 'POST' });
    setStatus(
      `机翻完成：补上 ${result.translatedCount} 个中文名` +
        (result.skipped ? ` · 跳过 ${result.skipped} 部（纯拉丁原名等不需要翻）` : '') +
        (result.failed.length ? ` · ${result.failed.length} 条失败` : '') +
        ` · 本季仍缺中文名 ${result.remaining} 部`,
      result.failed.length ? 'error' : 'ok',
    );
    if (result.translatedCount) {
      toast(`已补上 ${result.translatedCount} 个临时中文名；官方译名一到，点「更新数据」会自动替换`);
    } else {
      toast('没有需要机翻的条目');
    }
    await refresh();
  } catch (error) {
    setStatus(`机翻失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

/** 重新拉数据并重绘当前视图（改完追番列表后调用）。 */
async function refresh(reloadDetail = false) {
  try {
    if (state.view === 'week') await renderWeek();
    else if (state.view === 'season') {
      await loadOverview();
      renderSeason();
    } else if (state.view === 'my') await renderMy();
    else if (state.view === 'changes') await renderChanges();
    else if (state.view === 'search') void doSearch(state.searchQuery);

    if (reloadDetail && state.detailKey) await openDetail(state.detailKey);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function switchView(view) {
  state.view = view;
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === view));

  if (view === 'week') await renderWeek();
  else if (view === 'season') {
    if (!state.overview) await loadOverview();
    renderSeason();
  } else if (view === 'my') await renderMy();
  else if (view === 'changes') await renderChanges();
  else renderSearch();
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function bootstrap() {
  // 先恢复布局偏好，再拉数据 —— 排序口径要跟着请求一起发给服务端
  state.perRow = readStoredNumber(LS_PER_ROW, PER_ROW_OPTIONS, PER_ROW_DEFAULT);
  state.sort = readStoredString(
    LS_SORT,
    SORT_OPTIONS.map((option) => option.key),
    'firstAir',
  );
  // 第 2 层多个状态之间默认"且"（线上老行为）；用户切过就按记下来的来。
  state.statusAnd = localStorage.getItem(LS_STATUS_AND) !== '0';
  // 面板收没收起来也记住（收起是"我想看列表"的意思，下次打开不该又铺开）
  state.filtersCollapsed = localStorage.getItem(LS_FILTERS_COLLAPSED) === '1';

  const health = await api('/api/health');
  const current = await api(`/api/overview?season=&sort=${encodeURIComponent(state.sort)}`);

  state.season = current.season.id;
  state.selectedSeasons = [current.season.id];
  state.overview = current;

  const select = $('#season-select');
  const seasons = [...new Set([current.season.id, ...current.availableSeasons])];
  const subjectCounts = new Map((current.seasonSummaries ?? []).map((item) => [item.season, item.subjects]));
  select.innerHTML = seasons
    .map((id) => {
      const count = subjectCounts.get(id);
      const label = count === undefined ? `${id}（库里没有）` : `${id} · ${count} 部`;
      return `<option value="${esc(id)}"${id === state.season ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
  $('#tab-my-count').textContent = String(current.totals.tracking + current.totals.backlog);
  syncSeasonUi();

  if (health.stats.subjects === 0) {
    setStatus('本地库还是空的，点右上角「更新数据」开始（也可以先「只同步本季」快速看当季）');
  }

  await refreshChangeBadge();
  await switchView('week');
}

// 顶部控制区的按钮自己绑了监听，所以要在事件委托里排除掉，
// 否则点一次会跑两遍（「更新数据」跑两遍 = 两倍的源站请求与机翻额度）。
// 这是加固时发现的既有缺陷：界面上点了会重复触发，只是以前的两个按钮恰好幂等才没暴露。
const SELF_HANDLED = new Set(['update-btn', 'sync-btn', 'translate-btn']);

/**
 * 收起顶栏的「更多」菜单。
 *
 * `<details>` 自己管开合，但它**不会**在点别处时自动关 —— 不补这个的话菜单会一直挂着，
 * 挡住下面的内容。点菜单里的按钮时也顺手关掉（动作本身照常执行）。
 */
function closeMoreMenu() {
  const menu = $('#more-menu');
  if (menu?.open) menu.open = false;
}

// 事件委托：所有按钮都在这里统一处理，避免给每个元素单独绑事件
document.addEventListener('click', (event) => {
  if (!event.target.closest('#more-menu')) closeMoreMenu();

  // 除了按钮/链接，**可交互卡片**（整块可点，例如点番剧卡片弹详情）也要作为事件目标。
  // ⚠ 不要为了图省事改成 `closest('*')`：那样点页面任何空白都会进来，
  //   下面那些 `target.id === '...'` 分支的语义会被搅乱。
  const target =
    event.target.closest('button, a') ?? event.target.closest('[data-interactive]');
  if (!target) {
    if (event.target.id === 'modal-backdrop') closeDetail();
    return;
  }
  if (target.id && SELF_HANDLED.has(target.id)) return;

  // ⚠ 这里**不能**写 `if (target.closest('#filter-panel')) return;`。
  //   那是把筛选块放在面板外面时的写法（点击委托只管面板外的元素）。
  //   第五轮把筛选块折进面板之后，所有 data-toggle-filter / data-quick-filter /
  //   data-per-row / data-sort 按钮**都在面板里** —— 加这句会把它们全部吃掉：
  //   表现就是"点筛选块毫无反应、也不高亮"。这正是第六轮踩到的真 bug。
  //   面板内部的交互本来就是靠点击委托统一处理的，所以这里直接往下走。

  const dataset = target.dataset;

  // 「筛选」开关：整体展开 / 收起面板正文。**不重绘任何东西**，只切 hidden 与箭头 ——
  // 见 applyFilterPanelCollapsed 的注释（重绘会丢搜索框焦点）。
  // ⚠ 必须放在 `const dataset = ...` **之后**：放前面会踩 TDZ（Cannot access 'dataset'
  //   before initialization），表现就是"点这个按钮抛异常、毫无反应"。
  if (dataset.filterCollapse) {
    state.filtersCollapsed = !state.filtersCollapsed;
    store(LS_FILTERS_COLLAPSED, state.filtersCollapsed ? '1' : '0');
    applyFilterPanelCollapsed();
    return;
  }
  if (dataset.dismissUpdate) {
    target.closest('.card')?.remove();
    return;
  }
  // 点卡片上任意处都可以弹详情（原来的「详情」按钮已按需求去掉）。
  // ⚠ **必须在按钮分支之后**：追番 / 补番 / 移除 / 复制点了就只是那件事，
  //   不能连带弹详情。点击事件会从按钮冒泡到卡片，所以只靠"按钮自己 stopPropagation"
  //   不够稳（少写一个就是 bug），这里用"先处理按钮分支、卡片分支放最后"的结构兜底。
  if (dataset.copy) {
    void copySubjectTitle(dataset.copy);
    return;
  }
  if (dataset.seasonAll) {
    void selectAllSeasons();
    return;
  }
  if (dataset.seasonToggle) {
    void toggleSeason(dataset.seasonToggle);
    return;
  }
  if (dataset.weekOffset !== undefined) {
    state.offset = Number(dataset.weekOffset);
    void renderWeek();
    return;
  }
  // ---- 第 3 层：点一下 = 不选 → 含 → 不含 → 不选（三态循环） ----
  if (dataset.toggleFilter) {
    cycleFilterValue(dataset.toggleFilter, String(dataset.toggleValue ?? ''));
    refreshSubjectList();
    renderFilterPanelBody();
    return;
  }
  // 条件条上点某一项的 ✕：把"含"和"不含"两侧一起清掉（不是三态循环 —— 那里点一下是换态）
  if (dataset.clearFilter) {
    clearFilterValue(dataset.clearFilter, String(dataset.clearValue ?? ''));
    refreshSubjectList();
    renderFilterPanelBody();
    return;
  }
  // 第 2 层多个状态之间：且 ⇄ 或（这是个偏好，记在 localStorage 里）
  if (dataset.statusMode) {
    state.statusAnd = !state.statusAnd;
    store(LS_STATUS_AND, state.statusAnd ? '1' : '0');
    refreshSubjectList();
    renderFilterPanelBody();
    return;
  }
  if (dataset.quickFilter) {
    const value = dataset.quickFilter;
    const current = state.filters.side ?? [];
    const index = current.indexOf(value);
    if (index >= 0) current.splice(index, 1);
    else current.push(value);
    state.filters.side = current;
    refreshSubjectList();
    renderFilterPanelBody();
    return;
  }
  if (dataset.clearFilters) {
    state.filters = emptyFilters();
    refreshSubjectList();
    renderFilterPanelBody();
    return;
  }
  if (dataset.perRow) {
    const perRow = Number(dataset.perRow);
    if (PER_ROW_OPTIONS.includes(perRow)) {
      state.perRow = perRow;
      store(LS_PER_ROW, perRow);
    }
    refreshSubjectList();
    renderFilterPanelBody();
    return;
  }
  if (dataset.sort) {
    void changeSort(dataset.sort);
    return;
  }
  if (dataset.myCategory) {
    state.myCategory = dataset.myCategory;
    void renderMy();
    return;
  }
  if (dataset.changesFilter) {
    state.showAllChanges = dataset.changesFilter === 'all';
    void renderChanges();
    return;
  }
  if (dataset.ackAll) {
    void (async () => {
      try {
        const result = await api('/api/changes/ack', { method: 'POST', body: JSON.stringify({}) });
        toast(`已标记 ${result.acknowledged} 条变更为已读`);
        await renderChanges();
      } catch (error) {
        toast(error.message, true);
      }
    })();
    return;
  }
  if (dataset.open) {
    void openDetail(dataset.open);
    return;
  }
  if (dataset.close) {
    closeDetail();
    return;
  }
  if (dataset.add) {
    void addToList(dataset.add, dataset.category ?? 'tracking', dataset.reload === '1');
    return;
  }
  if (dataset.addRemote !== undefined) {
    const item = (state._remoteCache ?? [])[Number(dataset.addRemote)];
    if (!item?.raw) return;
    // 远程条目先落库，再入列表：服务端 add 需要库里已存在该 subject
    void (async () => {
      try {
        setStatus('正在写入这部番…');
        const written = await api(
          `/api/search/import?season=${encodeURIComponent(state.season)}`,
          { method: 'POST', body: JSON.stringify({ raw: item.raw }) },
        );
        // 季度回填结果要说出来：否则从搜索加入的番在全季总览里找不到，会让人以为"加进去的番没了"
        if (written.season) {
          toast(`已归到 ${written.season} 季，可在季度下拉框切过去查看`);
        }
        await addToList(written.subjectKey, dataset.category ?? 'tracking');
        setStatus('');
      } catch (error) {
        toast(`写入失败：${error.message}`, true);
      }
    })();
    return;
  }
  if (dataset.watched) {
    const delta = Number(dataset.delta ?? 1);
    void (async () => {
      try {
        const { subject } = await api(`/api/subject/${encodeURIComponent(dataset.watched)}`);
        const next = Math.max(0, (subject.my?.watchedEps ?? 0) + delta);
        await patchMy(dataset.watched, { watchedEps: next }, dataset.reload === '1');
      } catch (error) {
        toast(error.message, true);
      }
    })();
    return;
  }
  if (dataset.category && dataset.to) {
    void patchMy(dataset.category, { category: dataset.to }, dataset.reload === '1');
    return;
  }
  if (dataset.remove) {
    void removeFromList(dataset.remove, dataset.reload === '1');
    return;
  }
  // ⚠ 卡片整体可点这一条**必须放在最后**：上面任何按钮分支一旦命中就已经 return，
  //   所以点「追番 / 补番 / 移除 / 复制」都不会走到这里、不会连带弹详情。
  //   以后新增卡片内的按钮时，也要把它的分支加在这条**之前**。
  if (dataset.subjectRow) {
    void openDetail(dataset.key);
    return;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Esc 优先收菜单（它比详情弹窗更"浅"），没有菜单开着再关弹窗
    const menu = $('#more-menu');
    if (menu?.open) {
      menu.open = false;
      return;
    }
    closeDetail();
    return;
  }
  // 键盘可达：卡片现在是"点一下弹详情"的交互元素，Tab 聚焦后回车/空格也要能打开。
  // （只加鼠标点击会让键盘用户打不开详情 —— 第六轮刚统一过键盘焦点样式，不要退回去。）
  // ⚠ `closest` 会**向上**遍历：焦点落在卡片里某个按钮上时它仍然命中卡片。
  //   若不排除按钮，这里会出两个静默 bug：
  //     · 空格：preventDefault 会阻止浏览器"keydown Space → click"的默认转换，
  //       于是卡片内按钮**永远按不动**（键盘用户彻底用不了追番/补番/移除/复制）；
  //     · 回车：浏览器在 keydown 阶段就派发了 click（按钮生效），这里再开一次详情 —— 多弹一个。
  //   所以只在"焦点就在卡片本身"时接管。
  if (event.key === 'Enter' || event.key === ' ') {
    const row = event.target?.closest?.('[data-subject-row]');
    if (row && !event.target.closest?.('button, a')) {
      event.preventDefault();
      void openDetail(row.dataset.key);
    }
  }
});

$('#update-btn').addEventListener('click', () => void updateData());
$('#sync-btn').addEventListener('click', () => void syncSeason());
$('#translate-btn').addEventListener('click', () => void translateMissing());

/** 请求总览时带上"选中的季度们"和排序口径。 */
function overviewQuery() {
  const seasons = state.selectedSeasons.length > 0 ? state.selectedSeasons : [state.season];
  return `season=${encodeURIComponent(seasons.join(','))}&sort=${encodeURIComponent(state.sort)}`;
}

/** 拉一次总览并把它应用到界面上（季度 / 排序变了都走这里）。 */
async function loadOverview() {
  state.overview = await api(`/api/overview?${overviewQuery()}`);
  return state.overview;
}

/** 主季 = 选中的第一个季度。周视图、.ics 都是单季口径，用主季。 */
function primarySeason() {
  return state.selectedSeasons[0] ?? state.season;
}

/** 界面上的季度徽标 / .ics 链接 / 下拉框，都跟着"选中集合"走。 */
function syncSeasonUi() {
  const count = state.selectedSeasons.length;
  const badge = $('#season-badge');
  if (badge) {
    badge.textContent =
      count > 1
        ? `${state.selectedSeasons[0]} 等 ${count} 季`
        : (state.overview?.season?.label ?? primarySeason());
  }
  const ics = $('#ics-link');
  if (ics) ics.href = `/api/ics?season=${encodeURIComponent(primarySeason())}&rule=${state.rule}`;
  const select = $('#season-select');
  if (select) select.value = primarySeason();
}

/** 点季度标签：选中 / 取消（可多选）。 */
async function toggleSeason(seasonId) {
  const index = state.selectedSeasons.indexOf(seasonId);
  if (index >= 0) {
    // 不允许一个都不选 —— 空集合会让请求回落到"当季"，和界面显示对不上
    if (state.selectedSeasons.length === 1) {
      toast('至少要留一个季度');
      return;
    }
    state.selectedSeasons.splice(index, 1);
  } else {
    state.selectedSeasons.push(seasonId);
  }
  await applySeasonChange();
}

/** 单选切换季度（顶部下拉框用）：整体替换选中集合。 */
async function selectSeason(seasonId) {
  state.selectedSeasons = [seasonId];
  await applySeasonChange();
}

/**
 * 「全选」：选中库里所有季度；已经全选时再点一次 = 回到只选当季。
 *
 * 两个刻意的设计：
 * 1. **主季（`selectedSeasons[0]`）保持为当前季**。周视图与 `.ics` 导出按主季算
 *    （见 primarySeason 与下方那句警告），若把列表里最新的季度排到最前，
 *    用户点一下"全选"就会连带改变周视图的内容 —— 那不是他要的效果。
 * 2. **再点一次回到只选当季**。全选后想回到单季，否则得逐个点掉 8 个标签。
 */
async function selectAllSeasons() {
  const all = (state.overview?.seasonSummaries ?? []).map((item) => item.season);
  if (all.length === 0) return;

  // 与 seasonLibraryNotice() 里的判定保持同一口径：只问"库里每个季度是否都已选中"，
  // 不比较集合长度（原因见那里的注释）。
  const isAllSelected = all.every((season) => state.selectedSeasons.includes(season));

  state.selectedSeasons = isAllSelected ? [state.season] : [state.season, ...all.filter((s) => s !== state.season)];
  await applySeasonChange();
}

async function applySeasonChange() {
  state.season = primarySeason();
  state.offset = 0;
  try {
    await loadOverview();
    syncSeasonUi();
    await refresh();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

/** 切换排序：要重新问服务端要列表（数据库里做排序，不在前端排）。 */
async function changeSort(sortKey) {
  if (!SORT_OPTIONS.some((option) => option.key === sortKey)) return;
  state.sort = sortKey;
  store(LS_SORT, sortKey);
  try {
    await loadOverview();
    renderSeason();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

/**
 * 面板开关上的箭头与计数徽标。
 *
 * 为什么单独一个函数：第 1 层是**常驻节点**、点筛选时不重绘，所以徽标（筛了几项）
 * 得在这里就地更新；否则收起面板筛完（比如从条件条的 ✕ 取消一项）徽标会一直显示旧数字。
 */
function syncFilterToggle() {
  const toggle = $('#filter-toggle');
  if (!toggle) return;
  const count = filterConditionCount();
  toggle.innerHTML = `筛选${count ? ` <span class="pill">${count}</span>` : ''} ${
    state.filtersCollapsed ? '▼' : '▲'
  }`;
  toggle.setAttribute('aria-expanded', state.filtersCollapsed ? 'false' : 'true');
  toggle.setAttribute('title', `${state.filtersCollapsed ? '展开' : '收起'}筛选面板（搜索框留在原地，已选条件也一直在下面看得见）`);
}

/**
 * 展开 / 收起面板正文。
 *
 * 刻意**只切 `#filter-panel-body` 的 hidden**，不调用 renderSeason / 不重绘第 1 层 ——
 * 重绘就会把搜索框的焦点弄丢（这正是第 1 层常驻的理由），而这个动作本身没有任何
 * 需要重算的东西。
 */
function applyFilterPanelCollapsed() {
  const body = $('#filter-panel-body');
  if (body) body.hidden = state.filtersCollapsed;
  syncFilterToggle();
}

/**
 * 只重绘筛选面板的**第 2~5 层**（`#filter-panel-body`）。
 *
 * 点了筛选项 / 排序 / 每行几部之后调用：列表已经由 refreshSubjectList() 更新，
 * 这里只需要把面板里的高亮、选中摘要、各选项部数、"显示方式"的当前值刷新一下。
 *
 * ⚠ 三条不能破的约定：
 *   1. **不要碰 `#filter-panel-head`**（搜索框在那里）：重绘它 = 点一次筛选丢一次光标，
 *      票的验收里专门有一条。原来搜索框在面板外的工具栏里，这个问题不存在；新设计把它
 *      挪进面板第 1 层，就靠这条拆法保住。
 *   2. 重绘前先把"哪几栏是展开的"从 DOM 里**同步**记下来：`toggle` 事件是异步派发的，
 *      只靠它会在"刚展开就点里面的选项"那一瞬间把展开状态丢掉。
 *   3. 四个 `<select>` 连同它们的 change 监听一并删掉了（票里明确不保留）——
 *      面板里现在只有一套筛选操作方式。
 */
function renderFilterPanelBody() {
  const host = $('#filter-panel-body');
  if (!host) return;
  for (const detail of $$('#filter-panel-body .filter-facet')) {
    const dimension = detail.dataset.facet;
    if (dimension) state.facetsOpen[dimension] = detail.open;
  }
  host.innerHTML = filterPanelBodyHtml(baseFilteredSubjects());
}

/**
 * 记住四栏 + 「显示方式」的展开状态。
 *
 * `toggle` 事件在 `<details>` 上派发且会冒泡，所以挂在 document 上就够了 ——
 * 面板正文每次点选都会整体换节点，逐个绑监听很容易在某次重绘后漏绑。
 * （另外 renderFilterPanelBody 在重绘前还会**同步**从 DOM 抓一次，防止 toggle 还没派发就重绘。）
 */
document.addEventListener('toggle', (event) => {
  const detail = event.target;
  const dimension = detail?.dataset?.facet;
  if (!dimension) return;
  state.facetsOpen[dimension] = Boolean(detail.open);
}, true);

$('#season-select').addEventListener('change', (event) => {
  void selectSeason(event.target.value);
});

$('#rule-select').addEventListener('change', (event) => {
  state.rule = event.target.value;
  $('#ics-link').href = `/api/ics?season=${encodeURIComponent(state.season)}&rule=${state.rule}`;
  if (state.view === 'week') void renderWeek();
});

$$('.tab').forEach((tab) => tab.addEventListener('click', () => void switchView(tab.dataset.view)));

// 倒计时每分钟刷新一次（不重新拉数据，只改文本）
setInterval(() => {
  for (const el of $$('[data-countdown]')) {
    el.textContent = countdownText(el.dataset.countdown);
  }
}, 30_000);

bootstrap().catch((error) => {
  $('#app').innerHTML = `<div class="empty" style="color:var(--danger)">初始化失败：${esc(error.message)}</div>`;
});
