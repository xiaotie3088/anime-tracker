/**
 * 前端交互冒烟测试（无浏览器）。
 *
 *   node src/server/server.ts     # 先起服务（要用真实数据渲染）
 *   pnpm ui:smoke                 # 另一终端跑
 *
 * 它做什么：把 `web/app.js` 真正加载起来（在一个手写的**元素树**壳里），
 * 用真实接口数据渲染「全季总览」，然后派发**真正会冒泡的 click 事件**，
 * 断言筛选 / 排序 / 每行几部 / 详情按钮这些交互确实有反应。
 *
 * 为什么非要有它：本机跑不起无头浏览器（DSH 沙箱挡掉 Chrome 的 mojo IPC 与 crashpad），
 * 而这类"按钮点了没反应"的 bug 只有真 DOM 事件路径才能暴露 ——
 * 第六轮那个 `if (target.closest('#filter-panel')) return;` 把面板里所有筛选块
 * 全吃掉的问题，靠"哑元素壳"是**查不出来**的（那个壳里 closest() 恒为 null）。
 *
 * ⚠ 写这个壳时踩过的坑（改动前先看，否则会白怀疑业务代码）：
 *   1. querySelector 必须**连根自己一起匹配**，否则 `\#app` 每次都会新建一个节点，
 *      "渲染进去的节点"和"测试点着的节点"变成两个不同对象。
 *   2. querySelectorAll 必须**递归所有后代**，只遍历直接子节点会让深层元素查不到。
 *   3. 布尔属性 `<details open>` 的属性值是空串，要按"出现过就算 true"判断。
 *   4. 重绘后旧节点会脱离文档 —— 断言状态前必须**重新查询**节点。
 */
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const source = readFileSync('web/app.js', 'utf8');

// ------------------------------ 元素与解析 ------------------------------

