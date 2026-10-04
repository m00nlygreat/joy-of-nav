import type { DistanceMode, InclusionMode, TieBreakMode } from "./settings.js";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Direction extends Point {
  magnitude: number;
}

export interface Candidate<T = unknown> {
  id: T;
  rect: Rect;
  documentOrder: number;
}

export function readDirection(x: number, y: number, deadzone: number): Direction | null {
  const magnitude = Math.hypot(x, y);
  if (!Number.isFinite(magnitude) || magnitude <= deadzone) return null;
  return { x, y, magnitude };
}

export function pointInCone(point: Point, origin: Point, direction: Point, fullAngle: number): boolean {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const pointLength = Math.hypot(dx, dy);
  const directionLength = Math.hypot(direction.x, direction.y);
  if (pointLength === 0 || directionLength === 0) return true;
  const cosine = Math.min(1, Math.max(-1, (dx * direction.x + dy * direction.y) / (pointLength * directionLength)));
  const angle = Math.acos(cosine) * 180 / Math.PI;
  return angle <= fullAngle / 2 + 1e-8;
}

function corners(rect: Rect): Point[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
}

function segmentIntersectsRect(start: Point, end: Point, rect: Rect): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let t0 = 0;
  let t1 = 1;
  const tests: Array<[number, number]> = [
    [-dx, start.x - rect.left],
    [dx, rect.right - start.x],
    [-dy, start.y - rect.top],
    [dy, rect.bottom - start.y],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function rayIntersectsRect(origin: Point, direction: Point, rect: Rect): boolean {
  const length = Math.max(...corners(rect).map((point) => Math.hypot(point.x - origin.x, point.y - origin.y))) + 1;
  const magnitude = Math.hypot(direction.x, direction.y);
  if (!magnitude) return false;
  const end = { x: origin.x + direction.x / magnitude * length, y: origin.y + direction.y / magnitude * length };
  return segmentIntersectsRect(origin, end, rect);
}

function rectIntersectsCone(rect: Rect, origin: Point, direction: Point, fullAngle: number): boolean {
  if (corners(rect).some((corner) => pointInCone(corner, origin, direction, fullAngle))) return true;
  const nearest = {
    x: Math.min(rect.right, Math.max(rect.left, origin.x)),
    y: Math.min(rect.bottom, Math.max(rect.top, origin.y)),
  };
  if (pointInCone(nearest, origin, direction, fullAngle)) return true;

  const axisAngle = Math.atan2(direction.y, direction.x);
  const halfAngle = fullAngle * Math.PI / 360;
  const start = { x: Math.cos(axisAngle - halfAngle), y: Math.sin(axisAngle - halfAngle) };
  const end = { x: Math.cos(axisAngle + halfAngle), y: Math.sin(axisAngle + halfAngle) };
  return rayIntersectsRect(origin, direction, rect)
    || rayIntersectsRect(origin, start, rect)
    || rayIntersectsRect(origin, end, rect);
}

function clipPolygon(polygon: Point[], signedDistance: (point: Point) => number): Point[] {
  if (!polygon.length) return [];
  const clipped: Point[] = [];
  let previous = polygon[polygon.length - 1]!;
  let previousDistance = signedDistance(previous);
  let previousInside = previousDistance >= -1e-8;
  for (const current of polygon) {
    const currentDistance = signedDistance(current);
    const currentInside = currentDistance >= -1e-8;
    if (currentInside !== previousInside) {
      const denominator = previousDistance - currentDistance;
      const amount = Math.abs(denominator) < 1e-12 ? 0 : previousDistance / denominator;
      clipped.push({
        x: previous.x + (current.x - previous.x) * amount,
        y: previous.y + (current.y - previous.y) * amount,
      });
    }
    if (currentInside) clipped.push(current);
    previous = current;
    previousDistance = currentDistance;
    previousInside = currentInside;
  }
  return clipped;
}

export function candidateInCone(candidate: Candidate, origin: Point, direction: Point, fullAngle: number, mode: InclusionMode): boolean {
  if (mode === "intersects") return rectIntersectsCone(candidate.rect, origin, direction, fullAngle);
  return pointInCone({
    x: (candidate.rect.left + candidate.rect.right) / 2,
    y: (candidate.rect.top + candidate.rect.bottom) / 2,
  }, origin, direction, fullAngle);
}

const SPOTLIGHT_CAP_SEGMENTS = 24;

export function createSpotlightPolygon(
  origin: Point,
  direction: Point,
  arrivalWidth: number,
  startWidth: number,
  viewportWidth: number,
  viewportHeight: number,
): Point[] {
  const directionLength = Math.hypot(direction.x, direction.y);
  if (!directionLength || (arrivalWidth <= 0 && startWidth <= 0)) return [];

  const unitDirection = { x: direction.x / directionLength, y: direction.y / directionLength };
  const perpendicular = { x: -unitDirection.y, y: unitDirection.x };
  const viewportCorners = corners({ left: 0, top: 0, right: viewportWidth, bottom: viewportHeight });
  const endDistance = Math.max(...viewportCorners.map((point) => (
    (point.x - origin.x) * unitDirection.x + (point.y - origin.y) * unitDirection.y
  )));
  if (endDistance <= 0) return [];

  const startRadius = Math.max(0, startWidth) / 2;
  const arrivalRadius = Math.max(0, arrivalWidth) / 2;
  const end = {
    x: origin.x + unitDirection.x * endDistance,
    y: origin.y + unitDirection.y * endDistance,
  };
  const pointAt = (along: number, across: number): Point => ({
    x: origin.x + unitDirection.x * along + perpendicular.x * across,
    y: origin.y + unitDirection.y * along + perpendicular.y * across,
  });
  const polygon = [
    pointAt(0, startRadius),
    { x: end.x + perpendicular.x * arrivalRadius, y: end.y + perpendicular.y * arrivalRadius },
    { x: end.x - perpendicular.x * arrivalRadius, y: end.y - perpendicular.y * arrivalRadius },
  ];

  if (startRadius > 0) {
    polygon.push(pointAt(0, -startRadius));
    for (let index = 1; index < SPOTLIGHT_CAP_SEGMENTS; index += 1) {
      const angle = -Math.PI / 2 - Math.PI * index / SPOTLIGHT_CAP_SEGMENTS;
      polygon.push(pointAt(Math.cos(angle) * startRadius, Math.sin(angle) * startRadius));
    }
  }
  return polygon;
}

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-14) return Math.hypot(point.x - start.x, point.y - start.y) <= 1e-7;
  const amount = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy)) <= 1e-7;
}

