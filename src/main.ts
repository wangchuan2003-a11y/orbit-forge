import "./style.css";
import {
  advance,
  clone,
  createPreset,
  decodeState,
  diagnostics,
  DT,
  encodeState,
  EPSILON,
  MAX_BODIES,
  relativeEnergyDrift,
  type Body,
  type Preset,
  type State,
} from "./physics";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("universe");
const context = canvas.getContext("2d")!;
const colors = [
  "#efc781",
  "#8bb9ff",
  "#a6d8bf",
  "#d8a1b9",
  "#b7a7ef",
  "#ebaa79",
  "#79c8d7",
  "#d5d2a8",
];
const captions: Record<Preset, string> = {
  planet: "行星与恒星都绕共同质心运动",
  binary: "没有固定的中心，两颗恒星相互牵引",
  three: "三个引力源，不承诺周期或长期稳定",
};
const shared = decodeState(location.hash);
let state = shared ?? createPreset("planet");
let resetState = clone(state);
let baseline = diagnostics(state).total;
let baselineCount = 0;
let preset: Preset | "custom" = shared ? "custom" : "planet";
let resetPreset: Preset | "custom" = preset;
let running =
  !shared && !matchMedia("(prefers-reduced-motion: reduce)").matches;
let placing = false;
let width = 1,
  height = 1,
  dpr = 1,
  budget = 0;
let lastTime = performance.now(),
  lastRefresh = 0;
let trails = new Map<number, { x: number; y: number }[]>();
let drag: {
  pointer: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
} | null = null;
const form = $<HTMLFormElement>("body-form");
const view = () => Number($<HTMLSelectElement>("view").value);
const scale = () => Math.min(width, height) / (view() * 2);
const screen = (x: number, y: number) => ({
  x: width / 2 + x * scale(),
  y: height / 2 - y * scale(),
});
const color = (id: number) => colors[id % colors.length];
const format = (value: number) =>
  Math.abs(value) < 0.0000005
    ? "0.000000"
    : Math.abs(value) > 10000
      ? value.toExponential(4)
      : value.toFixed(6);
function report(message: string) {
  $("status").textContent = message;
}

function setPlacing(value: boolean) {
  placing = value && state.bodies.length < MAX_BODIES;
  drag = null;
  $("stage").classList.toggle("placing", placing);
  $("place-mode").setAttribute("aria-pressed", String(placing));
  $("place-mode").textContent = placing
    ? "放置模式已开启 · 点击此处取消"
    : "或在画布上拖出速度箭头 ↗";
  $("place-hint").textContent = placing
    ? "按下选位置，拖动设速度，松开加入。箭头每个坐标单位对应一个速度单位；Esc 取消。"
    : "添加会暂停运行，并以新状态重新建立能量基准。";
}

function controls() {
  $("run").textContent = running ? "暂停" : "开始运行";
  $("run-state").textContent = running ? "运行中" : "已暂停";
  document.body.classList.toggle("paused", !running);
  $("body-count").textContent = `${state.bodies.length} / ${MAX_BODIES}`;
  $<HTMLButtonElement>("add-body").disabled = state.bodies.length >= MAX_BODIES;
  $<HTMLButtonElement>("place-mode").disabled =
    state.bodies.length >= MAX_BODIES;
  document
    .querySelectorAll<HTMLButtonElement>("[data-preset]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.preset === preset),
      ),
    );
}

