// Unit checks for the grade calculator behind grade_whatif (GitHub #2). No server, no Canvas.
import assert from "node:assert/strict";
import {
  CANVAS_DEFAULT_SCALE, currentView, finalView, gradeCourse, gradeGroup, letterFor, parseTarget, round2, solveTarget,
  type GradeGroup, type GradeItem,
} from "../src/grades.js";

let nextId = 1;
const item = (points: number, score: number | null, extra: Partial<GradeItem> = {}): GradeItem => ({
  id: nextId++, name: `a${nextId}`, points, score, excused: false, missing: false, ...extra,
});
const group = (items: GradeItem[], extra: Partial<GradeGroup> = {}): GradeGroup => ({
  id: nextId++, name: `g${nextId}`, weight: 0, drop_lowest: 0, drop_highest: 0, never_drop: [], items, ...extra,
});
const pct = (gs: GradeGroup[], weighted: boolean, view = currentView) => {
  const p = gradeCourse(gs, weighted, view).percent;
  return p === null ? null : round2(p);
};

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
  }
}

console.log("grade calculator");

check("unweighted: total points across groups; final counts ungraded as zero", () => {
  const gs = [group([item(10, 8), item(10, null)]), group([item(80, 72)])];
  assert.equal(pct(gs, false), 88.89); // 80 / 90
  assert.equal(pct(gs, false, finalView), 80); // 80 / 100
});

check("weighted: group percentages times weights, scaled up when groups are empty", () => {
  const hw = group([item(10, 9), item(10, 10)], { weight: 40 }); // 95%
  const exams = group([item(100, 80)], { weight: 60 }); // 80%
  assert.equal(pct([hw, exams], true), 86); // 38 + 48
  const empty = group([item(100, null)], { weight: 50 });
  // Current: only hw counts, so 95% of 40 is scaled up to 95.
  assert.equal(pct([{ ...hw, weight: 50 }, empty], true), 95);
  assert.equal(pct([{ ...hw, weight: 50 }, empty], true, finalView), 47.5);
});

check("weighted: weights over 100 aren't scaled down (extra-credit groups)", () => {
  const a = group([item(10, 10)], { weight: 100 });
  const bonus = group([item(10, 5)], { weight: 10 });
  assert.equal(pct([a, bonus], true), 105);
});

check("excused work is left out of both views", () => {
  const gs = [group([item(10, 9), item(10, null, { excused: true }), item(10, 0, { excused: true })])];
  assert.equal(pct(gs, false), 90);
  assert.equal(pct(gs, false, finalView), 90);
});

check("drop_lowest keeps the best ratio, not the highest percentages", () => {
  // Dropping the lowest percentage (2/10) gives 25/40 = 62.5%; dropping 5/20 gives 22/30 = 73.33%.
  const a = item(10, 2);
  const b = item(20, 5);
  const c = item(20, 20);
  const r = gradeGroup(group([a, b, c], { drop_lowest: 1 }), currentView);
  assert.deepEqual(r.dropped.map((d) => d.id), [b.id]);
  assert.equal(round2(r.percent!), 73.33);
});

check("drop_lowest only drops among graded work in the current view; ungraded zeros drop first in final", () => {
  const g = group([item(10, 6), item(10, 9), item(10, null)], { drop_lowest: 1 });
  assert.equal(round2(gradeGroup(g, currentView).percent!), 90);
  assert.equal(round2(gradeGroup(g, finalView).percent!), 75);
});

check("drop_highest, never_drop, and never dropping everything", () => {
  const keepMe = item(10, 1);
  const g = group([keepMe, item(10, 5), item(10, 10)], { drop_lowest: 1, never_drop: [keepMe.id] });
  assert.equal(round2(gradeGroup(g, currentView).percent!), 55); // 11 / 20: drops the 5, keeps the 1
  const high = group([item(10, 5), item(10, 10)], { drop_highest: 1 });
  assert.equal(round2(gradeGroup(high, currentView).percent!), 50);
  const all = group([item(10, 4), item(10, 8)], { drop_lowest: 5 });
  assert.equal(round2(gradeGroup(all, currentView).percent!), 80);
});

check("letters follow the scale with Canvas's two-decimal rounding", () => {
  assert.equal(letterFor(93.999, CANVAS_DEFAULT_SCALE), "A");
  assert.equal(letterFor(93.99, CANVAS_DEFAULT_SCALE), "A-");
  assert.equal(letterFor(12, CANVAS_DEFAULT_SCALE), "F");
  assert.equal(letterFor(null, CANVAS_DEFAULT_SCALE), undefined);
  assert.equal(parseTarget("b+", CANVAS_DEFAULT_SCALE), 87);
  assert.equal(parseTarget("88.5%", CANVAS_DEFAULT_SCALE), 88.5);
  assert.throws(() => parseTarget("Q", CANVAS_DEFAULT_SCALE), /isn't a percentage or a letter/);
});

check("target: average needed on remaining work (weighted)", () => {
  const hwDone = item(100, 90);
  const final = item(100, null);
  const gs = [group([hwDone], { weight: 50 }), group([final], { weight: 50 })];
  const r = solveTarget(gs, true, 87, new Set([final.id]), finalView);
  assert.equal(r.reachable, true);
  assert.equal(r.needed_percent, 84); // 45 + 0.5·84 = 87
  assert.equal(r.best_possible, 95);
  assert.equal(r.worst_possible, 45);
});

check("target: unreachable, and already secured", () => {
  const a = item(100, 50);
  const b = item(100, null);
  const gs = [group([a, b])];
  const no = solveTarget(gs, false, 80, new Set([b.id]), finalView);
  assert.equal(no.reachable, false);
  assert.equal(no.needed_percent, undefined);
  assert.equal(no.best_possible, 75);
  const yes = solveTarget(gs, false, 20, new Set([b.id]), finalView);
  assert.equal(yes.already_secured, true);
});

check("target: drop_lowest lets a zero on remaining work be dropped", () => {
  const gs = [group([item(10, 9), item(10, 9), item(10, null)], { drop_lowest: 1 })];
  const remaining = new Set([gs[0].items[2].id]);
  assert.equal(solveTarget(gs, false, 90, remaining, finalView).already_secured, true);
  const r = solveTarget(gs, false, 92, remaining, finalView);
  assert.equal(r.needed_percent, 94); // drops a 9: (9 + x·10) / 20 ≥ 0.92 → x ≥ 0.94
});

console.log(`\n${passed} unit checks passed${failed ? `, ${failed} failed` : ""}`);
if (failed) process.exitCode = 1;