class El {
  tag: string;
  attrs: Record<string, string> = {};
  children: El[] = [];
  parent: El | null = null;
  id = '';
  className = '';
  dataset: Record<string, string> = {};
  style: { cssText: string } = { cssText: '' };
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  textContent = '';
  value = '';
  href = '';
  disabled = false;
  open = false;
  classList = {
    // ⚠ 必须是**真会改 className** 的实现：真实 DOM 的 classList.add/remove 会改 className，
    //   早先这里是空函数，于是"代码里加了个类"在断言里永远看不到，测试会误报失败。
    add: (...cs: string[]) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const c of cs) set.add(c);
      this.className = [...set].join(' ');
    },
    remove: (...cs: string[]) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const c of cs) set.delete(c);
      this.className = [...set].join(' ');
    },
    toggle: (c: string) => {
      if (this.classList.contains(c)) this.classList.remove(c);
      else this.classList.add(c);
    },
    contains: (c: string) => this.className.split(/\s+/).filter(Boolean).includes(c),
  };
  private _html = '';

  constructor(tag: string) {
    this.tag = tag;
  }

  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }

  get innerHTML() {
    return this._html;
  }
  set innerHTML(html: string) {
    this._html = html;
    this.children = parseHtml(html, this);
    // 防御：确保解析出来的顶层节点确实指回自己
    for (const child of this.children) child.parent = this;
  }

  closest(sel: string): El | null {
    for (let node: El | null = this; node; node = node.parent) {
      if (node.matches(sel)) return node;
    }
    return null;
  }

  matches(sel: string): boolean {
    if (sel === 'button, a') return this.tag === 'button' || this.tag === 'a';
    if (sel.includes(',')) return sel.split(',').some((part) => this.matches(part.trim()));

    // 依次取出 #id / .class / [attr="v"] / 标签名，全部要满足
    const idMatch = /#([\w-]+)/.exec(sel);
    if (idMatch && this.id !== idMatch[1]) return false;

    for (const cls of sel.match(/\.([\w-]+)/g) ?? []) {
      if (!this.classList.contains(cls.slice(1))) return false;
    }

    for (const part of sel.match(/\[[\w-]+(?:="[^"]*")?\]/g) ?? []) {
      const m = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(part);
      if (!m) return false;
      const value = this.attrs[m[1]];
      if (value === undefined) return false;
      if (m[2] !== undefined && value !== m[2]) return false;
    }

    const tagMatch = /^([a-zA-Z][\w-]*)/.exec(sel);
    if (tagMatch && this.tag !== tagMatch[1]) return false;

    return true;
  }

  querySelector(sel: string): El | null {
    // ⚠ 必须连自己一起匹配：document.querySelector('#app') 在真实 DOM 里是会找到
    //   已经在文档里的那一个的。少了这一步，$('#app') 每次都会新建一个节点，
    //   于是"渲染进去的节点"和"测试点着的节点"是两个不同的对象 —— 排查会白跑。
    if (this.matches(sel)) return this;
    return this.querySelectorAll(sel)[0] ?? null;
  }

  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    // ⚠ 必须**递归所有后代**：只遍历直接子节点的话，深层元素（比如 #filter-panel 里的
    //   .filter-facet）永远查不到，测试就会报"没渲染出来"，白白怀疑业务代码。
    const walk = (node: El): void => {
      for (const child of node.children) {
        if (child.matches(sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  replaceWith(other: El | null) {
    if (!other || !this.parent) return;
    const siblings = this.parent.children;
    siblings[siblings.indexOf(this)] = other;
    other.parent = this.parent;
  }
  remove() {
    if (!this.parent) return;
    const siblings = this.parent.children;
    siblings.splice(siblings.indexOf(this), 1);
  }
  prepend() {}
  append() {}
  removeAttribute() {}
  setAttribute() {}

  /** 从自己一路冒泡到根，逐层调用监听器。 */
  dispatch(type: string, extra: Record<string, unknown> = {}) {
    const path: El[] = [];
    for (let node: El | null = this; node; node = node.parent) path.push(node);
    for (const node of path) {
      for (const fn of node.listeners[type] ?? []) {
        fn({ type, target: this, currentTarget: node, ...extra });
      }
    }
  }
  click() {
    this.dispatch('click');
  }
}

const VOID_TAGS = new Set(['img', 'br', 'input', 'hr', 'meta', 'link']);

function parseHtml(html: string, parent: El | null): El[] {
  const roots: El[] = [];
  const stack: El[] = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html))) {
    const [, closing, tag, attrText, selfClose, text] = match;
    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed && stack.length) stack[stack.length - 1].textContent += trimmed;
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }
    const el = new El(tag);
    for (const attr of (attrText ?? '').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      el.attrs[attr[1]] = attr[2] ?? '';
      if (attr[1] === 'id') el.id = attr[2] ?? '';
      if (attr[1] === 'class') el.className = attr[2] ?? '';
      if (attr[1] === 'href') el.href = attr[2] ?? '';
      // 布尔属性：只要出现就算 true（`<details open>` 的属性值是空串，
      // 不能按"值是否非空"来判断 —— 真实浏览器就是这么认的）
      if (attr[1] === 'open') el.open = true;
      if (attr[1].startsWith('data-')) {
        const key = attr[1].slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        el.dataset[key] = attr[2] ?? '';
      }
    }
    el.parent = stack[stack.length - 1] ?? null;
    (el.parent ? el.parent.children : roots).push(el);

    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
  }
  void parent;
  return roots;
}

// ------------------------------ 文档壳 ------------------------------

const docRoot = new El('html');
const documentListeners: Record<string, ((e: unknown) => void)[]> = {};

const getById = (id: string): El => {
  // 用 querySelectorAll（它只看后代）而不是 querySelector —— 后者会连根自己一起匹配
  let el = docRoot.querySelectorAll(`#${id}`)[0];
  if (!el) {
    el = new El('main');
    el.id = id;
    el.parent = docRoot;
    docRoot.children.push(el);
  }
  return el;
};

