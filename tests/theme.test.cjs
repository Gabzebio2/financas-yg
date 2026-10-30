const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/theme.js"), "utf8");

function element(attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  const classes = new Set();
  const listeners = new Map();
  return {
    textContent: "",
    getAttribute: (key) => attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, String(value)),
    hasAttribute: (key) => attrs.has(key),
    toggleAttribute: (key, enabled) => { if (enabled) attrs.set(key, ""); else attrs.delete(key); },
    classList: {
      toggle: (key, enabled) => { if (enabled) classes.add(key); else classes.delete(key); },
      contains: (key) => classes.has(key),
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire: (type, event = {}) => (listeners.get(type) || []).forEach((fn) => fn(event)),
    querySelectorAll: () => [],
  };
}

function harness({ preference, failRead = false, failWrite = false, blockedGetter = false, readyState = "loading", lateNodes = false } = {}) {
  const values = new Map([["fyg:dataset:demo", '{"transactions":[{"amount":25}]}']]);
  if (preference !== undefined) values.set("fyg:theme", preference);
  const writes = [], reads = [], events = [];
  const storage = {
    getItem(key) { reads.push(key); if (failRead) throw new Error("blocked read"); return values.get(key) ?? null; },
    setItem(key, value) { if (failWrite) throw new Error("quota exceeded"); writes.push([key, value]); values.set(key, value); },
  };
  const html = element();
  const meta = element({ name: "theme-color", content: "#old" });
  const buttons = Array.from({ length: 2 }, () => {
    const button = element({ "data-theme-toggle": "" });
    button.label = element({ "data-theme-label": "" });
    button.sun = element({ "data-theme-icon": "sun" });
    button.moon = element({ "data-theme-icon": "moon" });
    button.querySelectorAll = (selector) => selector === "[data-theme-label]" ? [button.label] : selector === "[data-theme-icon]" ? [button.sun, button.moon] : [];
    return button;
  });
  let nodesReady = !lateNodes;
  const document = Object.assign(element(), {
    readyState,
    documentElement: html,
    querySelectorAll: (selector) => !nodesReady ? [] : selector === "[data-theme-toggle]" ? buttons : selector === 'meta[name="theme-color"]' ? [meta] : [],
    dispatchEvent: (event) => {
      events.push({ type: event.type, theme: event.detail.theme, appliedTheme: html.getAttribute("data-theme"), metaColor: meta.getAttribute("content") });
      return true;
    },
  });
  const window = element();
  Object.defineProperty(window, "localStorage", { get() { if (blockedGetter) throw new Error("SecurityError"); return storage; } });
  const context = vm.createContext({ document, window, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  vm.runInContext(source, context);
  return { values, writes, reads, events, storage, html, meta, buttons, window, document,
    ready() { nodesReady = true; document.readyState = "complete"; document.fire("DOMContentLoaded"); },
    external(key, newValue, storageArea = storage) { window.fire("storage", { key, newValue, storageArea }); },
  };
}

test("aplica modo noturno antes de DOMContentLoaded sem escrever dados financeiros", () => {
  const env = harness({ lateNodes: true });
  assert.equal(env.html.getAttribute("data-theme"), "dark");
  assert.deepEqual(env.reads, ["fyg:theme"]);
  assert.equal(env.writes.length, 0);
  env.ready();
  assert.equal(env.meta.getAttribute("content"), "#17161e");
  assert.equal(env.buttons[0].label.textContent, "Modo claro");
  assert.equal(env.values.get("fyg:dataset:demo"), '{"transactions":[{"amount":25}]}');
});

test("restaura preferência clara antes do primeiro paint e prepara os dois botões", () => {
  const env = harness({ preference: "light" });
  assert.equal(env.html.getAttribute("data-theme"), "light");
  env.ready();
  assert.equal(env.meta.getAttribute("content"), "#f6f4fa");
  env.buttons.forEach((button) => {
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(button.getAttribute("aria-label"), "Modo noturno");
    assert.equal(button.getAttribute("title"), "Ativar modo noturno");
    assert.equal(button.label.textContent, "Modo noturno");
    assert.equal(button.sun.hasAttribute("hidden"), true);
    assert.equal(button.moon.hasAttribute("hidden"), false);
    assert.equal(button.moon.getAttribute("aria-hidden"), "true");
  });
  assert.equal(env.events.length, 0);
});

test("alternar em qualquer botão atualiza ambos, persiste apenas tema e notifica após aplicar", () => {
  const env = harness();
  env.ready();
  env.buttons[0].fire("click");
  assert.deepEqual(env.writes, [["fyg:theme", "light"]]);
  assert.deepEqual(env.events, [{ type: "fyg:themechange", theme: "light", appliedTheme: "light", metaColor: "#f6f4fa" }]);
  env.buttons.forEach((button) => assert.equal(button.getAttribute("aria-pressed"), "false"));
  env.buttons[1].fire("click");
  assert.equal(env.html.getAttribute("data-theme"), "dark");
  assert.deepEqual(env.writes[1], ["fyg:theme", "dark"]);
  env.buttons.forEach((button) => {
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(button.label.textContent, "Modo claro");
    assert.equal(button.sun.hasAttribute("hidden"), false);
    assert.equal(button.moon.classList.contains("hidden"), true);
  });
  assert.deepEqual([...env.values.keys()].sort(), ["fyg:dataset:demo", "fyg:theme"]);
});

test("preferências inválidas usam dark e não são gravadas ou executadas", () => {
  for (const preference of ["", "LIGHT", "sepia", "null", '{"theme":"light"}', '<script>alert(1)</script>']) {
    const env = harness({ preference });
    assert.equal(env.html.getAttribute("data-theme"), "dark");
    assert.equal(env.writes.length, 0);
    assert.equal(env.values.get("fyg:theme"), preference);
  }
});

test("continua alternando se leitura, escrita ou acesso ao armazenamento forem bloqueados", () => {
  for (const options of [{ failRead: true }, { failWrite: true }, { blockedGetter: true }]) {
    const env = harness(options);
    env.ready();
    env.buttons[1].fire("click");
    assert.equal(env.html.getAttribute("data-theme"), "light");
    assert.equal(env.buttons[0].label.textContent, "Modo noturno");
    assert.equal(env.events.length, 1);
    assert.equal(env.values.get("fyg:dataset:demo"), '{"transactions":[{"amount":25}]}');
  }
});

test("evento storage sincroniza abas e notifica sem regravar ou criar loop", () => {
  const env = harness();
  env.ready();
  env.external("fyg:theme", "light");
  assert.equal(env.html.getAttribute("data-theme"), "light");
  assert.equal(env.buttons[1].getAttribute("aria-pressed"), "false");
  assert.equal(env.events.length, 1);
  assert.equal(env.writes.length, 0);
  env.external("fyg:theme", "light");
  assert.equal(env.events.length, 1);
  env.external("fyg:dataset:demo", "dark");
  env.external("fyg:theme", "dark", {}); // sessionStorage/outro armazenamento
  assert.equal(env.html.getAttribute("data-theme"), "light");
  assert.equal(env.events.length, 1);
});

test("remoção, valor externo inválido e limpeza do armazenamento retornam ao padrão dark", () => {
  for (const [key, value] of [["fyg:theme", null], ["fyg:theme", "sepia"], [null, null]]) {
    const env = harness({ preference: "light" });
    env.ready();
    env.external(key, value);
    assert.equal(env.html.getAttribute("data-theme"), "dark");
    assert.equal(env.meta.getAttribute("content"), "#17161e");
    assert.equal(env.events.length, 1);
    assert.equal(env.writes.length, 0);
  }
});

test("script também conecta os controles quando executado depois do DOM pronto", () => {
  const env = harness({ preference: "light", readyState: "complete" });
  env.buttons[0].fire("click");
  assert.equal(env.html.getAttribute("data-theme"), "dark");
  assert.equal(env.events.length, 1);
});
