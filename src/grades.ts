// Grade arithmetic for grade_whatif (GitHub #2). Pure functions, no Canvas calls, so it can be unit-tested.
// Follows Canvas's own calculator: excused work is left out, drop rules keep the subset that gives the
// group its best (drop_lowest) or worst (drop_highest) percentage, and weighted courses scale group weights
// up when the groups that count add up to less than 100.
import type { AssignmentGroup, GradingStandard } from "./types.js";

export interface GradeItem {
  id: number;
  name: string;
  points: number;
  /** null when not graded yet (or not posted to the student). */
  score: number | null;
  excused: boolean;
  missing: boolean;
}

export interface GradeGroup {
  id: number;
  name: string;
  weight: number;
  drop_lowest: number;
  drop_highest: number;
  never_drop: number[];
  items: GradeItem[];
}

export interface Cutoff {
  name: string;
  /** Lowest percentage (0–100) that earns this letter. */
  min: number;
}

/** Canvas's default grading scheme, used when the course's own scale can't be read. */
export const CANVAS_DEFAULT_SCALE: Cutoff[] = [
  ["A", 94], ["A-", 90], ["B+", 87], ["B", 84], ["B-", 80], ["C+", 77], ["C", 74], ["C-", 70],
  ["D+", 67], ["D", 64], ["D-", 61], ["F", 0],
].map(([name, min]) => ({ name: name as string, min: min as number }));

/** The score each item counts with, or null to leave it out (ungraded in the current view). */
export type ScoreFn = (item: GradeItem) => number | null;

export const currentView: ScoreFn = (i) => i.score;
export const finalView: ScoreFn = (i) => i.score ?? 0;

interface Kept {
  item: GradeItem;
  score: number;
}

export interface GroupResult {
  group: GradeGroup;
  earned: number;
  possible: number;
  /** null when nothing in the group counts. */
  percent: number | null;
  dropped: GradeItem[];
}

export interface CourseResult {
  /** null when nothing counts yet. */
  percent: number | null;
  groups: GroupResult[];
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function gradeCourse(groups: GradeGroup[], weighted: boolean, view: ScoreFn): CourseResult {
  const results = groups.map((g) => gradeGroup(g, view));
  const counted = results.filter((r) => r.possible > 0);
  if (weighted) {
    const fullWeight = counted.reduce((n, r) => n + r.group.weight, 0);
    if (fullWeight === 0) return { percent: null, groups: results };
    const sum = counted.reduce((n, r) => n + (r.earned / r.possible) * r.group.weight, 0);
    // Like Canvas: scale up when the counted groups' weights fall short of 100, never down.
    return { percent: fullWeight < 100 ? (sum * 100) / fullWeight : sum, groups: results };
  }
  const earned = counted.reduce((n, r) => n + r.earned, 0);
  const possible = counted.reduce((n, r) => n + r.possible, 0);
  return { percent: possible > 0 ? (earned / possible) * 100 : null, groups: results };
}

export function gradeGroup(g: GradeGroup, view: ScoreFn): GroupResult {
  const scored: Kept[] = [];
  for (const item of g.items) {
    if (item.excused) continue;
    const score = view(item);
    if (score !== null) scored.push({ item, score });
  }
  const neverDrop = new Set(g.never_drop);
  const fixed = scored.filter((k) => neverDrop.has(k.item.id));
  let droppable = scored.filter((k) => !neverDrop.has(k.item.id));

  // Canvas never drops everything: at least one droppable item is kept.
  let dropLowest = g.drop_lowest;
  let dropHighest = g.drop_highest;
  if (dropLowest >= droppable.length) {
    dropLowest = Math.max(droppable.length - 1, 0);
    dropHighest = 0;
  } else if (dropLowest + dropHighest >= droppable.length) {
    dropHighest = Math.max(droppable.length - dropLowest - 1, 0);
  }
  const dropped: GradeItem[] = [];
  if (dropLowest > 0) {
    const keep = bestSubset(droppable, droppable.length - dropLowest, fixed, "highest");
    dropped.push(...droppable.filter((k) => !keep.includes(k)).map((k) => k.item));
    droppable = keep;
  }
  if (dropHighest > 0) {
    const keep = bestSubset(droppable, droppable.length - dropHighest, fixed, "lowest");
    dropped.push(...droppable.filter((k) => !keep.includes(k)).map((k) => k.item));
    droppable = keep;
  }
  const kept = [...fixed, ...droppable];
  const earned = kept.reduce((n, k) => n + k.score, 0);
  const possible = kept.reduce((n, k) => n + k.item.points, 0);
  return { group: g, earned, possible, percent: possible > 0 ? (earned / possible) * 100 : null, dropped };
}

/**
 * Picks `keep` items so the group's ratio (with `fixed` always counted) is as high (or low) as possible.
 * Ranking by percentage alone is wrong when point values differ, so this searches for the ratio q at which
 * the best `keep` items' total of (score − q·points) is exactly zero (the method Canvas uses too).
 */
function bestSubset(items: Kept[], keep: number, fixed: Kept[], want: "highest" | "lowest"): Kept[] {
  const sign = want === "highest" ? 1 : -1;
  const fixedS = fixed.reduce((n, k) => n + k.score, 0);
  const fixedP = fixed.reduce((n, k) => n + k.item.points, 0);
  const pick = (q: number) =>
    [...items]
      .sort((a, b) => sign * (b.score - q * b.item.points - (a.score - q * a.item.points)) || a.item.id - b.item.id)
      .slice(0, keep);
  const value = (q: number) => pick(q).reduce((n, k) => n + k.score - q * k.item.points, fixedS - q * fixedP);

  const ratios = [...items, ...fixed].filter((k) => k.item.points > 0).map((k) => k.score / k.item.points);
  let lo = Math.min(0, ...ratios);
  let hi = Math.max(1, ...ratios) + [...items, ...fixed].reduce((n, k) => n + (k.item.points > 0 ? 0 : Math.abs(k.score)), 0);
  // value(q) falls as q rises (for either direction), and crosses zero at the best/worst ratio.
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (value(mid) > 0) lo = mid;
    else hi = mid;
  }
  return pick((lo + hi) / 2);
}