const document = {
  querySelector: (sel: string) => docRoot.querySelector(sel),
  querySelectorAll: (sel: string) => docRoot.querySelectorAll(sel),
  createElement: (tag: string) => {
    const el = new El(tag);
    // 模拟浏览器：innerHTML 赋值后可取 firstElementChild（renderFilterPanelOnly 依赖它）
    Object.defineProperty(el, 'firstElementChild', {
      get: () => el.children[0] ?? null,
    });
    return el;
  },
  addEventListener: (type: string, fn: (e: unknown) => void) => {
    (documentListeners[type] ??= []).push(fn);
  },
  body: docRoot,
};

const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
};

// ------------------------------ 真实数据 ------------------------------

const fetchJson = async (p: string) => {
  const res = await fetch(BASE + p);
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status}`);
  return res.json();
};
const health = await fetchJson('/api/health');
const overview = await fetchJson('/api/overview?season=2026-10&sort=firstAir');
const week = await fetchJson('/api/week?season=2026-10&rule=clock&offset=0');
const fetchStub = async (url: string) => {
  const body = String(url).includes('/api/week') ? week : String(url).includes('/api/health') ? health : overview;
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

// ------------------------------ 跑真实 app.js ------------------------------

// app.js 在模块顶层就直接给这些元素绑监听（拿不到就会抛），
// 所以要先像 index.html 那样把它们放进文档里。
for (const id of ['update-btn', 'sync-btn', 'translate-btn', 'season-select', 'rule-select', 'ics-link', 'more-menu']) {
  getById(id);
}

const factory = new Function(
  'document',
  'localStorage',
  'fetch',
  'setInterval',
  'setTimeout',
  'location',
  `${source}\n; return { renderSeason, renderWeek, getState: () => state };`,
);
const app = factory(document, localStorage, fetchStub, () => 0, () => 0, { reload: () => {} });
const state = app.getState() as Record<string, unknown>;

// document 的监听器挂到根上，事件才能冒泡到它
for (const [type, fns] of Object.entries(documentListeners)) {
  docRoot.listeners[type] = fns;
}

state.season = '2026-10';
state.selectedSeasons = ['2026-10'];
state.overview = overview;
state.view = 'season';
(state.filters as Record<string, unknown>).weekdays = [];
(state.filters as Record<string, unknown>).side = [];

let failures = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

const appEl = getById('app');
app.renderSeason();
const firstChild = appEl.children[0];
console.log(`\n#app 第 1 个子节点=<${firstChild?.tag} class="${firstChild?.className}"> parent=${firstChild?.parent ? `${firstChild.parent.tag}#${firstChild.parent.id}` : 'null'}`);
console.log(`#app 6 个子节点的 parent 分别 = ${appEl.children.map((c) => (c.parent ? `${c.parent.tag}#${c.parent.id}` : 'null')).join(', ')}`);

console.log(`\n渲染后 #app 直接子元素数=${appEl.children.length}，HTML 长度=${appEl.innerHTML.length}`);

const rowCount = () => appEl.querySelectorAll('.subject-row').length;
const total = rowCount();
console.log(`初始列表行数=${total}`);

console.log('\n【A】「筛选 / 排序」按钮');
const toggle = appEl.querySelector('#filter-toggle');
ok('按钮渲染出来了', Boolean(toggle), `textContent=${toggle?.textContent.trim()}`);
console.log(`    toggle.parent=${toggle?.parent?.tag}#${toggle?.parent?.id}  根监听器数=${docRoot.listeners.click?.length ?? 0}`);
console.log(`    toggle.closest('#filter-panel')=${toggle?.closest('#filter-panel')?.tag ?? 'null'}`);
const panelBefore = appEl.querySelector('#filter-panel');
ok('初始面板是展开的（filtersOpen=true）', Boolean(panelBefore));
if (toggle) {
  const metaBefore = appEl.querySelector('#subject-count')?.textContent ?? '';
  ok('展开时箭头是 ▲', (toggle.textContent ?? '').includes('▲'), `文本=${toggle.textContent?.trim()}`);

  toggle.click();
  ok('filtersOpen 翻成 false', state.filtersOpen === false);
  const panelAfter = appEl.querySelector('#filter-panel');
  ok('点一次后收起（面板消失）', !panelAfter);
  // ⚠ 重绘后原 toggle 节点已脱离文档：箭头要从**新查到的**节点上读
  const toggleAfter = appEl.querySelector('#filter-toggle');
  ok(
    '收起后箭头变 ▼',
    (toggleAfter?.textContent ?? '').includes('▼'),
    `现在的文本=${toggleAfter?.textContent?.trim() ?? '(拿不到节点)'}`,
  );
  ok('统计文本没被弄坏', (appEl.querySelector('#subject-count')?.textContent ?? '') === metaBefore);
}

console.log('\n【B】逐个点各类筛选块，看哪一类没反应');
// 先确保面板是展开的（上一步 A 把它收起了；toggle 节点在重绘后已被替换，要重新查）
const toggleFresh = appEl.querySelector('#filter-toggle');
if (!appEl.querySelector('#filter-panel')) toggleFresh?.click();
ok('面板已展开，可以开始点各类筛选块', Boolean(appEl.querySelector('#filter-panel')));

const rowCountNow = () => appEl.querySelectorAll('.subject-row').length;
// 每个用例前把筛选清空，避免上一个用例把列表筛空导致下一个"看起来没反应"
const resetFilters = () => {
  (state.filters as Record<string, unknown>).weekdays = [];
  (state.filters as Record<string, unknown>).mediaTypes = [];
  (state.filters as Record<string, unknown>).genres = [];
  (state.filters as Record<string, unknown>).platforms = [];
  (state.filters as Record<string, unknown>).side = [];
  app.renderSeason();
};
// 中文属性值用属性匹配即可，但为稳妥起见按属性遍历取节点
const findChip = (attr: string, value: string) =>
  appEl.querySelectorAll('button').find((b) => b.attrs[attr] === value);

const cases: { label: string; attr: string; value: string; expectChange: boolean }[] = [
  { label: '快速筛选「放送中」', attr: 'data-quick-filter', value: 'airing', expectChange: true },
  { label: '放送星期「周五」', attr: 'data-toggle-value', value: '5', expectChange: true },
  { label: '媒体类型「TV」', attr: 'data-toggle-value', value: 'TV', expectChange: true },
  { label: '类型标签「Action」', attr: 'data-toggle-value', value: 'Action', expectChange: true },
  { label: '国内平台「哔哩哔哩」', attr: 'data-toggle-value', value: '哔哩哔哩', expectChange: true },
  { label: '每行几部「6 部」', attr: 'data-per-row', value: '6', expectChange: false },
  { label: '排序「按中文名」', attr: 'data-sort', value: 'titleCn', expectChange: false },
];
for (const c of cases) {
  resetFilters();
  // ⚠ resetFilters() 会整块重绘，节点已换新：必须重绘之后再取节点，
  //   否则点的是一张已脱离文档的旧卡片，什么都不会发生（这坑我踩了两次）
  const el = findChip(c.attr, c.value);
  if (!el) {
    console.log(`  ❌ ${c.label}: 没渲染出来（${c.attr}="${c.value}"）`);
    failures += 1;
    continue;
  }
  const before = rowCountNow();
  el.click();
  // 排序是异步的（changeSort 要重新向服务端要数据），给它一个 tick
  await new Promise((resolve) => setTimeout(resolve, 30));
  const after = rowCountNow();
  // 重绘后原节点已脱离文档，状态要从"新查到的节点"上读
  const fresh = findChip(c.attr, c.value);
  const highlighted = fresh?.classList.contains('is-active') ?? false;
  const effective = c.expectChange ? after !== before : highlighted;
  console.log(
    `  ${effective ? '✓' : '✗'} ${c.label}: 行数 ${before}→${after} 高亮=${highlighted}`,
  );
  if (!effective) failures += 1;
}
resetFilters();

console.log('\n【D】卡片按钮：没加入列表的番也要有「详情」');
resetFilters();
const rows = appEl.querySelectorAll('.subject-row');
const notMine = rows.filter((r) => !r.querySelector('[data-remove]'));
const sample = notMine[0];
const sampleButtons = (sample?.querySelectorAll('button') ?? []).map((b) => b.textContent.trim());
console.log(`    未加入列表的卡片样例按钮=[${sampleButtons.join(', ')}]`);
ok('未加入列表的卡片有「详情」按钮', sampleButtons.includes('详情'));
ok('未加入列表的卡片仍有「追番」「补番」', sampleButtons.includes('追番') && sampleButtons.includes('补番'));
ok('「详情」排在「追番」之前', sampleButtons.indexOf('详情') < sampleButtons.indexOf('追番'));
const mine = rows.find((r) => r.querySelector('[data-remove]'));
if (mine) {
  const mineButtons = mine.querySelectorAll('button').map((b) => b.textContent.trim());
  console.log(`    已在列表的卡片按钮=[${mineButtons.join(', ')}]`);
  ok('已在列表的卡片保留「详情 / 移除」', mineButtons.includes('详情') && mineButtons.includes('移除'));
}

console.log('\n【E】筛选面板：四栏默认收起，可点开');
resetFilters();
// 先单独验证"建元素 + 写 innerHTML + 取 firstElementChild"这条链是好的
const probe = document.createElement('div') as unknown as { innerHTML: string; firstElementChild: El | null };
probe.innerHTML = '<div class="x"><span>hi</span></div>';
console.log(
  `    createElement 自检：innerHTML 长度=${probe.innerHTML.length} firstElementChild=${probe.firstElementChild?.className ?? 'null'}`,
);

const panelEl = appEl.querySelector('#filter-panel');
console.log(`    找到面板节点=${Boolean(panelEl)} 子节点=${panelEl?.children.length} 类名=${panelEl?.className}`);
console.log(
  `    各子节点：${(panelEl?.children ?? [])
    .map((c, i) => `${i}:${c.tag}.${c.className || '-'}(${c.children.length})`)
    .join(' ')}`,
);
const facetsWrap = panelEl?.children.find((c) => c.className.includes('filter-facets'));
console.log(
  `    filter-facets 的子节点：${(facetsWrap?.children ?? [])
    .map((c, i) => `${i}:${c.tag}.${c.className || '-'}(子${c.children.length})`)
    .join(' ')}`,
);
// 不用后代选择器，直接按类名取，再自己沿 parent 往上找 —— 把"选择器引擎"和"DOM 结构"分开验证
const facetNodes = appEl.querySelectorAll('.filter-facet');
console.log(
  `    .filter-facet 节点数=${facetNodes.length}，各自的祖先链：` +
    facetNodes
      .map((f) => `[${(() => { const out: string[] = []; let n: El | null = f; while (n) { out.push(`${n.tag}${n.id ? '#' + n.id : ''}${n.className ? '.' + n.className.split(' ')[0] : ''}`); n = n.parent; } return out.join('<'); })()}]`)
      .join(' '),
);
const facets = facetNodes.filter((f) => Boolean(f.closest('#filter-panel')));
console.log(`    分面栏数=${facets.length}，展开的=${facets.filter((f) => f.open).length}`);
ok('四栏分面都在', facets.length === 4, `实际 ${facets.length}`);
ok('默认全部收起（各栏只留标题，不铺满）', facets.every((f) => !f.open));
const head = facets[0]?.querySelector('.facet-head');
// 摘要文字在子节点上（我的壳把文本累积到各子节点，父节点的 textContent 不会聚合子节点）
const headText = (head?.querySelector('.facet-count')?.textContent ?? '') + (head?.querySelector('.facet-title')?.textContent ?? '');
ok('标题上有"一栏多少项 / 已选几个"的提示', headText.includes('项') || headText.includes('已选'), `文本=${headText}`);
if (facets[0]) {
  // 走真实路径：浏览器里点 <summary> 会翻 details.open 并派发 toggle 事件，
  // 这里照做（直接改 open 不会触发 toggle，测不出"状态有没有被记住"）
  const facet = facets[0];
  facet.open = true;
  facet.dispatch('toggle');
  ok(
    '展开状态被记住',
    (state.facetsOpen as Record<string, boolean> | undefined)?.weekdays === true,
    `facetsOpen=${JSON.stringify(state.facetsOpen)}`,
  );
  // 再点一个筛选块，面板会重绘 —— 展开状态必须还在
  const anyChip = appEl.querySelectorAll('button').find((b) => b.attrs['data-toggle-value'] === 'TV');
  anyChip?.click();
  const facetsAfter = appEl.querySelectorAll('.filter-facet').filter((f) => f.closest('#filter-panel'));
  const weekdayNode = facetsAfter.find((f) => f.attrs['data-facet'] === 'weekdays');
  console.log(
    `    [调试] facetsOpen=${JSON.stringify(state.facetsOpen)} weekdayNode.open=${weekdayNode?.open} ` +
      `attrs.open=${JSON.stringify(weekdayNode?.attrs?.open)} 栏数=${facetsAfter.length}`,
  );
  const weekdayStillOpen = weekdayNode?.open;
  ok('重绘后「放送星期」仍然是展开的（状态没被重置）', weekdayStillOpen === true, `实际=${weekdayStillOpen}`);
}

console.log('\n【C】下拉框（走 change，不经过点击委托）');
const mediaSelect = appEl.querySelector('#filter-media');
const baseRows = rowCountNow();
ok('媒体类型下拉存在', Boolean(mediaSelect));
ok(
  '下拉绑上了 change 监听',
  (mediaSelect?.listeners.change?.length ?? 0) > 0,
  `listeners=${mediaSelect?.listeners.change?.length ?? 0}`,
);
if (mediaSelect) {
  mediaSelect.value = 'MOVIE';
  mediaSelect.dispatch('change');
  ok('选 MOVIE 后列表变化', rowCountNow() !== baseRows, `(${baseRows} → ${rowCountNow()})`);
}

console.log('\n【F】每行几部：列数要真的被这个选择决定');
// 断言到"列表容器拿到了 .per-row-N"这一步。
// ⚠ 这个壳没有布局引擎，量不出"实际排了几列"；而 styles.css 里的列数是**字面量整数**
//   （不能用 repeat(min(...)) —— 那会被浏览器当无效声明丢掉，见 styles.css 的注释），
//   所以"类名对了"就等于"列数对了"。
// 真实列数仍建议在浏览器里目视确认一次（见 .scratch/overview-layout-bug 的验收说明）。
for (const n of [3, 4, 5, 6, 7]) {
  resetFilters();
  const chip = findChip('data-per-row', String(n));
  if (!chip) {
    ok(`「${n} 部」按钮渲染出来了`, false);
    continue;
  }
  chip.click();
  const listEl = appEl.querySelector('#subject-list');
  ok(
    `选「${n} 部」后列表容器带 .per-row-${n}`,
    listEl?.classList.contains(`per-row-${n}`) ?? false,
    `class="${listEl?.className ?? '(拿不到节点)'}"`,
  );
  // 只应有一个 per-row-* 类（旧的不清掉会两个类打架，胜负取决于样式表顺序）
  const howMany = [3, 4, 5, 6, 7].filter((m) => listEl?.classList.contains(`per-row-${m}`)).length;
  ok(`选「${n} 部」后只剩一个 per-row 类`, howMany === 1, `实际 ${howMany} 个`);
}
resetFilters();

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
