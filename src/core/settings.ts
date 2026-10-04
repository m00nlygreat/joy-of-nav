export type NeutralBehavior = "retain" | "clear";
export type CandidateStart = "first" | "preserve";
export type InclusionMode = "center" | "intersects";
export type DistanceMode = "center" | "nearest";
export type TieBreakMode = "dom" | "top-left";
export type CandidateNumberVisibility = "show" | "hide";
export type ControlGuideVisibility = "show" | "hide";
export type SpeedCurve = [number, number, number, number, number];

export interface Settings {
  deadzone: number;
  spotlightArrivalSize: number;
  spotlightStartSize: number;
  triggerThreshold: number;
  neutralBehavior: NeutralBehavior;
  candidateStart: CandidateStart;
  inclusionMode: InclusionMode;
  distanceMode: DistanceMode;
  tieBreak: TieBreakMode;
  candidateNumberVisibility: CandidateNumberVisibility;
  controlGuideVisibility: ControlGuideVisibility;
  scrollSpeedCurve: SpeedCurve;
  pointerSpeedCurve: SpeedCurve;
  scrollMaxSpeed: number;
  pointerMaxSpeed: number;
  rightStickCandidateStepDegrees: number;
}

const DEFAULT_SCROLL_SPEED_CURVE: SpeedCurve = [0, 0.1, 0.3, 0.62, 1];
const DEFAULT_POINTER_SPEED_CURVE: SpeedCurve = [0, 0.08, 0.28, 0.62, 1];
const PREVIOUS_SCROLL_SPEED_CURVE: SpeedCurve = [0, 0.58, 0.82, 0.95, 1];
const PREVIOUS_POINTER_SPEED_CURVE: SpeedCurve = [0, 0.5, 0.76, 0.92, 1];

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  deadzone: 0.2,
  spotlightArrivalSize: 30,
  spotlightStartSize: 0,
  triggerThreshold: 0.5,
  neutralBehavior: "retain",
  candidateStart: "first",
  inclusionMode: "center",
  distanceMode: "center",
  tieBreak: "dom",
  candidateNumberVisibility: "show",
  controlGuideVisibility: "show",
  scrollSpeedCurve: DEFAULT_SCROLL_SPEED_CURVE,
  pointerSpeedCurve: DEFAULT_POINTER_SPEED_CURVE,
  scrollMaxSpeed: 2200,
  pointerMaxSpeed: 1800,
  rightStickCandidateStepDegrees: 70,
});

const LIMITS = {
  deadzone: { min: 0.05, max: 0.6 },
  triggerThreshold: { min: 0.1, max: 1 },
  scrollMaxSpeed: { min: 100, max: 4000 },
  pointerMaxSpeed: { min: 100, max: 3000 },
  rightStickCandidateStepDegrees: { min: 15, max: 180 },
  spotlightArrivalSize: { min: 0, max: 100 },
  spotlightStartSize: { min: 0, max: 100 },
} as const;

function numericValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export interface SpeedCurveBezierSegment {
  startX: number;
  startY: number;
  control1X: number;
  control1Y: number;
  control2X: number;
  control2Y: number;
  endX: number;
  endY: number;
}

export function speedCurveBezierSegments(curve: SpeedCurve): SpeedCurveBezierSegment[] {
  const spacing = 1 / 4;
  const slopes = curve.slice(0, 4).map((value, index) => (curve[index + 1]! - value) / spacing);
  const tangents = [slopes[0]!];
  for (let index = 1; index < 4; index += 1) {
    const previous = slopes[index - 1]!;
    const next = slopes[index]!;
    tangents.push(previous <= 0 || next <= 0 ? 0 : (2 * previous * next) / (previous + next));
  }
  tangents.push(slopes[3]!);

  return Array.from({ length: 4 }, (_, index) => {
    const startX = index * spacing;
    const endX = startX + spacing;
    return {
      startX,
      startY: curve[index]!,
      control1X: startX + spacing / 3,
      control1Y: curve[index]! + tangents[index]! * spacing / 3,
      control2X: endX - spacing / 3,
      control2Y: curve[index + 1]! - tangents[index + 1]! * spacing / 3,
      endX,
      endY: curve[index + 1]!,
    };
  });
}

