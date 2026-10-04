import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
  };
}

function createBackgroundHarness() {
  const sentMessages = [];
  const sessionState = {};
  const events = {
    installed: makeEvent(),
    message: makeEvent(),
    activated: makeEvent(),
    updated: makeEvent(),
    removed: makeEvent(),
    focusChanged: makeEvent(),
  };
  const chrome = {
    runtime: {
      onInstalled: events.installed,
      onMessage: events.message,
      sendMessage: async () => undefined,
    },
    storage: {
      session: {
        async get() { return { ...sessionState }; },
        async set(values) { Object.assign(sessionState, values); },
      },
      local: {
        async get() { return {}; },
        async set() {},
      },
    },
    tabs: {
      onActivated: events.activated,
      onUpdated: events.updated,
      onRemoved: events.removed,
      async sendMessage(tabId, message, options) {
        sentMessages.push({ tabId, message, options });
        return undefined;
      },
      async get() { return { active: false }; },
      async query() { return []; },
      async goBack() {},
      async goForward() {},
      async create() {},
      async update() {},
    },
    windows: {
      onFocusChanged: events.focusChanged,
      WINDOW_ID_NONE: -1,
      async getLastFocused() { return { focused: false }; },
      async get() { return { focused: false }; },
    },
    scripting: { async executeScript() {} },
  };

  return {
    chrome,
    sentMessages,
    sessionState,
    getMessageListener() { return events.message.listeners[0]; },
  };
}

async function dispatch(listener, message, sender) {
  return new Promise((resolve) => {
    const keepAlive = listener(message, sender, resolve);
    if (!keepAlive) setTimeout(() => resolve(undefined), 0);
  });
}

test("frame routing sends one input to the active nested frame and returns one level", async () => {
  const harness = createBackgroundHarness();
  const source = await readFile(new URL("../dist/extension/background.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { chrome: harness.chrome, URL, console, setTimeout, clearTimeout });
  const listener = harness.getMessageListener();
  const tab = { id: 41 };

  await dispatch(listener, { type: "joy-nav:register-frame", token: "root", route: ["root"] }, { tab, frameId: 0 });
  await dispatch(listener, { type: "joy-nav:register-frame", token: "child", route: ["root", "child"] }, { tab, frameId: 7 });
  await dispatch(listener, { type: "joy-nav:register-frame", token: "nested", route: ["root", "child", "nested"] }, { tab, frameId: 12 });

  const nestedRoute = ["root", "child", "nested"];
  assert.equal(
    (await dispatch(listener, { type: "joy-nav:set-frame-route", route: nestedRoute, waitForNeutral: true }, { tab, frameId: 7 })).routed,
    true,
  );

  const sample = { axes: [0.8, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) };
  assert.equal(
    (await dispatch(listener, { type: "joy-nav:send-frame-input", route: nestedRoute, timestamp: 1, sequence: 1, sample }, { tab, frameId: 0 })).sent,
    true,
  );
  assert.ok(harness.sentMessages.some(({ message, options }) => options?.frameId === 12
    && message.type === "joy-nav:frame-input" && message.frameToken === "nested"));
  assert.ok(harness.sentMessages.some(({ message, options }) => options?.frameId === 12
    && message.type === "joy-nav:wait-for-neutral"));

  const parentRoute = ["root", "child"];
  assert.equal(
    (await dispatch(listener, { type: "joy-nav:set-frame-route", route: parentRoute }, { tab, frameId: 12 })).routed,
    true,
  );
  assert.ok(harness.sentMessages.some(({ message, options }) => options?.frameId === 12
    && message.type === "joy-nav:deactivate-frame"));
  assert.ok(harness.sentMessages.some(({ message, options }) => options?.frameId === 0
    && message.type === "joy-nav:frame-route" && message.route.join("/") === "root/child"));

  assert.equal(
    (await dispatch(listener, { type: "joy-nav:send-frame-input", route: parentRoute, timestamp: 2, sequence: 2, sample }, { tab, frameId: 0 })).sent,
    true,
  );
  assert.ok(harness.sentMessages.some(({ message, options }) => options?.frameId === 7
    && message.type === "joy-nav:frame-input" && message.frameToken === "child"));
  assert.equal(harness.sessionState.joyNavRoutes["41"].join("/"), parentRoute.join("/"));
});
