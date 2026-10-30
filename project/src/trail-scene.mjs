// ---------------------------------------------------------------------------
// 共享「场景模型」：buildTrailScene(props, frame) → 一个纯数据对象
//
// 为什么要这一层：这个动画有两个消费方 ——
//   ① Remotion 组件（出片）
//   ② trail-studio.html 调参台（浏览器内实时预览）
// 如果两边各自实现一遍绘制逻辑，迟早分叉成「调参台里对得上、出片却偏了」。
// 所以把**一切**（参数解析与钳制、时间→里程、相机、瓦片清单、轨迹路径、
// 剖面折线、游标位置、全部文案与颜色）都收敛到这个纯函数里，
// React 与 DOM 两边只做「把返回值塞进元素属性」这一件事。
//
// 纯函数、无副作用、不依赖 Remotion —— 因此也能在 Node 里跑单测。
// ---------------------------------------------------------------------------

import {
  cameraAt,
  tilesForCamera,
  tileScreenSize,
  sampleAt,
  smoothArray,
  profilePolyline,
  profileY,
  niceBounds,
  mercLengthFractions,
  mercFractionAtDistance,
  mercX,
  mercY,
  clamp,
  clamp01,
  EASING_FN,
} from "./trail-geo.mjs";

const safeColor = (c, fallback) =>
  typeof c === "string" && /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\)|hsla?\(.+\))$/.test(c) ? c : fallback;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** #RRGGBB 混色（路型色相强度 = 0 时退回轨迹主色，只看形状不看色） */
const mixHex = (a, b, t) => {
  const pa = /^#([0-9a-f]{6})$/i.exec(a ?? "");
  const pb = /^#([0-9a-f]{6})$/i.exec(b ?? "");
  if (!pa || !pb) return a;
  const f = clamp(t, 0, 1);
  const ca = parseInt(pa[1], 16);
  const cb = parseInt(pb[1], 16);
  const ch = (sh) => {
    const va = (ca >> sh) & 255;
    const vb = (cb >> sh) & 255;
    return Math.round(va + (vb - va) * f)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
};

const SANS = "'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif";
const MONO = "Consolas, 'SF Mono', Menlo, monospace";

/**
 * 读数字宽估算（只服务「读数别压住坐标轴标签 / 别顶出画布」这一件事）。
 * 读数形如 "724 m"：数字 0.56 em、空格 0.3 em、单位 m 0.85 em，再加渲染时的 letter-spacing 1px。
 * 宁可估宽一点 —— 估窄了会贴上去，估宽了只是多让几像素。
 */
const readoutHalfW = (text, fontSize) => {
  let w = 0;
  for (const ch of String(text)) w += /[0-9]/.test(ch) ? 0.56 : /[.\-]/.test(ch) ? 0.32 : ch === " " ? 0.32 : 0.85;
  return (w * fontSize + String(text).length * 1) / 2 + 10;
};


/** 轨迹墨卡托路径串（只与几何有关，缓存一次 —— 每帧重建 3100 点的串纯属浪费） */
let trackPathCache = null;
function trackPathOf(geo) {
  if (trackPathCache && trackPathCache.geo === geo) return trackPathCache.d;
  let d = "";
  for (let i = 0; i < geo.mx.length; i++) d += `${i ? "L" : "M"}${geo.mx[i].toFixed(9)} ${geo.my[i].toFixed(9)}`;
  trackPathCache = { geo, d };
  return d;
}

// ---------------------------------------------------------------------------
// 路型（路面类型）
//
// ★ 为什么不用「细线纹理」而是「有宽度的路面带」：
//   6px 的线上做 dash 纹理只能读出「虚实」，读不出「这是什么路」。
//   路面带把宽度、材质、色相三件事同时用上，1080p 一眼能分辨。
//
// ★ 材质**不是图片**，全部是确定性图元（圆/线），沿路径按弧长采样后输出：
//   ① 台阶横杠、胎印人字必须逐点算法向 —— pattern 平铺会随路径拐弯而歪。
//   ② 图元坐标在「用户坐标（墨卡托归一化）」里，尺寸统一乘 invK，
//      渲染方整组 scale(k) 后视觉尺寸正好等于设定的像素值。
// ---------------------------------------------------------------------------

/** 内置路型表。顺序即调参台下拉框顺序；wide = 相对带宽的倍率 */
export const ROAD_TYPES = [
  { key: "机耕路", wide: 1.15, casing: "#2E2116", base: "#A87E52", done: "#C9A170", decor: "tire" },
  { key: "土路", wide: 1.0, casing: "#3A2A1C", base: "#C7A87D", done: "#E0C69C", decor: "dirt" },
  { key: "步道台阶", wide: 0.95, casing: "#1F262E", base: "#7C8897", done: "#AEBAC9", decor: "steps" },
  { key: "陡坡山路", wide: 0.8, casing: "#4A1505", base: "#B23A10", done: "#E4693A", decor: "slope" },
  { key: "攀爬", wide: 0.62, casing: "#221A13", base: "#5A4A3B", done: "#8A7460", decor: "rock" },
  // 公路：沥青灰 + 两侧白边线 + 中央黄虚线。放在最后，不动已有 key 的顺序。
  { key: "公路", wide: 1.35, casing: "#15181C", base: "#3A4048", done: "#5B636D", decor: "asphalt" },
];
/** 「无」= 保持原来的单色线（不画路面带） */
export const ROAD_KEYS = ["无", ...ROAD_TYPES.map((t) => t.key)];
const ROAD_BY_KEY = new Map(ROAD_TYPES.map((t) => [t.key, t]));

/** 确定性伪随机（禁 Math.random：同一帧两次调用必须同值，否则出片与调参台对不上） */
const pseudo = (i, salt) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * 按里程切一段路径串。
 * 等距重采样下下标 i ↔ i×stepM，所以端点插值即可，中间顶点直接取。
 */
const sliceCache = new Map();
function pathSlice(geo, m0, m1) {
  const key = `${m0.toFixed(2)}|${m1.toFixed(2)}`;
  const hit = sliceCache.get(key);
  if (hit && hit.geo === geo) return hit.d;
  const a = sampleAt(geo, m0);
  const b = sampleAt(geo, m1);
  let d = `M${a.x.toFixed(9)} ${a.y.toFixed(9)}`;
  const i0 = Math.ceil(m0 / geo.stepM);
  const i1 = Math.floor(m1 / geo.stepM);
  for (let i = Math.max(1, i0); i <= i1 && i < geo.mx.length; i++) {
    d += `L${geo.mx[i].toFixed(9)} ${geo.my[i].toFixed(9)}`;
  }
  d += `L${b.x.toFixed(9)} ${b.y.toFixed(9)}`;
  if (sliceCache.size > 400) sliceCache.clear();
  sliceCache.set(key, { geo, d });
  return d;
}

/**
 * 解析「路型分段」→ 覆盖全里程的连续区间数组。
 *
 * 起止支持三种写法（混用）：
 *   数字         → 里程 km
 *   "起点"/"终点" → 0 / 总里程
 *   其他字符串    → 自定义途经点的「名称」，取其里程
 * 重叠按「后定义覆盖先定义」，最后合并相邻同类型。
 */
export function parseRoadCuts(raw, geo, waypoints) {
  let arr;
  try {
    arr = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const total = geo.totalM;
  const nameToM = new Map();
  for (const w of waypoints ?? []) if (w.name) nameToM.set(String(w.name), w.distM);

  const at = (v, fallback) => {
    if (v === null || v === undefined || v === "") return fallback;
    if (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v).trim())) {
      return clamp(Number(v) * 1000, 0, total); // km → m
    }
    const s = String(v).trim();
    if (s === "起点" || s === "开始") return 0;
    if (s === "终点" || s === "结束") return total;
    const m = nameToM.get(s);
    return m === undefined ? null : clamp(m, 0, total);
  };

  const defs = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const type = String(it["路型"] ?? it.type ?? "").trim();
    if (!ROAD_BY_KEY.has(type)) continue;
    const s = at(it["起"] ?? it.start, 0);
    const e = at(it["止"] ?? it.end, total);
    if (s === null || e === null) continue; // 名称不存在：跳过（调参台会标红提示）
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    if (hi - lo < 0.5) continue;
    defs.push({ s: lo, e: hi, t: type });
  }
  if (!defs.length) return [];

  let segs = [{ s: 0, e: total, t: "无" }];
  for (const d of defs) {
    const next = [];
    for (const g of segs) {
      if (g.e <= d.s + 1e-6 || g.s >= d.e - 1e-6) {
        next.push(g);
        continue;
      }
      if (g.s < d.s - 1e-6) next.push({ s: g.s, e: d.s, t: g.t });
      next.push({ s: Math.max(g.s, d.s), e: Math.min(g.e, d.e), t: d.t });
      if (g.e > d.e + 1e-6) next.push({ s: d.e, e: g.e, t: g.t });
    }
    segs = next;
  }
  segs.sort((a, b) => a.s - b.s);
  const merged = [];
  for (const g of segs) {
    const last = merged[merged.length - 1];
    if (last && last.t === g.t && Math.abs(last.e - g.s) < 0.01) last.e = g.e;
    else merged.push({ ...g });
  }
  return merged;
}

