interface PageStatus {
  enabled: boolean;
  supported: boolean;
  gamepadConnected: boolean;
}

const toggleButton = document.querySelector<HTMLButtonElement>("#toggleButton")!;
const statusTitle = document.querySelector<HTMLElement>("#statusTitle")!;
const statusDescription = document.querySelector<HTMLElement>("#statusDescription")!;
const statusIcon = document.querySelector<HTMLElement>("#statusIcon")!;
const pageLabel = document.querySelector<HTMLElement>("#pageLabel")!;

let activeTabId: number | undefined;
let currentStatus: PageStatus | null = null;
let unavailableReason: string | null = null;

function showUnavailable(message: string): void {
  unavailableReason = message;
  currentStatus = null;
  statusTitle.textContent = "이 페이지에서 사용할 수 없습니다";
  statusDescription.textContent = message;
  statusIcon.dataset.tone = "error";
  toggleButton.textContent = "자동 실행 불가";
  toggleButton.disabled = true;
}

function renderStatus(status: PageStatus | null): void {
  currentStatus = status;
  toggleButton.disabled = false;
  if (!status) {
    statusTitle.textContent = "이 페이지에 자동 실행되지 않았습니다";
    statusDescription.textContent = "Chrome 내부 페이지는 지원되지 않습니다. file:// 페이지는 확장 세부 정보에서 파일 URL 접근을 허용하세요.";
    statusIcon.dataset.tone = "error";
    toggleButton.textContent = "자동 실행 불가";
    toggleButton.disabled = true;
    return;
  }

  statusIcon.dataset.tone = status.enabled ? "active" : "ready";
  if (status.enabled) {
    statusTitle.textContent = status.gamepadConnected ? "탐색이 켜져 있습니다" : "탐색 대기 중";
    statusDescription.textContent = status.gamepadConnected
      ? "L스틱으로 방향을 지정하고 X로 탐색 후보를 순회하세요."
      : status.supported
        ? "페이지를 다시 활성화한 뒤 컨트롤러의 버튼이나 스틱을 한 번 움직여 보세요."
        : "이 브라우저 페이지에서는 Gamepad API를 사용할 수 없습니다.";
    toggleButton.textContent = "이 페이지에서 끄기";
  } else {
    statusTitle.textContent = "현재 페이지에서 멈춰 있습니다";
    statusDescription.textContent = "이 문서에서는 일시 중지되었습니다. 새 문서를 열면 자동 실행됩니다.";
    toggleButton.textContent = "이 페이지에서 켜기";
  }
}

async function queryPageStatus(tabId: number): Promise<PageStatus | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "joy-nav:get-status" }) as PageStatus;
  } catch {
    return null;
  }
}

async function initialize(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      showUnavailable("활성 탭을 찾을 수 없습니다.");
      return;
    }
    activeTabId = tab.id;
    pageLabel.textContent = tab.title ? tab.title.slice(0, 30) : "활성 탭";
    const pageStatus = await queryPageStatus(tab.id);
    if (pageStatus) renderStatus(pageStatus);
    else showUnavailable("이 페이지에 자동 실행 스크립트가 주입되지 않았습니다. 사이트 접근 허용 여부를 확인하세요.");
  } catch {
    showUnavailable("Chrome에서 이 탭을 제어할 수 없습니다.");
  }
}

toggleButton.addEventListener("click", async () => {
  if (activeTabId === undefined || unavailableReason) return;
  toggleButton.disabled = true;
  toggleButton.textContent = "상태 변경 중…";

  try {
    if (!currentStatus) throw new Error("Content script is not available on this page.");
    const nextEnabled = !currentStatus?.enabled;
    currentStatus = await chrome.tabs.sendMessage(activeTabId, {
      type: "joy-nav:set-enabled",
      enabled: nextEnabled,
    }) as PageStatus;
    renderStatus(currentStatus);
  } catch {
    showUnavailable("이 페이지에 스크립트를 넣지 못했습니다. chrome:// 페이지와 Chrome 웹 스토어는 지원하지 않습니다.");
  }
});

document.querySelector<HTMLButtonElement>("#settingsButton")!.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void initialize();
