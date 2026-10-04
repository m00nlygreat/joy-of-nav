import { createSpotlightPolygon, hasRisen, nextCycleIndex, rankSpotlightCandidates, readDirection, resolveSelectionIndex, type Candidate, type Direction, type Point } from "../core/navigation.js";
import { DEFAULT_SETTINGS, mapSpeedCurve, normalizeSettings, type Settings } from "../core/settings.js";

type GamepadSample = {
  axes: number[];
  buttons: { pressed: boolean; value: number }[];
};

function installContentScript(): void {
  const extensionWindow = window as Window & { __joyOfNavContentInitialized?: boolean };
  if (extensionWindow.__joyOfNavContentInitialized) return;
  extensionWindow.__joyOfNavContentInitialized = true;

  const CLICKABLE_SELECTOR = [
    "a[href]",
    "area[href]",
    "button",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[role='link']",
    "[tabindex]:not([tabindex='-1'])",
    "[onclick]",
    "iframe",
  ].join(",");

  const SVG_NS = "http://www.w3.org/2000/svg";
  let enabled = true;
  let activeTabOwned = false;
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let frameId: number | null = null;
  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let svg: SVGSVGElement | null = null;
  let spotlightCutout: SVGPathElement | null = null;
  let spotlightMask: SVGMaskElement | null = null;
  let dimLayer: SVGRectElement | null = null;
  let selectedMarkLayer: SVGGElement | null = null;
  let candidateNumbersLayer: SVGGElement | null = null;
  let cursorLayer: SVGGElement | null = null;
  let controlGuide: HTMLDivElement | null = null;
  let observer: MutationObserver | null = null;
  let candidates: Candidate<HTMLElement>[] = [];
  let selectedIndex = -1;
  let candidateMarksDirty = true;
  let activeDirection: Direction | null = null;
  let lastActiveDirection: Direction | null = null;
  let pinnedDirection: Direction | null = null;
  let pinned = false;
  let xWasDown = false;
  let rightTriggerWasDown = false;
  let leftTriggerWasDown = false;
  let leftStickClickWasDown = false;
  let rightStickClickWasDown = false;
  let leftBumperWasDown = false;
  let rightBumperWasDown = false;
  let aWasDown = false;
  let bWasDown = false;
  let arrowKeyRepeatAt = new Map<string, number>();
  let ignoreCurrentButtons = true;
  let refreshNeeded = true;
  let lastRefreshAt = 0;
  let lastDirectionAngle: number | null = null;
  let smoothedLeftStick: Point = { x: 0, y: 0 };
  let connectedGamepad = false;
  let supported = typeof navigator.getGamepads === "function";
  const isTopFrame = window === window.top;
  const frameToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let framePath: string[] = isTopFrame ? [frameToken] : [];
  let framePathRegistered = false;
  let activeFramePath: string[] = [];
  let pendingFramePath: string[] | null = null;
  let pendingFrameWaitForNeutral = false;
  let pendingFrameRouteAttempts = 0;
  let frameRouteRetryTimer: number | null = null;
  const frameTokenByElement = new WeakMap<HTMLIFrameElement, string>();
  const frameElementByToken = new Map<string, HTMLIFrameElement>();
  let frameInputSequence = 0;
  let overlayDismissedUntilNeutral = false;
  let virtualPointer = { x: 0, y: 0 };
  let virtualPointerVisible = false;
  let virtualPointerVisibleUntil = 0;
  let yModeActive = false;
  let lastLeftStickScrollAngle: number | null = null;
  let lastRightStickCycleAngle: number | null = null;
  let rightStickCycleRemainder = 0;
  let pointerInitialized = false;
  let lastFrameAt = 0;
  const temporaryTabIndexTargets = new WeakSet<HTMLElement>();
  let focusChangeSequence = 0;

  const ARROW_BUTTONS = [
    { button: 12, key: "ArrowUp", code: "ArrowUp" },
    { button: 13, key: "ArrowDown", code: "ArrowDown" },
    { button: 14, key: "ArrowLeft", code: "ArrowLeft" },
    { button: 15, key: "ArrowRight", code: "ArrowRight" },
  ] as const;
  const ARROW_REPEAT_DELAY = 420;
  const ARROW_REPEAT_INTERVAL = 75;
  const POINTER_DISPLAY_DURATION = 1000;
  const SPOTLIGHT_SMOOTHING_SECONDS = 0.06;

  function centerPoint(): Point {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function candidateIsVisible(element: HTMLElement): boolean {
    if (!element.isConnected || element.matches(":disabled, [aria-disabled='true'], [hidden], [inert]") || element.closest("[inert], [aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.pointerEvents === "none") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
  }

  function collectCandidates(direction: Direction): Candidate<HTMLElement>[] {
    const raw = [...document.querySelectorAll<HTMLElement>(CLICKABLE_SELECTOR)];
    const possible: Candidate<HTMLElement>[] = [];
    raw.forEach((element, documentOrder) => {
      if (host?.contains(element) || !candidateIsVisible(element)) return;
      const rect = element.getBoundingClientRect();
      possible.push({
        id: element,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        documentOrder,
      });
    });

    return rankSpotlightCandidates(
      possible,
      centerPoint(),
      direction,
      Math.min(window.innerWidth, window.innerHeight) * settings.spotlightArrivalSize / 100,
      Math.min(window.innerWidth, window.innerHeight) * settings.spotlightStartSize / 100,
      window.innerWidth,
      window.innerHeight,
      settings.inclusionMode,
      settings.distanceMode,
      settings.tieBreak,
    );
  }

  function createSvg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
    return document.createElementNS(SVG_NS, tag);
  }

  function setOverlayVisibility(visible: boolean): void {
    host?.style.setProperty("display", visible ? "block" : "none", "important");
  }

  function ensureOverlay(): void {
    if (host && shadow) return;
    host = document.createElement("div");
    host.setAttribute("data-joy-of-nav", "overlay");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;";
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        #overlaySvg { position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: hidden; pointer-events: none; }
        #dim { fill: rgba(5, 10, 9, .68); }
        #selectedElement { fill: none; stroke: #c7ec73; stroke-width: 2; vector-effect: non-scaling-stroke; }
        #selectedElement[data-kind="iframe"] { stroke: #73dfff; }
        .candidateNumberBackground { fill: rgba(22, 38, 31, .82); stroke: none; }
        .candidateNumber { fill: #d6ff83; font: 700 10px/1 system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
        .selectedCandidateNumber { fill: #d6ff83; stroke: rgba(5, 10, 9, .88); stroke-width: 1.5; stroke-linejoin: round; paint-order: stroke fill; font: 800 10px/1 system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
        #virtualCursorOuter { fill: rgba(5, 10, 9, .7); stroke: #f6ffe8; stroke-width: 2; }
        #virtualCursorInner { fill: #d6ff83; stroke: #1c2814; stroke-width: 1; }
        #controlGuide { all: initial; position: fixed; inset: auto 0 0; z-index: 1; isolation: isolate; display: flex; justify-content: center; box-sizing: border-box; width: 100%; padding: 14px 18px 8px; color: #fff; font: 500 11px/1.2 system-ui, sans-serif; pointer-events: none; opacity: 0; visibility: hidden; transform: translateY(13px); transition: opacity 220ms ease, transform 280ms cubic-bezier(.2,.75,.25,1), visibility 0s linear 280ms; }
        #controlGuide::before, #controlGuide::after { content: ""; position: absolute; left: -8vw; right: -8vw; bottom: -34px; height: 276px; pointer-events: none; }
        #controlGuide::before { z-index: -2; background: linear-gradient(to top, rgba(0,0,0,.84) 0%, rgba(0,0,0,.72) 15%, rgba(0,0,0,.5) 37%, rgba(0,0,0,.25) 62%, rgba(0,0,0,.08) 82%, transparent 100%); }
        #controlGuide::after { z-index: -1; background: rgba(0,0,0,.01); -webkit-backdrop-filter: blur(13px); backdrop-filter: blur(13px); -webkit-mask-image: linear-gradient(to top, #000 0%, rgba(0,0,0,.92) 22%, rgba(0,0,0,.68) 47%, rgba(0,0,0,.3) 73%, transparent 100%); mask-image: linear-gradient(to top, #000 0%, rgba(0,0,0,.92) 22%, rgba(0,0,0,.68) 47%, rgba(0,0,0,.3) 73%, transparent 100%); }
        #controlGuide[data-visible="true"] { opacity: 1; visibility: visible; transform: translateY(0); transition-delay: 0s; }
        #controlGuide[data-mode="spotlight"] #yGuide, #controlGuide[data-mode="y"] #spotlightGuide { display: none; }
        .guide-layout { display: flex; align-items: center; justify-content: center; gap: 17px; width: 100%; max-width: 1200px; }
        .guide-mode-title { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; color: rgba(255,255,255,.62); font-size: 8px; font-weight: 800; letter-spacing: .12em; white-space: nowrap; }
        .guide-items { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; justify-content: center; min-width: 0; gap: 8px 19px; }
        .guide-item { all: initial; display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; color: rgba(255,255,255,.96); font: 650 11px/1.2 system-ui, sans-serif; white-space: nowrap; }
        .guide-key { all: initial; box-sizing: border-box; display: inline-flex; min-width: 23px; height: 23px; align-items: center; justify-content: center; padding: 0 4px; border: 2px solid rgba(255,255,255,.58); border-radius: 6px; background: rgba(5,8,8,.72); color: #fff; font: 900 10px/1 system-ui, sans-serif; text-shadow: 0 1px 2px rgba(0,0,0,.75); box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }
        .guide-key-a, .guide-key-b, .guide-key-x, .guide-key-y { width: 23px; padding: 0; border-color: currentColor; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.08); }
        .guide-key-a { color: #68e68b; }
        .guide-key-b { color: #ff6f72; }
        .guide-key-x { color: #70a9ff; }
        .guide-key-y { color: #ffdc62; }
        .guide-key-stick { min-width: 25px; height: 25px; border-width: 2px; border-radius: 50%; box-shadow: inset 0 0 0 2px rgba(255,255,255,.12), inset 0 0 0 5px rgba(0,0,0,.42); }
        .guide-key-dpad { flex: 0 0 23px; min-width: 23px; width: 23px; height: 23px; padding: 3px; border-radius: 5px; }
        .guide-dpad-icon { display: block; width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 2.8; stroke-linecap: round; stroke-linejoin: round; }
        .guide-pair { display: inline-flex; align-items: center; gap: 3px; }
        .guide-pair-separator { color: rgba(255,255,255,.5); font: 600 10px/1 system-ui, sans-serif; }
        @media (max-width: 680px) { #controlGuide { padding: 12px 10px 7px; } #controlGuide::before, #controlGuide::after { left: -12vw; right: -12vw; height: 238px; } .guide-layout { flex-wrap: wrap; gap: 5px 12px; } .guide-items { gap: 6px 13px; } }
        @media (prefers-reduced-motion: reduce) { #controlGuide { transition: none; } }
      </style>
      <svg id="overlaySvg" aria-hidden="true" viewBox="0 0 1 1">
        <defs><mask id="spotlightMask" style="mask-type:luminance" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="0" height="0"><rect id="maskBase" x="0" y="0" width="0" height="0" fill="white"></rect><path id="spotlightCutout" d="" fill="black"></path></mask></defs>
        <rect id="dim" x="0" y="0" width="0" height="0" mask="url(#spotlightMask)" visibility="hidden"></rect>
        <g id="selectedMark"></g>
        <g id="candidateNumbers"></g>
        <g id="virtualCursor" visibility="hidden"><circle id="virtualCursorOuter" r="10"></circle><circle id="virtualCursorInner" r="3.5"></circle></g>
      </svg>
      <div id="controlGuide" data-visible="false" data-mode="spotlight" aria-hidden="true">
        <div class="guide-layout" id="spotlightGuide">
          <span class="guide-mode-title">SPOTLIGHT</span>
          <div class="guide-items">
            <span class="guide-item"><span class="guide-key guide-key-a">A</span>실행</span>
            <span class="guide-item"><span class="guide-key guide-key-b">B</span>취소</span>
            <span class="guide-item"><span class="guide-pair"><span class="guide-key guide-key-x">X</span><span class="guide-pair-separator">/</span><span class="guide-key">LT</span></span>다음 후보</span>
            <span class="guide-item"><span class="guide-key">LB</span>이전 후보</span>
            <span class="guide-item"><span class="guide-key guide-key-stick">LS</span>고정</span>
            <span class="guide-item"><span class="guide-key guide-key-stick">RS</span>후보 순환</span>
          </div>
        </div>
        <div class="guide-layout" id="yGuide">
          <span class="guide-mode-title"><span class="guide-key guide-key-y">Y</span> 유지 중</span>
          <div class="guide-items">
            <span class="guide-item"><span class="guide-key guide-key-dpad"><svg class="guide-dpad-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" /></svg></span>휠 이동</span>
            <span class="guide-item"><span class="guide-key guide-key-stick">LS</span>돌려 스크롤</span>
            <span class="guide-item"><span class="guide-key">LB</span>이전 탭</span>
            <span class="guide-item"><span class="guide-key">LT</span>다음 탭</span>
            <span class="guide-item"><span class="guide-key guide-key-a">A</span>Enter</span>
            <span class="guide-item"><span class="guide-key guide-key-b">B</span>Esc</span>
          </div>
        </div>
      </div>
    `;
    svg = shadow.querySelector("svg");
    spotlightCutout = shadow.querySelector("#spotlightCutout");
    spotlightMask = shadow.querySelector("#spotlightMask");
    dimLayer = shadow.querySelector("#dim");
    selectedMarkLayer = shadow.querySelector("#selectedMark");
    candidateNumbersLayer = shadow.querySelector("#candidateNumbers");
    cursorLayer = shadow.querySelector("#virtualCursor");
    controlGuide = shadow.querySelector<HTMLDivElement>("#controlGuide");
    document.documentElement.append(host);
  }

  function createSpotlightPath(origin: Point, direction: Point): string {
    const shortSide = Math.min(window.innerWidth, window.innerHeight);
    const polygon = createSpotlightPolygon(
      origin,
      direction,
      shortSide * settings.spotlightArrivalSize / 100,
      shortSide * settings.spotlightStartSize / 100,
      window.innerWidth,
      window.innerHeight,
    );
    if (!polygon.length) return "";
    return `M ${polygon[0]!.x} ${polygon[0]!.y} ${polygon.slice(1).map((point) => `L ${point.x} ${point.y}`).join(" ")} Z`;
  }

  function render(): void {
    const selectedLayer = selectedMarkLayer;
    const numbersLayer = candidateNumbersLayer;
    const virtualCursorLayer = cursorLayer;
    const guide = controlGuide;
    if (!enabled || !host || !svg || !spotlightCutout || !spotlightMask || !dimLayer || !selectedLayer || !numbersLayer || !virtualCursorLayer || !guide) return;
    const overlayDirection = activeDirection ?? (pinned ? pinnedDirection : null);
    const showSpotlight = overlayDirection !== null;
    const showGuide = settings.controlGuideVisibility === "show" && (showSpotlight || yModeActive);
    guide.dataset.mode = yModeActive ? "y" : "spotlight";
    guide.dataset.visible = String(showGuide);
    if (!showSpotlight && !virtualPointerVisible && !showGuide) {
      setOverlayVisibility(false);
      return;
    }

    setOverlayVisibility(true);
    svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    spotlightMask.setAttribute("width", String(window.innerWidth));
    spotlightMask.setAttribute("height", String(window.innerHeight));
    const maskBase = shadow!.querySelector<SVGRectElement>("#maskBase")!;
    maskBase.setAttribute("width", String(window.innerWidth));
    maskBase.setAttribute("height", String(window.innerHeight));
    dimLayer.setAttribute("width", String(window.innerWidth));
    dimLayer.setAttribute("height", String(window.innerHeight));
    if (overlayDirection) {
      const spotlightPath = createSpotlightPath(centerPoint(), overlayDirection);
      spotlightCutout.setAttribute("d", spotlightPath);
      dimLayer.setAttribute("visibility", spotlightPath ? "visible" : "hidden");
    } else {
      spotlightCutout.setAttribute("d", "");
      dimLayer.setAttribute("visibility", "hidden");
    }
    selectedLayer.replaceChildren();
    if (!showSpotlight) {
      numbersLayer.replaceChildren();
      candidateMarksDirty = true;
    } else if (settings.candidateNumberVisibility === "hide") {
      numbersLayer.replaceChildren();
      candidateMarksDirty = false;
    } else if (candidateMarksDirty) {
      numbersLayer.replaceChildren();
      candidates.forEach((candidate, index) => {
        const { left, top } = candidate.rect;
        const label = String(index + 1);
        const badgeWidth = Math.max(14, label.length * 6 + 5);

        if (index !== selectedIndex) {
          const background = createSvg("rect");
          background.setAttribute("x", String(left + 2));
          background.setAttribute("y", String(top + 2));
          background.setAttribute("width", String(badgeWidth));
          background.setAttribute("height", "14");
          background.setAttribute("rx", "3.5");
          background.setAttribute("class", "candidateNumberBackground");
          numbersLayer.append(background);
        }

        const number = createSvg("text");
        number.textContent = label;
        number.setAttribute("x", String(left + 2 + badgeWidth / 2));
        number.setAttribute("y", String(top + 9));
        number.setAttribute("class", index === selectedIndex ? "selectedCandidateNumber" : "candidateNumber");
        numbersLayer.append(number);
      });
      candidateMarksDirty = false;
    }

    const selectedCandidate = showSpotlight ? candidates[selectedIndex] : undefined;
    if (selectedCandidate) {
      const rect = selectedCandidate.rect;
      const mark = createSvg("rect");
      mark.setAttribute("x", String(rect.left));
      mark.setAttribute("y", String(rect.top));
      mark.setAttribute("width", String(Math.max(1, rect.right - rect.left)));
      mark.setAttribute("height", String(Math.max(1, rect.bottom - rect.top)));
      mark.setAttribute("rx", "3");
      mark.setAttribute("id", "selectedElement");
      if (selectedCandidate.id instanceof HTMLIFrameElement) mark.setAttribute("data-kind", "iframe");
      selectedLayer.append(mark);
    }

    virtualCursorLayer.setAttribute("visibility", virtualPointerVisible ? "visible" : "hidden");
    virtualCursorLayer.setAttribute("transform", `translate(${virtualPointer.x} ${virtualPointer.y})`);

  }

  function sameCandidates(left: Candidate<HTMLElement>[], right: Candidate<HTMLElement>[]): boolean {
    return left.length === right.length && left.every((candidate, index) => candidate.id === right[index]?.id);
  }

  function refreshCandidates(direction: Direction): void {
    const nextCandidates = collectCandidates(direction);
    candidateMarksDirty = true;
    if (!sameCandidates(candidates, nextCandidates)) {
      const previouslySelected = candidates[selectedIndex]?.id;
      candidates = nextCandidates;
      selectedIndex = resolveSelectionIndex(
        previouslySelected,
        candidates.map((candidate) => candidate.id),
        settings.candidateStart === "preserve",
      );
    } else {
      candidates = nextCandidates;
    }
    refreshNeeded = false;
    lastRefreshAt = performance.now();
    lastDirectionAngle = Math.atan2(direction.y, direction.x);
  }

  function applySettings(value: unknown): void {
    const previous = settings;
    settings = normalizeSettings(value);
    if (previous.neutralBehavior !== settings.neutralBehavior && !activeDirection && !pinned && settings.neutralBehavior === "clear") {
      candidates = [];
      selectedIndex = -1;
    }
    refreshNeeded = true;
    candidateMarksDirty = true;

    const spotlightDirection = activeDirection ?? (pinned ? pinnedDirection : null);
    if (spotlightDirection) refreshCandidates(spotlightDirection);
    render();
  }

  function resetInputEdges(): void {
    xWasDown = false;
    rightTriggerWasDown = false;
    leftTriggerWasDown = false;
    leftStickClickWasDown = false;
    rightStickClickWasDown = false;
    leftBumperWasDown = false;
    rightBumperWasDown = false;
    aWasDown = false;
    bWasDown = false;
    yModeActive = false;
    lastLeftStickScrollAngle = null;
    lastRightStickCycleAngle = null;
    rightStickCycleRemainder = 0;
    releaseArrowKeys();
    ignoreCurrentButtons = true;
    connectedGamepad = false;
    virtualPointerVisible = false;
    virtualPointerVisibleUntil = 0;
    lastFrameAt = 0;
  }

  function snapshotGamepad(gamepad: Gamepad): GamepadSample {
    return {
      axes: Array.from(gamepad.axes),
      buttons: Array.from(gamepad.buttons, (button) => ({ pressed: button.pressed, value: button.value })),
    };
  }

  function gamepadFrame(timestamp: number): void {
    frameId = null;
    if (!enabled || !isTopFrame || !activeTabOwned || document.visibilityState !== "visible" || document.hasFocus?.() === false) return;

    let gamepads: (Gamepad | null)[] = [];
    try { gamepads = [...navigator.getGamepads()]; } catch { gamepads = []; }
    const gamepad = gamepads.find((item) => item?.connected && item.mapping === "standard" && item.axes.length >= 4 && item.buttons.length >= 16) ?? null;
    connectedGamepad = Boolean(gamepad);

    if (activeFramePath.length) {
      void chrome.runtime.sendMessage({
        type: "joy-nav:send-frame-input",
        route: [frameToken, ...activeFramePath],
        timestamp,
        sequence: ++frameInputSequence,
        sample: gamepad ? snapshotGamepad(gamepad) : null,
      }).catch(() => undefined);
    } else {
      processGamepadFrame(timestamp, gamepad ? snapshotGamepad(gamepad) : null);
    }

    render();
    frameId = requestAnimationFrame(gamepadFrame);
  }

  function processGamepadFrame(timestamp: number, gamepad: GamepadSample | null): void {
    if (!enabled) return;
    if (!isTopFrame) ensureOverlay();
    const elapsedSeconds = lastFrameAt ? Math.min((timestamp - lastFrameAt) / 1000, 0.05) : 0;
    lastFrameAt = timestamp;
    if (virtualPointerVisible && performance.now() >= virtualPointerVisibleUntil) virtualPointerVisible = false;
    connectedGamepad = Boolean(gamepad);

    if (!gamepad) {
      if (activeDirection && !pinned && settings.neutralBehavior === "clear") {
        candidates = [];
        selectedIndex = -1;
      }
      activeDirection = null;
      smoothedLeftStick = { x: 0, y: 0 };
      lastDirectionAngle = null;
      overlayDismissedUntilNeutral = false;
      yModeActive = false;
      resetInputEdges();
      render();
      return;
    }

    if (!pointerInitialized) {
      virtualPointer = centerPoint();
      pointerInitialized = true;
    }

    const yDown = gamepad.buttons[3]!.pressed;
    if (!isTopFrame && ignoreCurrentButtons) yModeActive = yDown;
    if (yDown && !yModeActive) {
      if (!isTopFrame) {
        returnToParentFrame();
        return;
      }
      cancelCone();
      lastActiveDirection = null;
    }

    const smoothing = elapsedSeconds > 0
      ? elapsedSeconds / (SPOTLIGHT_SMOOTHING_SECONDS + elapsedSeconds)
      : 1;
    smoothedLeftStick = {
      x: smoothedLeftStick.x + (gamepad.axes[0]! - smoothedLeftStick.x) * smoothing,
      y: smoothedLeftStick.y + (gamepad.axes[1]! - smoothedLeftStick.y) * smoothing,
    };
    const direction = readDirection(smoothedLeftStick.x, smoothedLeftStick.y, settings.deadzone);
    const hadActiveDirection = activeDirection !== null;
    if (yDown) {
      if (activeDirection && (refreshNeeded || performance.now() - lastRefreshAt >= 180)) refreshCandidates(activeDirection);
    } else {
      if (!direction) {
        overlayDismissedUntilNeutral = false;
        activeDirection = null;
        if (!pinned) lastDirectionAngle = null;
      } else if (!overlayDismissedUntilNeutral) {
        const angle = Math.atan2(direction.y, direction.x);
        const angleChanged = lastDirectionAngle === null || Math.abs(Math.atan2(Math.sin(angle - lastDirectionAngle), Math.cos(angle - lastDirectionAngle))) > Math.PI / 90;
        if (refreshNeeded || angleChanged || performance.now() - lastRefreshAt >= 180) refreshCandidates(direction);
        activeDirection = direction;
        lastActiveDirection = direction;
        if (pinned) pinnedDirection = direction;
      } else {
        activeDirection = null;
      }
    }

    const xDown = gamepad.buttons[2]!.pressed;
    const leftBumperDown = gamepad.buttons[4]!.pressed;
    const rightBumperDown = gamepad.buttons[5]!.pressed;
    const leftTriggerDown = readTrigger(gamepad, 6);
    const rightTriggerDown = readTrigger(gamepad, 7);
    const aDown = gamepad.buttons[0]!.pressed;
    const bDown = gamepad.buttons[1]!.pressed;
    const leftStickClickDown = gamepad.buttons[10]!.pressed;
    const rightStickClickDown = gamepad.buttons[11]!.pressed;

    if (ignoreCurrentButtons) {
      xWasDown = xDown;
      rightTriggerWasDown = rightTriggerDown;
      leftTriggerWasDown = leftTriggerDown;
      leftStickClickWasDown = leftStickClickDown;
      rightStickClickWasDown = rightStickClickDown;
      leftBumperWasDown = leftBumperDown;
      rightBumperWasDown = rightBumperDown;
      aWasDown = aDown;
      bWasDown = bDown;
      yModeActive = yDown;
      if (activeDirection !== null || (pinned && pinnedDirection !== null)) {
        cycleCandidatesWithRightStick(gamepad.axes[2]!, gamepad.axes[3]!);
      } else {
        resetRightStickCandidateCycle();
        moveVirtualPointer(gamepad.axes[2]!, gamepad.axes[3]!, elapsedSeconds);
      }
      ignoreCurrentButtons = false;
    } else {
      if (yDown !== yModeActive) {
        yModeActive = yDown;
        releaseArrowKeys();
      }

      if (hasRisen(leftStickClickDown, leftStickClickWasDown)) {
        if (pinned) {
          pinned = false;
          pinnedDirection = null;
        } else {
          const directionToPin = activeDirection ?? lastActiveDirection;
          if (directionToPin) {
            pinned = true;
            pinnedDirection = directionToPin;
            refreshNeeded = true;
          }
        }
      }

      const spotlightActive = activeDirection !== null || (pinned && pinnedDirection !== null);
      if (spotlightActive) {
        cycleCandidatesWithRightStick(gamepad.axes[2]!, gamepad.axes[3]!);
      } else {
        resetRightStickCandidateCycle();
        moveVirtualPointer(gamepad.axes[2]!, gamepad.axes[3]!, elapsedSeconds);
      }
      const l1Rose = hasRisen(leftBumperDown, leftBumperWasDown);
      const l2Rose = hasRisen(leftTriggerDown, leftTriggerWasDown);
      const xRose = hasRisen(xDown, xWasDown);
      if (spotlightActive) {
        if (l1Rose) cycleSelectedCandidate("previous");
        else if (l2Rose || xRose) cycleSelectedCandidate("next");
      } else if (xRose && !yDown) {
        pressKeyboardKey(" ");
      }

      if (yDown) {
        releaseArrowKeys();
        if (!spotlightActive && l1Rose) void sendBrowserCommand("previous-tab");
        if (!spotlightActive && l2Rose) void sendBrowserCommand("next-tab");
        scrollWithDpad(gamepad, elapsedSeconds);
        scrollWithLeftStick(direction, elapsedSeconds);
      } else {
        lastLeftStickScrollAngle = null;
        updateArrowKeys(gamepad, timestamp);
        if (!spotlightActive && l1Rose) void sendBrowserCommand("back");
        if (!spotlightActive && l2Rose) void sendBrowserCommand("forward");
      }

      if (hasRisen(rightBumperDown, rightBumperWasDown)) clickAtVirtualPointer("right");
      if (hasRisen(rightTriggerDown, rightTriggerWasDown)) clickAtVirtualPointer("left");
      if (hasRisen(rightStickClickDown, rightStickClickWasDown)) clickAtVirtualPointer("middle");

      const bRose = hasRisen(bDown, bWasDown);
      const aRose = hasRisen(aDown, aWasDown);
      if (bRose && spotlightActive) {
        rememberSelectedIframe(true);
        cancelCone();
      } else if (bRose && !isTopFrame) {
        returnToParentFrame();
      } else if (bRose) {
        pressKeyboardKey("Escape");
      } else if (aRose && spotlightActive) {
        const selected = candidates[selectedIndex]?.id;
        if (selected && !(selected instanceof HTMLIFrameElement) && candidateIsVisible(selected)) {
          focusSelected();
          pressEnter(selected);
          if (pinned) {
            pinned = false;
            pinnedDirection = null;
          }
        }
      } else if (aRose) {
        pressEnter();
      }

      xWasDown = xDown;
      rightTriggerWasDown = rightTriggerDown;
      leftTriggerWasDown = leftTriggerDown;
      leftStickClickWasDown = leftStickClickDown;
      rightStickClickWasDown = rightStickClickDown;
      leftBumperWasDown = leftBumperDown;
      rightBumperWasDown = rightBumperDown;
      aWasDown = aDown;
      bWasDown = bDown;
    }

    if (!activeDirection && pinned && pinnedDirection && (refreshNeeded || performance.now() - lastRefreshAt >= 180)) {
      refreshCandidates(pinnedDirection);
    }
    if (!activeDirection && !pinned && hadActiveDirection) {
      rememberSelectedIframe();
      if (settings.neutralBehavior === "clear") {
        candidates = [];
        selectedIndex = -1;
      }
    }

    render();
  }

  function readTrigger(gamepad: GamepadSample, index: number): boolean {
    const trigger = gamepad.buttons[index];
    if (!trigger) return false;
    const value = Number.isFinite(trigger.value) ? trigger.value : Number(trigger.pressed);
    return value >= settings.triggerThreshold;
  }

  function moveVirtualPointer(axisX: number, axisY: number, elapsedSeconds: number): void {
    const direction = readDirection(axisX, axisY, settings.deadzone);
    if (!direction || elapsedSeconds <= 0) return;
    const effectiveMagnitude = Math.min(1, (direction.magnitude - settings.deadzone) / (1 - settings.deadzone));
    const speed = settings.pointerMaxSpeed * mapSpeedCurve(effectiveMagnitude, settings.pointerSpeedCurve);
    const distance = speed * elapsedSeconds;
    const nextX = Math.min(Math.max(0, window.innerWidth - 1), Math.max(0, virtualPointer.x + direction.x / direction.magnitude * distance));
    const nextY = Math.min(Math.max(0, window.innerHeight - 1), Math.max(0, virtualPointer.y + direction.y / direction.magnitude * distance));
    if (nextX === virtualPointer.x && nextY === virtualPointer.y) return;
    virtualPointer = { x: nextX, y: nextY };
    showVirtualPointer();
    dispatchMouseMove(nextX, nextY);
  }

  function moveVirtualPointerTo(element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    virtualPointer = {
      x: Math.min(Math.max(0, rect.left + rect.width / 2), Math.max(0, window.innerWidth - 1)),
      y: Math.min(Math.max(0, rect.top + rect.height / 2), Math.max(0, window.innerHeight - 1)),
    };
    virtualPointerVisible = false;
    virtualPointerVisibleUntil = 0;
  }

  function showVirtualPointer(): void {
    virtualPointerVisible = true;
    virtualPointerVisibleUntil = performance.now() + POINTER_DISPLAY_DURATION;
  }

  function dispatchMouseMove(x: number, y: number): void {
    const target = document.elementFromPoint(x, y) ?? document.documentElement;
    target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse", clientX: x, clientY: y, isPrimary: true }));
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, composed: true, view: window, clientX: x, clientY: y }));
  }

  function keyboardTarget(): HTMLElement {
    return document.activeElement instanceof HTMLElement ? document.activeElement : document.body ?? document.documentElement;
  }

  function dispatchKeyboard(target: HTMLElement, type: "keydown" | "keyup", key: string, repeat = false): KeyboardEvent {
    const code = key === " " ? "Space" : key;
    const event = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true, repeat });
    target.dispatchEvent(event);
    return event;
  }

  function pressKeyboardKey(key: string): void {
    const target = keyboardTarget();
    const down = dispatchKeyboard(target, "keydown", key);
    const up = dispatchKeyboard(target, "keyup", key);
    if (key === "Escape" && !down.defaultPrevented && !up.defaultPrevented) {
      const dialog = target.closest<HTMLDialogElement>("dialog[open]");
      if (dialog?.open) dialog.close();
    }
  }

  function pressEnter(target = keyboardTarget()): void {
    const keyDown = dispatchKeyboard(target, "keydown", "Enter");
    const keyUp = dispatchKeyboard(target, "keyup", "Enter");
    if (keyDown.defaultPrevented || keyUp.defaultPrevented) return;
    if (target instanceof HTMLInputElement && target.form && ["email", "number", "password", "search", "tel", "text", "url"].includes(target.type)) {
      target.form.requestSubmit();
      return;
    }
    target.closest<HTMLElement>(CLICKABLE_SELECTOR)?.click();
  }

  function updateArrowKeys(gamepad: GamepadSample, timestamp: number): void {
    for (const item of ARROW_BUTTONS) {
      const isDown = Boolean(gamepad.buttons[item.button]?.pressed);
      const repeatAt = arrowKeyRepeatAt.get(item.key);
      if (isDown && repeatAt === undefined) {
        const target = keyboardTarget();
        const event = dispatchKeyboard(target, "keydown", item.key);
        if (!event.defaultPrevented) applyArrowDefault(target, item.key);
        arrowKeyRepeatAt.set(item.key, timestamp + ARROW_REPEAT_DELAY);
      } else if (isDown && repeatAt !== undefined && timestamp >= repeatAt) {
        const target = keyboardTarget();
        const event = dispatchKeyboard(target, "keydown", item.key, true);
        if (!event.defaultPrevented) applyArrowDefault(target, item.key);
        arrowKeyRepeatAt.set(item.key, timestamp + ARROW_REPEAT_INTERVAL);
      } else if (!isDown && repeatAt !== undefined) {
        dispatchKeyboard(keyboardTarget(), "keyup", item.key);
        arrowKeyRepeatAt.delete(item.key);
      }
    }
  }

  function applyArrowDefault(target: HTMLElement, key: string): void {
    if (target instanceof HTMLInputElement && ["number", "range"].includes(target.type)) {
      const step = target.step === "any" ? 1 : Number(target.step || 1);
      const direction = key === "ArrowUp" || key === "ArrowRight" ? 1 : -1;
      const min = target.min === "" ? -Infinity : Number(target.min);
      const max = target.max === "" ? Infinity : Number(target.max);
      const current = Number(target.value);
      if (!Number.isFinite(current) || !Number.isFinite(step)) return;
      target.value = String(Math.min(max, Math.max(min, current + direction * step)));
      target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (target instanceof HTMLInputElement && ["email", "password", "search", "tel", "text", "url"].includes(target.type)) {
      if (key === "ArrowLeft" || key === "ArrowRight") {
        const start = target.selectionStart;
        const end = target.selectionEnd;
        if (start === null || end === null) return;
        const position = start !== end ? (key === "ArrowLeft" ? start : end) : start + (key === "ArrowRight" ? 1 : -1);
        target.setSelectionRange(Math.min(target.value.length, Math.max(0, position)), Math.min(target.value.length, Math.max(0, position)));
        target.dispatchEvent(new Event("select", { bubbles: true }));
      }
      return;
    }
    if (target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart;
      const end = target.selectionEnd;
      if (start !== end && (key === "ArrowLeft" || key === "ArrowRight")) {
        const position = key === "ArrowLeft" ? start : end;
        target.setSelectionRange(position, position);
        target.dispatchEvent(new Event("select", { bubbles: true }));
        return;
      }
      const value = target.value;
      const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const column = start - lineStart;
      let nextPosition = start;
      if (key === "ArrowLeft") nextPosition = Math.max(0, start - 1);
      else if (key === "ArrowRight") nextPosition = Math.min(value.length, start + 1);
      else if (key === "ArrowUp" && lineStart > 0) {
        const previousLineEnd = lineStart - 1;
        const previousLineStart = value.lastIndexOf("\n", Math.max(0, previousLineEnd - 1)) + 1;
        nextPosition = Math.min(previousLineStart + column, previousLineEnd);
      } else if (key === "ArrowDown") {
        const nextLineStart = value.indexOf("\n", start);
        if (nextLineStart >= 0) {
          const nextLineEndIndex = value.indexOf("\n", nextLineStart + 1);
          const nextLineEnd = nextLineEndIndex < 0 ? value.length : nextLineEndIndex;
          nextPosition = Math.min(nextLineStart + 1 + column, nextLineEnd);
        }
      }
      target.setSelectionRange(nextPosition, nextPosition);
      target.dispatchEvent(new Event("select", { bubbles: true }));
      return;
    }
    if (target.isContentEditable) return;
    if (target instanceof HTMLSelectElement) {
      const direction = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
      target.selectedIndex = Math.min(target.options.length - 1, Math.max(0, target.selectedIndex + direction));
      target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    window.scrollBy({
      left: key === "ArrowLeft" ? -40 : key === "ArrowRight" ? 40 : 0,
      top: key === "ArrowUp" ? -40 : key === "ArrowDown" ? 40 : 0,
      behavior: "auto",
    });
  }

  function releaseArrowKeys(): void {
    for (const key of arrowKeyRepeatAt.keys()) dispatchKeyboard(keyboardTarget(), "keyup", key);
    arrowKeyRepeatAt.clear();
  }

  function scrollWithDpad(gamepad: GamepadSample, elapsedSeconds: number): void {
    const vertical = Number(Boolean(gamepad.buttons[13]?.pressed)) - Number(Boolean(gamepad.buttons[12]?.pressed));
    const horizontal = Number(Boolean(gamepad.buttons[15]?.pressed)) - Number(Boolean(gamepad.buttons[14]?.pressed));
    if ((!vertical && !horizontal) || elapsedSeconds <= 0) return;
    const magnitude = Math.hypot(horizontal, vertical);
    const speed = settings.scrollMaxSpeed * elapsedSeconds / Math.max(1, magnitude);
    const deltaX = horizontal * speed;
    const deltaY = vertical * speed;
    scrollAtVirtualPointer(deltaX, deltaY);
  }

  function scrollWithLeftStick(direction: Direction | null, elapsedSeconds: number): void {
    if (!direction) {
      lastLeftStickScrollAngle = null;
      return;
    }

    const angle = Math.atan2(direction.y, direction.x);
    const previousAngle = lastLeftStickScrollAngle;
    lastLeftStickScrollAngle = angle;
    if (previousAngle === null || elapsedSeconds <= 0) return;

    const angleDelta = clockwiseAngleDelta(previousAngle, angle);

    // Gamepad Y points down, so increasing atan2 angles follow clockwise rotation.
    const magnitude = Math.min(1, (direction.magnitude - settings.deadzone) / (1 - settings.deadzone));
    const speedFactor = mapSpeedCurve(magnitude, settings.scrollSpeedCurve);
    const turnsPerSecond = Math.min(1, Math.abs(angleDelta) / (2 * Math.PI * elapsedSeconds));
    const deltaY = Math.sign(angleDelta) * settings.scrollMaxSpeed * turnsPerSecond * speedFactor * elapsedSeconds;
    if (deltaY) scrollAtVirtualPointer(0, deltaY);
  }

  function cycleCandidatesWithRightStick(axisX: number, axisY: number): void {
    const direction = readDirection(axisX, axisY, settings.deadzone);
    if (!direction) {
      lastRightStickCycleAngle = null;
      rightStickCycleRemainder = 0;
      return;
    }

    const angle = Math.atan2(direction.y, direction.x);
    const previousAngle = lastRightStickCycleAngle;
    lastRightStickCycleAngle = angle;
    if (previousAngle === null) return;
    if (candidates.length < 2) {
      rightStickCycleRemainder = 0;
      return;
    }

    const angleDelta = clockwiseAngleDelta(previousAngle, angle);
    const magnitude = Math.min(1, (direction.magnitude - settings.deadzone) / (1 - settings.deadzone));
    rightStickCycleRemainder += angleDelta * magnitude;
    const stepAngle = settings.rightStickCandidateStepDegrees * Math.PI / 180;
    const steps = Math.trunc(rightStickCycleRemainder / stepAngle);
    if (!steps) return;

    rightStickCycleRemainder -= steps * stepAngle;
    const cycleDirection = steps > 0 ? "next" : "previous";
    for (let index = 0; index < Math.abs(steps); index += 1) cycleSelectedCandidate(cycleDirection);
  }

  function resetRightStickCandidateCycle(): void {
    lastRightStickCycleAngle = null;
    rightStickCycleRemainder = 0;
  }

  function clockwiseAngleDelta(previousAngle: number, angle: number): number {
    let delta = angle - previousAngle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    else if (delta < -Math.PI) delta += 2 * Math.PI;
    return delta;
  }

  function scrollAtVirtualPointer(deltaX: number, deltaY: number): void {
    if (!deltaX && !deltaY) return;
    showVirtualPointer();
    const target = document.elementFromPoint(virtualPointer.x, virtualPointer.y) ?? document.documentElement;
    const allowed = target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, composed: true, view: window, clientX: virtualPointer.x, clientY: virtualPointer.y, deltaX, deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL }));
    if (allowed) scrollAtTarget(target, deltaX, deltaY);
  }

  function scrollAtTarget(target: Element, deltaX: number, deltaY: number): void {
    const horizontalTarget = scrollableAncestor(target, "x", deltaX);
    const verticalTarget = scrollableAncestor(target, "y", deltaY);
    if (horizontalTarget) horizontalTarget.scrollBy({ left: deltaX, behavior: "auto" });
    else if (deltaX) window.scrollBy({ left: deltaX, behavior: "auto" });
    if (verticalTarget) verticalTarget.scrollBy({ top: deltaY, behavior: "auto" });
    else if (deltaY) window.scrollBy({ top: deltaY, behavior: "auto" });
  }

  function scrollableAncestor(target: Element, axis: "x" | "y", delta: number): HTMLElement | null {
    let ancestor = target instanceof HTMLElement ? target : target.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      if (canScroll(ancestor, axis, delta)) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function canScroll(element: HTMLElement, axis: "x" | "y", delta: number): boolean {
    if (!delta) return false;
    const style = getComputedStyle(element);
    const overflow = axis === "x" ? style.overflowX : style.overflowY;
    if (!/(auto|scroll|overlay)/.test(overflow)) return false;
    const current = axis === "x" ? element.scrollLeft : element.scrollTop;
    const extent = axis === "x" ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
    return extent > 0 && (delta > 0 ? current < extent : current > 0);
  }

  function clickAtVirtualPointer(button: "left" | "middle" | "right"): void {
    const target = document.elementFromPoint(virtualPointer.x, virtualPointer.y);
    if (!target || host?.contains(target)) return;
    showVirtualPointer();
    const mouseButton = button === "left" ? 0 : button === "middle" ? 1 : 2;
    const buttons = button === "left" ? 1 : button === "middle" ? 4 : 2;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: virtualPointer.x, clientY: virtualPointer.y, button: mouseButton };
    target.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons }));
    target.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons }));
    if (button === "right") {
      target.dispatchEvent(new MouseEvent("contextmenu", { ...base, buttons }));
    }
    target.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    if (button === "left") {
      const clickable = target.closest<HTMLElement>(CLICKABLE_SELECTOR) ?? (target instanceof HTMLElement ? target : null);
      clickable?.click();
      return;
    }

    const auxiliaryClick = new MouseEvent("auxclick", { ...base, buttons: 0 });
    if (button === "middle") target.dispatchEvent(auxiliaryClick);
    if (button === "middle" && !auxiliaryClick.defaultPrevented) {
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (anchor && /^https?:$/i.test(new URL(anchor.href, document.baseURI).protocol)) {
        void chrome.runtime.sendMessage({ type: "joy-nav:open-background-tab", url: anchor.href }).catch(() => undefined);
      }
    }
  }

  function cancelCone(): void {
    overlayDismissedUntilNeutral = true;
    activeDirection = null;
    pinned = false;
    pinnedDirection = null;
    candidates = [];
    selectedIndex = -1;
    lastDirectionAngle = null;
    refreshNeeded = true;
  }

  function selectedIframe(): HTMLIFrameElement | null {
    const selected = candidates[selectedIndex]?.id;
    return selected instanceof HTMLIFrameElement ? selected : null;
  }

  function requestFrameRoute(route: string[], waitForNeutral = false): void {
    if (route.length === 0 || route[0] !== framePath[0]) return;
    pendingFramePath = route;
    pendingFrameWaitForNeutral = waitForNeutral;
    pendingFrameRouteAttempts = 0;
    if (frameRouteRetryTimer !== null) window.clearTimeout(frameRouteRetryTimer);
    frameRouteRetryTimer = null;
    sendPendingFrameRoute();
  }

  function sendPendingFrameRoute(): void {
    const route = pendingFramePath;
    if (!route || !framePathRegistered) return;
    const waitForNeutral = pendingFrameWaitForNeutral;
    void chrome.runtime.sendMessage({ type: "joy-nav:set-frame-route", route, waitForNeutral }).then((response: { routed?: boolean } | undefined) => {
      if (pendingFramePath !== route) return;
      if (response?.routed) {
        pendingFramePath = null;
        pendingFrameWaitForNeutral = false;
        pendingFrameRouteAttempts = 0;
        frameRouteRetryTimer = null;
      } else if (pendingFrameRouteAttempts < 20) {
        pendingFrameRouteAttempts += 1;
        frameRouteRetryTimer = window.setTimeout(sendPendingFrameRoute, 100);
      }
    }).catch(() => {
      if (pendingFramePath !== route || pendingFrameRouteAttempts >= 20) return;
      pendingFrameRouteAttempts += 1;
      frameRouteRetryTimer = window.setTimeout(sendPendingFrameRoute, 100);
    });
  }

  function rememberSelectedIframe(waitForNeutral = false): void {
    const iframe = selectedIframe();
    if (!iframe) return;
    activateIframe(iframe, waitForNeutral);
  }

  function activateIframe(iframe: HTMLIFrameElement, waitForNeutral = false): void {
    pendingSelectedIframe = iframe;
    pendingFrameWaitForNeutral = waitForNeutral;
    const childToken = frameTokenByElement.get(iframe);
    if (!childToken) return;
    pendingSelectedIframe = null;
    requestFrameRoute([...framePath, childToken], waitForNeutral);
  }

  let pendingSelectedIframe: HTMLIFrameElement | null = null;

  function returnToParentFrame(): void {
    if (isTopFrame || framePath.length < 2) return;
    requestFrameRoute(framePath.slice(0, -1));
  }

  function clearLocalNavigation(): void {
    activeDirection = null;
    lastActiveDirection = null;
    pinnedDirection = null;
    pinned = false;
    candidates = [];
    selectedIndex = -1;
    lastDirectionAngle = null;
    smoothedLeftStick = { x: 0, y: 0 };
    overlayDismissedUntilNeutral = true;
    refreshNeeded = true;
    resetInputEdges();
    render();
  }

  function registerFramePath(): void {
    if (!framePath.length || framePath[framePath.length - 1] !== frameToken) return;
    void chrome.runtime.sendMessage({ type: "joy-nav:register-frame", token: frameToken, route: framePath })
      .then((response: { registered?: boolean } | undefined) => {
        framePathRegistered = response?.registered === true;
        if (framePathRegistered && pendingFramePath) requestFrameRoute(pendingFramePath);
      })
      .catch(() => { framePathRegistered = false; });
  }

  function onFrameHandshake(event: MessageEvent): void {
    const message = event.data as { type?: string; token?: string; route?: unknown } | null;
    if (message?.type === "joy-nav:frame-hello" && typeof message.token === "string" && event.source) {
      const iframe = [...document.querySelectorAll("iframe")].find((item) => item.contentWindow === event.source);
      if (!iframe) return;
      const previousToken = frameTokenByElement.get(iframe);
      if (previousToken && previousToken !== message.token) frameElementByToken.delete(previousToken);
      frameTokenByElement.set(iframe, message.token);
      frameElementByToken.set(message.token, iframe);
      (event.source as WindowProxy).postMessage({ type: "joy-nav:frame-parent", token: message.token, route: framePath }, "*");
      if (pendingSelectedIframe === iframe) activateIframe(iframe, pendingFrameWaitForNeutral);
      return;
    }

    if (message?.type !== "joy-nav:frame-parent" || event.source !== window.parent || message.token !== frameToken) return;
    if (!Array.isArray(message.route) || !message.route.every((part) => typeof part === "string")) return;
    framePath = [...message.route, frameToken];
    framePathRegistered = false;
    registerFramePath();
  }

  function cycleSelectedCandidate(direction: "next" | "previous"): void {
    if (!candidates.length) return;
    if (direction === "next") {
      selectedIndex = nextCycleIndex(selectedIndex, candidates.length);
    } else {
      selectedIndex = selectedIndex < 0 || selectedIndex >= candidates.length
        ? candidates.length - 1
        : (selectedIndex - 1 + candidates.length) % candidates.length;
    }
    candidateMarksDirty = true;
    focusSelected();
    render();
  }

  function sendBrowserCommand(command: "back" | "forward" | "next-tab" | "previous-tab"): Promise<void> {
    return chrome.runtime.sendMessage({ type: "joy-nav:browser-command", command }).then(() => undefined).catch(() => undefined);
  }

  function focusSelected(): boolean {
    const element = candidates[selectedIndex]?.id;
    if (!element || !candidateIsVisible(element)) {
      refreshNeeded = true;
      return false;
    }
    moveVirtualPointerTo(element);
    if (element instanceof HTMLIFrameElement) return true;

    const focusWithoutScroll = (): void => {
      try {
        element.focus({ preventScroll: true });
      } catch {
        element.focus();
      }
    };

    focusWithoutScroll();
    if (document.activeElement === element) return true;
    if (element.hasAttribute("tabindex")) return false;

    element.setAttribute("tabindex", "-1");
    temporaryTabIndexTargets.add(element);
    element.addEventListener("blur", () => {
      if (!temporaryTabIndexTargets.delete(element)) return;
      if (element.getAttribute("tabindex") === "-1") element.removeAttribute("tabindex");
    }, { once: true });
    focusWithoutScroll();
    if (document.activeElement === element) return true;

    if (temporaryTabIndexTargets.delete(element)) element.removeAttribute("tabindex");
    refreshNeeded = true;
    return false;
  }

  function startLoop(): void {
    if (!isTopFrame || !enabled || !activeTabOwned || frameId !== null) return;
    supported = typeof navigator.getGamepads === "function";
    ensureOverlay();
    if (!supported) {
      render();
      return;
    }
    render();
    frameId = requestAnimationFrame(gamepadFrame);
  }

  function stopLoop(): void {
    if (isTopFrame && activeFramePath.length) {
      void chrome.runtime.sendMessage({ type: "joy-nav:deactivate-frame", route: [frameToken, ...activeFramePath] }).catch(() => undefined);
    }
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    activeDirection = null;
    smoothedLeftStick = { x: 0, y: 0 };
    if (settings.neutralBehavior === "clear" && !pinned) {
      candidates = [];
      selectedIndex = -1;
    }
    refreshNeeded = true;
    resetInputEdges();
    setOverlayVisibility(false);
  }

  function status(): { enabled: boolean; supported: boolean; gamepadConnected: boolean } {
    return { enabled, supported, gamepadConnected: connectedGamepad };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id === chrome.runtime.id && message?.type === "joy-nav:frame-input" && !isTopFrame && message.frameToken === frameToken) {
      const sample = message.sample === null ? null : isGamepadSample(message.sample) ? message.sample : undefined;
      if (sample !== undefined && typeof message.timestamp === "number") processGamepadFrame(message.timestamp, sample);
      return false;
    }
    if (sender.id === chrome.runtime.id && message?.type === "joy-nav:deactivate-frame" && !isTopFrame && message.frameToken === frameToken) {
      clearLocalNavigation();
      return false;
    }
    if (sender.id === chrome.runtime.id && message?.type === "joy-nav:wait-for-neutral" && !isTopFrame && message.frameToken === frameToken) {
      overlayDismissedUntilNeutral = true;
      return false;
    }
    if (sender.id === chrome.runtime.id && message?.type === "joy-nav:frame-route" && isTopFrame && Array.isArray(message.route)) {
      const route = message.route as unknown[];
      if (route[0] !== frameToken || !route.every((part) => typeof part === "string")) return false;
      activeFramePath = route.slice(1) as string[];
      clearLocalNavigation();
      pendingFramePath = null;
      pendingFrameWaitForNeutral = false;
      pendingFrameRouteAttempts = 0;
      if (frameRouteRetryTimer !== null) window.clearTimeout(frameRouteRetryTimer);
      frameRouteRetryTimer = null;
      return false;
    }
    if (message?.type === "joy-nav:tab-ownership" && typeof message.active === "boolean") {
      if (!isTopFrame) return false;
      const pageIsFocused = document.visibilityState === "visible" && document.hasFocus?.() !== false;
      activeTabOwned = message.active && pageIsFocused;
      if (activeTabOwned) {
        resetInputEdges();
        void chrome.storage.local.get("settings").then(({ settings: savedSettings }) => {
          if (!activeTabOwned) return;
          applySettings(savedSettings);
          startLoop();
        }).catch(() => startLoop());
      } else {
        stopLoop();
      }
      sendResponse({ active: activeTabOwned });
      return false;
    }
    if (message?.type === "joy-nav:get-status") {
      if (!isTopFrame) return false;
      sendResponse(status());
      return false;
    }
    if (message?.type === "joy-nav:set-enabled" && typeof message.enabled === "boolean") {
      if (!isTopFrame) return false;
      enabled = message.enabled;
      if (enabled) startLoop();
      else {
        pinned = false;
        pinnedDirection = null;
        lastActiveDirection = null;
        stopLoop();
      }
      sendResponse(status());
      return false;
    }
    return false;
  });

  chrome.storage.local.get("settings").then(({ settings: savedSettings }) => {
    settings = normalizeSettings(savedSettings);
    refreshNeeded = true;
    if (enabled) onVisibilityChange();
  }).catch(() => {
    settings = { ...DEFAULT_SETTINGS };
    if (enabled) onVisibilityChange();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.settings?.newValue) return;
    applySettings(changes.settings.newValue);
  });

  function onVisibilityChange(): void {
    if (!isTopFrame) return;
    const sequence = ++focusChangeSequence;
    const pageIsFocused = document.visibilityState === "visible" && document.hasFocus?.() !== false;
    if (!pageIsFocused) {
      relinquishTabOwnership();
      return;
    }

    void chrome.runtime.sendMessage({ type: "joy-nav:sync-active-tab" }).then((response: { active?: boolean } | undefined) => {
      if (sequence !== focusChangeSequence) return;
      activeTabOwned = response?.active === true;
      if (activeTabOwned && document.visibilityState === "visible" && document.hasFocus?.() !== false) {
        resetInputEdges();
        startLoop();
      } else {
        activeTabOwned = false;
        stopLoop();
      }
    }).catch(() => {
      if (sequence !== focusChangeSequence) return;
      activeTabOwned = false;
      stopLoop();
    });
  }

  function relinquishTabOwnership(): void {
    if (!isTopFrame) return;
    ++focusChangeSequence;
    activeTabOwned = false;
    stopLoop();
    void chrome.runtime.sendMessage({ type: "joy-nav:sync-active-tab" }).catch(() => undefined);
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onVisibilityChange);
  window.addEventListener("blur", relinquishTabOwnership);
  window.addEventListener("resize", () => {
    if (pointerInitialized) {
      virtualPointer.x = Math.min(Math.max(0, window.innerWidth - 1), Math.max(0, virtualPointer.x));
      virtualPointer.y = Math.min(Math.max(0, window.innerHeight - 1), Math.max(0, virtualPointer.y));
    }
    refreshNeeded = true;
    render();
  }, { passive: true });
  window.addEventListener("scroll", () => { refreshNeeded = true; }, { capture: true, passive: true });
  window.addEventListener("gamepadconnected", () => { refreshNeeded = true; startLoop(); });
  window.addEventListener("gamepaddisconnected", () => { connectedGamepad = false; resetInputEdges(); refreshNeeded = true; });

  observer = new MutationObserver((records) => {
    if (records.some((record) => !host?.contains(record.target))) refreshNeeded = true;
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "disabled", "aria-disabled", "aria-hidden", "href", "tabindex"],
  });

  function isGamepadSample(value: unknown): value is GamepadSample {
    if (!value || typeof value !== "object") return false;
    const sample = value as Partial<GamepadSample>;
    return Array.isArray(sample.axes) && sample.axes.length >= 4 && sample.axes.every((axis) => typeof axis === "number")
      && Array.isArray(sample.buttons) && sample.buttons.length >= 16
      && sample.buttons.every((button) => Boolean(button) && typeof button.pressed === "boolean" && typeof button.value === "number");
  }

  window.addEventListener("message", onFrameHandshake);
  if (isTopFrame) {
    registerFramePath();
  } else {
    let attempts = 0;
    const announceToParent = (): void => {
      if (framePath.length || attempts >= 20) return;
      attempts += 1;
      window.parent.postMessage({ type: "joy-nav:frame-hello", token: frameToken }, "*");
      window.setTimeout(announceToParent, 250);
    };
    announceToParent();
  }

  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.key !== "Escape" || isTopFrame || activeDirection !== null || (pinned && pinnedDirection !== null)) return;
    event.preventDefault();
    returnToParentFrame();
  }, true);

}

installContentScript();
