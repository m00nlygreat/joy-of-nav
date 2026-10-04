import { DEFAULT_SETTINGS } from "../core/settings.js";

let activeTabId: number | undefined;
let ownershipRevision = 0;
type RegisteredFrame = { frameId: number; route: string[] };
const framesByTab = new Map<number, Map<string, RegisteredFrame>>();
const activeFrameRouteByTab = new Map<number, string[]>();
type StoredFrameState = {
  joyNavFrames?: Record<string, [string, RegisteredFrame][]>;
  joyNavRoutes?: Record<string, string[]>;
};
const frameRegistryReady = chrome.storage.session.get<StoredFrameState>(["joyNavFrames", "joyNavRoutes"]).then((stored) => {
  for (const [tabId, entries] of Object.entries(stored.joyNavFrames ?? {})) {
    if (!Array.isArray(entries)) continue;
    const frames = new Map<string, RegisteredFrame>();
    for (const [token, frame] of entries) {
      if (typeof token === "string" && frame && Number.isInteger(frame.frameId)
        && Array.isArray(frame.route) && frame.route.every((part) => typeof part === "string")) {
        frames.set(token, { frameId: frame.frameId, route: [...frame.route] });
      }
    }
    framesByTab.set(Number(tabId), frames);
  }
  for (const [tabId, route] of Object.entries(stored.joyNavRoutes ?? {})) {
    if (Array.isArray(route) && route.every((part) => typeof part === "string")) activeFrameRouteByTab.set(Number(tabId), [...route]);
  }
}).catch(() => undefined);

function persistFrameRegistry(): Promise<void> {
  const joyNavFrames: Record<string, [string, RegisteredFrame][]> = {};
  const joyNavRoutes: Record<string, string[]> = {};
  framesByTab.forEach((frames, tabId) => { joyNavFrames[String(tabId)] = [...frames.entries()]; });
  activeFrameRouteByTab.forEach((route, tabId) => { joyNavRoutes[String(tabId)] = [...route]; });
  return chrome.storage.session.set({ joyNavFrames, joyNavRoutes }).catch(() => undefined);
}

function sendToFrame(tabId: number, token: string, message: Record<string, unknown>): void {
  const frame = framesByTab.get(tabId)?.get(token);
  if (!frame) return;
  void chrome.tabs.sendMessage(tabId, { ...message, frameToken: token }, { frameId: frame.frameId }).catch(() => undefined);
}

function isRegisteredRoute(tabId: number, route: string[]): boolean {
  const frames = framesByTab.get(tabId);
  if (!frames) return false;
  return route.every((token, index) => {
    const frame = frames.get(token);
    const prefix = route.slice(0, index + 1);
    return Boolean(frame && frame.route.length === prefix.length && frame.route.every((part, partIndex) => part === prefix[partIndex]));
  });
}

async function setActiveFrameRoute(tabId: number, route: string[], waitForNeutral: boolean): Promise<boolean> {
  await frameRegistryReady;
  if (!isRegisteredRoute(tabId, route) || framesByTab.get(tabId)?.get(route[0]!)?.frameId !== 0) return false;
  const previousRoute = activeFrameRouteByTab.get(tabId) ?? [route[0]!];
  if (previousRoute.length > 1 && previousRoute[previousRoute.length - 1] !== route[route.length - 1]) {
    sendToFrame(tabId, previousRoute[previousRoute.length - 1]!, { type: "joy-nav:deactivate-frame" });
  }
  activeFrameRouteByTab.set(tabId, [...route]);
  await persistFrameRegistry();
  if (waitForNeutral && route.length > 1) {
    sendToFrame(tabId, route[route.length - 1]!, { type: "joy-nav:wait-for-neutral" });
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "joy-nav:frame-route", route }, { frameId: 0 });
    return true;
  } catch {
    return false;
  }
}

