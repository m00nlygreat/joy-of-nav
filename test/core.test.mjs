import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  candidateInCone,
  hasRisen,
  nextCycleIndex,
  normalizeSettings,
  pointInCone,
  rankCandidates,
  readDirection,
  resolveSelectionIndex,
} from "../dist/core/index.js";

test("deadzone suppresses neutral input and preserves an active direction", () => {
  assert.equal(readDirection(0.12, 0.12, 0.2), null);
  assert.deepEqual(readDirection(0.8, 0, 0.2), { x: 0.8, y: 0, magnitude: 0.8 });
});

test("a point on the cone boundary is included", () => {
  assert.equal(pointInCone({ x: 10, y: Math.tan(Math.PI / 12) * 10 }, { x: 0, y: 0 }, { x: 1, y: 0 }, 30), true);
  assert.equal(pointInCone({ x: 10, y: 3 }, { x: 0, y: 0 }, { x: 1, y: 0 }, 30), false);
});

test("rectangle intersection includes a candidate whose center is outside the cone", () => {
  const candidate = { id: "wide", rect: { left: 12, top: -18, right: 44, bottom: -3 }, documentOrder: 0 };
  assert.equal(candidateInCone(candidate, { x: 0, y: 0 }, { x: 1, y: 0 }, 20, "center"), false);
  assert.equal(candidateInCone(candidate, { x: 0, y: 0 }, { x: 1, y: 0 }, 20, "intersects"), true);
});

test("candidates are ranked from the viewport center outward", () => {
  const candidates = [
    { id: "far", rect: { left: 90, top: -8, right: 110, bottom: 8 }, documentOrder: 0 },
    { id: "near", rect: { left: 20, top: -4, right: 30, bottom: 4 }, documentOrder: 1 },
  ];
  const ordered = rankCandidates(candidates, { x: 0, y: 0 }, { x: 1, y: 0 }, 30, "center", "center", "dom");
  assert.deepEqual(ordered.map(({ id }) => id), ["near", "far"]);
});

test("equal distances use the selected tie-break rule", () => {
  const candidates = [
    { id: "lower", rect: { left: 20, top: 4, right: 28, bottom: 12 }, documentOrder: 0 },
    { id: "upper", rect: { left: 20, top: -12, right: 28, bottom: -4 }, documentOrder: 1 },
  ];
  const ordered = rankCandidates(candidates, { x: 0, y: 0 }, { x: 1, y: 0 }, 70, "center", "center", "top-left");
  assert.deepEqual(ordered.map(({ id }) => id), ["upper", "lower"]);
});

test("cycling wraps, starts at the first candidate, and handles empty sets", () => {
  assert.equal(nextCycleIndex(-1, 3), 0);
  assert.equal(nextCycleIndex(2, 3), 0);
  assert.equal(nextCycleIndex(0, 0), -1);
});

test("new candidate sets start unselected; preserve mode keeps a surviving choice", () => {
  assert.equal(resolveSelectionIndex(undefined, ["a", "b"], false), -1);
  assert.equal(resolveSelectionIndex("b", ["a", "b"], true), 1);
  assert.equal(resolveSelectionIndex("b", ["a"], true), -1);
});

test("button edge detection fires once per press", () => {
  assert.equal(hasRisen(true, false), true);
  assert.equal(hasRisen(true, true), false);
  assert.equal(hasRisen(false, true), false);
});

test("stored settings are clamped and invalid options fall back to defaults", () => {
  assert.deepEqual(normalizeSettings({ deadzone: 2, coneAngle: "bad", neutralBehavior: "unknown" }), {
    ...DEFAULT_SETTINGS,
    deadzone: 0.6,
  });
});
