import test from "node:test";
import assert from "node:assert/strict";
import {
  accelerations,
  advance,
  clone,
  createPreset,
  decodeState,
  diagnostics,
  DT,
  encodeState,
  EPSILON,
  relativeEnergyDrift,
  validate,
} from "../.test-build/physics.js";

const near = (actual, expected, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} differs from ${expected} by more than ${tolerance}`,
  );
test("unequal masses receive equal and opposite forces", () => {
  const state = {
    ticks: 0,
    bodies: [
      { id: 0, mass: 2, x: -1, y: 0.5, vx: 0, vy: 0 },
      { id: 1, mass: 5, x: 2, y: -0.5, vx: 0, vy: 0 },
    ],
  };
  const [a, b] = accelerations(state.bodies);
  near(2 * a.x + 5 * b.x, 0);
  near(2 * a.y + 5 * b.y, 0);
  assert.ok(a.x > 0 && b.x < 0);
  near(a.x, (5 * 3) / Math.pow(10 + EPSILON ** 2, 1.5));
});

test("the force matches the gradient of the same softened potential", () => {
  const initial = createPreset("binary");
  initial.bodies[1].x = initial.bodies[0].x + 0.03;
  initial.bodies[1].y = 0.04;
  const h = 1e-6,
    plus = clone(initial),
    minus = clone(initial);
  plus.bodies[0].x += h;
  minus.bodies[0].x -= h;
  const derivative =
    (diagnostics(plus).potential - diagnostics(minus).potential) / (2 * h);
  const force = initial.bodies[0].mass * accelerations(initial.bodies)[0].x;
  near(-derivative, force, 1e-5);
});

test("a stable softened circular orbit keeps its radius and bounded energy error", () => {
  const initial = createPreset("planet"),
    energy = diagnostics(initial).total;
  let state = initial,
    worstEnergy = 0,
    worstRadius = 0;
  for (let block = 0; block < 80; block++) {
    state = advance(state, 250);
    const [a, b] = state.bodies;
    worstRadius = Math.max(
      worstRadius,
      Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - 2),
    );
    worstEnergy = Math.max(
      worstEnergy,
      Math.abs(relativeEnergyDrift(state, energy)),
    );
  }
  assert.ok(worstRadius < 2e-5, `radius deviation ${worstRadius}`);
  assert.ok(worstEnergy < 1e-6, `relative energy drift ${worstEnergy}`);
  assert.equal(state.ticks, 20_000);
});

test("an isolated three-body system conserves momentum and follows its center of mass", () => {
  const initial = createPreset("three");
  for (const body of initial.bodies) {
    body.vx += 0.2;
    body.vy -= 0.1;
  }
  const before = diagnostics(initial),
    final = advance(initial, 10_000),
    after = diagnostics(final);
  near(after.momentum.x, before.momentum.x, 1e-10);
  near(after.momentum.y, before.momentum.y, 1e-10);
  near(after.center.x, before.center.x + 0.2 * 10_000 * DT, 1e-10);
  near(after.center.y, before.center.y - 0.1 * 10_000 * DT, 1e-10);
});

test("fixed-step results do not depend on how render frames group steps", () => {
  const initial = createPreset("three");
  const allAtOnce = advance(initial, 2000);
  let grouped = advance(initial, 17);
  for (let i = 0; i < 99; i++) grouped = advance(grouped, 20);
  grouped = advance(grouped, 3);
  assert.deepEqual(grouped, allAtOnce);
  assert.deepEqual(initial, createPreset("three"));
});

test("Velocity Verlet is time-reversible to floating-point tolerance", () => {
  const initial = createPreset("binary");
  const turned = advance(initial, 3000);
  for (const body of turned.bodies) {
    body.vx *= -1;
    body.vy *= -1;
  }
  const back = advance(turned, 3000);
  back.bodies.forEach((body, i) => {
    near(body.x, initial.bodies[i].x, 1e-10);
    near(body.y, initial.bodies[i].y, 1e-10);
    near(body.vx, -initial.bodies[i].vx, 1e-10);
    near(body.vy, -initial.bodies[i].vy, 1e-10);
  });
});

test("coincident bodies remain finite and do not merge", () => {
  const state = createPreset("binary");
  for (const body of state.bodies) {
    body.x = 0;
    body.y = 0;
    body.vx = 0;
    body.vy = 0;
  }
  const result = advance(state, 100);
  assert.equal(result.bodies.length, 2);
  assert.ok(Number.isFinite(diagnostics(result).potential));
  near(diagnostics(result).potential, (-3 * 2) / EPSILON);
  assert.deepEqual(result.bodies, state.bodies);
});

test("zero energy gives no misleading relative drift percentage", () => {
  const state = {
    ticks: 0,
    bodies: [{ id: 0, mass: 1, x: 0, y: 0, vx: 0, vy: 0 }],
  };
  assert.equal(relativeEnergyDrift(state, 0), null);
  assert.equal(relativeEnergyDrift(state, 1e-14), null);
  assert.equal(relativeEnergyDrift(state, NaN), null);
});

test("snapshots round-trip precise phase-space state and replay deterministically", () => {
  for (const preset of ["planet", "binary", "three"]) {
    const state = advance(createPreset(preset), 789);
    const restored = decodeState(encodeState(state));
    assert.deepEqual(restored, state);
    assert.deepEqual(advance(restored, 321), advance(state, 321));
    near(relativeEnergyDrift(restored, diagnostics(restored).total), 0);
  }
});

test("invalid snapshots and out-of-range bodies are rejected without throwing on decode", () => {
  const good = createPreset("planet");
  for (const hash of [
    "",
    "#model",
    "#v1.broken",
    "#v2.e30",
    "#v1." + "a".repeat(12001),
    null,
  ])
    assert.equal(decodeState(hash), null);
  const pack = (value) =>
    "#v1." +
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const base = { v: 1, t: 0, b: [[0, 1, 0, 0, 0, 0]] };
  for (const value of [
    null,
    [],
    { ...base, v: 2 },
    { ...base, extra: true },
    { ...base, t: -1 },
    { ...base, b: [] },
    { ...base, b: Array.from({ length: 9 }, (_, id) => [id, 1, 0, 0, 0, 0]) },
    { ...base, b: [[0, 0, 0, 0, 0, 0]] },
    { ...base, b: [[0, 1, 0, 0, null, 0]] },
    {
      ...base,
      b: [
        [0, 1, 0, 0, 0, 0],
        [0, 1, 1, 1, 0, 0],
      ],
    },
    { ...base, b: [[0, 1, 1e9, 0, 0, 0]] },
    { ...base, b: [[0, 1, 0, 0, "2", 0]] },
  ])
    assert.equal(decodeState(pack(value)), null);
  assert.equal(decodeState(encodeState(good) + "="), null);
  for (const mass of [-1, 0, NaN, Infinity, 101])
    assert.throws(() =>
      validate({ ...good, bodies: [{ ...good.bodies[0], mass }] }),
    );
  assert.throws(() => advance(good, -1));
  assert.throws(() => advance(good, 1.5));
});