function sendTabOwnership(tabId: number, active: boolean): void {
  const message = {
    type: "joy-nav:tab-ownership",
    active,
  };
  void chrome.tabs.sendMessage(tabId, message).catch(async () => {
    if (!active) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active || tab.status !== "complete" || tab.windowId === undefined) return;
      const window = await chrome.windows.get(tab.windowId);
      if (!window.focused) return;
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["extension/content.js"] });
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // Restricted pages and tabs without host access cannot receive the overlay.
    }
  });
}

function updateActiveTab(tabId: number | undefined): void {
  if (activeTabId === tabId) {
    if (tabId !== undefined) sendTabOwnership(tabId, true);
    return;
  }
  const previousTabId = activeTabId;
  activeTabId = tabId;
  if (previousTabId !== undefined) sendTabOwnership(previousTabId, false);
  if (tabId !== undefined) sendTabOwnership(tabId, true);
}

async function syncFocusedTab(): Promise<void> {
  const revision = ++ownershipRevision;
  try {
    const focusedWindow = await chrome.windows.getLastFocused();
    if (revision !== ownershipRevision) return;
    if (!focusedWindow.focused || focusedWindow.id === undefined) {
      updateActiveTab(undefined);
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId: focusedWindow.id });
    if (revision === ownershipRevision) updateActiveTab(tab?.id);
  } catch {
    if (revision === ownershipRevision) updateActiveTab(undefined);
  }
}