/**
 * 沿路径生成材质图元 —— **屏幕坐标、像素尺寸**。
 *
 * ★ 为什么不用用户坐标（墨卡托）：
 *   轨迹组的变换是 scale(k)，k 约 2×10⁷。若图元尺寸写成 1.8/k ≈ 8×10⁻⁸，
 *   已经踩到 float32 精度下限，浏览器实际画出来是 0 或抖动；stroke-width 尤其明显。
 *   所以这里把点直接投到屏幕（x*k+gx），尺寸用 px，渲染方放在**不缩放**的层里。
 *   与路径的 transform 是同一个仿射变换，所以位置严格重合。
 *
 * @param upToM 只生成里程 ≤ 这个值的图元（材质跟着生长出现）
 */
function decorOf(geo, m0, m1, kind, bandPx, k, gx, gy, density, upToM, maxCount = 260) {
  const out = [];
  if (!kind || bandPx <= 0) return out;
  const end = Math.min(m1, upToM);
  if (end <= m0) return out;

  const baseGap = { tire: 18, dirt: 13, steps: 15, slope: 14, rock: 38, asphalt: 9 }[kind] ?? 14;
  let gapPx = baseGap / Math.max(0.2, density);
  // 1px = (1/k) 用户单位 = mpu/k 米
  const mPerPx = geo.mpu / k;
  const lenPx = (end - m0) / Math.max(1e-6, mPerPx);
  gapPx = Math.max(gapPx, lenPx / maxCount);
  const gap = Math.max(mPerPx * 0.5, gapPx * mPerPx);

  const half = bandPx / 2;
  let n = 0;
  for (let m = m0; m <= end; m += gap) {
    const a = sampleAt(geo, Math.min(m, m1));
    const b = sampleAt(geo, Math.min(m + 1.5, m1));
    const px = a.x * k + gx;
    const py = a.y * k + gy;
    let tx = (b.x - a.x) * k;
    let ty = (b.y - a.y) * k;
    const L = Math.hypot(tx, ty);
    if (L > 1e-9) {
      tx /= L;
      ty /= L;
    } else {
      tx = 1;
      ty = 0;
    }
    const nx = -ty;
    const ny = tx;
    const i = n++;

    if (kind === "steps") {
      const h = half + 1.4;
      out.push({ t: "l", x1: px - nx * h, y1: py - ny * h, x2: px + nx * h, y2: py + ny * h, c: "#F2F7FF", w: 1.5 });
      out.push({
        t: "l",
        x1: px - nx * h + tx * 1.8,
        y1: py - ny * h + ty * 1.8,
        x2: px + nx * h + tx * 1.8,
        y2: py + ny * h + ty * 1.8,
        c: "#141A22",
        w: 1.5,
      });
    } else if (kind === "tire") {
      for (const side of [-1, 1]) {
        const off = side * bandPx * 0.24;
        const cx = px + nx * off;
        const cy = py + ny * off;
        const a2 = 4.2;
        const b2 = 3.0;
        out.push({ t: "l", x1: cx - nx * a2, y1: cy - ny * a2, x2: cx + tx * b2, y2: cy + ty * b2, c: "#2A1C10", w: 1.8 });
        out.push({ t: "l", x1: cx + nx * a2, y1: cy + ny * a2, x2: cx + tx * b2, y2: cy + ty * b2, c: "#2A1C10", w: 1.8 });
      }
    } else if (kind === "slope") {
      const h = half * 0.95;
      const dx = (tx + nx) * h * 0.55;
      const dy = (ty + ny) * h * 0.55;
      out.push({ t: "l", x1: px - dx, y1: py - dy, x2: px + dx, y2: py + dy, c: "#6B1604", w: 1.8 });
    } else if (kind === "dirt") {
      const off = (pseudo(i, 3) - 0.5) * bandPx * 0.72;
      out.push({
        t: "c",
        cx: px + nx * off,
        cy: py + ny * off,
        r: 1.2 + 1.7 * pseudo(i, 7),
        f: pseudo(i, 11) > 0.5 ? "#8A6749" : "#F0DDBF",
        o: 0.7 + 0.3 * pseudo(i, 13),
      });
    } else if (kind === "asphalt") {
      // 公路：两侧白色边线（连续短段）+ 中央黄色虚线（每 3 个采样点一段）
      const hw = bandPx * 0.42;
      const seg2 = 3.2;
      out.push({ t: "l", x1: px - nx * hw - tx * seg2, y1: py - ny * hw - ty * seg2, x2: px - nx * hw + tx * seg2, y2: py - ny * hw + ty * seg2, c: "#E9EEF5", w: 1.3 });
      out.push({ t: "l", x1: px + nx * hw - tx * seg2, y1: py + ny * hw - ty * seg2, x2: px + nx * hw + tx * seg2, y2: py + ny * hw + ty * seg2, c: "#E9EEF5", w: 1.3 });
      if (i % 3 === 0) {
        const d2 = 5.5;
        out.push({ t: "l", x1: px - tx * d2, y1: py - ty * d2, x2: px + tx * d2, y2: py + ty * d2, c: "#E8C24A", w: 1.6 });
      }
    } else if (kind === "rock") {
      const off = (pseudo(i, 5) - 0.5) * bandPx * 0.6;
      const cx = px + nx * off;
      const cy = py + ny * off;
      out.push({ t: "c", cx, cy, r: 1.9 + 1.2 * pseudo(i, 17), f: pseudo(i, 19) > 0.45 ? "#F0D3A2" : "#CFBBA1", o: 1 });
      const a2 = 2.6;
      out.push({ t: "l", x1: cx - nx * a2, y1: cy - ny * a2, x2: cx + nx * a2 * 0.7, y2: cy + ny * a2 * 0.7, c: "#2A1F16", w: 1.1 });
    }
  }
  return out;
}