export function letterFor(percent: number | null, scale: Cutoff[]): string | undefined {
  if (percent === null) return undefined;
  const p = round2(percent);
  return [...scale].sort((a, b) => b.min - a.min).find((c) => p >= c.min - 1e-9)?.name;
}

/** "B+", "87", "87%" → a percentage, using the course's scale for letters. */
export function parseTarget(target: string, scale: Cutoff[]): number {
  const t = target.trim();
  const num = t.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (num) return Number(num[1]);
  const hit = scale.find((c) => c.name.toLowerCase() === t.toLowerCase());
  if (!hit) throw new Error(`"${target}" isn't a percentage or a letter on this course's scale (${scale.map((c) => c.name).join(", ")}).`);
  return hit.min;
}

export interface TargetResult {
  target_percent: number;
  /** Average needed on the remaining work, 0–100; undefined when unreachable or already secured. */
  needed_percent?: number;
  reachable: boolean;
  already_secured: boolean;
  /** Projected course percentage with 100% on everything remaining. */
  best_possible: number | null;
  /** Projected course percentage with 0 on everything remaining. */
  worst_possible: number | null;
}

/**
 * The lowest uniform percentage on the `remaining` items (all other ungraded work counted as zero) that
 * brings the course to `target`. The course grade only goes up as that percentage does, so bisect.
 */
export function solveTarget(
  groups: GradeGroup[],
  weighted: boolean,
  target: number,
  remaining: Set<number>,
  base: ScoreFn,
): TargetResult {
  const at = (x: number) =>
    gradeCourse(groups, weighted, (i) => (remaining.has(i.id) ? x * i.points : base(i))).percent;
  const reaches = (x: number) => {
    const p = at(x);
    return p !== null && round2(p) >= target - 1e-9;
  };
  const best = at(1);
  const worst = at(0);
  const out = {
    target_percent: target,
    best_possible: best === null ? null : round2(best),
    worst_possible: worst === null ? null : round2(worst),
  };
  if (reaches(0)) return { ...out, reachable: true, already_secured: true };
  if (remaining.size === 0 || !reaches(1)) return { ...out, reachable: false, already_secured: false };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (reaches(mid)) hi = mid;
    else lo = mid;
  }
  // Round up to a tenth of a percent so the stated average is always enough.
  return { ...out, needed_percent: Math.ceil(hi * 1000 - 1e-6) / 10, reachable: true, already_secured: false };
}

/** Canvas assignment groups → what the calculator needs. Ungraded-type and omitted assignments don't count. */
export function toGradeGroups(groups: AssignmentGroup[]): GradeGroup[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    weight: g.group_weight ?? 0,
    drop_lowest: g.rules?.drop_lowest ?? 0,
    drop_highest: g.rules?.drop_highest ?? 0,
    never_drop: g.rules?.never_drop ?? [],
    items: (g.assignments ?? [])
      .filter((a) => !a.omit_from_final_grade && a.grading_type !== "not_graded")
      .map((a) => ({
        id: a.id,
        name: a.name,
        points: a.points_possible ?? 0,
        score: a.submission?.score ?? null,
        excused: Boolean(a.submission?.excused),
        missing: Boolean(a.submission?.missing),
      })),
  }));
}

export function scaleFrom(standard: GradingStandard): Cutoff[] {
  return standard.grading_scheme.map((c) => ({ name: c.name, min: round2(c.value * 100) }));
}