void syncFocusedTab();

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const revision = ++ownershipRevision;
  void chrome.windows.get(windowId).then((focusedWindow) => {
    if (revision === ownershipRevision && focusedWindow.focused) updateActiveTab(tabId);
  }).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) void syncFocusedTab();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  const revision = ++ownershipRevision;
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    updateActiveTab(undefined);
    return;
  }
  void chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
    if (revision === ownershipRevision) updateActiveTab(tab?.id);
  }).catch(() => {
    if (revision === ownershipRevision) updateActiveTab(undefined);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void frameRegistryReady.then(async () => {
    framesByTab.delete(tabId);
    activeFrameRouteByTab.delete(tabId);
    await persistFrameRegistry();
  });
  if (activeTabId !== tabId) return;
  ++ownershipRevision;
  updateActiveTab(undefined);
  void syncFocusedTab();
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get("settings").then(({ settings }) => {
    if (!settings) return chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    return undefined;
  });
  void syncFocusedTab();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message?.type === "joy-nav:register-frame" && tabId !== undefined
    && typeof message.token === "string" && Array.isArray(message.route)
    && message.route.every((token: unknown) => typeof token === "string")
    && message.route.length > 0 && message.route[message.route.length - 1] === message.token
    && typeof sender.frameId === "number") {
    const token = message.token as string;
    const route = message.route as string[];
    void frameRegistryReady.then(async () => {
      const frames = framesByTab.get(tabId) ?? new Map<string, RegisteredFrame>();
      const replacedEntry = [...frames.entries()].find(([existingToken, frame]) => existingToken !== token && frame.frameId === sender.frameId);
      const activeRoute = activeFrameRouteByTab.get(tabId);
      let refreshRootRoute = false;
      if (replacedEntry) {
        frames.delete(replacedEntry[0]);
        if (activeRoute?.includes(replacedEntry[0])) {
          activeFrameRouteByTab.set(tabId, [...route]);
          refreshRootRoute = true;
        }
      }
      frames.set(token, { frameId: sender.frameId!, route: [...route] });
      framesByTab.set(tabId, frames);
      if (sender.frameId === 0 && !activeFrameRouteByTab.has(tabId)) activeFrameRouteByTab.set(tabId, [...route]);
      await persistFrameRegistry();
      if (refreshRootRoute) {
        void chrome.tabs.sendMessage(tabId, { type: "joy-nav:frame-route", route }, { frameId: 0 }).catch(() => undefined);
      }
      sendResponse({ registered: true });
    }).catch(() => sendResponse({ registered: false }));
    return true;
  }

  if (message?.type === "joy-nav:set-frame-route" && tabId !== undefined && Array.isArray(message.route)
    && message.route.every((token: unknown) => typeof token === "string") && message.route.length > 0) {
    const route = message.route as string[];
    void setActiveFrameRoute(tabId, route, message.waitForNeutral === true)
      .then((routed) => sendResponse({ routed }))
      .catch(() => sendResponse({ routed: false }));
    return true;
  }

  if (message?.type === "joy-nav:send-frame-input" && tabId !== undefined && sender.frameId === 0
    && Array.isArray(message.route) && message.route.every((token: unknown) => typeof token === "string")
    && typeof message.timestamp === "number" && typeof message.sequence === "number") {
    const route = message.route as string[];
    void frameRegistryReady.then(() => {
      const activeRoute = activeFrameRouteByTab.get(tabId);
      if (!activeRoute || activeRoute.length < 2 || route.length !== activeRoute.length
        || route.some((token, index) => token !== activeRoute[index]) || !isRegisteredRoute(tabId, route)) {
        sendResponse({ sent: false });
        return;
      }
      const targetToken = route[route.length - 1]!;
      sendToFrame(tabId, targetToken, {
        type: "joy-nav:frame-input",
        timestamp: message.timestamp,
        sequence: message.sequence,
        sample: message.sample,
      });
      sendResponse({ sent: true });
    }).catch(() => sendResponse({ sent: false }));
    return true;
  }

  if (message?.type === "joy-nav:deactivate-frame" && tabId !== undefined && sender.frameId === 0
    && Array.isArray(message.route) && message.route.every((token: unknown) => typeof token === "string")) {
    const route = message.route as string[];
    void frameRegistryReady.then(() => {
      const activeRoute = activeFrameRouteByTab.get(tabId);
      if (activeRoute && activeRoute.length === route.length && activeRoute.every((token, index) => token === route[index]) && route.length > 1) {
        sendToFrame(tabId, route[route.length - 1]!, { type: "joy-nav:deactivate-frame" });
      }
      sendResponse({ sent: true });
    }).catch(() => sendResponse({ sent: false }));
    return true;
  }

  if (message?.type === "joy-nav:browser-command") {
    const command = message.command;
    if (tabId === undefined) return false;

    if (command === "back" || command === "forward") {
      const navigation = command === "back" ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId);
      void navigation.then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }

    if ((command === "previous-tab" || command === "next-tab") && sender.tab?.windowId !== undefined) {
      const windowId = sender.tab.windowId;
      void chrome.tabs.query({ windowId }).then((tabs) => {
        const ordered = tabs.sort((left, right) => left.index - right.index);
        const currentIndex = ordered.findIndex((tab) => tab.id === tabId);
        if (currentIndex < 0 || ordered.length < 2) {
          sendResponse({ ok: false });
          return;
        }
        const delta = command === "previous-tab" ? -1 : 1;
        const nextIndex = (currentIndex + delta + ordered.length) % ordered.length;
        return chrome.tabs.update(ordered[nextIndex]!.id!, { active: true }).then(() => sendResponse({ ok: true }));
      }).catch(() => sendResponse({ ok: false }));
      return true;
    }
    return false;
  }

  if (message?.type === "joy-nav:open-background-tab" && typeof message.url === "string") {
    if (sender.tab?.windowId === undefined) {
      sendResponse({ ok: false });
      return false;
    }
    try {
      const url = new URL(message.url);
      if (!/^https?:$/.test(url.protocol)) {
        sendResponse({ ok: false });
        return false;
      }
      void chrome.tabs.create({ url: url.href, active: false, windowId: sender.tab.windowId })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    } catch {
      sendResponse({ ok: false });
      return false;
    }
  }

  if (message?.type === "joy-nav:sync-active-tab") {
    if (tabId === undefined) {
      sendResponse({ active: false });
      return false;
    }

    void syncFocusedTab().then(() => sendResponse({ active: activeTabId === tabId }));
    return true;
  }

  return false;
});