function refresh() {
  const d = diagnostics(state);
  $("sim-time").textContent = `t = ${(state.ticks * DT).toFixed(3)}`;
  $("ticks").textContent = String(state.ticks);
  $("kinetic").textContent = format(d.kinetic);
  $("potential").textContent = format(d.potential);
  $("energy").textContent = format(d.total);
  const drift = relativeEnergyDrift(state, baseline);
  $("drift").textContent =
    drift === null ? "基准接近零" : `${(drift * 100).toFixed(4)}%`;
  $("drift").classList.toggle(
    "warning",
    drift !== null && Math.abs(drift) > 0.01,
  );
  $("drift-note").textContent =
    drift === null
      ? `相对值无定义；绝对变化 ΔE = ${format(d.total - baseline)}`
      : Math.abs(drift) > 0.01
        ? "漂移超过 1%。近距离相遇可能放大固定步长误差。"
        : "(E − E₀) / |E₀|，用于观察数值误差";
  $("baseline-count").textContent = String(baselineCount);
  $("baseline-energy").textContent = format(baseline);
  $("momentum-x").textContent = format(d.momentum.x);
  $("momentum-y").textContent = format(d.momentum.y);
  $("center-x").textContent = format(d.center.x);
  $("center-y").textContent = format(d.center.y);
  $("body-data").replaceChildren(
    ...state.bodies.map((body) => {
      const row = document.createElement("tr");
      row.dataset.id = String(body.id);
      for (const value of [
        `${body.id + 1}`,
        body.mass.toFixed(3),
        format(body.x),
        format(body.y),
        format(body.vx),
        format(body.vy),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      const dot = document.createElement("span");
      dot.className = "body-dot";
      dot.style.background = color(body.id);
      row.firstElementChild!.prepend(dot);
      return row;
    }),
  );
  controls();
}

function rebase(next: State, message: string, replaceReset = false) {
  state = clone(next);
  if (replaceReset) {
    resetState = clone(state);
    resetPreset = preset;
  }
  baseline = diagnostics(state).total;
  baselineCount++;
  running = false;
  budget = 0;
  trails = new Map();
  setPlacing(false);
  refresh();
  draw();
  report(message);
}

function rememberTrail() {
  for (const body of state.bodies) {
    const points = trails.get(body.id) ?? [];
    points.push({ x: body.x, y: body.y });
    if (points.length > 1000) points.shift();
    trails.set(body.id, points);
  }
}

function integrate(steps: number) {
  try {
    state = advance(state, steps);
    rememberTrail();
  } catch {
    running = false;
    budget = 0;
    refresh();
    report("数值状态已超出本实验的有效范围，已暂停。请重置或换一个初始条件。");
  }
}

function toggleRun() {
  drag = null;
  setPlacing(false);
  running = !running;
  budget = 0;
  refresh();
  report(
    running
      ? "继续积分。播放速度只改变每秒步数，每步 Δt 始终为 0.002。"
      : "已暂停。可单步观察，或加入新的天体。",
  );
}

function step() {
  running = false;
  budget = 0;
  setPlacing(false);
  integrate(1);
  refresh();
  draw();
  report(
    `完成第 ${state.ticks} 个固定步，模拟时间 ${(state.ticks * DT).toFixed(3)}。`,
  );
}
$("run").onclick = toggleRun;
$("step").onclick = step;
$("reset").onclick = () => {
  preset = resetPreset;
  $("preset-caption").textContent =
    preset === "custom" ? "来自分享快照的初始条件" : captions[preset];
  rebase(resetState, "已回到本次实验的起始条件，能量基准已重建。");
};
document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach(
  (button) =>
    (button.onclick = () => {
      preset = button.dataset.preset as Preset;
      $("preset-caption").textContent = captions[preset];
      rebase(
        createPreset(preset),
        `已载入${button.textContent}。能量基准已重建；点击开始运行。`,
        true,
      );
    }),
);
$("place-mode").onclick = () => {
  running = false;
  budget = 0;
  setPlacing(!placing);
  refresh();
  draw();
};
$("view").onchange = () => draw();
$("trails").onchange = () => {
  trails.clear();
  draw();
};
$("speed").onchange = () => {
  budget = 0;
};

function addBody(x: number, y: number, vx: number, vy: number) {
  if (state.bodies.length >= MAX_BODIES) {
    report("最多支持 8 颗天体。可选择预设或重置本次实验。");
    return;
  }
  const mass = Number($<HTMLSelectElement>("mass").value);
  if (
    ![x, y, vx, vy, mass].every(Number.isFinite) ||
    Math.abs(x) > 20 ||
    Math.abs(y) > 20 ||
    Math.abs(vx) > 10 ||
    Math.abs(vy) > 10 ||
    mass < 0.001 ||
    mass > 100
  ) {
    report("请使用有效参数：位置 −20 到 20，速度分量 −10 到 10。");
    return;
  }
  const usedIds = new Set(state.bodies.map((item) => item.id));
  let id = 0;
  while (usedIds.has(id)) id++;
  const body: Body = {
    id,
    mass,
    x,
    y,
    vx,
    vy,
  };
  preset = "custom";
  $("preset-caption").textContent = "由你设定初始条件的引力系统";
  rebase(
    { bodies: [...state.bodies, body], ticks: 0 },
    `已加入第 ${state.bodies.length + 1} 颗天体。模拟时间归零，能量基准已重建。`,
  );
}
form.onsubmit = (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  addBody(
    ...(["new-x", "new-y", "new-vx", "new-vy"].map((id) =>
      Number($<HTMLInputElement>(id).value),
    ) as [number, number, number, number]),
  );
};

function world(event: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - width / 2) / scale(),
    y: -(event.clientY - rect.top - height / 2) / scale(),
  };
}
canvas.addEventListener("pointerdown", (event) => {
  if (!placing || event.button !== 0) return;
  event.preventDefault();
  const point = world(event);
  drag = { pointer: event.pointerId, ...point, vx: 0, vy: 0 };
  canvas.setPointerCapture(event.pointerId);
  canvas.focus({ preventScroll: true });
  draw();
});
canvas.addEventListener("pointermove", (event) => {
  if (!drag || drag.pointer !== event.pointerId) return;
  const point = world(event);
  drag.vx = Math.max(-10, Math.min(10, point.x - drag.x));
  drag.vy = Math.max(-10, Math.min(10, point.y - drag.y));
  draw();
});
canvas.addEventListener("pointerup", (event) => {
  if (!drag || drag.pointer !== event.pointerId) return;
  const { x, y, vx, vy } = drag;
  drag = null;
  for (const [id, value] of [
    ["new-x", x],
    ["new-y", y],
    ["new-vx", vx],
    ["new-vy", vy],
  ] as const)
    $<HTMLInputElement>(id).value = value.toFixed(3);
  addBody(x, y, vx, vy);
});
canvas.addEventListener("pointercancel", () => {
  drag = null;
  draw();
  report("已取消这次放置，系统未改变。");
});
window.addEventListener("blur", () => {
  if (drag) {
    drag = null;
    draw();
  }
});
window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (
    target.closest("input,select,textarea") ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  if (event.key === "Escape") {
    setPlacing(false);
    draw();
  }
  if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    step();
  }
  if (event.key === " " && target === canvas) {
    event.preventDefault();
    toggleRun();
  }
});

