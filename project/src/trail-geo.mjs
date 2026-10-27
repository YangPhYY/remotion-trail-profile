// ---------------------------------------------------------------------------
// 共享轨迹几何（普通 ESM，无 TS 语法）
//
// 为什么单独放一个 .js 而不是 .ts：这份数学要被三方共用 ——
//   ① Remotion 组件渲染（src/TrailProfile.tsx）
//   ② 离线瓦片预取脚本（scripts/fetch-trail-tiles.mjs，用同一套相机算需要哪些瓦片）
//   ③ 调参台网页（trail-studio.html，浏览器直接 <script type="module"> 加载）
// 三份实现分叉过一次的代价是「调参台里对得上、出片却偏了」，所以这里只留一份。
//
// ★ 对齐铁律（本模块的全部存在意义）
//   数据的唯一自变量是「累计里程 distM（米）」。dat.dist / dat.ele / dat.mercator
//   三个数组**按等里程重采样**，因此 下标 i ↔ 里程 i × stepM。
//   「按里程取点」于是退化成一次 O(1) 线性插值，而不是在不等距点集里二分查找。
//   地图头部位置、剖面游标海拔、里程读数全部由同一个 distM 推出 → 严格一一对应，
//   这由数据结构保证，而不依赖调用方是否小心。
// ---------------------------------------------------------------------------

export const MERC_WORLD_M = 40075016.685578488;
const PI = Math.PI;

/** 经度 → 归一化墨卡托 x，值域 [0,1]（与 y 同量纲，两轴世界尺寸都为 1） */
export const mercX = (lng) => (lng + 180) / 360;
/** 纬度 → 归一化墨卡托 y，值域 [0,1]（北为 0，南为 1） */
export const mercY = (lat) =>
  0.5 - Math.log((1 + Math.sin((lat * PI) / 180)) / (1 - Math.sin((lat * PI) / 180))) / (4 * PI);
/** 归一化墨卡托 y → 纬度（取相机参考纬度用） */
export const invMercY = (y) => (Math.atan(Math.sinh(PI * (1 - 2 * y))) * 180) / PI;
/** 该纬度处 1 个归一化墨卡托单位对应的地面米数（墨卡托是等角投影，两轴同尺度） */
export const mpuAt = (lat) => MERC_WORLD_M * Math.cos((lat * PI) / 180);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => clamp(v, 0, 1);

/**
 * 缓动函数（自实现，不依赖 remotion 的 Easing）。
 * 因为「场景模型」要被 Remotion 组件和浏览器调参台共用 —— 调参台里 import 不到
 * remotion，若两边各用一套 easing，调参台看到的速度曲线就会和出片不一样。
 * 这组公式与 remotion / react-native 的 Easing 系列结果一致：
 *   in(f) 就是 f 本身；out(f) = t => 1 − f(1−t)；inOut(f) 为分段镜像。
 */
export const EASING_FN = {
  线性: (t) => t,
  缓入缓出正弦: (t) => (1 - Math.cos(Math.PI * t)) / 2,
  缓出立方: (t) => 1 - Math.pow(1 - t, 3),
  缓入缓出立方: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  缓入立方: (t) => t * t * t,
};

/**
 * 对称滑动平均（前缀和 O(n)）。用于压 GPS 海拔噪声。
 * 对称滤波不产生相位偏移 —— 峰谷位置不会平移，所以「海拔与地理位置一一对应」仍然成立。
 */
export function smoothArray(a, win) {
  const n = a.length;
  const w = Math.max(1, Math.round(win));
  if (w <= 1) return a.slice();
  const half = Math.floor(w / 2);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
  }
  return out;
}

/** 在数组里按下标（可为小数）线性插值 */
export function lerpAt(arr, i) {
  const n = arr.length;
  if (n === 0) return 0;
  const x = clamp(i, 0, n - 1);
  const i0 = Math.floor(x);
  const i1 = Math.min(n - 1, i0 + 1);
  const t = x - i0;
  return arr[i0] + (arr[i1] - arr[i0]) * t;
}

/**
 * 把生成器产出的 JSON 包成几何索引。
 * @param {any} data src/trail-profile-data.json
 */