/**
 * 段坡度角（度）。
 *
 * ★ 标「最陡 200 m 窗口」而不是整段平均：
 *   2.9 km 的环线累计爬升 119 m，整段平均只有 4° —— 平均坡度会把陡坡摊平，
 *   标出来全是「↗3°」，等于没标。取段内滑动窗口的最大坡度，才对应「这段有个陡坡」的体感。
 *   段长不足一个窗口时退化为整段平均。
 * @param mode "max" 取最陡窗口（标注用） | "avg" 整段平均（游标读数用）
 */
function slopeOf(geo, s, e, mode = "max") {
  const sm = clamp(s, 0, geo.totalM);
  const em = clamp(e, 0, geo.totalM);
  const dist = Math.max(1, em - sm);
  const at = (m) => geo.ele[Math.round(clamp(m, 0, geo.totalM) / geo.stepM)] ?? 0;
  const dEle = at(em) - at(sm);
  const avg = (Math.atan2(Math.abs(dEle), dist) * 180) / Math.PI;
  if (mode === "avg" || dist <= 220) return { deg: avg, up: dEle >= 0, dEle };

  const winM = Math.min(200, dist);
  let best = avg;
  let bestUp = dEle >= 0;
  for (let m = sm; m + winM <= em; m += 20) {
    const d = at(m + winM) - at(m);
    const deg = (Math.atan2(Math.abs(d), winM) * 180) / Math.PI;
    if (deg > best) {
      best = deg;
      bestUp = d >= 0;
    }
  }
  return { deg: best, up: bestUp, dEle };
}

/**
 * 在轨迹上找离给定墨卡托坐标最近的点的里程（导出：调参台拖标记时要用）
 *
 * ★ 必须**逐线段做投影**，不能只比「离哪个样本顶点最近」：
 *   等距样本间距 stepM（默认 10 m）时，顶点法的落位误差最大可达 stepM/2 = 5 m，
 *   表现为「拖到路口，标记却吸到 5 m 外的点上」，而且自检里会被误当成换算链写错。
 *   逐线段投影 + 用 geo.dist 真实里程插值后，往返误差 < 0.01 m。
 */
export function nearestDistOnTrack(geo, x, y) {
  const n = geo.mx.length;
  if (n === 0) return 0;
  if (n === 1) return 0;
  let bestD2 = Infinity;
  let bestDist = 0;
  for (let i = 0; i < n - 1; i++) {
    const ax = geo.mx[i];
    const ay = geo.my[i];
    const vx = geo.mx[i + 1] - ax;
    const vy = geo.my[i + 1] - ay;
    const L2 = vx * vx + vy * vy;
    // 线段投影参数 t（夹到 [0,1]），零长线段退化到端点
    let t = L2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + vx * t;
    const py = ay + vy * t;
    const d2 = (px - x) * (px - x) + (py - y) * (py - y);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestDist = geo.dist[i] + (geo.dist[i + 1] - geo.dist[i]) * t;
    }
  }
  return bestDist;
}

// ---------------------------------------------------------------------------
// 途经点「样式」体系
//
// ★ 核心设计：**标记形状在这里被算成纯数据图元**，两个渲染方（Remotion 的 React
//   组件、调参台的字符串拼 SVG）都只做「按 t 建元素」这一件事。
//   为什么不各自画：形状几何（菱形四个顶点、图钉的贝塞尔控制点、圆环粗细、
//   标签该偏多少）一旦写两遍必然分叉 —— 一边改了圆环粗细、另一边没跟上，
//   就变成「调参台好看、出片不一样」这类最难查的问题。
//   图元用**本地坐标**（原点 = 标记中心，单位 px），渲染方只需套一个 translate。
// ---------------------------------------------------------------------------

/** 标记形状白名单（顺序即调参台下拉框顺序） */
export const WP_SHAPES = ["圆点", "圆环", "菱形", "方块", "三角", "图钉", "十字", "无"];
/** 标签相对标记的位置 */
export const WP_LABEL_POS = ["上", "下", "左", "右", "无"];

/**
 * 生成标记图元。
 * @param {string} shape 形状名（白名单外的值按「圆点」处理）
 * @param {number} s 大小（px，语义 = 半径）
 * @param {string} color 颜色（CSS 颜色串）
 * @returns {{ext:number, shapes:Array}} ext = 标记在四个方向上的外沿半径，用于自动排布标签
 *
 * 图元类型（渲染方按 t 建对应 SVG 元素）：
 *   {t:"circle", cx, cy, r, fill?, stroke?, sw?, so?}
 *   {t:"path",   d, fill?, stroke?, sw?, so?}
 *   {t:"line",   x1, y1, x2, y2, stroke, sw?}
 *   sw = stroke-width，so = stroke-opacity
 */
export function markShapes(shape, s, color) {
  const sw = (f) => Math.max(1, s * f);
  switch (shape) {
    case "圆环":
      return {
        ext: s * 1.5,
        shapes: [
          { t: "circle", cx: 0, cy: 0, r: s * 1.25, fill: "none", stroke: color, sw: sw(0.45) },
          { t: "circle", cx: 0, cy: 0, r: s * 0.42, fill: color },
        ],
      };
    case "菱形":
      return {
        ext: s * 1.35,
        shapes: [{ t: "path", d: `M0 ${-s * 1.35}L${s * 1.35} 0L0 ${s * 1.35}L${-s * 1.35} 0Z`, fill: color }],
      };
    case "方块":
      return {
        ext: s,
        shapes: [{ t: "path", d: `M${-s} ${-s}H${s}V${s}H${-s}Z`, fill: color }],
      };
    case "三角":
      return {
        ext: s * 1.1,
        shapes: [{ t: "path", d: `M0 ${-s * 1.1}L${s} ${s * 0.75}L${-s} ${s * 0.75}Z`, fill: color }],
      };
    case "图钉":
      // 水滴形：上圆下尖，中心留一个深色小孔（和高德/谷歌的 POI 图标同构）
      return {
        ext: s * 1.6,
        shapes: [
          {
            t: "path",
            d:
              `M0 ${s * 1.6}` +
              `C${-s * 1.5} ${s * 0.15} ${-s * 1.15} ${-s * 1.5} 0 ${-s * 1.5}` +
              `C${s * 1.15} ${-s * 1.5} ${s * 1.5} ${s * 0.15} 0 ${s * 1.6}Z`,
            fill: color,
          },
          { t: "circle", cx: 0, cy: -s * 0.45, r: s * 0.4, fill: "rgba(6,12,20,0.85)" },
        ],
      };
    case "十字":
      return {
        ext: s,
        shapes: [
          { t: "line", x1: -s, y1: 0, x2: s, y2: 0, stroke: color, sw: sw(0.32) },
          { t: "line", x1: 0, y1: -s, x2: 0, y2: s, stroke: color, sw: sw(0.32) },
        ],
      };
    case "无":
      return { ext: 0, shapes: [] };
    case "圆点":
    default:
      return {
        ext: s * 2,
        shapes: [
          { t: "circle", cx: 0, cy: 0, r: s, fill: color },
          { t: "circle", cx: 0, cy: 0, r: s * 2, fill: "none", stroke: color, sw: sw(0.22), so: 0.5 },
        ],
      };
  }
}

/**
 * 组装一个标记（图元 + 标签），屏幕坐标系。
 * 标签位置与偏移也在这里算 —— 两个渲染方只读结果，不再各自推导。
 */
