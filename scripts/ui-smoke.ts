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
  /** 详情弹窗的 `<div hidden>` 靠它判断开关（与 open 同理，布尔属性） */
  hidden = false;
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
// `modal-backdrop` / `modal` 是 openDetail() 要用的（index.html 里也有），必须一并建出来。
for (const id of [
  'update-btn',
  'sync-btn',
  'translate-btn',
  'season-select',
  'rule-select',
  'ics-link',
  'more-menu',
  'modal-backdrop',
  'modal',
]) {
  getById(id);
}

// 「复制番剧名」要真的调剪贴板。壳里没有 navigator，所以注入一个记录型的假剪贴板：
// 这样断言的是"代码确实调了 writeText 并传了正确的文本"，而不是"按钮有没有渲染出来"。
const copied: string[] = [];
const fakeNavigator = {
  clipboard: {
    writeText: async (text: string) => {
      copied.push(text);
    },
  },
};

const factory = new Function(
  'document',
  'localStorage',
  'fetch',
  'setInterval',
  'setTimeout',
  'location',
  'navigator',
  'window',
  `${source}\n; return { renderSeason, renderWeek, switchView, getState: () => state };`,
);
const app = factory(document, localStorage, fetchStub, () => 0, () => 0, { reload: () => {} }, fakeNavigator, {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
});
const state = app.getState() as Record<string, unknown>;

// document 的监听器挂到根上，事件才能冒泡到它
for (const [type, fns] of Object.entries(documentListeners)) {
  docRoot.listeners[type] = fns;
}

// `#app` 必须**先建出来**再做下面那个 await：bootstrap() 的尾巴会 renderWeek()，
// 而它要写 `$('#app').innerHTML` —— 元素不存在就抛，还会连带让 bootstrap 的 catch 也抛。
const appEl = getById('app');

// ⚠ 先让 `bootstrap()` 的异步尾巴跑完：它最后会 `switchView('week')`。
//   不等它落地，它会在后面任意一个 `await` 的间歇里把 `#app` 换成周视图 ——
//   于是断言会莫名其妙地"查不到筛选面板 / 行数变 0"。
//   实测踩过：B 段第一个用例正好在 `await setTimeout(30)` 里撞上它，行数 172→0，
//   而那条断言写的是"行数有变化"，于是**一直是假通过**。
await new Promise((resolve) => setTimeout(resolve, 80));

state.season = '2026-10';
state.selectedSeasons = ['2026-10'];
state.overview = overview;
state.view = 'season';
state.searchQuery = '';
state.statusAnd = true;

let failures = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