function polygonContainsPoint(polygon: Point[], point: Point): boolean {
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index]!;
    const previous = polygon[previousIndex]!;
    if (pointOnSegment(point, previous, current)) return true;
    if ((current.y > point.y) !== (previous.y > point.y)
      && point.x < (previous.x - current.x) * (point.y - current.y) / (previous.y - current.y) + current.x) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonIntersectsRect(polygon: Point[], rect: Rect): boolean {
  let clipped = polygon;
  clipped = clipPolygon(clipped, (point) => point.x - rect.left);
  clipped = clipPolygon(clipped, (point) => rect.right - point.x);
  clipped = clipPolygon(clipped, (point) => point.y - rect.top);
  clipped = clipPolygon(clipped, (point) => rect.bottom - point.y);
  return clipped.length > 0;
}

function candidateInSpotlightPolygon(candidate: Candidate, polygon: Point[], mode: InclusionMode): boolean {
  if (mode === "intersects") return polygonIntersectsRect(polygon, candidate.rect);
  return polygonContainsPoint(polygon, {
    x: (candidate.rect.left + candidate.rect.right) / 2,
    y: (candidate.rect.top + candidate.rect.bottom) / 2,
  });
}

export function candidateInSpotlight(
  candidate: Candidate,
  origin: Point,
  direction: Point,
  arrivalWidth: number,
  startWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  mode: InclusionMode,
): boolean {
  const polygon = createSpotlightPolygon(origin, direction, arrivalWidth, startWidth, viewportWidth, viewportHeight);
  return polygon.length > 0 && candidateInSpotlightPolygon(candidate, polygon, mode);
}

function candidateDistance(candidate: Candidate, origin: Point, mode: DistanceMode): number {
  const point = mode === "center"
    ? { x: (candidate.rect.left + candidate.rect.right) / 2, y: (candidate.rect.top + candidate.rect.bottom) / 2 }
    : {
      x: Math.min(candidate.rect.right, Math.max(candidate.rect.left, origin.x)),
      y: Math.min(candidate.rect.bottom, Math.max(candidate.rect.top, origin.y)),
    };
  return Math.hypot(point.x - origin.x, point.y - origin.y);
}

export function rankCandidates<T>(
  candidates: Candidate<T>[],
  origin: Point,
  direction: Point,
  fullAngle: number,
  inclusionMode: InclusionMode,
  distanceMode: DistanceMode,
  tieBreak: TieBreakMode,
): Candidate<T>[] {
  return candidates
    .filter((candidate) => candidateInCone(candidate, origin, direction, fullAngle, inclusionMode))
    .slice()
    .sort((left, right) => {
      const distanceDelta = candidateDistance(left, origin, distanceMode) - candidateDistance(right, origin, distanceMode);
      if (Math.abs(distanceDelta) > 0.01) return distanceDelta;
      if (tieBreak === "top-left") {
        const topDelta = left.rect.top - right.rect.top;
        if (Math.abs(topDelta) > 0.01) return topDelta;
        const leftDelta = left.rect.left - right.rect.left;
        if (Math.abs(leftDelta) > 0.01) return leftDelta;
      }
      return left.documentOrder - right.documentOrder;
    });
}

export function rankSpotlightCandidates<T>(
  candidates: Candidate<T>[],
  origin: Point,
  direction: Point,
  arrivalWidth: number,
  startWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  inclusionMode: InclusionMode,
  distanceMode: DistanceMode,
  tieBreak: TieBreakMode,
): Candidate<T>[] {
  const polygon = createSpotlightPolygon(origin, direction, arrivalWidth, startWidth, viewportWidth, viewportHeight);
  if (polygon.length === 0) return [];
  return candidates
    .filter((candidate) => candidateInSpotlightPolygon(candidate, polygon, inclusionMode))
    .slice()
    .sort((left, right) => {
      const distanceDelta = candidateDistance(left, origin, distanceMode) - candidateDistance(right, origin, distanceMode);
      if (Math.abs(distanceDelta) > 0.01) return distanceDelta;
      if (tieBreak === "top-left") {
        const topDelta = left.rect.top - right.rect.top;
        if (Math.abs(topDelta) > 0.01) return topDelta;
        const leftDelta = left.rect.left - right.rect.left;
        if (Math.abs(leftDelta) > 0.01) return leftDelta;
      }
      return left.documentOrder - right.documentOrder;
    });
}

export function nextCycleIndex(currentIndex: number, length: number): number {
  if (length <= 0) return -1;
  return currentIndex < 0 || currentIndex >= length ? 0 : (currentIndex + 1) % length;
}

export function resolveSelectionIndex<T>(previouslySelected: T | undefined, candidates: T[], preserve: boolean): number {
  if (preserve && previouslySelected !== undefined) {
    return candidates.indexOf(previouslySelected);
  }
  return -1;
}

export function hasRisen(currentlyDown: boolean, wasDown: boolean): boolean {
  return currentlyDown && !wasDown;
}