function buildMark({ key, name, x, y, opacity, distM, wpIndex, color, fontSize, size, shape, labelPos, labelGap, labelColor, halo }) {
  const { ext, shapes } = markShapes(shape, size, color);
  let label = null;
  if (labelPos !== "无" && name) {
    const gap = ext + labelGap;
    let dx = 0;
    let dy = 0;
    let anchor = "middle";
    if (labelPos === "上") dy = -gap;
    else if (labelPos === "下") dy = gap + fontSize * 0.78; // 基线 ≈ 文字底边，补偿一行的下沿
    else if (labelPos === "左") {
      dx = -gap;
      dy = fontSize * 0.36; // 垂直居中 ≈ 半个 x-height 的基线偏移
      anchor = "end";
    } else {
      dx = gap;
      dy = fontSize * 0.36;
      anchor = "start";
    }
    label = {
      text: name,
      x: x + dx,
      y: y + dy,
      anchor,
      fontSize,
      weight: 600,
      fill: labelColor || color,
      haloColor: halo.color,
      haloWidth: fontSize * halo.scale,
    };
  }
  return { key, name, x, y, opacity, distM, wpIndex, shapes, label, color, fontSize, size, shape, labelPos };
}

/**
 * 「自定义途经点」解析。
 *
 * 数据格式（JSON 字符串，存在参数 轨迹.自定义途经点 里）：
 *   [{"名称":"南天门","里程km":2.1},
 *    {"名称":"营地","经纬度":[113.05,34.48],"颜色":"#FF7043","形状":"图钉","字号":30},
 *    {"名称":"水源","里程":18400,"标签位置":"右","大小":8,"透明度":0.8,"显示":true}]
 *
 * ★ 定位方式二选一
 *   - 里程km（也接受 里程 / km）：直接按**累计里程**定位 —— 与剖面游标同一套里程，
 *     所以「在剖面上看到的位置」就是「地图上打点的位置」，不会错位。
 *   - 经纬度 [经度, 纬度]（也接受 lnglat）：投到墨卡托后**吸附到轨迹上最近的样本点**。
 *     用户从地图取点时很难正好点在线上，而途经点在语义上属于「路线上的位置」。
 * ★ 坐标一律由 sampleAt(geo, distM) 反查，而不是直接用用户给的坐标 ——
 *   保证标签必然落在轨迹上，与地图头部/剖面游标共用同一套里程坐标。
 * ★ 样式字段**每一个都是可选的**：缺省即「跟随全局默认」（null 表示「没设」，
 *   而不是「设成了假值」—— 否则单点想回到全局默认就做不到）。
 *   白名单外的值一律当作「没设」：手写 JSON 打错字不该让画面出现半边形状。
 */
const pick = (w, keys) => {
  for (const k of keys) if (w[k] !== undefined && w[k] !== null && w[k] !== "") return w[k];
  return undefined;
};
const pickNum = (w, keys, lo, hi) => {
  const v = Number(pick(w, keys));
  return Number.isFinite(v) ? clamp(v, lo, hi) : null;
};

function parseWaypoints(raw, geo) {
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string" && raw.trim()) {
    try {
      arr = JSON.parse(raw);
    } catch {
      return []; // 手工编辑 JSON 打错字不能把整个合成打崩
    }
  } else return [];
  if (!Array.isArray(arr)) return [];

  const out = [];
  arr.forEach((w, idx) => {
    if (!w || typeof w !== "object") return;
    const name = String(w["名称"] ?? w.name ?? "").trim();
    if (!name) return;
    // 每个点的「显示」开关：关掉即彻底不参与（连标签都不占位）
    if (pick(w, ["显示", "visible"]) === false) return;
    let distM = null;
    let byLL = false;
    const ll = w["经纬度"] ?? w.lnglat;
    if (Array.isArray(ll) && ll.length >= 2) {
      const lng = Number(ll[0]);
      const lat = Number(ll[1]);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        distM = nearestDistOnTrack(geo, mercX(lng), mercY(lat));
        byLL = true;
      }
    }
    if (distM === null) {
      const km = Number(w["里程km"] ?? w["里程"] ?? w.km);
      if (Number.isFinite(km)) distM = clamp(km * 1000, 0, geo.totalM);
    }
    if (distM === null) return;
    const p = sampleAt(geo, distM);

    const shapeRaw = pick(w, ["形状", "shape"]);
    const posRaw = pick(w, ["标签位置", "标签", "labelPos"]);
    out.push({
      key: `w${idx}`,
      // ★ wpIndex = **原始数组下标**（未被跳过时即等于调参台里的行号）——
      //   解析会跳过「无效 / 显示=false」的条目，所以不能用「输出序号」当行号，
      //   否则画布上拖 A 点会改到 B 点。调参台靠它把屏幕上的标记映射回列表行。
      wpIndex: idx,
      name,
      distM,
      byLL, // 调参台拖动时据此决定回写 里程km 还是 经纬度
      x: p.x,
      y: p.y,
      // —— 样式（null = 跟随全局默认）——
      color: safeColor(pick(w, ["颜色", "color"]), null),
      labelColor: safeColor(pick(w, ["标签颜色", "文字颜色"]), null),
      shape: WP_SHAPES.includes(shapeRaw) ? shapeRaw : null,
      size: pickNum(w, ["大小", "标记大小", "size"], 1, 60),
      fontSize: pickNum(w, ["字号", "文字大小", "fontSize"], 6, 200),
      labelPos: WP_LABEL_POS.includes(posRaw) ? posRaw : null,
      labelGap: pickNum(w, ["标签偏移", "标签距离", "gap"], 0, 200),
      alpha: pickNum(w, ["透明度", "opacity"], 0, 1),
    });
  });
  return out;
}

/** 带缓存的入口：调参台每帧都会问一次，而解析（尤其经纬度吸附）是 O(样本数) 的 */
let wpCache = { raw: null, geo: null, list: null };
function waypointsOf(raw, geo) {
  if (wpCache.raw === raw && wpCache.geo === geo) return wpCache.list;
  const list = parseWaypoints(raw, geo);
  wpCache = { raw, geo, list };
  return list;
}

/**
 * @param {any} geo   makeGeo(src/trail-profile-data.json) 的结果
 * @param {any} D     src/trail-profile-defaults.json
 * @param {any} props 用户参数（可只给部分分组）
 * @param {number} frame 当前帧
 * @param {{width:number,height:number,fps:number}} cfg
 */