app.renderSeason();
const firstChild = appEl.children[0];
console.log(`\n#app 第 1 个子节点=<${firstChild?.tag} class="${firstChild?.className}"> parent=${firstChild?.parent ? `${firstChild.parent.tag}#${firstChild.parent.id}` : 'null'}`);
console.log(`#app 6 个子节点的 parent 分别 = ${appEl.children.map((c) => (c.parent ? `${c.parent.tag}#${c.parent.id}` : 'null')).join(', ')}`);

console.log(`\n渲染后 #app 直接子元素数=${appEl.children.length}，HTML 长度=${appEl.innerHTML.length}`);

const rowCount = () => appEl.querySelectorAll('.subject-row').length;

/**
 * 收集一个节点及其**所有后代**的文本。
 *
 * ⚠ 不能直接用 `el.textContent`：这个手写壳把文本累积到**解析时的栈顶节点**上
 * （见 parseHtml 里 `stack[stack.length - 1].textContent += trimmed`），
 * 父节点的 textContent 不会聚合子节点 —— 于是 `appEl.textContent` **恒为空串**，
 * 拿它做 `includes()` 断言会**永远为真**（一条测不到任何东西的假守卫，这里踩过一次）。
 */
function collectText(el: El | null): string {
  if (!el) return '';
  return el.textContent + el.children.map((child) => collectText(child)).join('');
}

const total = rowCount();
console.log(`初始列表行数=${total}`);

// ---- 筛选相关的公共小工具（必须在第一个用到它们的断言之前声明：这里是 const 箭头函数，有 TDZ）----

const rowCountNow = () => appEl.querySelectorAll('.subject-row').length;
/** 按"属性名 + 精确值"取按钮（见文件里既有的口径：不用 dataset 驼峰键）。 */
const findChip = (attr: string, value: string) =>
  appEl.querySelectorAll('button').find((b) => b.attrs[attr] === value);

/**
 * 把筛选条件清空并重绘。
 *
 * ⚠ 这里**直接换掉整个 state.filters 对象**（而不是逐个清数组）：三态改版后每个维度是
 *   `{ include, exclude }` 两份，漏清一份就会让下一个用例"看起来没反应"。
 */
const resetFilters = () => {
  state.filters = {
    weekdays: { include: [], exclude: [] },
    mediaTypes: { include: [], exclude: [] },
    genres: { include: [], exclude: [] },
    platforms: { include: [], exclude: [] },
    side: [],
  };
  state.searchQuery = '';
  app.renderSeason();
};

console.log('\n【A】面板常显：搜索框是第 1 层，不再有「筛选 / 排序」总开关');
resetFilters();
const panelBefore = appEl.querySelector('#filter-panel');
ok('面板渲染出来了（常显，不需要先点开关）', Boolean(panelBefore));
ok('不再有「筛选 / 排序」按钮（已按票删掉）', !appEl.querySelector('#filter-toggle'));
const headSlot = appEl.querySelector('#filter-panel-head');
const bodySlot = appEl.querySelector('#filter-panel-body');
ok('面板拆成 第 1 层 / 第 2~5 层 两个槽', Boolean(headSlot) && Boolean(bodySlot));
const searchEl = appEl.querySelector('#season-search');
ok('搜索框在面板第 1 层里', Boolean(searchEl) && searchEl?.closest('#filter-panel-head') !== null);
ok('搜索框绑上了 input 监听', (searchEl?.listeners.input?.length ?? 0) > 0);
ok('部数提示在搜索框那一层（显示 N / M 部）', (appEl.querySelector('#subject-count')?.textContent ?? '').includes('部'));

// 票的硬性验收：搜索框焦点不因点筛选而丢失。
// 这个手写壳量不出"焦点"，但焦点丢失的根因是"节点被换掉了" —— 断言节点身份就够了。
console.log('\n【A2】点筛选不重绘面板第 1 层（搜索框焦点不丢的根因）');
const searchNodeBefore = appEl.querySelector('#season-search');
const headHtmlBefore = appEl.querySelector('#filter-panel-head')?.innerHTML ?? '';
const bodyHtmlBefore = appEl.querySelector('#filter-panel-body')?.innerHTML ?? '';
findChip('data-toggle-value', 'TV')?.click();
ok('点完之后第 1 层还是同一个搜索框节点（没被换掉 = 光标不会丢）', appEl.querySelector('#season-search') === searchNodeBefore);
ok('第 1 层的 HTML 没被重写', (appEl.querySelector('#filter-panel-head')?.innerHTML ?? '') === headHtmlBefore);
ok('第 2~5 层确实重绘了（高亮/部数要跟着变）', (appEl.querySelector('#filter-panel-body')?.innerHTML ?? '') !== bodyHtmlBefore);

console.log('\n【B】逐个点各类筛选块，看哪一类没反应');
const cases: { label: string; attr: string; value: string; expectChange: boolean }[] = [
  { label: '状态「放送中」', attr: 'data-quick-filter', value: 'airing', expectChange: true },
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

// ---------------------------------------------------------------------------
// 三态（含 / 不含 / 不选）：这是本票的核心，断言必须走真实的点击路径
// ---------------------------------------------------------------------------

const rawSubjects = (
  overview as { subjects: { key: string; genres: string[]; mediaType: string; status: string }[] }
).subjects;
const infoOf = new Map(rawSubjects.map((item) => [item.key, item]));
const rowKeys = () => appEl.querySelectorAll('.subject-row').map((r) => r.attrs['data-key'] ?? '');
const sameSet = (keys: string[], want: Set<string>) =>
  keys.length === want.size && keys.every((key) => want.has(key));
const keysWhere = (predicate: (item: (typeof rawSubjects)[number]) => boolean) =>
  new Set(rawSubjects.filter(predicate).map((item) => item.key));
const allKeys = rowKeys();
const fantasyKeys = keysWhere((item) => item.genres.includes('Fantasy'));

console.log('\n【B2】三态循环：点一下 = 含 → 不含 → 不选（票的核心验收）');
resetFilters();
ok('「奇幻」有候选（否则这一节测不出东西）', fantasyKeys.size > 0, `size=${fantasyKeys.size}`);
findChip('data-toggle-value', 'Fantasy')?.click();
ok('第 1 下 = 含：列表只剩含奇幻的', sameSet(rowKeys(), fantasyKeys), `${rowKeys().length} vs ${fantasyKeys.size}`);
const includeState = findChip('data-toggle-value', 'Fantasy');
ok(
  '含的那项带 is-active 与 ✓',
  (includeState?.classList.contains('is-active') ?? false) && (includeState?.textContent ?? '').includes('✓'),
);
findChip('data-toggle-value', 'Fantasy')?.click();
const afterExclude = rowKeys();
ok(
  '第 2 下 = 不含：列表里再没有含奇幻的（用户点名的用例）',
  afterExclude.every((key) => !fantasyKeys.has(key)),
  `剩 ${afterExclude.length} 行`,
);
ok(
  '不含时行数 = 总行数 − 含奇幻的',
  afterExclude.length === allKeys.length - fantasyKeys.size,
  `${afterExclude.length} vs ${allKeys.length - fantasyKeys.size}`,
);
const excludeState = findChip('data-toggle-value', 'Fantasy');
ok('不含的那项带 is-excluded（红字 + 删除线）', excludeState?.classList.contains('is-excluded') ?? false);
ok('不含的那项带 ⊘ 标记（不依赖颜色也能分辨）', (excludeState?.textContent ?? '').includes('⊘'));
ok('同一项不会同时又含又不含', !(excludeState?.classList.contains('is-active') ?? false));
findChip('data-toggle-value', 'Fantasy')?.click();
ok('第 3 下 = 恢复不选：又是全部', rowKeys().length === allKeys.length, `${rowKeys().length} vs ${allKeys.length}`);

console.log('\n【B3】组内并集 / 组间交集 / 排除一票否决');
resetFilters();
findChip('data-toggle-value', 'Fantasy')?.click();
findChip('data-toggle-value', 'Sci-Fi')?.click();
const unionKeys = keysWhere((item) => item.genres.includes('Fantasy') || item.genres.includes('Sci-Fi'));
ok('组内并集：同一维度选两个「含」', sameSet(rowKeys(), unionKeys), `${rowKeys().length} vs ${unionKeys.size}`);
findChip('data-toggle-value', 'TV')?.click();
const crossKeys = rowKeys();
ok('组间交集：每一行都是 TV', crossKeys.length > 0 && crossKeys.every((key) => infoOf.get(key)?.mediaType === 'TV'));
ok(
  '组间交集的数量 = TV ∩ (奇幻 ∪ 科幻)',
  crossKeys.length ===
    rawSubjects.filter(
      (item) => item.mediaType === 'TV' && (item.genres.includes('Fantasy') || item.genres.includes('Sci-Fi')),
    ).length,
  `${crossKeys.length}`,
);
// 把「奇幻」改成"不含"：排除要能穿过"组内并集"，一票否决
findChip('data-toggle-value', 'Fantasy')?.click();
const vetoKeys = rowKeys();
ok('排除一票否决：含奇幻的整条丢掉', vetoKeys.length > 0 && vetoKeys.every((key) => !fantasyKeys.has(key)));
ok(
  '排除不吃掉同组另一个「含」（科幻还在）',
  vetoKeys.every((key) => infoOf.get(key)?.genres.includes('Sci-Fi') ?? false),
);
ok('排除是跨维度的（TV 那条约束也还在）', vetoKeys.every((key) => infoOf.get(key)?.mediaType === 'TV'));

console.log('\n【B4】条件条：含与不含分开显示，都能单独取消');
resetFilters();
const filtersOf = () => state.filters as Record<string, { include: string[]; exclude: string[] }>;
/** 条件条里的按钮（壳的 matches() 不解析后代选择器，所以按 closest 过滤）。 */
const barChips = () => appEl.querySelectorAll('button').filter((b) => Boolean(b.closest('#active-filters')));
findChip('data-toggle-value', 'Fantasy')?.click();
findChip('data-toggle-value', 'Hentai')?.click();
findChip('data-toggle-value', 'Hentai')?.click(); // → 不含
const includeBarChip = barChips().find((b) => b.attrs['data-clear-value'] === 'Fantasy');
const excludeBarChip = barChips().find((b) => b.attrs['data-clear-value'] === 'Hentai');
ok('「含」的那项在条件条里，文字写明「含」', (includeBarChip?.textContent ?? '').includes('含'));
ok(
  '「不含」的那项在条件条里，文字是「⊘ 不含 …」',
  (excludeBarChip?.textContent ?? '').includes('⊘') && (excludeBarChip?.textContent ?? '').includes('不含'),
);
ok('「不含」的 chip 也带 is-excluded（删除线）', excludeBarChip?.classList.contains('is-excluded') ?? false);
includeBarChip?.click();
ok(
  '点「含」的 ✕ 只清掉含，不含还在',
  filtersOf().genres.include.length === 0 && filtersOf().genres.exclude.length === 1,
  JSON.stringify(filtersOf().genres),
);
barChips().find((b) => b.attrs['data-clear-value'] === 'Hentai')?.click();
ok('点「不含」的 ✕ 只清掉不含', filtersOf().genres.exclude.length === 0);
findChip('data-toggle-value', 'Fantasy')?.click();
findChip('data-quick-filter', 'airing')?.click();
const clearAllBtn = appEl.querySelectorAll('button').find((b) => 'data-clear-filters' in b.attrs);
ok('渲染出「全部清空」', Boolean(clearAllBtn));
clearAllBtn?.click();
ok(
  '「全部清空」把含、不含、状态一起清掉',
  filtersOf().genres.include.length === 0 &&
    filtersOf().genres.exclude.length === 0 &&
    ((state.filters as { side?: string[] }).side ?? []).length === 0 &&
    rowCountNow() === allKeys.length,
  `行数=${rowCountNow()}`,
);

console.log('\n【B5】第 2 层那个"多个之间：且 / 或"的小切换键');
resetFilters();
state.statusAnd = true;
app.renderSeason();
const airingKeys = keysWhere((item) => item.status === 'airing');
const upcomingKeys = keysWhere((item) => item.status === 'upcoming');
const modeBtn = () => findChip('data-status-mode', '1');
findChip('data-quick-filter', 'airing')?.click();
findChip('data-quick-filter', 'upcoming')?.click();
ok('默认「且」：放送中 ∧ 未开播 = 0 部（沿用线上老行为）', rowCountNow() === 0, `行数=${rowCountNow()}`);
ok('切换键上写着当前是「且」', (modeBtn()?.textContent ?? '').includes('且'));
modeBtn()?.click();
ok('点一下变成「或」', (modeBtn()?.textContent ?? '').includes('或'));
ok(
  '「或」：放送中 ∪ 未开播',
  rowCountNow() === airingKeys.size + upcomingKeys.size,
  `${rowCountNow()} vs ${airingKeys.size + upcomingKeys.size}`,
);
ok('切换被记进 localStorage（不只是这一屏有效）', store.get('anime-tracker.statusAnd') === '0');
modeBtn()?.click();
ok('再切回「且」，行数回到 0', rowCountNow() === 0 && store.get('anime-tracker.statusAnd') === '1');
resetFilters();

console.log('\n【D】卡片按钮：详情改成点整张卡片，「追番 / 补番 / 移除」保留');
const rows = appEl.querySelectorAll('.subject-row');
const notMine = rows.filter((r) => !r.querySelector('[data-remove]'));
const sample = notMine[0];
const sampleButtons = (sample?.querySelectorAll('button') ?? []).map((b) => b.textContent.trim());
console.log(`    未加入列表的卡片样例按钮=[${sampleButtons.join(', ')}]`);
// 这一节用的是"逐卡片 querySelectorAll('button')"而不是 `.subject-row button`：
// 这个手写壳的 matches() 不解析后代选择器，写成后代选择器会命中卡片 div 自己。
ok('卡片上没有「详情」按钮了（改成点整张卡片）', !sampleButtons.includes('详情'));
ok('未加入列表的卡片仍有「追番」「补番」', sampleButtons.includes('追番') && sampleButtons.includes('补番'));
ok('卡片上有「复制番剧名」按钮', sampleButtons.includes('复制'));
const mine = rows.find((r) => r.querySelector('[data-remove]'));
if (mine) {
  const mineButtons = mine.querySelectorAll('button').map((b) => b.textContent.trim());
  console.log(`    已在列表的卡片按钮=[${mineButtons.join(', ')}]`);
  // 注意：移除按钮的**文字**是「移除」，但它的危险语义靠 btn-danger 类表达，这里只查文字
  ok('已在列表的卡片保留「移除」且没有「详情」', mineButtons.includes('移除') && !mineButtons.includes('详情'));
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
// 三态改版后折叠栏有 5 个：四个维度 + 一个「显示方式」（排序与每行几部收在里面）
const dimensionFacets = facets.filter((f) => f.attrs['data-facet'] !== 'display');
const displayFacet = facets.find((f) => f.attrs['data-facet'] === 'display');
console.log(`    折叠栏数=${facets.length}（维度 ${dimensionFacets.length} + 显示方式 ${displayFacet ? 1 : 0}），展开的=${facets.filter((f) => f.open).length}`);
ok('四个维度栏都在', dimensionFacets.length === 4, `实际 ${dimensionFacets.length}`);
ok('多了一个「显示方式」折叠栏（排序 + 每行几部收在里面）', Boolean(displayFacet));
ok(
  '「显示方式」里确实放着排序与每行几部的按钮',
  Boolean(displayFacet) &&
    displayFacet !== undefined &&
    displayFacet.querySelectorAll('button').length > 0,
);
ok('五个折叠栏默认全部收起（各栏只留标题，不铺满）', facets.every((f) => !f.open));
const head = dimensionFacets[0]?.querySelector('.facet-head');
// 摘要文字在子节点上（我的壳把文本累积到各子节点，父节点的 textContent 不会聚合子节点）
const headText = (head?.querySelector('.facet-count')?.textContent ?? '') + (head?.querySelector('.facet-title')?.textContent ?? '');
ok('标题上有"一栏多少项 / 已选几个"的提示', headText.includes('项') || headText.includes('已选'), `文本=${headText}`);

// 标题右侧要把「含」与「不含」分开报：已选 1 · 排除 1
resetFilters();
findChip('data-toggle-value', 'Action')?.click();
findChip('data-toggle-value', 'Mecha')?.click();
findChip('data-toggle-value', 'Mecha')?.click(); // → 不含
const genresFacet = () => appEl.querySelectorAll('.filter-facet').find((f) => f.attrs['data-facet'] === 'genres');
const genresCount = () => genresFacet()?.querySelector('.facet-count')?.textContent ?? '';
ok(
  '标题上分开报「已选 1 · 排除 1」',
  genresCount().includes('已选 1') && genresCount().includes('排除 1'),
  `文本=${genresCount()}`,
);
ok(
  '摘要里"不含"的那一项带删除线类',
  Boolean(genresFacet()?.querySelector('.facet-picked')?.querySelectorAll('.is-excluded').length),
);
resetFilters();

if (dimensionFacets[0]) {
  // 走真实路径：浏览器里点 <summary> 会翻 details.open 并派发 toggle 事件，
  // 这里照做（直接改 open 不会触发 toggle，测不出"状态有没有被记住"）
  const facet = dimensionFacets[0];
  facet.open = true;
  facet.dispatch('toggle');
  ok(
    '展开状态被记住',
    (state.facetsOpen as Record<string, boolean> | undefined)?.weekdays === true,
    `facetsOpen=${JSON.stringify(state.facetsOpen)}`,
  );
  // 再点一个筛选块，面板正文会重绘 —— 展开状态必须还在
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

console.log('\n【C】旧的两套筛选 UI 已经删掉（面板里只剩一套操作方式）');
resetFilters();
ok(
  '四个下拉框全都没了（#filter-weekday / #filter-media / #filter-genre / #filter-platform）',
  ['filter-weekday', 'filter-media', 'filter-genre', 'filter-platform'].every(
    (id) => !appEl.querySelector(`#${id}`),
  ),
);
ok(
  '筛选面板里一个 <select> 都没有了',
  appEl.querySelectorAll('select').every((s) => !s.closest('#filter-panel')),
);
const toggleButtons = appEl.querySelectorAll('button').filter((b) => 'data-toggle-value' in b.attrs);
ok(
  '三态选项只出现在第 3 层的四个维度栏里（没有第二套联动同一份条件）',
  toggleButtons.length > 0 && toggleButtons.every((b) => Boolean(b.closest('.filter-facets'))),
  `三态按钮数=${toggleButtons.length}`,
);

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

console.log('\n【G】总览页精简与季度全选');
// 顶部那排统计卡片（172 本季番剧总数 / 放送中 / 未开播 / …）已按用户要求去掉。
// 断言"不再渲染"而不是"数据没了" —— overview.totals 仍要用（我的追番徽章、季度说明里的总数）。
// ⚠ 必须先切到总览视图：#app 的 innerHTML 每次渲染都会被整块替换，
//   上一步停留在哪个视图不确定，直接查 .stat-row 可能查的是别的视图。
state.overview = overview;
await app.switchView('season');
ok('顶部统计卡片已移除', appEl.querySelectorAll('.stat-row').length === 0);
// 只挑**真的被删掉**的标签来查。
// ⚠ 不要把「缺中文名」写进来：它同时是快速筛选栏里一个 chip 的文字（web/app.js 的快速筛选），
//   那个 chip 必须保留 —— 写进来只会让断言在真实 DOM 下失败。
// ⚠ 文本要用 collectText 收集后代：手写壳里父节点的 textContent 恒为空串（见该函数的注释）。
const statLabels = ['本季番剧总数', '临时机翻名'];
const appText = collectText(appEl);
ok(
  '统计卡片独有的文字一个都不剩',
  statLabels.every((label) => !appText.includes(label)),
  `仍出现=${statLabels.filter((label) => appText.includes(label)).join(', ')}（appText 长度=${appText.length}）`,
);
// 防"假守卫"自检：如果 collectText 拿不到任何文本，上面那条会永远为真 ——
// 所以顺带断言文本确实收集到了（探针用一个**必然存在**的文字）。
ok('文本收集本身是有效的（防假守卫自检）', appText.includes('库里已有的季度'), `appText 长度=${appText.length}`);
ok(
  '面板外壳没有被误删（搜索框与筛选面板还在）',
  Boolean(appEl.querySelector('#season-search')) && Boolean(appEl.querySelector('#filter-panel')),
);

// 季度全选：按钮要排在季度标签**最前面**，点一次选中库里所有季度。
const overviewSeasons = ((overview as { seasonSummaries?: { season: string }[] }).seasonSummaries ?? []).map(
  (item) => item.season,
);
console.log(`    库里季度=${overviewSeasons.join(', ')}`);
// 用带连字符的**属性名**找按钮，而不是 `b.dataset.seasonAll`：
// 这个文件里找节点的既有口径是"属性名 + 精确值"（见 findChip 的 `b.attrs[attr] === value`），
// dataset 的键是驼峰形态，两套混用容易在看代码的人那里产生误解。
const findSeasonAll = () => appEl.querySelectorAll('button').find((b) => 'data-season-all' in b.attrs);
const allBtn = findSeasonAll();
ok('渲染出「全选」按钮', Boolean(allBtn), `文本=${allBtn?.textContent.trim() ?? '(没有)'}`);
if (allBtn) {
  const chipRow = allBtn.parent;
  const firstChip = chipRow?.children[0];
  ok(
    '「全选」排在季度标签最前面',
    firstChip === allBtn,
    `第一个是 <${firstChip?.tag} class="${firstChip?.className}">`,
  );
  const wantAll = [state.season, ...overviewSeasons.filter((s) => s !== state.season)];
  allBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const gotAll = (state.selectedSeasons as string[]).join(',');
  ok(
    `点「全选」选中全部 ${wantAll.length} 个季度（主季仍是 ${String(state.season)}）`,
    gotAll === wantAll.join(','),
    `实际=${gotAll}`,
  );
  const freshAll = findSeasonAll();
  ok('全部选中时「全选」按钮显示为按下状态', freshAll?.classList.contains('is-active') ?? false);
  // 再点一次要能回到"只选当季"：全选之后逐个点掉 8 个标签体验太差
  freshAll?.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok(
    '再点一次回到只选当季',
    (state.selectedSeasons as string[]).join(',') === String(state.season),
    `实际=${(state.selectedSeasons as string[]).join(',')}`,
  );
}

// 导航栏里那几个 tab 在 index.html，**不在 #app 内**，这个手写壳量不到 ——
// 那条断言放在 verify.ts（直接读 index.html），这里只确认总览视图没被改坏。
console.log('\n【H】总览视图仍然正常');
await app.switchView('season');
ok('总览视图仍能渲染出番剧行', appEl.querySelectorAll('.subject-row').length > 0);

// 全选之后列表会从 172 部变成全库 1000+ 部（9 个季度）。实测一次渲染耗时，
// 免得"能出结果但界面卡死"这种问题要等用户来发现。
console.log('\n【I】全选后的渲染规模（9 个季度一起渲染）');
const allSeasons = ['2026-10', '2026-07', '2026-04', '2026-01', '2025-10', '2025-07', '2025-04', '2025-01', '2024-10'];
state.overview = overview;
state.season = '2026-10';
state.selectedSeasons = allSeasons;
const bigOverview = await fetchJson(
  `/api/overview?season=${encodeURIComponent(allSeasons.join(','))}&sort=firstAir`,
);
state.overview = bigOverview;
const renderStart = Date.now();
app.renderSeason();
const renderMs = Date.now() - renderStart;
const bigRows = appEl.querySelectorAll('.subject-row').length;
console.log(`    9 个季度：接口 ${(bigOverview as { subjects: unknown[] }).subjects.length} 条，渲染出 ${bigRows} 行，耗时 ${renderMs}ms`);
ok('9 个季度一起渲染不抛错且行数匹配', bigRows === (bigOverview as { subjects: unknown[] }).subjects.length);
// 上限放宽到 15 秒：这只手写壳比真实 DOM 慢得多，这里只拦"卡死"，不做性能验收。
// 真实浏览器里的手感要人工确认（见票里的说明）。
ok('单次渲染在 15 秒内完成（只是拦住卡死，不是性能验收）', renderMs < 15_000, `实际 ${renderMs}ms`);

// 还原成单季，避免影响后续断言
state.selectedSeasons = ['2026-10'];
state.overview = overview;
resetFilters();

console.log('\n【J】点卡片弹详情，但点按钮不能同时弹详情');
// 这是本票最容易出的 bug：卡片改成整块可点后，"追番 / 补番 / 移除 / 复制"必须不能连带弹详情。
// 能不能在壳里测？能 —— 这些按钮本来就靠 document 级点击委托（壳里 document 的监听器挂在 docRoot 上，
// El.dispatch 会从 target 一路冒泡到根），所以这条路径是真实的。
// ⚠ 排版警告：这个壳的 matches() **不解析后代选择器** —— `.subject-row button` 会被理解成
//   "同时是 .subject-row 又是 button"，结果命中**卡片 div 自己**（实测 172 个，按钮 0 个）。
//   所以这里一律"对每张卡片单独 querySelectorAll('button')"，别写后代选择器。
await app.switchView('season');
const backdrop = docRoot.querySelectorAll('#modal-backdrop')[0];
ok('测试壳里有详情弹窗容器', Boolean(backdrop), '若为 ✗，是壳没建这两个元素，不是业务代码的问题');
const modalOf = () => docRoot.querySelectorAll('#modal')[0];
const closeModal = () => {
  if (backdrop) backdrop.hidden = true;
  if (modalOf()) modalOf()!.innerHTML = '';
};
/** 取所有卡片上的按钮（配合壳不支持后代选择器，只能逐卡片取） */
const cardButtons = (): El[] => appEl.querySelectorAll('.subject-row').flatMap((row) => row.querySelectorAll('button'));

const notMineRow = appEl.querySelectorAll('.subject-row').find((r) => !r.querySelector('[data-remove]'));
ok('找得到一部未加入列表的番（用于测试）', Boolean(notMineRow), `key=${notMineRow?.attrs['data-key']}`);
if (backdrop && notMineRow) {
  closeModal();
  // 点卡片本身（不是按钮）
  notMineRow.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok('点卡片弹出了详情', backdrop.hidden === false);
  ok(
    '详情内容是该番（弹窗里有标题）',
    (modalOf()?.innerHTML ?? '').length > 0,
    `modal 长度=${(modalOf()?.innerHTML ?? '').length}`,
  );

  // 点「追番」：不能连带弹详情
  closeModal();
  const addBtn = notMineRow.querySelectorAll('button').find((b) => 'data-add' in b.attrs);
  ok('卡片上的「追番」按钮还在', Boolean(addBtn), `卡片按钮数=${notMineRow.querySelectorAll('button').length}`);
  addBtn?.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok('点「追番」不会连带弹出详情', backdrop.hidden === true);
}
closeModal();

console.log('\n【K】卡片上的「复制番剧名」按钮');
state.overview = overview;
await app.switchView('season');
const rowsNow = appEl.querySelectorAll('.subject-row');
const copyBtns = cardButtons().filter((b) => 'data-copy' in b.attrs);
ok('每张卡片都有「复制」按钮', copyBtns.length === rowsNow.length, `实际 ${copyBtns.length} 个 / 卡片 ${rowsNow.length} 张`);
const firstCopy = copyBtns[0];
if (backdrop && firstCopy) {
  // 复制要先确认"点它不会弹详情"，再确认"真的调了剪贴板、且传的是这张番的名字"
  closeModal();
  const copyRow = firstCopy.closest('.subject-row');
  const cnTitle = (copyRow?.querySelector('.t-cn')?.textContent ?? '').trim();
  const origTitle = (copyRow?.querySelector('.t-orig')?.textContent ?? '').trim();
  const before = copied.length;
  firstCopy.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok('点「复制」不会连带弹出详情', backdrop.hidden === true);
  // 真正要锁的是"按钮携带的 key 与它所在卡片一致"（而不是拿它去比卡片节点）
  const copyKey = firstCopy.attrs['data-copy'];
  ok(
    '「复制」按钮携带的 key 与所在卡片一致',
    Boolean(copyKey) && copyKey === copyRow?.attrs['data-key'],
    `按钮=${copyKey} 卡片=${copyRow?.attrs['data-key']}`,
  );
  ok('「复制」真的调了剪贴板', copied.length === before + 1, `copied=${JSON.stringify(copied)}`);
  const text = copied[copied.length - 1] ?? '';
  // 只复制中文名，不加原名：搜索引擎会把"中文名 原名"整串当短语，反而搜不到
  ok(
    '复制的内容就是这张番的中文名',
    cnTitle.length > 0 && text === cnTitle,
    `copied=${JSON.stringify(text)} cnTitle=${JSON.stringify(cnTitle)}`,
  );
  ok('复制内容里不带日文原名（否则贴到站外搜不到）', origTitle === '' || !text.includes(origTitle), `copied=${JSON.stringify(text)} orig=${JSON.stringify(origTitle)}`);
}

// 把「详情」按钮去掉之后，卡片上不该再有它 —— 弹详情改成点卡片了
const detailBtns = cardButtons().filter((b) => 'data-open' in b.attrs);
ok('卡片上不再有「详情」按钮', detailBtns.length === 0, `仍有 ${detailBtns.length} 个`);

console.log('\n【L】卡片与按钮的键盘行为（keydown 路径）');
// 为什么必须单独测这条：鼠标路径与键盘路径**走的是两段代码**。
// 实测踩过的真 bug —— keydown 分支里用 `closest('[data-subject-row]')` 会**向上**命中卡片，
// 于是焦点在按钮上按空格时，preventDefault() 吃掉了浏览器"Space → click"的默认转换，
// 卡片内按钮**永远按不动**（键盘用户彻底用不了追番/补番/移除/复制），而且是静默的。
state.overview = overview;
await app.switchView('season');
const keyTargets = appEl.querySelectorAll('.subject-row');
const keyRow = keyTargets.find((r) => !r.querySelector('[data-remove]'));
if (backdrop && keyRow) {
  // ① 焦点在**卡片本身**：回车应打开详情
  closeModal();
  // 用对象承载"是否被 preventDefault"：`let x = false` 会被 TS 收窄成字面量 false，
  // 后续 `x === true` 直接报"两个类型没有重叠"。
  const cardKey = { prevented: false };
  keyRow.dispatch('keydown', { key: 'Enter', preventDefault: () => (cardKey.prevented = true) });
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok('卡片上按回车能打开详情', backdrop.hidden === false, `prevented=${cardKey.prevented}`);
  ok('回车被 preventDefault 接管', cardKey.prevented === true);

  // ② 焦点在卡片**内部的按钮**上：不得抢走浏览器的激活行为
  closeModal();
  const keyAdd = keyRow.querySelectorAll('button').find((b) => 'data-add' in b.attrs);
  const buttonKey = { prevented: false };
  keyAdd?.dispatch('keydown', { key: ' ', preventDefault: () => (buttonKey.prevented = true) });
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok('在「追番」按钮上按空格不会弹出详情', backdrop.hidden === true);
  ok('在「追番」按钮上按空格不会 preventDefault（否则按钮永远按不动）', buttonKey.prevented === false);
}
closeModal();

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
