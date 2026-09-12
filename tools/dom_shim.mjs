/* =============================================================================
 * dom_shim.mjs —— 一个「够用就好」的浏览器 DOM 替身，用来在 Node 里真实跑 app.js
 * -----------------------------------------------------------------------------
 * 为什么需要它：
 *   改完前端以后，「语法没问题」不等于「点了按钮有反应」。项目里没有浏览器自动化
 *   环境（无 puppeteer / jsdom），所以这里实现 app.js 实际用到的那一小部分 DOM：
 *     · 解析 innerHTML（含自闭合标签、注释、文本节点）
 *     · querySelector / querySelectorAll，支持 #id、.class、tag[attr="v"]、后代组合
 *     · classList / dataset / style / setAttribute / value / checked
 *     · appendChild / insertAdjacentHTML / textContent
 *     · fetch 带上 cookie jar（后端靠 aipm_uid 做多用户隔离，不带 cookie 就串号）
 *
 * 它**不是**一个完整浏览器实现：不做布局、不做 CSS 计算、不跑事件冒泡。
 * 断言里只检查「数据有没有正确渲染进 DOM」和「点击后有没有发出正确的请求」，
 * 不检查像素和样式。样式相关的检查交给 verify_frontend.mjs 和 verify_theme*。
 * ========================================================================== */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// 原生 fetch 的引用：模块加载时先存下来（之后会被测试覆盖成带 cookie jar 的版本）
const NATIVE_FETCH = globalThis.fetch.bind(globalThis);

/* ------------------------------- 选择器引擎 ------------------------------- */

function parseCompound(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([#.]?[A-Za-z0-9_-]+)|(\[[^\]]+\])|(\*)/g;
  let m;
  while ((m = re.exec(sel))) {
    if (m[2]) {
      const body = m[2].slice(1, -1);
      const eq = body.indexOf('=');
      if (eq < 0) out.attrs.push({ name: body.trim(), value: null });
      else {
        let v = body.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        out.attrs.push({ name: body.slice(0, eq).trim(), value: v });
      }
    } else if (m[3]) {
      // *
    } else {
      const tok = m[1];
      if (tok.startsWith('#')) out.id = tok.slice(1);
      else if (tok.startsWith('.')) out.classes.push(tok.slice(1));
      else out.tag = tok.toLowerCase();
    }
  }
  return out;
}

function matchesCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v == null) return false;
    if (a.value != null && v !== a.value) return false;
  }
  return true;
}

function queryAll(root, selector) {
  // 子代组合符 > 在这里按后代处理：测试里两种写法都当「在后代里找」，
  // 因为本项目所有选择器都只是用来定位，不依赖严格父子关系。
  const chains = String(selector).replace(/>/g, ' ').split(',').map(s => s.trim()).filter(Boolean)
    .map(s => s.split(/\s+/).map(parseCompound));

  const all = [];
  (function collect(node) {
    for (const c of node.children || []) {
      if (c.nodeType === 1) { all.push(c); collect(c); }
    }
  })(root);

  const res = [];
  for (const chain of chains) {
    const last = chain[chain.length - 1];
    for (const el of all) {
      if (!matchesCompound(el, last)) continue;
      // 逐层向上找祖先，匹配剩余的复合选择器（后代组合，不要求直接父子）
      let ok = true, p = el.parentNode, k = chain.length - 2;
      while (k >= 0) {
        let found = false;
        while (p && p.nodeType === 1) {
          if (matchesCompound(p, chain[k])) { found = true; p = p.parentNode; break; }
          p = p.parentNode;
        }
        if (!found) { ok = false; break; }
        k--;
      }
      if (ok && res.indexOf(el) < 0) res.push(el);
    }
  }
  return res;
}