function normalizeSpeedCurve(value: unknown, fallback: SpeedCurve): SpeedCurve {
  if (!Array.isArray(value) || value.length < 5) return [...fallback];
  const previousDefaults = fallback === DEFAULT_SCROLL_SPEED_CURVE
    ? PREVIOUS_SCROLL_SPEED_CURVE
    : PREVIOUS_POINTER_SPEED_CURVE;
  if (previousDefaults.every((point, index) => Number(value[index]) === point)) return [...fallback];
  const curve: SpeedCurve = [
    0,
    numericValue(value[1], fallback[1], 0, 1),
    numericValue(value[2], fallback[2], 0, 1),
    numericValue(value[3], fallback[3], 0, 1),
    1,
  ];
  for (let index = 2; index <= 3; index += 1) {
    curve[index] = Math.max(curve[index - 1]!, curve[index]!);
  }
  return curve;
}

export function mapSpeedCurve(value: number, curve: SpeedCurve): number {
  const input = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const segment = Math.min(3, Math.floor(input * 4));
  const amount = input * 4 - segment;
  const { startY, control1Y, control2Y, endY } = speedCurveBezierSegments(curve)[segment]!;
  const inverse = 1 - amount;
  return inverse ** 3 * startY
    + 3 * inverse ** 2 * amount * control1Y
    + 3 * inverse * amount ** 2 * control2Y
    + amount ** 3 * endY;
}

export function normalizeSettings(value: unknown): Settings {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const source = record as Partial<Record<keyof Settings, unknown>>;
  const legacySize = record.spotlightSize ?? record.coneAngle;
  const hasNewSpotlightSizes = source.spotlightArrivalSize !== undefined || source.spotlightStartSize !== undefined;
  const migrateLegacySpotlightSize = !hasNewSpotlightSizes && legacySize !== undefined;
  const legacySizePercent = migrateLegacySpotlightSize
    ? numericValue(legacySize, DEFAULT_SETTINGS.spotlightArrivalSize, LIMITS.spotlightArrivalSize.min, LIMITS.spotlightArrivalSize.max)
    : undefined;
  const legacyWasCylinder = record.spotlightShape === "cylinder";
  return {
    deadzone: numericValue(source.deadzone, DEFAULT_SETTINGS.deadzone, LIMITS.deadzone.min, LIMITS.deadzone.max),
    spotlightArrivalSize: numericValue(source.spotlightArrivalSize, legacySizePercent ?? DEFAULT_SETTINGS.spotlightArrivalSize, LIMITS.spotlightArrivalSize.min, LIMITS.spotlightArrivalSize.max),
    spotlightStartSize: numericValue(source.spotlightStartSize, legacyWasCylinder ? legacySizePercent ?? DEFAULT_SETTINGS.spotlightStartSize : DEFAULT_SETTINGS.spotlightStartSize, LIMITS.spotlightStartSize.min, LIMITS.spotlightStartSize.max),
    triggerThreshold: numericValue(source.triggerThreshold, DEFAULT_SETTINGS.triggerThreshold, LIMITS.triggerThreshold.min, LIMITS.triggerThreshold.max),
    neutralBehavior: source.neutralBehavior === "clear" ? "clear" : "retain",
    candidateStart: source.candidateStart === "preserve" ? "preserve" : "first",
    inclusionMode: source.inclusionMode === "intersects" ? "intersects" : "center",
    distanceMode: source.distanceMode === "nearest" ? "nearest" : "center",
    tieBreak: source.tieBreak === "top-left" ? "top-left" : "dom",
    candidateNumberVisibility: source.candidateNumberVisibility === "hide" ? "hide" : "show",
    controlGuideVisibility: source.controlGuideVisibility === "hide" ? "hide" : "show",
    scrollSpeedCurve: normalizeSpeedCurve(source.scrollSpeedCurve, DEFAULT_SCROLL_SPEED_CURVE),
    pointerSpeedCurve: normalizeSpeedCurve(source.pointerSpeedCurve, DEFAULT_POINTER_SPEED_CURVE),
    scrollMaxSpeed: numericValue(source.scrollMaxSpeed, DEFAULT_SETTINGS.scrollMaxSpeed, LIMITS.scrollMaxSpeed.min, LIMITS.scrollMaxSpeed.max),
    pointerMaxSpeed: numericValue(source.pointerMaxSpeed, DEFAULT_SETTINGS.pointerMaxSpeed, LIMITS.pointerMaxSpeed.min, LIMITS.pointerMaxSpeed.max),
    rightStickCandidateStepDegrees: numericValue(source.rightStickCandidateStepDegrees, DEFAULT_SETTINGS.rightStickCandidateStepDegrees, LIMITS.rightStickCandidateStepDegrees.min, LIMITS.rightStickCandidateStepDegrees.max),
  };
}

export const SETTING_LIMITS = LIMITS;