function draw() {
  const ctx = context;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#090f1a";
  ctx.fillRect(0, 0, width, height);
  const haze = ctx.createRadialGradient(
    width * 0.5,
    height * 0.47,
    0,
    width * 0.5,
    height * 0.47,
    height * 0.55,
  );
  haze.addColorStop(0, "#182132");
  haze.addColorStop(1, "#090f1a");
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 110; i++) {
    const x = (((i * 127.13 + 31) % 997) / 997) * width;
    const y = (((i * i * 17.3 + 73) % 991) / 991) * height;
    ctx.fillStyle = i % 6 ? "#687c9b50" : "#b5c4da90";
    ctx.beginPath();
    ctx.arc(x, y, i % 6 ? 0.6 : 1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#25304470";
  ctx.lineWidth = 0.7;
  const spacing = view() > 5 ? 2 : 1;
  const limitX = Math.ceil(width / scale() / 2);
  for (let x = -limitX; x <= limitX; x += spacing) {
    const p = screen(x, 0);
    ctx.beginPath();
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, height);
    ctx.stroke();
  }
  for (let y = -view(); y <= view(); y += spacing) {
    const p = screen(0, y);
    ctx.beginPath();
    ctx.moveTo(0, p.y);
    ctx.lineTo(width, p.y);
    ctx.stroke();
  }
  ctx.strokeStyle = "#566a8445";
  ctx.setLineDash([3, 6]);
  for (const radius of [1, 2, 3]) {
    const p = screen(0, 0);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * scale(), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if ($<HTMLInputElement>("trails").checked) {
    for (const [id, points] of trails) {
      if (points.length < 2) continue;
      ctx.strokeStyle = color(id) + "90";
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      points.forEach((point, index) => {
        const p = screen(point.x, point.y);
        if (index) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      ctx.stroke();
    }
  }
  const center = screen(
    diagnostics(state).center.x,
    diagnostics(state).center.y,
  );
  ctx.strokeStyle = "#d0dcef70";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(center.x - 5, center.y);
  ctx.lineTo(center.x + 5, center.y);
  ctx.moveTo(center.x, center.y - 5);
  ctx.lineTo(center.x, center.y + 5);
  ctx.stroke();
  for (const body of state.bodies) {
    const p = screen(body.x, body.y);
    const radius = 3.5 + Math.log1p(body.mass) * 4;
    const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 4);
    halo.addColorStop(0, color(body.id) + "65");
    halo.addColorStop(1, color(body.id) + "00");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color(body.id);
    ctx.shadowColor = color(body.id);
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color(body.id) + "cc";
    ctx.font = "10px Consolas, monospace";
    ctx.fillText(
      String(body.id + 1).padStart(2, "0"),
      p.x + radius + 6,
      p.y - radius - 3,
    );
  }
  if (drag) {
    const from = screen(drag.x, drag.y),
      to = screen(drag.x + drag.vx, drag.y + drag.vy);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.strokeStyle = "#f6d79c";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(
      to.x - 10 * Math.cos(angle - 0.45),
      to.y - 10 * Math.sin(angle - 0.45),
    );
    ctx.lineTo(to.x, to.y);
    ctx.lineTo(
      to.x - 10 * Math.cos(angle + 0.45),
      to.y - 10 * Math.sin(angle + 0.45),
    );
    ctx.stroke();
    ctx.fillStyle = "#f6d79c";
    ctx.beginPath();
    ctx.arc(from.x, from.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "11px Consolas, monospace";
    ctx.fillText(
      `v = ${Math.hypot(drag.vx, drag.vy).toFixed(2)}`,
      from.x + 10,
      from.y + 22,
    );
  }
}

new ResizeObserver(() => {
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  draw();
}).observe(canvas);

$("share").onclick = async () => {
  const url = new URL(location.href);
  url.hash = encodeState(state).slice(1);
  window.history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url.href);
    report(
      "当前快照链接已复制。包含质量、位置、速度与步数；打开后以此刻重建能量基准。",
    );
  } catch {
    report(
      "快照已写入地址栏，请复制浏览器地址分享。接收者会从此刻的条件开始。",
    );
  }
};
$("export-png").onclick = () => {
  const output = document.createElement("canvas");
  output.width = canvas.width;
  output.height = canvas.height + Math.round(76 * dpr);
  const ctx = output.getContext("2d")!;
  ctx.fillStyle = "#090f1a";
  ctx.fillRect(0, 0, output.width, output.height);
  ctx.drawImage(canvas, 0, 0);
  ctx.fillStyle = "#efc781";
  ctx.font = `${12 * dpr}px Consolas, monospace`;
  ctx.fillText(
    `ORBIT FORGE | t=${(state.ticks * DT).toFixed(3)} | bodies=${state.bodies.length}`,
    18 * dpr,
    canvas.height + 26 * dpr,
  );
  ctx.fillStyle = "#92a9c8";
  ctx.font = `${10 * dpr}px Consolas, monospace`;
  ctx.fillText(
    `G=1 | epsilon=${EPSILON} | dt=${DT} | dimensionless`,
    18 * dpr,
    canvas.height + 48 * dpr,
  );
  output.toBlob((blob) => {
    if (!blob) {
      report("图片生成失败，请重试。");
      return;
    }
    const link = document.createElement("a"),
      url = URL.createObjectURL(blob);
    link.href = url;
    link.download = "orbit-forge.png";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    report("当前画布已导出为 PNG，包含模型参数与模拟时间。");
  });
};
window.addEventListener("hashchange", () => {
  if (!location.hash || location.hash === "#model") return;
  const restored = decodeState(location.hash);
  if (restored) {
    preset = "custom";
    $("preset-caption").textContent = "来自分享快照的初始条件";
    rebase(restored, "已载入分享快照，并以此状态建立新的能量基准。", true);
  } else report("快照链接无效，当前系统保持不变。");
});
document.addEventListener("visibilitychange", () => {
  budget = 0;
  lastTime = performance.now();
});
function frame(now: number) {
  const elapsed = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (running && !document.hidden) {
    budget += (elapsed * Number($<HTMLSelectElement>("speed").value)) / DT;
    const steps = Math.min(200, Math.floor(budget));
    if (steps > 0) {
      budget = Math.min(200, budget - steps);
      integrate(steps);
    }
  }
  if (running && now - lastRefresh > 100) {
    refresh();
    lastRefresh = now;
  }
  if (running) draw();
  requestAnimationFrame(frame);
}
refresh();
if (shared) {
  $("preset-caption").textContent = "来自分享快照的初始条件";
  report("已载入分享快照。当前状态是新的能量基准，点击开始运行。");
} else if (location.hash && location.hash !== "#model")
  report("快照链接无效，已载入默认行星系统。");
requestAnimationFrame(frame);