export function makeGeo(data) {
  const mercXArr = data.mercator.map((p) => p[0]);
  const mercYArr = data.mercator.map((p) => p[1]);
  const stepM = data.meta.stepM;
  const totalM = data.dist[data.dist.length - 1];
  const latRef = invMercY((data.bbox.minY + data.bbox.maxY) / 2);
  return {
    data,
    stepM,
    totalM,
    dist: data.dist,
    ele: data.ele,
    mx: mercXArr,
    my: mercYArr,
    latRef,
    /** 该纬度下 1 个归一化墨卡托单位 = 多少米 */
    mpu: mpuAt(latRef),
    bbox: data.bbox,
    marks: data.marks ?? [],
    stats: data.stats,
  };
}

/**
 * 按里程取点（严格对齐的入口）。
 * 返回归一化墨卡托坐标 + 海拔，地图与剖面共用这一个结果。
 */
export function sampleAt(geo, distM) {
  const i = clamp(distM, 0, geo.totalM) / geo.stepM;
  return {
    x: lerpAt(geo.mx, i),
    y: lerpAt(geo.my, i),
    ele: lerpAt(geo.ele, i),
    i,
  };
}

/** 只取海拔（剖面用；与 sampleAt 走同一插值，保证与地图头部完全一致） */
export const eleAt = (geo, distM) => lerpAt(geo.ele, clamp(distM, 0, geo.totalM) / geo.stepM);

/**
 * ★ 平移相机（屏幕像素量，正 = 画面内容向右/向下移动）。
 *
 * 必须走这里重建相机对象，**绝不能**写 `cam = { ...cam, cx: ... }`：
 * toScreen 是 makeCamera 内部的方法，它捕获的是构造时的 cx/cy/k 形参，
 * 展开对象只改了字段、toScreen 仍按旧中心投影 —— 结果是「轨迹组（吃 gx/gy 变换）
 * 平移了、瓦片与头部标记（吃 toScreen）没平移」，底图与轨迹直接错开。
 */
export function panCameraPx(geo, cam, dxPx, dyPx) {
  if (!dxPx && !dyPx) return cam;
  return makeCamera(
    geo,
    cam.cx - dxPx / cam.k,
    cam.cy - dyPx / cam.k,
    cam.k,
    cam.screenW,
    cam.screenH
  );
}

/**
 * 相机：把归一化墨卡托坐标映射到屏幕像素。
 * 缩放 k 的定义 —— 画面宽度 screenW 恰好对应地面 camWidthM 米：
 *   屏幕 1 px = camWidthM / screenW 米 = (camWidthM / screenW) / mpu 个墨卡托单位
 *   → k = screenW * mpu / camWidthM  [px / 墨卡托单位]
 * ⚠ x 与 y 用同一个 k（墨卡托等角 → 两轴同尺度），否则轨迹会被拉伸。
 *
 * @param {any} geo
 * @param {number} distM 当前里程（米）
 * @param {{screenW:number, screenH:number, camWidthM:number, lookaheadM?:number, mode?:string}} opt
 */
export function cameraAt(geo, distM, opt) {
  const { screenW, screenH, camWidthM } = opt;
  const lookaheadM = opt.lookaheadM ?? 0;
  const mode = opt.mode ?? "跟随滑动";

  if (mode === "全景展开") return fitCamera(geo, screenW, screenH, opt.fit);

  // 跟随滑动：相机中心 = 当前里程 + 前瞻距离处的位置
  const c = sampleAt(geo, clamp(distM + lookaheadM, 0, geo.totalM));
  const k = (screenW * geo.mpu) / Math.max(1, camWidthM);
  return makeCamera(geo, c.x, c.y, k, screenW, screenH);
}

