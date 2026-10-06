/**
 * 原型：筛选面板（五层 + 三态）—— 一次性的可交互原型，**不是产品代码**。
 *
 * 它在回答一个问题（票 `.scratch/filter-modes/issues/01`）：
 *   「这个五层 + 三态（不选 / 含 / 不含）的面板，点起来顺不顺手、看不看得懂？」
 *
 * 刻意做成的东西：
 *   - 真的能点：三态循环、选中项置顶、折叠栏、实时部数、排序、每行几部、搜索框都在跑。
 *   - 数据是**真实快照**（data.js，2026-10 共 172 部 / 101 个类型标签），不是编的数：
 *     部数、候选顺序、列表长度都是真的，手感才可信。
 *   - 三个变体（A / B / C）真的换结构，不是换颜色。
 *   - 三个开关（置顶 / 部数口径 / 状态交集并集）是票里**没定死**的三个点，用来当场比。
 *     其中"状态 chip 之间是交集还是并集"默认沿用**线上行为 = 交集**（同时点「放送中」+「未开播」
 *     会一部都不剩），原型里可以一键切成并集看差别 —— 默认值不动，免得把线上的老行为
 *     混进"新手感"里一起评价。
 *
 * 刻意不做的东西（票里也写明不做）：
 *   - 不碰 web/app.js、不调 API、不改 data/anime.db；没有测试、没有错误处理、没有抽象。
 *   - 不做标签文字搜索、不做筛选方案收藏、不做侧边栏。
 *
 * ── 语义规则（票 §三，四条，实现就按这四条） ──────────────────────────────
 *   1. 组内并集、组间交集：同一维度选多个 = 满足任意一个；不同维度之间 = 同时满足。
 *   2. 排除是一票否决：命中任一维度的任一排除项，整条直接丢弃，不再看其他条件。
 *   3. 同一项不可能同时"含"与"不含"：三态循环天然保证互斥（这是选三态、
 *      而不是"另加一个排除按钮"的主要原因）。
 *   4. 部数口径 = 「如果现在点它（含），会剩下多少」——数字直接回答"点下去会得到什么"。
 *      因为三态是循环的，"点它"的后果取决于它现在的状态：
 *        不选 → 含   ：数字 = 只看含它的会剩多少
 *        含   → 不含 ：数字 = 把它整类丢掉之后会剩多少
 *        不含 → 不选 ：数字 = 放开它之后会剩多少
 *      被排除项**留在列表里**（不像票里备选的"显示 0 或干脆不出现"），
 *      否则它就只能去底部的条件条里点回来了 —— 那条路更绕。
 *
 *   ⚠ 但这一条有个坑，正是因为它是"循环"的：**已经"含"的项，数字是"点掉它之后"的部数，
 *     通常比当前列表还大**。实测：含「奇幻」→ 列表 31 部，而「奇幻」那个按钮自己写着 141
 *     （= 172 − 31，"改成不含会剩 141"），旁边没选中的「科幻」写着 15（= 含它剩 15）。
 *     两个数字口径不同却并排显示，很容易读成"奇幻有 141 部"。
 *     所以原型把三种口径都做出来了（底部工具条切换），当场比：
 *       afterClick 票的口径：点它之后剩多少（会随状态换含义）
 *       inResult   现在列表里有几部（永远和列表头对得上；被排除的项自然显示 0，
 *                  正好是票里 §三.4 备选的"显示为 0"）
 *       stableBase 固定基数：只按搜索框 + 状态算（线上旧口径，数字不随筛选跳动）
 * ─────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 常量（与 web/app.js 对齐，改这里要同步那边）
  // -------------------------------------------------------------------------

  const $ = (selector) => document.querySelector(selector);

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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

  const MEDIA_TYPE_CN = {
    TV: 'TV 动画',
    MOVIE: '剧场版',
    OVA: 'OVA',
    ONA: '网络动画',
    WEB: '网络动画',
    SPECIAL: '特别篇',
  };

  const SORT_OPTIONS = [
    { key: 'firstAir', label: '首集放送时间（早→晚）' },
    { key: 'firstAirDesc', label: '首集放送时间（晚→早）' },
    { key: 'weekday', label: '按放送星期 / 时刻' },
    { key: 'titleCn', label: '按中文名' },
    { key: 'totalEps', label: '按集数（多→少）' },
  ];

  const PER_ROW_OPTIONS = [3, 4, 5, 6, 7];

  /** 第 3 层四个维度，顺序就是面板里的顺序（放送星期 / 媒体类型 / 国内平台 / 类型标签）。 */
  const DIMS = ['weekdays', 'mediaTypes', 'platforms', 'genres'];
  const DIM_LABELS = {
    weekdays: '放送星期',
    mediaTypes: '媒体类型',
    platforms: '国内平台',
    genres: '类型标签',
  };

  /** 第 2 层的六个状态 chip：**不是标签**，是"我这边"的预设条件，所以和三态分开。 */
  const STATUS_CHIPS = [
    ['mine', '我追的'],
    ['backlog', '补番库'],
    ['airing', '放送中'],
    ['upcoming', '未开播'],
    ['bilibili', 'B站有版权'],
    ['nozh', '缺中文名'],
  ];

  const VARIANTS = [
    {
      key: 'A',
      name: '票的规格',
      note: '五层竖排，各占一行：搜索 → 状态 → 四个折叠维度 → 排序 → 每行几部。左边这是基线。',
    },
    {
      key: 'B',
      name: '显示方式收进折叠栏',
      note: '排序与每行几部并进一个默认收起的「显示方式」，面板只剩 状态 + 四个维度，更短。',
    },
    {
      key: 'C',
      name: '宽屏双栏 + 标签网格',
      note: '维度分两栏（大屏），类型标签用两列网格 + 自己的一块滚动区，少滚一点。窗口拉宽才看得出差别。',
    },
  ];

  /**
   * 部数口径三档（票 §三.4 只说了一种，原型三种都做出来当场比）。
   * 这是原型里最值得看的一处：同一次点击，三种口径给出的数字差很多。
   */
  const COUNT_MODES = [
    {
      key: 'afterClick',
      short: '点它剩多少',
      long: '点它之后剩多少（票 §三.4）——含/不含项的数字含义会跟着换',
      note: '选项右边的数字 = 点它一下之后会剩多少（票 §三.4）',
    },
    {
      key: 'inResult',
      short: '列表里有几部',
      long: '现在列表里有几部含它 —— 永远和列表头对得上；被排除的项自然是 0',
      note: '选项右边的数字 = 现在列表里有几部含它（被排除的项自然是 0）',
    },
    {
      key: 'stableBase',
      short: '固定基数',
      long: '只按搜索框 + 状态算（线上旧口径）——付代价换来"数字不随筛选跳"',
      note: '选项右边的数字 = 以「搜索框 + 状态」为固定基数算（线上旧口径，不随筛选跳）',
    },
  ];
  const countMode = () => COUNT_MODES.find((mode) => mode.key === state.countMode) ?? COUNT_MODES[0];

  // -------------------------------------------------------------------------
  // 数据快照（data.js 由 build-data.mjs 生成）
  // -------------------------------------------------------------------------

  const DATA = window.PROTO_DATA;
  if (!DATA) {
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<p style="padding:20px;color:var(--danger)">读不到 data.js —— 先在仓库根跑 node prototype/filter-panel/build-data.mjs 生成它。</p>',
    );
    return;
  }
  const SUBJECTS = DATA.subjects;

  const esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );

  /** 一个番剧在某个维度上有哪些值（一律是字符串，避免 dataset 的 number/string 混用）。 */
  const VALUE_OF = {
    weekdays: (item) => (item.weekday === null ? [] : [String(item.weekday)]),
    mediaTypes: (item) => [item.mediaType],
    platforms: (item) => item.platforms,
    genres: (item) => item.genres,
  };

  /** 每个维度的候选全集（部数过滤与排序都在渲染时做，这里只保证"值出现过"）。 */
  const ALL_VALUES = {};
  for (const dim of DIMS) {
    const set = new Set();
    for (const item of SUBJECTS) for (const value of VALUE_OF[dim](item)) set.add(String(value));
    const values = [...set];
    ALL_VALUES[dim] = dim === 'weekdays' ? values.sort((a, b) => Number(a) - Number(b)) : values;
  }

  function labelOf(dim, value) {
    if (dim === 'weekdays') return WEEKDAYS[Number(value)] ?? `星期 ${value}`;
    if (dim === 'mediaTypes') return MEDIA_TYPE_CN[value] ?? value;
    if (dim === 'genres') return GENRE_CN[value] ?? value;
    return value;
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  function emptyDims() {
    const dims = {};
    for (const dim of DIMS) dims[dim] = { include: [], exclude: [] };
    return dims;
  }

  const state = {
    variant: 'A',
    /** 原型开关 1：选中项移不移到列表最前面（票要求"移"，这里能当场比出差别）。 */
    pinSelected: true,
    /** 原型开关 2：部数口径三档之一（票 §三.4 只定了一种，见 COUNT_MODES）。 */
    countMode: 'afterClick',
    /** 原型开关 3：六个状态 chip 之间是并集（或）还是交集（且）。默认沿用线上 = 交集。 */
    statusAnd: true,
    query: '',
    /** 第 2 层：状态预设，多选可切换（不是三态）。 */
    status: [],
    dims: emptyDims(),
    sort: 'firstAir',
    perRow: 4,
    /** 折叠栏展开记忆：面板正文每次交互都会重绘，不记就会被收起。 */
    open: {},
    forceDark: false,
  };

  // -------------------------------------------------------------------------
  // 纯逻辑：过滤 / 计数 / 排序（这一块可以整段搬进 web/app.js）
  // -------------------------------------------------------------------------

  function statusMatch(item, key) {
    if (key === 'mine') return Boolean(item.myCategory);
    if (key === 'backlog') return item.myCategory === 'backlog';
    if (key === 'airing') return item.status === 'airing';
    if (key === 'upcoming') return item.status === 'upcoming';
    if (key === 'bilibili') return item.platforms.some((name) => name.includes('哔哩哔哩'));
    if (key === 'nozh') return !item.titleCn;
    return true;
  }

  function matchesQuery(item) {
    const query = state.query.trim().toLowerCase();
    if (!query) return true;
    return [item.titleCn, item.titleOriginal]
      .filter(Boolean)
      .some((title) => String(title).toLowerCase().includes(query));
  }

  function matchesStatus(item, keys) {
    if (keys.length === 0) return true;
    return state.statusAnd
      ? keys.every((key) => statusMatch(item, key))
      : keys.some((key) => statusMatch(item, key));
  }

  /** 第 1、2 层的结果：搜索框 + 状态 chip（第 3 层的四个维度还没参与）。 */
  function baseItems() {
    return SUBJECTS.filter((item) => matchesQuery(item) && matchesStatus(item, state.status));
  }

  /** 规则 1 + 2：组内并集、组间交集、排除一票否决。 */
  function passes(item, dims) {
    for (const dim of DIMS) {
      const selected = dims[dim];
      const values = VALUE_OF[dim](item);
      if (selected.exclude.length && values.some((value) => selected.exclude.includes(value))) {
        return false; // 一票否决：不再看其他条件
      }
      if (selected.include.length && !values.some((value) => selected.include.includes(value))) {
        return false;
      }
    }
    return true;
  }

  function resultItems(dims) {
    return baseItems().filter((item) => passes(item, dims));
  }

  const current = () => resultItems(state.dims);

  /** 规则 4：部数 = 点它一下之后会剩多少（票的口径；另两档见 COUNT_MODES）。 */
  function optionCount(dim, value) {
    const selected = state.dims[dim];
    if (state.countMode === 'stableBase') {
      // 旧口径：一律以"搜索框 + 状态"为基数，数字不随筛选跳动
      return baseItems().filter((item) => VALUE_OF[dim](item).includes(value)).length;
    }
    if (state.countMode === 'inResult') {
      // 现在列表里有几部含它（被排除的项自然算成 0）
      return current().filter((item) => VALUE_OF[dim](item).includes(value)).length;
    }
    if (selected.exclude.includes(value)) {
      return resultItems({
        ...state.dims,
        [dim]: { include: selected.include, exclude: selected.exclude.filter((v) => v !== value) },
      }).length;
    }
    if (selected.include.includes(value)) {
      return resultItems({
        ...state.dims,
        [dim]: { include: selected.include.filter((v) => v !== value), exclude: [...selected.exclude, value] },
      }).length;
    }
    return resultItems({
      ...state.dims,
      [dim]: { include: [...selected.include, value], exclude: selected.exclude },
    }).length;
  }

  /** 状态 chip 的部数，同一条口径。 */
  function statusCount(key) {
    const on = state.status.includes(key);
    if (state.countMode === 'stableBase') {
      return baseItems().filter((item) => statusMatch(item, key)).length;
    }
    if (state.countMode === 'inResult') {
      return current().filter((item) => statusMatch(item, key)).length;
    }
    const next = on ? state.status.filter((k) => k !== key) : [...state.status, key];
    return SUBJECTS.filter((item) => matchesQuery(item) && matchesStatus(item, next)).length;
  }

  /** 点一下这个选项之后它变成什么（三态循环：不选 → 含 → 不含 → 不选）。 */
  function nextStateOf(dim, value) {
    const selected = state.dims[dim];
    if (selected.exclude.includes(value)) {
      return { include: selected.include, exclude: selected.exclude.filter((v) => v !== value) };
    }
    if (selected.include.includes(value)) {
      return { include: selected.include.filter((v) => v !== value), exclude: [...selected.exclude, value] };
    }
    return { include: [...selected.include, value], exclude: selected.exclude };
  }

  /** 某一维度的候选：部数降序，部数为 0 不显示（已选/已排除的除外，否则点不回来）。 */
  function entriesFor(dim) {
    const selected = state.dims[dim];
    const entries = ALL_VALUES[dim].map((value) => ({ value, count: optionCount(dim, value) }));
    const isPicked = (value) => selected.include.includes(value) || selected.exclude.includes(value);
    return entries
      .filter((entry) => entry.count > 0 || isPicked(entry.value))
      .sort((a, b) => {
        if (state.pinSelected) {
          const pinned = Number(isPicked(b.value)) - Number(isPicked(a.value));
          if (pinned !== 0) return pinned;
        }
        return b.count - a.count || String(a.value).localeCompare(String(b.value));
      });
  }

  function sortedItems(items) {
    const text = (a, b) => String(a ?? '').localeCompare(String(b ?? ''));
    const comparators = {
      firstAir: (a, b) => text(a.firstAirAtUtc ?? '~', b.firstAirAtUtc ?? '~'),
      firstAirDesc: (a, b) => text(b.firstAirAtUtc ?? '', a.firstAirAtUtc ?? ''),
      weekday: (a, b) =>
        (a.weekday ?? 9) - (b.weekday ?? 9) || text(a.time ?? '~', b.time ?? '~'),
      titleCn: (a, b) =>
        text(a.titleCn ?? a.titleOriginal ?? '', b.titleCn ?? b.titleOriginal ?? ''),
      totalEps: (a, b) => (b.totalEps ?? -1) - (a.totalEps ?? -1),
    };
    return [...items].sort(comparators[state.sort] ?? comparators.firstAir);
  }

  // -------------------------------------------------------------------------
  // 渲染：面板（第 1 层单独一个常驻节点，见 refreshPanelBody 的注释）
  // -------------------------------------------------------------------------

  function headHtml() {
    return `
      <div class="filter-layer">
        <div class="toolbar">
          <input type="search" id="proto-search" placeholder="搜索中文名 / 原名（也可以直接搜别名）"
                 value="${esc(state.query)}" aria-label="搜索番剧" />
          <span class="hint" id="proto-count">显示 ${current().length} / ${baseItems().length} 部</span>
        </div>
      </div>`;
  }

  function layerStatusHtml() {
    const options = STATUS_CHIPS.map(([key, label]) => {
      const on = state.status.includes(key);
      return `<button class="filter-opt${on ? ' is-active' : ''}" data-status="${key}"
                aria-pressed="${on ? 'true' : 'false'}"
                title="点一下选中，再点取消（可多选）">${on ? '✓ ' : ''}${label}<span class="c">${statusCount(
                  key,
                )}</span></button>`;
    }).join('');
    return `
      <div class="filter-layer">
        <div class="filter-group">
          <div class="filter-group-head">状态${
            state.statusAnd ? '（多选 = 同时满足，且）' : '（多选 = 满足任意一个，或）'
          }</div>
          <div class="filter-opts">${options}</div>
        </div>
      </div>`;
  }

  function optionButtonHtml(dim, entry) {
    const selected = state.dims[dim];
    const included = selected.include.includes(entry.value);
    const excluded = selected.exclude.includes(entry.value);
    const marker = included ? '✓ ' : excluded ? '⊘ ' : '';
    const hint = included ? '现在：含它。再点一下 → 不含' : excluded ? '现在：不含它。再点一下 → 不管它' : '现在：不管它。点一下 → 只看含它的';
    const countText = `${entry.count}（${countMode().short}）`;
    return `<button class="filter-opt${included ? ' is-active' : ''}${excluded ? ' is-excluded' : ''}"
              data-dim="${dim}" data-value="${esc(entry.value)}"
              aria-pressed="${included ? 'true' : 'false'}"
              title="${esc(`${hint}；${countText}`)}">${marker}${esc(labelOf(dim, entry.value))}<span class="c">${
                entry.count
              }</span></button>`;
  }

  function facetHtml(dim, { grid = false, tall = false } = {}) {
    const selected = state.dims[dim];
    const entries = entriesFor(dim);
    const includeCount = selected.include.length;
    const excludeCount = selected.exclude.length;

    const summary =
      includeCount && excludeCount
        ? `已选 ${includeCount} · 排除 ${excludeCount}`
        : includeCount
          ? `已选 ${includeCount}`
          : excludeCount
            ? `排除 ${excludeCount}`
            : `${entries.length} 项`;

    const picked = [
      ...selected.include.map((value) => esc(labelOf(dim, value))),
      ...selected.exclude.map((value) => `<span class="is-excluded">⊘${esc(labelOf(dim, value))}</span>`),
    ].join('、');

    // 有选中/排除时保持展开，不被重绘收起（票 §二）
    const open = includeCount > 0 || excludeCount > 0 || state.open[dim] === true;
    const optionsClass = `filter-opts${tall ? ' is-tall' : ''}${grid ? ' is-grid' : ''}${
      dim === 'genres' && !tall ? ' is-scroll' : ''
    }`;

    return `
      <details class="filter-facet" data-facet="${dim}"${open ? ' open' : ''}>
        <summary class="facet-head">
          <span class="facet-title">${DIM_LABELS[dim]}</span>
          <span class="facet-count">${summary}</span>
          <span class="facet-picked">${picked}</span>
          <span class="facet-caret">▾</span>
        </summary>
        <div class="${optionsClass}">${entries.map((entry) => optionButtonHtml(dim, entry)).join('')}</div>
      </details>`;
  }

  function layerDimsHtml() {
    return `<div class="filter-layer filter-facets">${DIMS.map((dim) => facetHtml(dim)).join('')}</div>`;
  }

  function layerDimsTwoColsHtml() {
    return `
      <div class="filter-layer">
        <div class="filter-cols">
          <div class="filter-facets">
            ${facetHtml('weekdays')}
            ${facetHtml('mediaTypes')}
            ${facetHtml('platforms')}
          </div>
          <div class="filter-facets">${facetHtml('genres', { grid: true, tall: true })}</div>
        </div>
      </div>`;
  }

  function layerSortHtml() {
    const options = SORT_OPTIONS.map((option) => {
      const on = state.sort === option.key;
      return `<button class="filter-opt${on ? ' is-active' : ''}" data-sort="${option.key}"
                aria-pressed="${on ? 'true' : 'false'}">${on ? '✓ ' : ''}${esc(option.label)}</button>`;
    }).join('');
    return `
      <div class="filter-layer">
        <div class="filter-group">
          <div class="filter-group-head">排序方式（不是筛选，只改顺序）</div>
          <div class="filter-opts">${options}</div>
        </div>
      </div>`;
  }

  function layerPerRowHtml() {
    const options = PER_ROW_OPTIONS.map(
      (n) =>
        `<button class="filter-opt${state.perRow === n ? ' is-active' : ''}" data-per-row="${n}"
           aria-pressed="${state.perRow === n ? 'true' : 'false'}">${state.perRow === n ? '✓ ' : ''}${n} 部</button>`,
    ).join('');
    return `
      <div class="filter-layer">
        <div class="filter-group">
          <div class="filter-group-head">每行几部（不是筛选，只改列数）</div>
          <div class="filter-opts">${options}</div>
        </div>
      </div>`;
  }

  /** 变体 B 专属：排序 + 每行几部收进一个默认收起的折叠栏。 */
  function layerDisplayHtml() {
    const sortLabel = (SORT_OPTIONS.find((option) => option.key === state.sort) ?? SORT_OPTIONS[0]).label;
    const open = state.open.display === true;
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
              <div class="filter-opts">${SORT_OPTIONS.map((option) => {
                const on = state.sort === option.key;
                return `<button class="filter-opt${on ? ' is-active' : ''}" data-sort="${option.key}">${
                  on ? '✓ ' : ''
                }${esc(option.label)}</button>`;
              }).join('')}</div>
            </div>
            <div class="filter-group">
              <div class="filter-group-head">每行几部</div>
              <div class="filter-opts">${PER_ROW_OPTIONS.map(
                (n) =>
                  `<button class="filter-opt${state.perRow === n ? ' is-active' : ''}" data-per-row="${n}">${
                    state.perRow === n ? '✓ ' : ''
                  }${n} 部</button>`,
              ).join('')}</div>
            </div>
          </div>
        </details>
      </div>`;
  }

  /** 每个变体末尾都带这一行：把当前部数口径写在面板里，免得数字被误读。 */
  function countModeNoteHtml() {
    const mode = countMode();
    return `<div class="filter-note">${esc(mode.note)}。底部工具条可以切换另外两种口径当场对比。</div>`;
  }

  function bodyHtml() {
    if (state.variant === 'B') {
      return layerStatusHtml() + layerDimsHtml() + layerDisplayHtml() + countModeNoteHtml();
    }
    if (state.variant === 'C') {
      return (
        layerStatusHtml() + layerDimsTwoColsHtml() + layerSortHtml() + layerPerRowHtml() + countModeNoteHtml()
      );
    }
    return layerStatusHtml() + layerDimsHtml() + layerSortHtml() + layerPerRowHtml() + countModeNoteHtml();
  }

  /** 已选条件条：含与不含**分开显示**，都能单独取消。 */
  function chipsHtml() {
    const chips = [];
    for (const dim of DIMS) {
      const selected = state.dims[dim];
      for (const value of selected.include) {
        chips.push(`<button class="chip is-active" data-clear-dim="${dim}" data-clear-value="${esc(value)}"
            title="点一下取消（变回不管它）">含 ${esc(labelOf(dim, value))} ✕</button>`);
      }
      for (const value of selected.exclude) {
        chips.push(`<button class="chip is-excluded" data-clear-dim="${dim}" data-clear-value="${esc(value)}"
            title="点一下取消排除">⊘ 不含 ${esc(labelOf(dim, value))} ✕</button>`);
      }
    }
    for (const key of state.status) {
      const label = (STATUS_CHIPS.find(([value]) => value === key) ?? [key, key])[1];
      chips.push(
        `<button class="chip is-active" data-clear-status="${key}" title="点一下取消">${label} ✕</button>`,
      );
    }
    if (chips.length === 0) return '';
    return `<div class="active-filters">
        <span class="af-label">已选条件</span>
        ${chips.join('')}
        <button class="btn btn-sm" data-clear-all="1" title="含与不含两侧一起清掉">全部清空</button>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // 渲染：列表（卡片结构与 web/app.js 的 subjectRow 保持一致，密度才可信）
  // -------------------------------------------------------------------------

  function machineTag(source) {
    return source === 'machine'
      ? '<span class="tag tag-warn" title="机器翻译的临时译名">临时机翻</span>'
      : '';
  }

  function coverHtml(url) {
    return url
      ? `<img class="cover" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer"
           onerror="this.onerror=null;this.className='cover ep-cover-ph';this.removeAttribute('src');this.textContent='◈';" />`
      : '<div class="cover ep-cover-ph">◈</div>';
  }

  function rowHtml(item) {
    const inList =
      item.myCategory === 'tracking'
        ? '<span class="tag tag-ok">追番中</span>'
        : item.myCategory === 'backlog'
          ? '<span class="tag tag-purple">补番库</span>'
          : '';
    const weekday = item.weekday === null ? null : WEEKDAYS[item.weekday];
    const tags = [
      `<span class="tag">${esc(MEDIA_TYPE_CN[item.mediaType] ?? item.mediaType)}</span>`,
      item.totalEps
        ? `<span class="tag">${item.totalEps} 话</span>`
        : '<span class="tag tag-warn">集数未知</span>',
      item.firstAirAtUtc
        ? `<span class="tag">首播 ${esc(item.firstAirAtUtc.slice(0, 10))}</span>`
        : '',
      weekday ? `<span class="tag">${esc(weekday)} ${esc(item.time ?? '')}</span>` : '',
      ...item.genres.map(
        (genre) =>
          `<span class="tag" title="原始标签：${esc(genre)}">${esc(GENRE_CN[genre] ?? genre)}</span>`,
      ),
      ...item.platforms.map((name) => `<span class="tag tag-ok">${esc(name)}</span>`),
    ].join('');

    return `
      <div class="subject-row" data-key="${esc(item.key)}">
        ${coverHtml(item.coverUrl)}
        <div class="info">
          <div class="t-cn">${esc(item.titleCn ?? '（无中文名）')} ${machineTag(item.titleCnSource)} ${inList}</div>
          <div class="t-orig">${esc(item.titleOriginal ?? '')}</div>
          <div class="meta">${tags}</div>
        </div>
        <div class="actions">
          ${
            item.myCategory
              ? `<button class="btn btn-sm btn-danger" data-remove="${esc(item.key)}">移除</button>`
              : `<button class="btn btn-sm btn-primary" data-add="${esc(item.key)}" data-cat="tracking">追番</button>
                 <button class="btn btn-sm" data-add="${esc(item.key)}" data-cat="backlog">补番</button>`
          }
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // 刷新：列表 + 面板
  // -------------------------------------------------------------------------

  /**
   * 面板正文（第 2~5 层）单独一个节点，第 1 层的搜索框**永不重绘**。
   *
   * 为什么：票的验收里有一条「搜索框焦点不因点筛选而丢失」，而新设计把搜索框放进了
   * 面板第 1 层（线上是放在面板外的工具栏里）。只要点一下就重写整个面板，光标就没了。
   * 拆成「常驻的 head + 重绘的 body」两个槽，这个矛盾就消失了 —— 也就是线上
   * `refreshSubjectList()` 那条"只重绘列表不重绘面板"的原则，在这里往前挪了一步。
   */
  function refreshPanelBody() {
    // 重绘前先把"哪几栏是展开的"从 DOM 里**同步**记下来（与 web/app.js 的 renderFilterPanelOnly 同一套做法）。
    // 只靠下面那个 toggle 事件不够：它是异步派发的，"刚展开就立刻点里面的选项"那一瞬间
    // 事件还没跑，重绘就会把刚展开的栏又收回去。
    for (const detail of document.querySelectorAll('#panel-body .filter-facet')) {
      const dimension = detail.dataset.facet;
      if (dimension) state.open[dimension] = detail.open;
    }
    $('#panel-body').innerHTML = bodyHtml();
  }

  function refreshList() {
    const list = $('#subject-list');
    list.className = `subject-list per-row-${state.perRow}`;
    const items = sortedItems(current());
    list.innerHTML = items.length
      ? items.map(rowHtml).join('')
      : '<div class="empty">没有匹配的番剧 —— 换个关键词，或把筛选放宽</div>';
    $('#proto-count').textContent = `显示 ${items.length} / ${baseItems().length} 部`;
    $('#active-filters').innerHTML = chipsHtml();
    // 卡片上的追番 / 补番是内存里改的，标签页上的数字跟着动一下，免得看起来像没反应
    $('#tab-my-count').textContent = String(SUBJECTS.filter((item) => item.myCategory).length);
  }

  function refreshAll() {
    refreshPanelBody();
    refreshList();
  }

  function syncVariantNote() {
    const variant = VARIANTS.find((item) => item.key === state.variant) ?? VARIANTS[0];
    $('#proto-variant-note').innerHTML = `<b>变体 ${variant.key}｜${esc(variant.name)}</b> —— ${esc(
      variant.note,
    )}`;
    $('#proto-variant').textContent = `${variant.key} · ${variant.name}`;
  }

  function setVariant(key) {
    state.variant = key;
    syncVariantNote();
    refreshAll();
  }

  function cycleVariant(step) {
    const index = VARIANTS.findIndex((item) => item.key === state.variant);
    const next = (index + step + VARIANTS.length) % VARIANTS.length;
    setVariant(VARIANTS[next].key);
  }

  function syncBar() {
    $('#proto-pin').checked = state.pinSelected;
    const mode = countMode();
    $('#proto-count-mode').textContent = `部数口径：${mode.short}`;
    $('#proto-count-mode').title = `${mode.long}（点一下换下一种）`;
    $('#proto-status-mode').textContent = state.statusAnd ? '状态 chip：同时满足（且）' : '状态 chip：满足任意（或）';
    $('#proto-status-mode').classList.toggle('is-on', state.statusAnd);
    $('#proto-theme').textContent = state.forceDark ? '主题：强制深色' : '主题：跟随系统';
  }

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  /** 三态循环：不选 → 含 → 不含 → 不选。 */
  function cycleOption(dim, value) {
    state.dims[dim] = nextStateOf(dim, value);
    refreshAll();
  }

  function toggleStatus(key) {
    state.status = state.status.includes(key)
      ? state.status.filter((item) => item !== key)
      : [...state.status, key];
    refreshAll();
  }

  function clearDimension(dim, value) {
    const selected = state.dims[dim];
    state.dims[dim] = {
      include: selected.include.filter((item) => item !== value),
      exclude: selected.exclude.filter((item) => item !== value),
    };
    refreshAll();
  }

  function clearAllFilters() {
    state.dims = emptyDims();
    state.status = [];
    refreshAll();
  }

  /** 卡片上的追番 / 补番 / 移除：只在内存里改，让"我追的"那个数字真的会动。 */
  function setCategory(key, category) {
    const item = SUBJECTS.find((entry) => entry.key === key);
    if (!item) return;
    item.myCategory = category;
    refreshAll();
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('button, [data-proto]');
    if (!target) return;

    if (target.dataset.dim) return cycleOption(target.dataset.dim, target.dataset.value);
    if (target.dataset.status) return toggleStatus(target.dataset.status);
    if (target.dataset.sort) {
      state.sort = target.dataset.sort;
      return refreshAll();
    }
    if (target.dataset.perRow) {
      state.perRow = Number(target.dataset.perRow);
      return refreshAll();
    }
    if (target.dataset.clearDim) return clearDimension(target.dataset.clearDim, target.dataset.clearValue);
    if (target.dataset.clearStatus) return toggleStatus(target.dataset.clearStatus);
    if (target.dataset.clearAll) return clearAllFilters();
    if (target.dataset.add) return setCategory(target.dataset.add, target.dataset.cat);
    if (target.dataset.remove) return setCategory(target.dataset.remove, null);
  });

  // 搜索框：只刷新列表 + 面板正文，**不碰自己**，所以焦点和光标位置都保得住
  document.addEventListener('input', (event) => {
    if (event.target.id !== 'proto-search') return;
    state.query = event.target.value;
    refreshPanelBody();
    refreshList();
  });

  // 折叠状态记忆：`toggle` 事件在 <details> 上派发且会冒泡，挂在 document 上就够了 ——
  // 面板正文每次交互都整体换节点，逐个绑监听很容易漏绑（与 web/app.js 同一套做法）。
  document.addEventListener(
    'toggle',
    (event) => {
      const dimension = event.target?.dataset?.facet;
      if (!dimension) return;
      state.open[dimension] = Boolean(event.target.open);
    },
    true,
  );

  // 键盘 ← → 换变体（在输入框里打字时不抢键）
  document.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
    if (event.key === 'ArrowLeft') cycleVariant(-1);
    else if (event.key === 'ArrowRight') cycleVariant(1);
    else return;
    event.preventDefault();
  });

  $('#proto-prev').addEventListener('click', () => cycleVariant(-1));
  $('#proto-next').addEventListener('click', () => cycleVariant(1));
  $('#proto-pin').addEventListener('change', (event) => {
    state.pinSelected = event.target.checked;
    refreshAll();
  });
  $('#proto-count-mode').addEventListener('click', () => {
    const index = COUNT_MODES.findIndex((mode) => mode.key === state.countMode);
    state.countMode = COUNT_MODES[(index + 1) % COUNT_MODES.length].key;
    syncBar();
    refreshAll();
  });
  $('#proto-status-mode').addEventListener('click', () => {
    state.statusAnd = !state.statusAnd;
    syncBar();
    refreshAll();
  });
  $('#proto-theme').addEventListener('click', () => {
    state.forceDark = !state.forceDark;
    document.documentElement.classList.toggle('theme-dark', state.forceDark);
    syncBar();
  });
  $('#proto-reset').addEventListener('click', () => {
    state.query = '';
    state.dims = emptyDims();
    state.status = [];
    state.sort = 'firstAir';
    state.perRow = 4;
    state.open = {};
    $('#proto-search').value = '';
    refreshAll();
  });

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  $('#season-badge').textContent = DATA.season?.label ?? DATA.season?.id ?? '';
  $('#proto-season').textContent = String(DATA.season?.id ?? '');
  $('#proto-saved').textContent = String(DATA.savedAt ?? '').slice(0, 16).replace('T', ' ');
  $('#proto-shape').textContent = `${SUBJECTS.length} 部 · ${ALL_VALUES.genres.length} 个类型标签 · ${
    ALL_VALUES.platforms.length
  } 个国内平台`;
  $('#tab-my-count').textContent = String(SUBJECTS.filter((item) => item.myCategory).length);

  $('#panel-head').innerHTML = headHtml();
  syncVariantNote();
  syncBar();
  refreshAll();

  /**
   * 把状态与纯逻辑挂到 window 上。
   * 既是原型规范里那条"把状态露出来"（在控制台里能直接核对数字），
   * 也是给一次性自检脚本用的把手（见 .scratch 里的 selfcheck，不进版本库）。
   */
  window.__PROTO__ = { state, SUBJECTS, current, baseItems, resultItems, passes, optionCount, statusCount, entriesFor, bodyHtml, chipsHtml, nextStateOf, COUNT_MODES, VARIANTS };
})();
