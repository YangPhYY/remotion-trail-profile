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
  const mercNorm = mercLengthFractions(geo);
  const drawnFrac = mercFractionAtDistance(geo, mercNorm, distM);

  // 标注与自定义途经点合并成一份列表。
  // 两者都挂在「里程」这个统一坐标上，所以地图上的点位与剖面游标同源、不会错位。
  const inView = (sx, sy) => sx > -160 && sx < width + 160 && sy > -80 && sy < mapH + 80;
  const marks = [];

  if (markMode !== "关闭") {
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

  if (showWaypoints) {
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
      showBase,
      opacity: tileOpacity,
      filter: `grayscale(${tileGray}) brightness(${(1.55 - tileDarken).toFixed(3)}) contrast(1.12) blur(${tileBlur}px)`,
      tiles,
      darkTop: `rgba(4,8,14,${(tileDarken * 0.42).toFixed(3)})`,
      darkBottom: `rgba(4,8,14,${(tileDarken * 0.72).toFixed(3)})`,
      topFadeHeight: mapH * 0.42,
      topFadeAlpha: showBase ? 0.45 : 0,
      gx: width / 2 - cam.cx * k,
      gy: mapH / 2 - cam.cy * k,
      k,
      trackPath: trackPathOf(geo),
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
      start: T["显示起终点"] !== false ? { x: startScr.sx, y: startScr.sy } : null,
      end: T["显示起终点"] !== false && finished ? { x: endScr.sx, y: endScr.sy } : null,
      head: headR > 0
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