export function buildTrailScene(geo, D, props, frame, cfg) {
  const { width, height, fps } = cfg;
  const P = props ?? {};

  // ---------- ① 参数解析：默认值 JSON 打底 + props 覆盖 ----------
  // ⚠ 必须按分组深合并。CLI --props 与 defaultProps 是浅合并，只传 {"海拔剖面":{"游标位置":0.5}}
  //   会把整组替换掉；直接读 props 就会拿到 undefined → NaN → 钳制后变成诡异的值。
  const M = { ...D["地图"], ...(P["地图"] ?? {}) };
  const T = { ...D["轨迹"], ...(P["轨迹"] ?? {}) };
  const C = { ...D["海拔剖面"], ...(P["海拔剖面"] ?? {}) };
  const U = { ...D["剖面游标"], ...(P["剖面游标"] ?? {}) };
  const X = { ...D["坐标轴"], ...(P["坐标轴"] ?? {}) };
  const A = { ...D["动画节奏"], ...(P["动画节奏"] ?? {}) };
  const W = { ...D["文字标题"], ...(P["文字标题"] ?? {}) };
  const H = { ...D["数据读数"], ...(P["数据读数"] ?? {}) };

  // ★ 本合成是**平面全景**：整条轨迹一屏静止展示，没有镜头滑动/跟随。
  //   因此「镜头模式 / 视野宽度 / 前瞻距离 / 头部安全边距 / 地图底边延伸」这些
  //   服务于镜头跟随的参数已全部移除（参数表、schema、默认值三处同步删）。
  //   动画的唯一动态 = 轨迹按里程生长 + 剖面游标同步推进。
  const fitRatio = clamp(num(M["轨迹占比"], D["地图"]["轨迹占比"] ?? 0.9), 0.4, 1);
  const fitPosX = clamp(num(M["轨迹位置X"], D["地图"]["轨迹位置X"] ?? 0.5), 0, 1);
  const fitPosY = clamp(num(M["轨迹位置Y"], D["地图"]["轨迹位置Y"] ?? 0.5), 0, 1);
  // 底图默认关闭：平面展示不需要卫星影像，也就不必加载那几百张瓦片。
  const showBase = M["显示底图"] === true;
  const tileOpacity = clamp(num(M["底图不透明度"], D["地图"]["底图不透明度"] ?? 0.85), 0, 1);
  const tileDarken = clamp(num(M["底图暗化"], D["地图"]["底图暗化"] ?? 0.55), 0, 1);
  const tileGray = clamp(num(M["底图去色"], D["地图"]["底图去色"] ?? 0.75), 0, 1);
  const tileBlur = clamp(num(M["底图模糊"], D["地图"]["底图模糊"] ?? 2), 0, 24);

  const trackW = clamp(num(T["线宽"], D["轨迹"]["线宽"]), 1, 30);
  const ghostOpacity = clamp(num(T["未走不透明度"], D["轨迹"]["未走不透明度"]), 0, 1);
  const glowMul = clamp(num(T["光晕倍数"], D["轨迹"]["光晕倍数"]), 1, 6);
  const headR = clamp(num(T["头部点半径"], D["轨迹"]["头部点半径"]), 0, 40);
  const markMode = T["标注显示"] === "全部" ? "全部" : T["标注显示"] === "精选" ? "精选" : "关闭";
  const markFont = clamp(num(T["标注字号"], D["轨迹"]["标注字号"]), 8, 48);
  // ★ 轨迹总开关（与「海拔剖面 · 显示」同一层级的总开关）
  //   关掉后：轨迹线（幽灵/已走/光晕）+ 头部光点 + 起终点 + 标注 + 自定义途经点
  //   一起隐藏 —— 因为这几样是同一层「地图叠加」，只关线条会留下一堆悬空标签。
  //   底图不受它管：那是「地图 · 显示底图」，可能是想留个卫星影像垫在下面。
  //   剖面、游标、标题、读数也都不受影响 —— 于是「只出海拔图」= 关轨迹 + 关底图。
  const showTrack = T["显示轨迹"] !== false;
  // 自定义途经点（用户自己加的）：与 KML 预置标注共用「里程」这套坐标，
  // 但颜色/字号独立，且可以只在走到之后出现。
  const showWaypoints = T["途经点显示"] !== false;
  const wpColor = safeColor(T["途经点颜色"], D["轨迹"]["途经点颜色"] ?? "#FFD54F");
  const wpFont = clamp(num(T["途经点字号"], D["轨迹"]["途经点字号"] ?? 24), 8, 48);
  const wpWalkToShow = T["走到后出现"] === true;
  // 途经点样式的**全局默认**（每个点都可以在数据里单独覆盖，见 parseWaypoints）：
  // 形状 / 大小 / 标签位置 / 标签偏移 / 透明度 —— 缺省时用这套。
  const wpShapeRaw = T["途经点形状"] ?? D["轨迹"]["途经点形状"];
  const wpShape = WP_SHAPES.includes(wpShapeRaw) ? wpShapeRaw : "圆点";
  const wpSize = clamp(num(T["途经点大小"], D["轨迹"]["途经点大小"] ?? 5.5), 1, 40);
  const wpPosRaw = T["途经点标签位置"] ?? D["轨迹"]["途经点标签位置"];
  const wpLabelPos = WP_LABEL_POS.includes(wpPosRaw) ? wpPosRaw : "上";
  const wpLabelGap = clamp(num(T["途经点标签偏移"], D["轨迹"]["途经点标签偏移"] ?? 6), 0, 200);
  const wpAlpha = clamp(num(T["途经点透明度"], D["轨迹"]["途经点透明度"] ?? 1), 0, 1);
  const MARK_HALO = { color: "rgba(0,0,0,0.7)", scale: 0.22 };

  const profMode = C["剖面模式"] === "跟随窗口" ? "跟随窗口" : "整条显示";
  const showProfile = C["显示"] !== false;
  const profBottomGap = clamp(num(C["离底距离"], D["海拔剖面"]["离底距离"]), 0, 700);
  const profH = clamp(num(C["高度"], D["海拔剖面"]["高度"]), 80, 720);
  const padLeft = clamp(num(C["左留白"], D["海拔剖面"]["左留白"]), 0, 600);
  const padRight = clamp(num(C["右留白"], D["海拔剖面"]["右留白"]), 0, 600);
  const profW = clamp(num(C["线宽"], D["海拔剖面"]["线宽"]), 1, 20);
  const smoothWin = clamp(num(C["平滑窗口"], D["海拔剖面"]["平滑窗口"]), 1, 81);
  const windowM = clamp(
    num(C["显示里程窗口米"], D["海拔剖面"]["显示里程窗口米"]),
    500,
    Math.max(500, geo.totalM)
  );
  const cursorPos = clamp(num(C["游标位置"], D["海拔剖面"]["游标位置"]), 0.05, 0.95);
  const areaAlpha = clamp(num(C["填充不透明度"], D["海拔剖面"]["填充不透明度"]), 0, 1);
  const profGhost = clamp(num(C["未走不透明度"], D["海拔剖面"]["未走不透明度"]), 0, 1);
  const panelAlpha = clamp(num(C["内衬不透明度"], D["海拔剖面"]["内衬不透明度"]), 0, 1);

  const cursorW = clamp(num(U["线宽"], D["剖面游标"]["线宽"]), 1, 12);
  const cursorR = clamp(num(U["点半径"], D["剖面游标"]["点半径"]), 0, 24);
  const readSize = clamp(num(U["读数字号"], D["剖面游标"]["读数字号"]), 16, 140);
  const readLift = clamp(num(U["读数上移"], D["剖面游标"]["读数上移"]), 0, 300);

  const axisFont = clamp(num(X["字号"], D["坐标轴"]["字号"]), 10, 72);
  const sec = clamp(num(A["时长秒"], D["动画节奏"]["时长秒"]), 3, 180);
  const fadeFrames = clamp(num(A["开场淡入帧"], D["动画节奏"]["开场淡入帧"]), 0, 90);
  const titleSize = clamp(num(W["字号"], D["文字标题"]["字号"]), 16, 120);
  const hudFont = clamp(num(H["字号"], D["数据读数"]["字号"]), 12, 80);

  const pathColor = safeColor(T["轨迹颜色"], D["轨迹"]["轨迹颜色"]);
  const doneColor = safeColor(T["已走颜色"], D["轨迹"]["已走颜色"]);
  const markColor = safeColor(T["标注颜色"], D["轨迹"]["标注颜色"]);
  const profColor = safeColor(C["线颜色"], D["海拔剖面"]["线颜色"]);
  const cursorColor = safeColor(U["线颜色"], D["剖面游标"]["线颜色"]);
  const readColor = safeColor(U["读数颜色"], D["剖面游标"]["读数颜色"]);
  const axisColor = safeColor(X["颜色"], D["坐标轴"]["颜色"]);
  const titleColor = safeColor(W["颜色"], D["文字标题"]["颜色"]);
  const hudColor = safeColor(H["颜色"], D["数据读数"]["颜色"]);
  // ★ 透明背景：给剪辑软件（剪映等）叠加用。必须在 safeColor 之前短路，
  //   否则 "transparent" 会被判成非法颜色回落成不透明底色。
  const bgColor = M["透明背景"] ? "transparent" : safeColor(M["背景色"], D["地图"]["背景色"]);

  // ---------- 路型参数 ----------
  const R = { ...(D["路型"] ?? {}), ...(P["路型"] ?? {}) };
  const showRoad = R["显示路型"] !== false;
  const roadMul = clamp(num(R["路型带宽倍数"], 2), 1, 6);
  const roadDensity = clamp(num(R["纹理密度"], 1), 0.2, 3);
  // 色相强度：0 = 全部用轨迹主色（只靠宽度和材质区分），1 = 满色
  const roadHue = clamp(num(R["路型色相强度"], 0.85), 0, 1);
  const showRoadBadge = R["段首徽标"] !== false;
  const badgeFont = clamp(num(R["徽标字号"], 17), 10, 40);
  const badgePosRaw = R["徽标位置"] ?? "自动";
  const badgePos = ["自动", "上", "下", "左", "右"].includes(badgePosRaw) ? badgePosRaw : "自动";
  const badgeGap = clamp(num(R["徽标偏移"], 0), -120, 200);
  const badgeColor = safeColor(R["徽标颜色"], "#FFFFFF");
  // 坡度：剖面标注 + 游标读数（阈值以下不标）
  const showSlopeMark = C["剖面坡度标注"] === true;
  const slopeMinDeg = clamp(num(C["坡度标注下限"], 15), 0, 60);
  const slopeFont = clamp(num(C["坡度标注字号"], 16), 10, 60);
  const slopeLift = clamp(num(C["坡度标注上移"], 26), -60, 300);
  const slopeColor = safeColor(C["坡度标注颜色"], "#FFFFFF");
  const showSlopeReadout = U["坡度读数"] === true;
  const slopeReadFont = clamp(num(U["坡度读数字号"], 14), 8, 60);
  const slopeReadLift = clamp(num(U["坡度读数上移"], 0), -40, 200);
  const slopeReadColor = safeColor(U["坡度读数颜色"], "#FFFFFF");

  // ---------- ② 唯一的驱动量：帧 → 里程 ----------
  const ease = EASING_FN[String(A["生长缓动"])] ?? EASING_FN["线性"];
  const growFrames = Math.max(1, Math.round(sec * fps));
  const progress = clamp01(ease(clamp01(frame / growFrames)));
  const distM = progress * geo.totalM;
  const finished = progress >= 0.9999;

  // 海拔平滑：对称滑动平均不产生相位偏移，峰谷位置不平移 → 一一对应仍成立
  const g = smoothWin > 1 ? { ...geo, ele: smoothArray(geo.ele, smoothWin) } : geo;

  // ---------- ③ 剖面几何（先算 —— 地图区要裁到它的上沿） ----------
  // ★ 两种剖面模式
  //   整条显示（默认）：曲线 x = plotLeft + (d/totalM)×plotW —— **与帧无关**，全程一屏铺满；
  //                     游标 x 随里程从左到右扫过，扫过处曲线由暗转亮。
  //                     配合平面全景 = 一页看完所有动画，不用等镜头、也不用拖时间轴。
  //   跟随窗口：曲线 x = 游标 x +（d − distM）×ppm（经典 HUD，窗口跟着游标滑动）。
  const wholeProfile = profMode === "整条显示";
  const plotLeft = padLeft;
  const plotW = Math.max(60, width - padLeft - padRight);
  const plotBottom = height - profBottomGap;
  const plotTop = plotBottom - profH;
  // 整条模式下 ppm 恒为 plotW/totalM，游标 x = plotLeft + distM×ppm；
  // 代入 profileX 恰好化为 plotLeft + d×ppm —— 于是「曲线静止、游标移动」。
  const cursorX = wholeProfile
    ? plotLeft + clamp01(distM / Math.max(1, geo.totalM)) * plotW
    : plotLeft + cursorPos * plotW;
  const mapH = Math.max(160, showProfile ? plotTop : height);

  const bounds = niceBounds(geo.stats.minEle, geo.stats.maxEle, 100);
  const eleLo = X["下限模式"] === "固定" ? clamp(num(X["固定下限"], 0), 0, 4000) : bounds.lo;
  const eleHi = X["上限模式"] === "固定"
    ? Math.max(eleLo + 50, clamp(num(X["固定上限"], 1500), 100, 6000))
    : Math.max(eleLo + 50, bounds.hi);

  // ---------- ④ 相机（地图与剖面共用同一个 distM） ----------
  // ★ 相机与帧无关：全景适配只取决于「画布尺寸 + 占比/位置」，
  //   所以整段动画里 (cx, cy, k) 恒定 —— 这正是「去掉地图滑动」的实现方式。
  const cam = cameraAt(g, 0, {
    screenW: width,
    screenH: mapH,
    mode: "全景展开",
    fit: { widthRatio: fitRatio, posX: fitPosX, posY: fitPosY },
  });

  const headPt = sampleAt(g, distM); // ← 地图头部 / 剖面游标 / 海拔读数 三者的共同来源
  const headScr = cam.toScreen(headPt.x, headPt.y);

  // ---------- ⑤ 底图瓦片（默认不取：平面展示不需要卫星影像） ----------
  const tileZ = 15;
  const tileSize = showBase ? tileScreenSize(cam, tileZ) : 0;
  const tiles = showBase
    ? tilesForCamera(cam, tileZ).map((t) => {
        const s = cam.toScreen(t.x / Math.pow(2, t.z), t.y / Math.pow(2, t.z));
        return {
          key: `${t.z}/${t.x}/${t.y}`,
          src: `trail-tiles/sat/${t.z}/${t.x}/${t.y}.jpg`,
          x: s.sx,
          y: s.sy,
          w: tileSize + 1,
          h: tileSize + 1,
        };
      })
    : [];

  // ---------- ⑥ 轨迹 ----------
  const k = cam.k;
  const invK = 1 / k;
  // 轨迹组的世界→屏幕平移量（材质图元用屏幕坐标，必须与这个变换严格一致）
  const gxMap = width / 2 - cam.cx * k;
  const gyMap = mapH / 2 - cam.cy * k;
  const mercNorm = mercLengthFractions(geo);
  const drawnFrac = mercFractionAtDistance(geo, mercNorm, distM);

  // 标注与自定义途经点合并成一份列表。
  // 两者都挂在「里程」这个统一坐标上，所以地图上的点位与剖面游标同源、不会错位。
  const inView = (sx, sy) => sx > -160 && sx < width + 160 && sy > -80 && sy < mapH + 80;
  const marks = [];

  if (showTrack && markMode !== "关闭") {
    for (const m of geo.marks) {
      if (markMode === "精选" && !m.highlight) continue;
      const s = cam.toScreen(m.x, m.y);
      // 走不到之前不出现 —— 强化「轨迹前进时标注依次出现」
      const pop = clamp01((distM - m.distM) / (geo.totalM * 0.006));
      if (pop <= 0.01 || !inView(s.sx, s.sy)) continue;
      marks.push(
        buildMark({
          key: `p:${m.name}`,
          name: m.name,
          x: s.sx,
          y: s.sy,
          opacity: pop,
          distM: m.distM,
          color: markColor,
          fontSize: markFont,
          size: 4.5,
          shape: "圆点",
          labelPos: "上",
          labelGap: 4,
          labelColor: null,
          halo: MARK_HALO,
        })
      );
    }
  }

  if (showTrack && showWaypoints) {
    for (const w of waypointsOf(T["自定义途经点"], geo)) {
      const s = cam.toScreen(w.x, w.y);
      const pop = wpWalkToShow ? clamp01((distM - w.distM) / (geo.totalM * 0.006)) : 1;
      if (pop <= 0.01 || !inView(s.sx, s.sy)) continue;
      marks.push(
        buildMark({
          key: `w:${w.key}`,
          name: w.name,
          x: s.sx,
          y: s.sy,
          // 逐点透明度 × 出现动画 —— 两个都生效（透明度只是把它调得更淡）
          opacity: pop * (w.alpha ?? wpAlpha),
          distM: w.distM,
          wpIndex: w.wpIndex,
          color: w.color || wpColor,
          fontSize: w.fontSize ?? wpFont,
          size: w.size ?? wpSize,
          shape: w.shape ?? wpShape,
          labelPos: w.labelPos ?? wpLabelPos,
          labelGap: w.labelGap ?? wpLabelGap,
          labelColor: w.labelColor,
          halo: MARK_HALO,
        })
      );
    }
  }

  // ---------- ⑥b 路型分段：按里程切路径 + 生成材质图元 ----------
  // ★ 只有在「路型分段」解析出实际区间时才接管轨迹绘制；
  //   否则 road = null，渲染方走原来的单条 trackPath（保证关掉后逐像素一致）。
  let road = null;
  if (showRoad) {
    const wps = waypointsOf(T["自定义途经点"], geo);
    const cuts = parseRoadCuts(R["路型分段"], geo, wps);
    if (cuts.length) {
      const bandBase = trackW * roadMul;
      // 色相强度 0 → 退回轨迹主色（材质/宽度仍在，只是不再区分颜色）
      const tint = (c) => (roadHue >= 0.999 ? c : mixHex(pathColor, c, roadHue));
      const segs = cuts.map((sg, si) => {
        const def = ROAD_BY_KEY.get(sg.t) ?? null;
        const plain = !def;
        const bandPx = plain ? trackW : bandBase * def.wide;
        const p = clamp01((distM - sg.s) / Math.max(1, sg.e - sg.s)) * 100;
        // 起点徽标：段长太短不标（挤不下），沿法向让开路面带。
        // ★ 同样是屏幕坐标 + px 字号：放进 scale(k) 组里字号会变成 1e-7 量级。
        let badge = null;
        if (showRoadBadge && !plain && sg.e - sg.s > geo.totalM * 0.05) {
          // 徽标放**段中点**：段首往往正好压着途经点标签
          const midM = (sg.s + sg.e) / 2;
          const bp = sampleAt(geo, midM);
          const bq = sampleAt(geo, Math.min(midM + 6, sg.e));
          const bpx = bp.x * k + gxMap;
          const bpy = bp.y * k + gyMap;
          let tx = (bq.x - bp.x) * k;
          let ty = (bq.y - bp.y) * k;
          const L = Math.hypot(tx, ty) || 1;
          tx /= L;
          ty /= L;
          const off = bandPx / 2 + badgeFont * 0.82 + badgeGap;
          const pop = clamp01((distM - sg.s) / (geo.totalM * 0.01));
          if (pop > 0.02) {
            // 「自动」= 沿法向左右交替（相邻段一左一右，避开途经点标签）；
            // 其余方位是**屏幕上的绝对方向**，用户按字面理解「上/下/左/右」即可。
            let bx = bpx;
            let by = bpy;
            let anchor = "middle";
            if (badgePos === "自动") {
              const sgn = si % 2 === 0 ? 1 : -1;
              bx = bpx - sgn * ty * off;
              by = bpy + sgn * tx * off;
            } else if (badgePos === "上") {
              by = bpy - off;
            } else if (badgePos === "下") {
              by = bpy + off + badgeFont * 0.35;
            } else if (badgePos === "左") {
              bx = bpx - off;
              anchor = "end";
            } else if (badgePos === "右") {
              bx = bpx + off;
              anchor = "start";
            }
            badge = {
              x: bx,
              y: by,
              anchor,
              text: def.key,
              fontSize: badgeFont,
              opacity: pop,
              color: badgeColor,
              haloColor: "rgba(0,0,0,0.72)",
              haloWidth: badgeFont * 0.16,
            };
          }
        }
        return {
          key: `rd:${si}:${sg.t}`,
          type: sg.t,
          plain,
          startM: sg.s,
          endM: sg.e,
          d: pathSlice(geo, sg.s, sg.e),
          bandW: bandPx * invK,
          casingW: (bandPx + 3) * invK,
          casing: plain ? null : tint(def.casing),
          base: plain ? pathColor : tint(def.base),
          done: plain ? doneColor : tint(def.done),
          p,
          // ★ 材质**全段生成**，不按已走裁剪：
          //   用户要的是「一眼看懂整条路线哪里是什么路」，所以让未走段也带材质（压暗显示）。
          //   生长感由底色带的 dash 裁剪负责，两者互补。
          decor: plain ? [] : decorOf(geo, sg.s, sg.e, def.decor, bandPx, k, gxMap, gyMap, roadDensity, sg.e),
          decorAlpha: plain ? 1 : p > 0.5 ? 1 : 0.34,
          baseAlpha: plain ? ghostOpacity : clamp(ghostOpacity + 0.1, 0.35, 0.85),
          badge,
        };
      });
      road = { segments: segs, bandPx: bandBase * invK, total: cuts.length };
    }
  }

  const startScr = cam.toScreen(geo.mx[0], geo.my[0]);
  const endScr = cam.toScreen(geo.mx[geo.mx.length - 1], geo.my[geo.my.length - 1]);

  // ---------- ⑦ 剖面折线与游标 ----------
  let profile = null;
  if (showProfile) {
    const poly = profilePolyline(
      g, distM, cursorX, wholeProfile ? geo.totalM : windowM, plotLeft, plotW, eleLo, eleHi, plotTop, profH, 3
    );
    const pt = poly.pts;
    let curveD = "";
    for (let i = 0; i < pt.length; i++) curveD += `${i ? "L" : "M"}${pt[i][0].toFixed(2)} ${pt[i][1].toFixed(2)}`;
    const areaD = pt.length
      ? `${curveD} L${pt[pt.length - 1][0].toFixed(2)} ${plotBottom.toFixed(2)} L${pt[0][0].toFixed(2)} ${plotBottom.toFixed(2)} Z`
      : "";
    // 游标处的曲线 y 就是 eleAt(geo, distM) —— 与地图头部、右上角读数同源
    const cursorY = profileY(headPt.ele, eleLo, eleHi, plotTop, profH);
    // 读数默认居中于游标，但两端必须让开：里程 0 时它会压住左侧「上限 m」标签，
    // 100% 时又顶到画布右缘。钳制只影响横向（纵向由「读数上移」控制）。
    const roText = `${Math.round(headPt.ele)} m`;
    const roHalf = readoutHalfW(roText, readSize);
    const roLo = (X["显示上下限"] !== false ? plotLeft - 18 + 22 : 10) + roHalf;
    const roHi = Math.min(plotLeft + plotW, width - 14) - roHalf;
    const roX = clamp(cursorX, Math.min(roLo, roHi), Math.max(roLo, roHi));
    profile = {
      plotLeft,
      plotTop,
      plotW,
      plotH: profH,
      plotBottom,
      cursorX,
      mapH,
      curveD,
      areaD,
      color: profColor,
      lineWidth: profW,
      ghostOpacity: profGhost,
      areaAlpha,
      panelAlpha,
      panelY: mapH,
      panelH: height - mapH,
      axis: X["显示上下限"] !== false
        ? {
            color: axisColor,
            fontSize: axisFont,
            lines: X["显示上下基线"] !== false,
            hiLabel: `${Math.round(eleHi)} m`,
            loLabel: `${Math.round(eleLo)} m`,
            labelX: plotLeft - 18,
            hiY: plotTop + axisFont * 0.36,
            loY: plotBottom + axisFont * 0.36,
            hiLineY: plotTop,
            loLineY: plotBottom,
          }
        : null,
      cursor: U["显示"] !== false
        ? { x: cursorX, y0: plotTop, y1: cursorY, dotY: cursorY, width: cursorW, color: cursorColor, r: cursorR }
        : null,
      readout: U["读数显示"] !== false
        ? {
            text: roText,
            x: roX,
            y: plotTop - readLift,
            fontSize: readSize,
            color: readColor,
          }
        : null,
      // 坡度标注：只标「有路型且 ≥ 阈值」的段，位置取段中点、曲线正上方。
      // 跟随窗口模式下曲线会滑动，x 映射不再等于里程比例 —— 只在整条模式标。
      slopeMarks: (() => {
        if (!showSlopeMark || !wholeProfile || !road) return [];
        const outList = [];
        for (const sg of road.segments) {
          if (sg.plain) continue;
          const sl = slopeOf(g, sg.startM, sg.endM);
          if (!(sl.deg >= slopeMinDeg)) continue;
          const midM = (sg.startM + sg.endM) / 2;
          const midEle = sampleAt(g, midM).ele;
          outList.push({
            x: plotLeft + (midM / Math.max(1, geo.totalM)) * plotW,
            y: profileY(midEle, eleLo, eleHi, plotTop, profH) - slopeLift,
            text: `${sl.up ? "↗" : "↘"} ${Math.round(sl.deg)}°`,
            color: slopeColor,
            fontSize: slopeFont,
          });
        }
        return outList;
      })(),
      // 游标所在段的坡度（读数下方单独一行；不在任何路型段内则不显示）
      slopeReadout: (() => {
        if (!showSlopeReadout || !road) return null;
        const hit = road.segments.find((sg) => distM >= sg.startM && distM <= sg.endM && !sg.plain);
        if (!hit) return null;
        const sl = slopeOf(g, hit.startM, hit.endM, "avg");
        // y 直接算好：与海拔读数是同一条基线，再叠「坡度读数上移」
        const baseY = plotTop - readLift;
        return {
          text: `${sl.up ? "↗" : "↘"} ${Math.round(sl.deg)}°`,
          color: slopeReadColor,
          fontSize: slopeReadFont,
          y: baseY + slopeReadFont * 2.1 + slopeReadLift,
        };
      })(),
    };
  }

  // ---------- ⑧ 叠加文案 ----------
  const fade = clamp01(fadeFrames > 0 ? frame / fadeFrames : 1);

  const title =
    W["显示"] !== false
      ? {
          x: width * 0.045,
          y: height * 0.055,
          main: { text: String(W["主标题"] ?? geo.data.meta.title), fontSize: titleSize * 1.35, color: titleColor },
          sub: { text: String(W["副标题"] ?? ""), fontSize: titleSize * 0.62, color: titleColor },
        }
      : null;

  const hudLines = [];
  if (H["显示里程"] !== false)
    hudLines.push({
      text: `${(distM / 1000).toFixed(2)}`,
      suffix: ` / ${geo.stats.distKm.toFixed(2)} km`,
      fontSize: hudFont * 1.7,
      weight: 700,
      opacity: 1,
    });
  if (H["显示海拔"] !== false)
    hudLines.push({ text: `海拔 ${Math.round(headPt.ele)} m`, suffix: "", fontSize: hudFont, weight: 400, opacity: 0.95 });
  if (H["显示进度"] !== false)
    hudLines.push({ text: `${Math.round(progress * 100)} %`, suffix: "", fontSize: hudFont, weight: 400, opacity: 0.8 });
  const hud =
    H["显示"] !== false && hudLines.length
      ? { x: width - width * 0.04, y: height * 0.055, color: hudColor, lines: hudLines }
      : null;

  return {
    width,
    height,
    mapH,
    fade,
    bgColor,
    fontSans: SANS,
    fontMono: MONO,
    // 用于调试 / 调参台显示的实时量
    progress,
    distM,
    finished,
    eleLo,
    eleHi,
    map: {
      // 轨迹总开关：渲染方据此决定要不要画 trackPath 那两组 path。
      // 头部点 / 起终点 / 标注已在上面按 showTrack 置空，所以两处判断一致。
      showTrack,
      showBase,
      opacity: tileOpacity,
      filter: `grayscale(${tileGray}) brightness(${(1.55 - tileDarken).toFixed(3)}) contrast(1.12) blur(${tileBlur}px)`,
      tiles,
      darkTop: `rgba(4,8,14,${(tileDarken * 0.42).toFixed(3)})`,
      darkBottom: `rgba(4,8,14,${(tileDarken * 0.72).toFixed(3)})`,
      topFadeHeight: mapH * 0.42,
      topFadeAlpha: showBase ? 0.45 : 0,
      gx: gxMap,
      gy: gyMap,
      k,
      trackPath: trackPathOf(geo),
      // 路型分段：null = 未启用（渲染方走 trackPath 单线）。有值时按段绘制路面带，
      // 每段自带 d / 包边 / 底色 / 已走色 / 段内进度 p / 材质图元 / 徽标。
      road,
      ghost: { color: pathColor, opacity: ghostOpacity, widthUser: trackW * invK },
      glow: {
        on: T["显示光晕"] !== false,
        color: doneColor,
        widthUser: trackW * glowMul * invK,
        std: Math.max(0.4, (trackW * glowMul * 0.32) / k),
        dash: `${drawnFrac > 0 ? drawnFrac : 0.00001} 1`,
      },
      done: { color: doneColor, widthUser: trackW * invK, dash: `${drawnFrac > 0 ? drawnFrac : 0.00001} 1` },
      marks: {
        // ★ 每个点自带「图元数组 + 标签对象」，几何全部在 buildMark/markShapes 里算好：
        //   渲染方只做 translate + 按 t 建元素，不做任何形状/标签位置推导。
        //   fontSize / color 仍保留，仅供旧调用方兜底。
        list: marks,
        fontSize: markFont,
        color: markColor,
      },
      start: showTrack && T["显示起终点"] !== false ? { x: startScr.sx, y: startScr.sy } : null,
      end: showTrack && T["显示起终点"] !== false && finished ? { x: endScr.sx, y: endScr.sy } : null,
      head: showTrack && headR > 0
        ? {
            x: headScr.sx,
            y: headScr.sy,
            r: headR,
            pulse: 1 + 0.18 * Math.sin((frame / fps) * Math.PI * 4),
            color: doneColor,
          }
        : null,
    },
    profile,
    title,
    hud,
  };
}

/** 由 props 反推合成时长（帧）—— Remotion 的 calculateMetadata 与调参台共用 */
export function trailDurationInFrames(props, D, fps) {
  const A = { ...D["动画节奏"], ...((props ?? {})["动画节奏"] ?? {}) };
  const sec = clamp(num(A["时长秒"], D["动画节奏"]["时长秒"]), 3, 180);
  const hold = clamp(num(A["结尾定格帧"], D["动画节奏"]["结尾定格帧"]), 0, 180);
  return Math.max(Math.round(fps * 2), Math.round(sec * fps) + hold);
}