/* ------------------------------- 节点 ------------------------------------- */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = s => String(s).replace(/&(#?[a-z0-9]+);/gi, (m, g) => (ENT[g.toLowerCase()] != null ? ENT[g.toLowerCase()] : m));

class ClassList {
  constructor(el) { this.el = el; }
  _list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _set(list) { this.el.setAttribute('class', list.join(' ')); }
  contains(c) { return this._list().indexOf(c) >= 0; }
  add(...cs) { const l = this._list(); cs.forEach(c => { if (l.indexOf(c) < 0) l.push(c); }); this._set(l); }
  remove(...cs) { this._set(this._list().filter(c => cs.indexOf(c) < 0)); }
  toggle(c, force) {
    const has = this.contains(c);
    const on = force === undefined ? !has : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

class El {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
    this.style = new Proxy({ _d: {} }, {
      get: (t, k) => (k === '_d' ? t._d : (t._d[k] != null ? t._d[k] : '')),
      set: (t, k, v) => { t._d[k] = v; return true; },
    });
    this._text = '';
    // 事件属性（onclick 等）直接挂在实例上，测试里手动触发
  }

  /* ---- 属性 ---- */
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) {
    this.attrs.set(n, String(v));
    if (n === 'id') this._id = String(v);
    if (n === 'value') this._value = String(v);
    if (n === 'checked') this._checked = true;
    if (n === 'selected') this._selected = true;
    if (n === 'disabled') this.disabled = true;
  }
  removeAttribute(n) { this.attrs.delete(n); }

  get id() { return this.attrs.get('id') || ''; }
  set id(v) { this.attrs.set('id', String(v)); }

  // dataset 必须做成「活的对象」：真实 DOM 里 el.dataset.x = 1 会写回 data-x 属性、
  // 之后 el.dataset.x 能读到。如果只返回一个普通对象，写进去就丢了 —— 那会让
  // 「读自己刚写的 dataset」这类代码在测试里永远读不到值（假失败）。
  get dataset() {
    const el = this;
    const attrOf = k => 'data-' + String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    return new Proxy({}, {
      get(t, k) {
        if (typeof k !== 'string') return undefined;
        const a = attrOf(k);
        return el.attrs.has(a) ? el.attrs.get(a) : undefined;
      },
      set(t, k, v) { el.attrs.set(attrOf(k), String(v)); return true; },
      has(t, k) { return typeof k === 'string' && el.attrs.has(attrOf(k)); },
    });
  }

  // 真实 DOM 里 className 和 class 属性是同一份数据；这里必须同步，
  // 否则用 el.className = 'x' 建出来的元素按 .x 选择器是选不到的
  get className() { return this.attrs.get('class') || ''; }
  set className(v) { this.attrs.set('class', String(v)); }

  /* ---- 表单值 ---- */
  get value() {
    if (this._value != null) return this._value;
    if (this.tagName === 'SELECT') {
      const opts = queryAll(this, 'option');
      const sel = opts.find(o => o._selected) || opts[0];
      return sel ? (sel.getAttribute('value') != null ? sel.getAttribute('value') : sel.textContent) : '';
    }
    return this.getAttribute('value') || '';
  }
  set value(v) { this._value = String(v); }
  get checked() { return !!this._checked; }
  set checked(v) { this._checked = !!v; }
  get disabled() { return !!this._disabled; }
  set disabled(v) { this._disabled = !!v; }
  get scrollTop() { return this._scrollTop || 0; }
  set scrollTop(v) { this._scrollTop = v; }
  get scrollHeight() { return 0; }

  /* ---- 树操作 ---- */
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1); return node; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  closest(sel) {
    const c = parseCompound(sel);
    let p = this;
    while (p && p.nodeType === 1) { if (matchesCompound(p, c)) return p; p = p.parentNode; }
    return null;
  }

  /* ---- 内容 ---- */
  get textContent() {
    if (this.children.length === 0) return decode(this._text);
    // 文本子节点取 _text，元素子节点递归
    return this.children.map(c => (c.nodeType === 3 ? decode(c._text) : c.textContent)).join('');
  }
  set textContent(v) { this.children = []; this._text = String(v); }

  set innerHTML(html) { this.children = []; this._text = ''; parseInto(this, String(html), this.ownerDocument); }
  get innerHTML() { return serialize(this); }

  insertAdjacentHTML(pos, html) {
    const frag = { children: [] };
    const holder = new El('div', this.ownerDocument);
    parseInto(holder, String(html), this.ownerDocument);
    if (pos === 'afterbegin') {
      const old = this.children;
      this.children = [];
      holder.children.forEach(c => this.appendChild(c));
      old.forEach(c => this.appendChild(c));
    } else {
      holder.children.forEach(c => this.appendChild(c));
    }
    return frag;
  }

  /* ---- 查询 ---- */
  querySelector(sel) { const r = queryAll(this, sel); return r.length ? r[0] : null; }
  querySelectorAll(sel) { return queryAll(this, sel); }

  /* ---- 事件（手动触发用） ---- */
  click() { if (typeof this.onclick === 'function') return this.onclick({ target: this, stopPropagation() {}, preventDefault() {} }); }
  fire(type, extra) {
    const h = this['on' + type];
    if (typeof h === 'function') return h(Object.assign({ target: this, key: '', stopPropagation() {}, preventDefault() {} }, extra || {}));
  }
  addEventListener() { /* app.js 里只对 document/window 用过 */ }
}

/* ------------------------------- 解析 ------------------------------------- */

function parseInto(root, html, doc) {
  const tagRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0, m;
  let cur = root;
  while ((m = tagRe.exec(html))) {
    const text = html.slice(last, m.index);
    // 只保留有内容的文本；纯空白（HTML 里的换行缩进）直接丢掉
    if (text && text.trim()) {
      const t = new El('#text', doc);
      t.nodeType = 3;
      t._text = text;
      t.parentNode = cur;
      cur.children.push(t);
    }
    last = tagRe.lastIndex;
    if (m[0].startsWith('<!--')) continue;

    const closing = m[0][1] === '/';
    const tag = m[1];
    const attrStr = m[2] || '';
    const selfClose = m[3] === '/' || VOID_TAGS.has(tag.toLowerCase());

    if (closing) {
      if (cur !== root && cur.tagName.toLowerCase() === tag.toLowerCase()) cur = cur.parentNode;
      continue;
    }

    const el = new El(tag, doc);
    const aRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
    let am;
    while ((am = aRe.exec(attrStr))) {
      let v = am[2] == null ? '' : am[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      el.setAttribute(am[1], v);
      if (am[1] === 'value') el._value = v;
    }
    cur.appendChild(el);
    if (!selfClose) cur = el;
  }
  const tail = html.slice(last);
  if (tail) root._text += tail;
  return root;
}

function serialize(el) {
  const attrs = [...el.attrs].map(([k, v]) => ' ' + k + '="' + v + '"').join('');
  const tag = el.tagName.toLowerCase();
  const inner = el.children.map(c => (c.nodeType === 3 ? c._text : serialize(c))).join('') +
    (el.children.length ? '' : el._text);
  if (VOID_TAGS.has(tag)) return '<' + tag + attrs + '>';
  return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
}

/* ------------------------------- Document --------------------------------- */

class Doc extends El {
  constructor() { super('#document', null); this.ownerDocument = this; }
  createElement(tag) { return new El(tag, this); }
  getElementById(id) { return queryAll(this, '#' + id)[0] || null; }
  addEventListener() {}
}

export function createDOM(html) {
  const doc = new Doc();
  parseInto(doc, html, doc);
  const body = queryAll(doc, 'body')[0] || doc;
  const head = queryAll(doc, 'head')[0] || doc;
  doc.body = body;
  doc.head = head;
  doc.documentElement = queryAll(doc, 'html')[0] || doc;
  doc.title = 'AIPM 学习工作台';
  return doc;
}

export function makeFetch(BASE) {
  // 必须在覆盖 globalThis.fetch 之前抓住原生实现，否则会自己调自己（栈溢出）
  const nativeFetch = NATIVE_FETCH;
  const jar = new Map();
  async function f(url, init) {
    init = init || {};
    const u = new URL(String(url), BASE);
    const headers = Object.assign({}, init.headers || {});
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
    const r = await nativeFetch(u, Object.assign({}, init, { headers: headers }));
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    for (const c of sc) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    return r;
  }
  f.jar = jar;
  return f;
}

export function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
    _map: m,
  };
}
