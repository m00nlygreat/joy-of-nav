import { DEFAULT_SETTINGS, normalizeSettings, speedCurveBezierSegments, type Settings, type SpeedCurve } from "../core/settings.js";

const form = document.querySelector<HTMLFormElement>("#settingsForm")!;
const saveStatus = document.querySelector<HTMLElement>("#saveStatus")!;
const saveMessage = saveStatus.querySelector<HTMLElement>("span:last-child")!;
const resetButton = document.querySelector<HTMLButtonElement>("#resetButton")!;
const SPEED_CURVE_NAMES = ["scrollSpeedCurve", "pointerSpeedCurve"] as const;
const CURVE_PLOT = { top: 20, bottom: 155, left: 40, right: 310, height: 200 } as const;

function paintStatus(message: string, tone: "saved" | "error" | "idle" = "idle"): void {
  saveMessage.textContent = message;
  saveStatus.dataset.tone = tone;
}

function speedCurveDots(name: typeof SPEED_CURVE_NAMES[number]): SVGCircleElement[] {
  return [...form.querySelectorAll<SVGCircleElement>(`circle[data-speed-curve-dot="${name}"]`)]
    .sort((first, second) => Number(first.dataset.curveIndex) - Number(second.dataset.curveIndex));
}

function curveFromChart(name: typeof SPEED_CURVE_NAMES[number]): SpeedCurve {
  const dots = speedCurveDots(name);
  return [0, Number(dots[1]?.dataset.value ?? 0) / 100, Number(dots[2]?.dataset.value ?? 0) / 100, Number(dots[3]?.dataset.value ?? 0) / 100, 1];
}

function paintSpeedCurve(name: typeof SPEED_CURVE_NAMES[number], curve: SpeedCurve): void {
  const coordinates = curve.map((value, index) => ({
    x: CURVE_PLOT.left + (CURVE_PLOT.right - CURVE_PLOT.left) * index / 4,
    y: CURVE_PLOT.bottom - (CURVE_PLOT.bottom - CURVE_PLOT.top) * value,
  }));
  const toX = (value: number): number => CURVE_PLOT.left + (CURVE_PLOT.right - CURVE_PLOT.left) * value;
  const toY = (value: number): number => CURVE_PLOT.bottom - (CURVE_PLOT.bottom - CURVE_PLOT.top) * value;
  const bezierSegments = speedCurveBezierSegments(curve);
  const curvePath = `M ${toX(bezierSegments[0]!.startX)} ${toY(bezierSegments[0]!.startY)} ${bezierSegments.map((segment) => (
    `C ${toX(segment.control1X)} ${toY(segment.control1Y)} ${toX(segment.control2X)} ${toY(segment.control2Y)} ${toX(segment.endX)} ${toY(segment.endY)}`
  )).join(" ")}`;
  form.querySelector<SVGPathElement>(`[data-speed-curve-path="${name}"]`)?.setAttribute("d", curvePath);
  const areaPath = `${curvePath} L ${CURVE_PLOT.right} ${CURVE_PLOT.bottom} L ${CURVE_PLOT.left} ${CURVE_PLOT.bottom} Z`;
  form.querySelector<SVGPathElement>(`[data-speed-curve-area="${name}"]`)?.setAttribute("d", areaPath);

  speedCurveDots(name).forEach((dot, index) => {
    const value = Math.round(curve[index]! * 100);
    dot.dataset.value = String(value);
    dot.setAttribute("cx", String(coordinates[index]!.x));
    dot.setAttribute("cy", String(coordinates[index]!.y));
    if (index > 0 && index < 4) {
      const inputPercent = index * 25;
      dot.setAttribute("aria-valuenow", String(value));
      dot.setAttribute("aria-valuetext", `${inputPercent}% 입력, 속도 ${value}%`);
      const label = form.querySelector<SVGTextElement>(`text[data-speed-curve-label="${name}"][data-curve-index="${index}"]`);
      label?.setAttribute("x", String(coordinates[index]!.x));
      label?.setAttribute("y", String(Math.max(CURVE_PLOT.top - 5, coordinates[index]!.y - 12)));
      if (label) label.textContent = `${value}%`;
      const readout = form.querySelector<HTMLOutputElement>(`output[data-speed-curve-readout="${name}"][data-curve-index="${index}"]`);
      if (readout) readout.textContent = `${value}%`;
    }
  });
}

function setSpeedCurvePoint(name: typeof SPEED_CURVE_NAMES[number], changedIndex: number, percent: number): void {
  const curve = curveFromChart(name);
  curve[changedIndex] = Math.min(100, Math.max(0, Math.round(percent))) / 100;
  for (let index = changedIndex - 1; index >= 1; index -= 1) {
    curve[index] = Math.min(curve[index]!, curve[index + 1]!);
  }
  for (let index = changedIndex + 1; index <= 3; index += 1) {
    curve[index] = Math.max(curve[index]!, curve[index - 1]!);
  }
  paintSpeedCurve(name, curve);
  paintStatus("변경 사항을 저장하세요.");
}

function moveSpeedCurvePoint(chart: SVGSVGElement, name: typeof SPEED_CURVE_NAMES[number], index: number, clientY: number): void {
  const bounds = chart.getBoundingClientRect();
  if (bounds.height <= 0) return;
  const chartY = (clientY - bounds.top) / bounds.height * CURVE_PLOT.height;
  const fraction = (CURVE_PLOT.bottom - chartY) / (CURVE_PLOT.bottom - CURVE_PLOT.top);
  setSpeedCurvePoint(name, index, fraction * 100);
}

