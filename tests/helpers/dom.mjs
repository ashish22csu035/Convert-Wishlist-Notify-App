// A small DOM stub for running the storefront scripts in node:vm without a browser or any
// dependency. It understands the selectors the scripts use: tags, classes, ids, attribute
// operators (=, *=, ^=, $=), descendant combinators and comma lists.
// ---- selector engine -----------------------------------------------------------
function parseCompound(text) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const token = /^(?:([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([*^$]?=)"?([^\]"]*)"?)?\])/;
  let rest = text;
  while (rest) {
    const m = token.exec(rest);
    if (!m) throw new Error("unsupported selector: " + text);
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else out.attrs.push({ name: m[4], op: m[5] ?? null, value: m[6] ?? null });
    rest = rest.slice(m[0].length);
  }
  return out;
}
function matchesCompound(node, c) {
  if (c.tag && node.tag !== c.tag) return false;
  if (c.id && node.attrs.id !== c.id) return false;
  if (!c.classes.every((cls) => node.has(cls))) return false;
  return c.attrs.every(({ name, op, value }) => {
    if (!(name in node.attrs)) return false;
    const actual = node.attrs[name];
    if (!op) return true;
    if (op === "=") return actual === value;
    if (op === "*=") return actual.includes(value);
    if (op === "^=") return actual.startsWith(value);
    return actual.endsWith(value);
  });
}
function matchesSelector(node, selector) {
  return selector.split(",").some((part) => {
    const compounds = part.trim().split(/\s+/).map(parseCompound);
    if (!matchesCompound(node, compounds.at(-1))) return false;
    let index = compounds.length - 2;
    for (let up = node.parent; up && index >= 0; up = up.parent) {
      if (matchesCompound(up, compounds[index])) index -= 1;
    }
    return index < 0;
  });
}

class Dom {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.innerHTML = "";
    this.style = {};
    this.rectOverride = null;
    const self = this;
    this.classList = {
      add: (c) => {
        if (!self.has(c)) self.className = `${self.className} ${c}`.trim();
      },
      remove: (c) => {
        self.className = self.className.split(" ").filter((x) => x && x !== c).join(" ");
      },
      contains: (c) => self.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !self.has(c) : on;
        if (want) self.classList.add(c);
        else self.classList.remove(c);
      },
    };
  }
  has(c) {
    return this.className.split(" ").includes(c);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get parentNode() {
    return this.parent;
  }
  appendChild(node) {
    node.remove();
    node.parent = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    node.remove();
    node.parent = this;
    const at = this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    return node;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(node) {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  hasAttribute(k) {
    return k in this.attrs;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set href(v) {
    this.attrs.href = v;
  }
  get href() {
    return this.attrs.href;
  }
  closest(sel) {
    for (let n = this; n; n = n.parent) if (matchesSelector(n, sel)) return n;
    return null;
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelector(sel) {
    return this.all().find((n) => matchesSelector(n, sel)) ?? null;
  }
  querySelectorAll(sel) {
    return this.all().filter((n) => matchesSelector(n, sel));
  }
  getBoundingClientRect() {
    const r = this.rectOverride ? this.rectOverride() : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    return r;
  }
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

const el = (tag, className = "", attrs = {}) => {
  const node = new Dom(tag);
  node.className = className;
  Object.assign(node.attrs, attrs);
  return node;
};

export { Dom, el, tick, matchesSelector };