/**
 * ★ 全景适配相机：把**整条轨迹完整放进画面**，并控制它在画面里的占比与位置。
 *
 * 这是「平面展示」模式唯一的相机 —— 不跟随、不滑动，整条路线一屏看完，
 * 动画只体现在「轨迹从左到右生长 + 剖面同步推进」。
 *
 * @param {any} geo
 * @param {number} screenW 地图区宽（px）
 * @param {number} screenH 地图区高（px）
 * @param {{widthRatio?:number, posX?:number, posY?:number}} [fit]
 *   widthRatio 目标占比 0~1（含义见下）；posX/posY 0=贴左/贴顶，0.5=居中，1=贴右/贴底
 *
 * ★ 占比为什么是「两个方向取较小者」
 *   轨迹包围盒的宽高比是固定的（本轨迹 1.93:1）。若只按宽度算缩放，扁轨迹在
 *   竖向就会顶出画面被切掉；只按高度算，横向又留一大片空白。
 *   所以 k = min(可用宽/包围盒宽, 可用高/包围盒高) —— **保证整条完整可见**，
 *   而 widthRatio 是「两条边各自最多占到多少」。
 *   ⚠ 因此实际横向占比通常小于 widthRatio（当轨迹比画面更「高」时），
 *     这是几何决定的、不是 bug；想让它更宽只能把剖面调矮（地图区变高）或换画幅。
 *   实测本轨迹在 1920×850 地图区、widthRatio=0.9 时：横向占 69%、纵向占 90%。
 */
export function fitCamera(geo, screenW, screenH, fit = {}) {
  const ratio = clamp(fit.widthRatio ?? 0.9, 0.2, 1);
  const posX = clamp(fit.posX ?? 0.5, 0, 1);
  const posY = clamp(fit.posY ?? 0.5, 0, 1);
  const bw = Math.max(geo.bbox.maxX - geo.bbox.minX, 1e-12);
  const bh = Math.max(geo.bbox.maxY - geo.bbox.minY, 1e-12);
  const k = Math.min((screenW * ratio) / bw, (screenH * ratio) / bh);
  const tw = bw * k;
  const th = bh * k;
  // 位置：把「剩余空白」按 posX/posY 分配（0=全留在右侧/下方 → 内容贴左上）
  const gx = posX * (screenW - tw) - geo.bbox.minX * k;
  const gy = posY * (screenH - th) - geo.bbox.minY * k;
  return makeCamera(geo, (screenW / 2 - gx) / k, (screenH / 2 - gy) / k, k, screenW, screenH);
}

function makeCamera(geo, cx, cy, k, screenW, screenH) {
  return {
    cx,
    cy,
    k,
    screenW,
    screenH,
    /** 地面米 / 屏幕像素 = (1 px → 1/k 墨卡托单位) × (1 单位 → mpu 米) */
    mPerPx: geo.mpu / k,
    toScreen(x, y) {
      return { sx: screenW / 2 + (x - cx) * k, sy: screenH / 2 + (y - cy) * k };
    },
    /** 屏幕像素长度 → 地面米数 */
    pxToMeters(px) {
      return (px * geo.mpu) / k;
    },
  };
}

/** 依据画面清晰度需求选瓦片层级：让一张 256px 瓦片在屏幕上约 256px（不过度放大） */
export function tileZoomFor(camWidthM, screenW, latRef, maxZ = 18) {
  const k = (screenW * mpuAt(latRef)) / Math.max(1, camWidthM);
  const zt = Math.log2(k / 256);
  return clamp(Math.ceil(zt), 3, maxZ);
}

/**
 * 当前相机视野需要哪些瓦片。
 * 推导：屏幕 px → 墨卡托单位（1/k）→ z 级世界像素（×256·2^z）
 */
export function tilesForCamera(cam, z) {
  const world = 256 * Math.pow(2, z);
  const wx = cam.cx * world;
  const wy = cam.cy * world;
  // 屏幕 1px 对应多少 z 级世界像素
  const wppx = world / cam.k;
  const hx = (cam.screenW / 2) * wppx;
  const hy = (cam.screenH / 2) * wppx;
  const max = Math.pow(2, z);
  const out = [];
  for (let tx = Math.floor((wx - hx) / 256); tx <= Math.floor((wx + hx) / 256); tx++) {
    for (let ty = Math.floor((wy - hy) / 256); ty <= Math.floor((wy + hy) / 256); ty++) {
      if (ty < 0 || ty >= max) continue;
      out.push({ z, x: ((tx % max) + max) % max, y: ty });
    }
  }
  return out;
}