function bindSpeedCurveCharts(): void {
  for (const chart of form.querySelectorAll<SVGSVGElement>("svg[data-speed-curve-chart]")) {
    const name = chart.dataset.speedCurveChart as typeof SPEED_CURVE_NAMES[number];
    let activePointer: { id: number; index: number } | null = null;

    chart.addEventListener("pointerdown", (event: PointerEvent) => {
      const handle = event.target instanceof SVGCircleElement ? event.target : null;
      const index = Number(handle?.dataset.curveIndex);
      if (!handle || index < 1 || index > 3) return;
      activePointer = { id: event.pointerId, index };
      chart.setPointerCapture(event.pointerId);
      moveSpeedCurvePoint(chart, name, index, event.clientY);
      event.preventDefault();
    });

    chart.addEventListener("pointermove", (event: PointerEvent) => {
      if (activePointer?.id !== event.pointerId) return;
      moveSpeedCurvePoint(chart, name, activePointer.index, event.clientY);
    });

    chart.addEventListener("pointerup", (event: PointerEvent) => {
      if (activePointer?.id !== event.pointerId) return;
      activePointer = null;
      void save();
    });

    chart.addEventListener("pointercancel", () => {
      if (!activePointer) return;
      activePointer = null;
      void save();
    });

    for (const handle of chart.querySelectorAll<SVGCircleElement>("circle.curve-handle")) {
      handle.addEventListener("keydown", (event: KeyboardEvent) => {
        const index = Number(handle.dataset.curveIndex);
        const current = Number(handle.getAttribute("aria-valuenow"));
        const step = event.shiftKey ? 5 : 1;
        let next: number | null = null;
        if (event.key === "ArrowUp" || event.key === "ArrowRight") next = current + step;
        else if (event.key === "ArrowDown" || event.key === "ArrowLeft") next = current - step;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = 100;
        if (next === null) return;
        event.preventDefault();
        setSpeedCurvePoint(name, index, next);
      });
      handle.addEventListener("keyup", (event: KeyboardEvent) => {
        if (["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "Home", "End"].includes(event.key)) void save();
      });
    }
  }
}

function render(settings: Settings): void {
  for (const input of form.querySelectorAll<HTMLInputElement>("input[data-setting]")) {
    const key = input.dataset.setting as keyof Settings;
    input.value = String(settings[key]);
    input.setAttribute("aria-invalid", "false");
    const range = form.querySelector<HTMLInputElement>(`input[data-range-for="${key}"]`);
    if (range) range.value = String(settings[key]);
  }
  for (const select of form.querySelectorAll<HTMLSelectElement>("select[data-setting]")) {
    const key = select.dataset.setting as keyof Settings;
    select.value = String(settings[key]);
  }
  for (const name of SPEED_CURVE_NAMES) paintSpeedCurve(name, settings[name]);
}

function readForm(): Settings | null {
  const numericInputs = [...form.querySelectorAll<HTMLInputElement>("input[data-setting]")];
  let valid = true;
  for (const input of numericInputs) {
    const passes = input.value.trim() !== "" && input.validity.valid;
    input.setAttribute("aria-invalid", String(!passes));
    valid = valid && passes;
  }
  if (!valid) return null;

  const values: Record<string, unknown> = {};
  for (const input of numericInputs) values[input.dataset.setting!] = Number(input.value);
  for (const select of form.querySelectorAll<HTMLSelectElement>("select[data-setting]")) values[select.dataset.setting!] = select.value;
  for (const name of SPEED_CURVE_NAMES) values[name] = curveFromChart(name);
  return normalizeSettings(values);
}

async function save(): Promise<void> {
  const settings = readForm();
  if (!settings) {
    paintStatus("허용 범위 안의 값을 입력하세요.", "error");
    return;
  }
  try {
    await chrome.storage.local.set({ settings });
    paintStatus("저장됨 · 켜져 있는 페이지에 바로 반영", "saved");
  } catch {
    paintStatus("설정을 저장하지 못했습니다. 다시 시도하세요.", "error");
  }
}

function syncRange(input: HTMLInputElement): void {
  const setting = input.dataset.setting ?? input.dataset.rangeFor;
  if (!setting) return;
  const range = form.querySelector<HTMLInputElement>(`input[data-range-for="${setting}"]`);
  if (!range) return;

  if (input.type === "range") {
    const number = form.querySelector<HTMLInputElement>(`input[data-setting="${setting}"]`);
    if (number) {
      number.value = input.value;
      number.setAttribute("aria-invalid", "false");
    }
  } else if (input.value.trim() && input.validity.valid) {
    range.value = input.value;
    input.setAttribute("aria-invalid", "false");
  }
}

for (const input of form.querySelectorAll<HTMLInputElement>("input[data-setting], input[data-range-for]")) {
  input.addEventListener("input", () => {
    syncRange(input);
    paintStatus("변경 사항을 저장하세요.");
  });
  input.addEventListener("change", () => void save());
}

bindSpeedCurveCharts();

for (const select of form.querySelectorAll<HTMLSelectElement>("select[data-setting]")) {
  select.addEventListener("change", () => void save());
}

resetButton.addEventListener("click", async () => {
  render(DEFAULT_SETTINGS as Settings);
  await save();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.settings?.newValue) {
    render(normalizeSettings(changes.settings.newValue));
  }
});

for (const input of form.querySelectorAll<HTMLInputElement>("input[data-setting]")) {
  input.setAttribute("aria-describedby", `${input.id}Helper`);
}

void chrome.storage.local.get("settings").then(({ settings }) => {
  render(normalizeSettings(settings));
  paintStatus("설정이 이 기기에 저장됩니다.");
}).catch(() => {
  render(DEFAULT_SETTINGS as Settings);
  paintStatus("기본 설정을 표시 중입니다. 저장 상태를 확인하세요.", "error");
});
