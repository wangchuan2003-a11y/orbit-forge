/** A dimensionless, softened Newtonian point-mass model; no collision response. */
export const G = 1;
export const EPSILON = 0.06;
export const DT = 0.002;
export const MAX_BODIES = 8;
export type Body = {
  id: number;
  mass: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};
export type State = { bodies: Body[]; ticks: number };
export type Preset = "planet" | "binary" | "three";

export function clone(state: State): State {
  return {
    bodies: state.bodies.map((body) => ({ ...body })),
    ticks: state.ticks,
  };
}

export function validate(state: State): void {
  if (
    !state ||
    !Array.isArray(state.bodies) ||
    state.bodies.length < 1 ||
    state.bodies.length > MAX_BODIES ||
    !Number.isInteger(state.ticks) ||
    state.ticks < 0 ||
    state.ticks > 1e9
  )
    throw new TypeError("Invalid state.");
  const ids = new Set<number>();
  for (const body of state.bodies) {
    if (
      !body ||
      !Number.isInteger(body.id) ||
      body.id < 0 ||
      body.id > 10000 ||
      ids.has(body.id) ||
      !Number.isFinite(body.mass) ||
      body.mass < 0.001 ||
      body.mass > 100 ||
      !Number.isFinite(body.x) ||
      !Number.isFinite(body.y) ||
      Math.abs(body.x) > 1e6 ||
      Math.abs(body.y) > 1e6 ||
      !Number.isFinite(body.vx) ||
      !Number.isFinite(body.vy) ||
      Math.abs(body.vx) > 1e4 ||
      Math.abs(body.vy) > 1e4
    ) {
      throw new TypeError("Invalid body.");
    }
    ids.add(body.id);
  }
}

/** Pairwise updates ensure equal and opposite forces, including unequal masses. */
export function accelerations(bodies: Body[]): { x: number; y: number }[] {
  const result = bodies.map(() => ({ x: 0, y: 0 }));
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const dx = bodies[j].x - bodies[i].x;
      const dy = bodies[j].y - bodies[i].y;
      const factor = G / Math.pow(dx * dx + dy * dy + EPSILON * EPSILON, 1.5);
      result[i].x += factor * bodies[j].mass * dx;
      result[i].y += factor * bodies[j].mass * dy;
      result[j].x -= factor * bodies[i].mass * dx;
      result[j].y -= factor * bodies[i].mass * dy;
    }
  }
  return result;
}

/** Velocity Verlet; advancing N steps is independent of render-frame grouping. */
export function advance(initial: State, count = 1): State {
  if (!Number.isInteger(count) || count < 0 || count > 100_000)
    throw new RangeError("Invalid step count.");
  validate(initial);
  const state = clone(initial);
  let acceleration = accelerations(state.bodies);
  for (let step = 0; step < count; step++) {
    for (let i = 0; i < state.bodies.length; i++) {
      const body = state.bodies[i];
      body.x += body.vx * DT + (acceleration[i].x * DT * DT) / 2;
      body.y += body.vy * DT + (acceleration[i].y * DT * DT) / 2;
      body.vx += (acceleration[i].x * DT) / 2;
      body.vy += (acceleration[i].y * DT) / 2;
    }
    acceleration = accelerations(state.bodies);
    for (let i = 0; i < state.bodies.length; i++) {
      state.bodies[i].vx += (acceleration[i].x * DT) / 2;
      state.bodies[i].vy += (acceleration[i].y * DT) / 2;
    }
    state.ticks++;
  }
  validate(state);
  return state;
}

export function diagnostics(state: State) {
  let kinetic = 0,
    potential = 0,
    mass = 0,
    px = 0,
    py = 0,
    cx = 0,
    cy = 0;
  for (const body of state.bodies) {
    kinetic += 0.5 * body.mass * (body.vx * body.vx + body.vy * body.vy);
    mass += body.mass;
    px += body.mass * body.vx;
    py += body.mass * body.vy;
    cx += body.mass * body.x;
    cy += body.mass * body.y;
  }
  for (let i = 0; i < state.bodies.length; i++) {
    for (let j = i + 1; j < state.bodies.length; j++) {
      const a = state.bodies[i],
        b = state.bodies[j];
      potential -=
        (G * a.mass * b.mass) /
        Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + EPSILON ** 2);
    }
  }
  return {
    kinetic,
    potential,
    total: kinetic + potential,
    mass,
    momentum: { x: px, y: py },
    center: { x: cx / mass, y: cy / mass },
  };
}

export function relativeEnergyDrift(
  state: State,
  initialEnergy: number,
): number | null {
  if (!Number.isFinite(initialEnergy) || Math.abs(initialEnergy) < 1e-12)
    return null;
  return (diagnostics(state).total - initialEnergy) / Math.abs(initialEnergy);
}

export function createPreset(name: Preset): State {
  if (name === "planet" || name === "binary") {
    const a = name === "planet" ? 10 : 3;
    const b = name === "planet" ? 0.08 : 2;
    const radius = name === "planet" ? 2 : 3;
    const total = a + b;
    const speed = Math.sqrt(
      (G * total * radius * radius) /
        Math.pow(radius * radius + EPSILON * EPSILON, 1.5),
    );
    return {
      ticks: 0,
      bodies: [
        {
          id: 0,
          mass: a,
          x: (-b / total) * radius,
          y: 0,
          vx: 0,
          vy: (-b / total) * speed,
        },
        {
          id: 1,
          mass: b,
          x: (a / total) * radius,
          y: 0,
          vx: 0,
          vy: (a / total) * speed,
        },
      ],
    };
  }
  if (name !== "three") throw new TypeError("Unknown preset.");
  const bodies: Body[] = [
    { id: 0, mass: 5, x: 0, y: 0, vx: 0, vy: 0 },
    { id: 1, mass: 0.5, x: 2, y: 0, vx: 0, vy: 1.5 },
    { id: 2, mass: 0.3, x: -2.6, y: 0.8, vx: -0.3, vy: -1.1 },
  ];
  const d = diagnostics({ bodies, ticks: 0 });
  for (const body of bodies) {
    body.x -= d.center.x;
    body.y -= d.center.y;
    body.vx -= d.momentum.x / d.mass;
    body.vy -= d.momentum.y / d.mass;
  }
  return { bodies, ticks: 0 };
}

/** A shared snapshot starts a new energy baseline at its saved positions/velocities. */
export function encodeState(state: State): string {
  validate(state);
  const payload = JSON.stringify({
    v: 1,
    t: state.ticks,
    b: state.bodies.map(({ id, mass, x, y, vx, vy }) => [
      id,
      mass,
      x,
      y,
      vx,
      vy,
    ]),
  });
  return (
    "#v1." +
    btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}

export function decodeState(hash: string): State | null {
  if (
    typeof hash !== "string" ||
    hash.length > 12_000 ||
    !/^#v1\.[A-Za-z0-9_-]+$/.test(hash)
  )
    return null;
  try {
    const encoded = hash.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    const value = JSON.parse(
      atob(encoded + "=".repeat((4 - (encoded.length % 4)) % 4)),
    );
    if (
      !value ||
      value.v !== 1 ||
      !Array.isArray(value.b) ||
      !value.b.every((row: unknown) => Array.isArray(row) && row.length === 6)
    )
      return null;
    const state: State = {
      ticks: value.t,
      bodies: value.b.map(([id, mass, x, y, vx, vy]: number[]) => ({
        id,
        mass,
        x,
        y,
        vx,
        vy,
      })),
    };
    validate(state);
    return encodeState(state) === hash ? state : null;
  } catch {
    return null;
  }
}