/** 一张瓦片在屏幕上的边长（px）。用整数 z 时该值 ≥ 256 说明图像被放大 */
export const tileScreenSize = (cam, z) => cam.k / Math.pow(2, z);

/**
 * 海拔剖面：把「里程」映射到屏幕 x。
 *   x = cursorX + (d − distM) × pxPerMeter，pxPerMeter = axisW / windowM
 * 游标（x = cursorX，绝对坐标）恒好落在当前里程 distM 上 —— 与地图头部同一个 distM。
 * axisW = 绘图区宽度（不含左右留白），不要传整屏宽，否则曲线会压到轴标签上。
 */
export function profileX(distM, d, cursorX, windowM, axisW) {
  const ppm = axisW / Math.max(1, windowM);
  return cursorX + (d - distM) * ppm;
}

/** 海拔 → 屏幕 y（线性映射到 [top, top + height]） */
export function profileY(ele, eleLo, eleHi, top, height) {
  const span = Math.max(1e-6, eleHi - eleLo);
  return top + (1 - (ele - eleLo) / span) * height;
}

/** 自动轴界：向下/向上取整到「好看的」刻度 */
export function niceBounds(lo, hi, snap = 100) {
  return {
    lo: Math.floor(lo / snap) * snap,
    hi: Math.ceil(hi / snap) * snap,
  };
}

/**
 * 取一段里程区间内的剖面折线（屏幕坐标）。stepPx 控制采样密度，
 * 越密越平滑、越稀疏越快（3px 在 1920 宽下约 640 点，肉眼已看不出折角）。
 *
 * ⚠ 区间必须由「绘图区左右边界」反推，不能用整屏宽 —— 否则窗口右侧的
 * 里程会被算进画面外，白跑采样。
 */
export function profilePolyline(
  geo, distM, cursorX, windowM, axisLeft, axisW, eleLo, eleHi, top, height, stepPx = 3
) {
  const ppm = axisW / Math.max(1, windowM);
  const stepM = Math.max(geo.stepM, stepPx / ppm);
  const dStart = Math.max(0, distM - (cursorX - axisLeft) / ppm);
  const dEnd = Math.min(geo.totalM, distM + (axisLeft + axisW - cursorX) / ppm);
  const pts = [];
  let d = dStart;
  for (; d <= dEnd; d += stepM) {
    pts.push([
      profileX(distM, d, cursorX, windowM, axisW),
      profileY(eleAt(geo, d), eleLo, eleHi, top, height),
    ]);
  }
  // 末端补齐：否则最后不足一个 step 的一小段会被丢掉，曲线画不到窗口右缘
  if (pts.length === 0 || d - stepM < dEnd - 1e-9) {
    pts.push([
      profileX(distM, dEnd, cursorX, windowM, axisW),
      profileY(eleAt(geo, dEnd), eleLo, eleHi, top, height),
    ]);
  }
  return { pts, dStart, dEnd, ppm, stepM };
}

/**
 * 等距采样点集的「墨卡托累计长度」归一化表。
 * 用途：轨迹「已走部分」用 stroke-dasharray + pathLength 实现局部绘制时，
 * 进度必须按墨卡托弧长算而不是按里程 —— Web 墨卡托的尺度因子是 1/cos(纬度)，
 * 本轨迹跨 34.45°~34.52°，两者差 ~0.04%，在 31 km 上就是 15 m ≈ 14 px 的偏差。
 * 用这张表即可精确到亚像素。
 */
export function mercLengthFractions(geo) {
  const n = geo.mx.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(geo.mx[i] - geo.mx[i - 1], geo.my[i] - geo.my[i - 1]);
  }
  const total = cum[n - 1] || 1;
  const norm = new Array(n);
  for (let i = 0; i < n; i++) norm[i] = cum[i] / total;
  return norm;
}

/** 里程 → 墨卡托弧长占比（用上面那张表按连续下标插值） */
export const mercFractionAtDistance = (geo, norm, distM) => lerpAt(norm, clamp(distM, 0, geo.totalM) / geo.stepM);

export const fmtKm = (m) => (m / 1000).toFixed(2);
export const fmtM = (m) => Math.round(m).toString();
