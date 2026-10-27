// 解析 KML（gx:Track / LineString + 具名 Point 标注）→ 输出 src/trail-profile-data.json
//
// 本生成器是「轨迹 ↔ 海拔」唯一真相源。核心设计（决定动画能否严格对齐）：
//
//   ★ 唯一自变量 = 累计里程 distM（米）
//     · 输出数组按**等里程重采样**（默认每 10 m 一个点），下标 i ↔ 里程 i × stepM
//     · 于是「按里程取点」退化为一次线性插值，无需二分查找，也不会因点密度不均
//       导致同一 progress 在「地图位置」和「海拔曲线」上落到不同地方
//     · 地图墨卡托坐标与海拔共用同一个下标 → 一一对应由数据结构保证，而非靠代码小心
//
//   坐标系：两步路导出的 KML 为 WGS-84，叠高德底图前必须转 GCJ-02（否则整体偏数百米）。
//   判定优先级：KML 显式 OvCoordType > 高德 POI 反查（纠偏前后中位偏差比较）> 默认 WGS-84。
//
// 用法:
//   node scripts/build-trail-profile.mjs "<kml路径>" [--step=10] [--no-verify]
//   node scripts/build-trail-profile.mjs "<kml>" --out=src/trail-profile-data.json

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=").slice(1).join("=") : d;
};
const flag = (k) => process.argv.includes(`--${k}`);

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------
function loadEnv() {
  const p = join(root, ".env");
  const out = {};
  if (!existsSync(p)) return out;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 坐标转换（WGS-84 <-> GCJ-02）
// ---------------------------------------------------------------------------
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return ret;
}
function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return ret;
}
export function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };
  const dLat = transformLat(lng - 105, lat - 35);
  const dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLatR = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  const dLngR = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lng: lng + dLngR, lat: lat + dLatR };
}

// ---------------------------------------------------------------------------
// KML 解析：gx:Track 优先，LineString 兜底，两侧都能取海拨
// ---------------------------------------------------------------------------
function parseKml(text) {
  const tracks = []; // { name, coords: [{lng,lat,ele}] }
  const marks = []; // { name, lng, lat, ele }

  const pmRe = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g;
  let m;
  while ((m = pmRe.exec(text)) !== null) {
    const body = m[1];
    const nameM = body.match(/<name>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/name>/);
    const name = nameM ? nameM[1].trim() : "";

    // gx:Track
    const coords = [];
    const cRe = /<gx:coord>\s*([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\s*<\/gx:coord>/g;
    let c;
    while ((c = cRe.exec(body)) !== null) {
      coords.push({ lng: Number(c[1]), lat: Number(c[2]), ele: c[3] != null ? Number(c[3]) : null });
    }
    if (coords.length > 1) {
      tracks.push({ name: name || "轨迹", coords });
      continue;
    }

    // LineString（有些导出器只给这个）
    const lsM = body.match(/<LineString>[\s\S]*?<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/);
    if (lsM) {
      const ls = [];
      for (const tok of lsM[1].trim().split(/\s+/)) {
        const p = tok.split(",");
        if (p.length < 2) continue;
        ls.push({ lng: Number(p[0]), lat: Number(p[1]), ele: p[2] != null ? Number(p[2]) : null });
      }
      if (ls.length > 1) {
        tracks.push({ name: name || "轨迹", coords: ls });
        continue;
      }
    }

    // Point（具名标注）
    const pM = body.match(/<Point>[\s\S]*?<coordinates>\s*([-\d.]+),([-\d.]+)(?:,([-\d.]+))?\s*<\/coordinates>/);
    if (pM) {
      marks.push({
        name,
        lng: Number(pM[1]),
        lat: Number(pM[2]),
        ele: pM[3] != null ? Number(pM[3]) : null,
      });
    }
  }
  return { tracks, marks };
}

// ---------------------------------------------------------------------------
// 距离 / 投影
//   · mercY 归一化到 [0,1]（Web 墨卡托），x 用 (lng+180)/360 同样归一化
//     → 两轴世界尺寸相同 = 1，等比性天然成立（这是本项目踩过的坑：两轴必须同一世界尺寸）
// ---------------------------------------------------------------------------
const R = 6371000;
function distM(a, b) {
  const dLat = ((b.lat - a.lat) * PI) / 180;
  const dLng = ((b.lng - a.lng) * PI) / 180;
  const la1 = (a.lat * PI) / 180;
  const la2 = (b.lat * PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const mercX = (lng) => (lng + 180) / 360;
const mercY = (lat) =>
  0.5 - Math.log((1 + Math.sin((lat * PI) / 180)) / (1 - Math.sin((lat * PI) / 180))) / (4 * PI);

// ---------------------------------------------------------------------------
// 坐标系反查校验（同 build-elevation-track.mjs 的策略，只采信名称互为子串的 POI，取中位数抗离群）
// ---------------------------------------------------------------------------
function pickCity(rawText) {
  const m = rawText.match(/<Data name="PosStartName">\s*<value>\s*([^<]+?)\s*<\/value>/);
  return m ? m[1].trim() : "";
}
async function verifyCoordSystem(marks, key, rawText) {
  if (/OvCoordType>\s*WGS/i.test(rawText)) return { system: "wgs84", reason: "KML 显式声明 OvCoordType=WGS-84", samples: [] };
  if (/OvCoordType>\s*GCJ/i.test(rawText)) return { system: "gcj02", reason: "KML 显式声明 OvCoordType=GCJ-02", samples: [] };
  if (!key) return { system: "wgs84", reason: "无 AMAP key，按户外 App 默认（WGS-84）处理", samples: [] };

  const clng = marks.reduce((a, m) => a + m.lng, 0) / marks.length;
  const clat = marks.reduce((a, m) => a + m.lat, 0) / marks.length;
  const anchor = wgs84ToGcj02(clng, clat);
  // ⚠ 必须剔除「通用词」标注：卫生间 / 商店 / 起点 / 风景点 这类名字在全城有几十个同名 POI，
  // 周边搜索会把 5 km 外的无关点匹配回来 —— 这种样本的两种假设距离都很大（数千 m），
  // 方向随机，一旦进中位数就会把判定带反（实测：真匹配 南天门 7 m / 一线天 20 m，
  // 却因为 4 个垃圾样本把整条轨迹判成 GCJ-02 不纠偏，整体偏 ~500 m）。
  const GENERIC_RE = /^(起点|终点|途经点|卫生间|商店|超市|风景点|补给点|游客中心|停车场|饭店|酒店|路口|桥|河|山|寺|庙|观|亭|门|泉|峰|洞|台|沟|岭|垭口)/;
  const cands = marks.filter(
    (m) => m.name && m.name.length >= 2 && m.name.length <= 8 && !GENERIC_RE.test(m.name)
  );
  const samples = [];
  for (const mk of cands) {
    if (samples.filter((s) => typeof s.distM === "number").length >= 6) break;
    try {
      const kw = mk.name.length > 3 ? mk.name.slice(0, 3) : mk.name;
      const url =
        "https://restapi.amap.com/v3/place/around?key=" + encodeURIComponent(key) +
        "&location=" + anchor.lng.toFixed(6) + "," + anchor.lat.toFixed(6) +
        "&keywords=" + encodeURIComponent(kw) + "&radius=8000&offset=10&sortrule=distance&page=1";
      const res = await fetch(url);
      const json = await res.json();
      const pois = Array.isArray(json.pois) ? json.pois : [];
      let best = null;
      for (const p of pois) {
        if (!p.location || !p.name) continue;
        const a = p.name.replace(/[()（）\s]/g, "");
        const b = mk.name.replace(/[()（）\s]/g, "");
        const hit = a.includes(b) || b.includes(a) || (b.length >= 3 && a.includes(b.slice(0, 3)));
        if (!hit) continue;
        const [lng, lat] = p.location.split(",").map(Number);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const g = wgs84ToGcj02(mk.lng, mk.lat);
        const dRaw = distM({ lng, lat }, mk);
        const dFix = distM({ lng, lat }, g);
        if (!best || Math.min(dRaw, dFix) < Math.min(best.dRaw, best.dFix)) best = { poi: p.name, dRaw, dFix };
      }
      if (best) samples.push({ mark: mk.name, poi: best.poi, distM: Math.round(best.dFix), distRaw: Math.round(best.dRaw) });
    } catch (e) {
      samples.push({ mark: mk.name, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const ok = samples.filter((s) => typeof s.distM === "number");
  if (ok.length < 1) {
    return { system: "wgs84", reason: `POI 反查无有效样本（${ok.length} 个），按户外 App 默认（WGS-84）处理`, samples };
  }
  // ⚠ 只采信「决定性样本」：某一假设下距离已很近（< 800 m），另一假设明显更远。
  // 距离都很远的样本（> 800 m）说明匹配到的根本不是该地点，其倾向毫无信息量，
  // 纳入统计只会把结论拉平（见上方 GENERIC_RE 的注释）。若一个决定性样本都没有，
  // 说明反查失败 → 回退默认 WGS-84，而不是用垃圾样本投票。
  const decisive = ok.filter((s) => Math.min(s.distM, s.distRaw) < 800);
  if (!decisive.length) {
    return {
      system: "wgs84",
      reason: `POI 反查 ${ok.length} 个样本均无近距离命中（最近 ${Math.round(Math.min(...ok.map((s) => Math.min(s.distM, s.distRaw))))} m），反查失败 → 按户外 App 默认（WGS-84）处理`,
      samples,
    };
  }
  const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
  const medFix = med(decisive.map((s) => s.distM));
  const medRaw = med(decisive.map((s) => s.distRaw));
  const system = medFix <= medRaw ? "wgs84" : "gcj02";
  return {
    system,
    reason: `POI 反查决定性样本 ${decisive.length}/${ok.length} 个，中位偏差：纠偏后 ${medFix} m / 未纠偏 ${medRaw} m → 判定为 ${system === "wgs84" ? "WGS-84，已纠偏" : "GCJ-02，无需纠偏"}`,
    samples,
  };
}

// ---------------------------------------------------------------------------
// 等里程重采样
//   · 海拔：线性插值（原始点距 ~5 m，重采样到 step 后形状不失真）
//   · 墨卡托：同一 t 上插值，保证海拔与地理位置共用同一个参数
// ---------------------------------------------------------------------------
function resampleByDistance(raw, cum, stepM) {
  const total = cum[cum.length - 1];
  const n = Math.floor(total / stepM) + 1;
  const out = { dist: [], ele: [], x: [], y: [] };
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = i * stepM;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg > 1e-9 ? Math.min(1, Math.max(0, (d - cum[j]) / seg)) : 0;
    const a = raw[j];
    const b = raw[j + 1];
    out.dist.push(+d.toFixed(2));
    // 海拔：四点里至少一端有效才插值，否则留 null 由后处理前向填充
    if (a.ele != null && b.ele != null) out.ele.push(a.ele + (b.ele - a.ele) * t);
    else out.ele.push(a.ele ?? b.ele ?? null);
    out.x.push(a.x + (b.x - a.x) * t);
    out.y.push(a.y + (b.y - a.y) * t);
  }
  // 末端补一个点，保证曲线画到终点（否则最后一小段被截掉，读数与终点对不上）
  if (out.dist[out.dist.length - 1] < total - 1e-6) {
    const a = raw[raw.length - 1];
    out.dist.push(+total.toFixed(2));
    out.ele.push(a.ele);
    out.x.push(a.x);
    out.y.push(a.y);
  }
  return out;
}

// 海拔空洞填充：线性插值 + 两端平推
function fillEleGaps(arr) {
  const n = arr.length;
  let first = -1;
  for (let i = 0; i < n; i++) if (arr[i] != null) { first = i; break; }
  if (first < 0) return arr.map(() => 0);
  for (let i = 0; i < first; i++) arr[i] = arr[first];
  let i = first;
  while (i < n) {
    if (arr[i] != null) { i++; continue; }
    let j = i;
    while (j < n && arr[j] == null) j++;
    const a = arr[i - 1];
    const b = j < n ? arr[j] : a;
    const span = j - i + 1;
    for (let k = i; k < j; k++) arr[k] = a + ((b - a) * (k - i + 1)) / span;
    i = j;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const kmlPath = process.argv[2];
  if (!kmlPath || !existsSync(kmlPath)) {
    console.error('用法: node scripts/build-trail-profile.mjs "<kml路径>" [--step=10] [--no-verify]');
    process.exit(1);
  }
  const stepM = Math.max(2, Number(arg("step", "10")) || 10);
  const outArg = arg("out", "src/trail-profile-data.json");
  const outPath = isAbsolute(outArg) ? outArg : resolve(root, outArg);
  const skipVerify = flag("no-verify");

  const raw = readFileSync(kmlPath, "utf8");
  const docM = raw.match(/<Document\b[^>]*>\s*<name>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/name>/);
  const docName = docM ? docM[1].trim() : "";
  const { tracks, marks } = parseKml(raw);
  if (!tracks.length) {
    console.error("✗ 未解析到轨迹（需要 gx:Track 或 LineString）");
    process.exit(1);
  }
  tracks.sort((a, b) => b.coords.length - a.coords.length);
  const track = tracks[0];
  console.log(`✓ 解析轨迹【${track.name}】${track.coords.length} 点`);
  console.log(`✓ 具名标注点 ${marks.length} 个`);

  const env = loadEnv();
  const verify = skipVerify
    ? { system: "wgs84", reason: "已跳过校验，按 WGS-84 处理", samples: [] }
    : await verifyCoordSystem(marks, env.AMAP_SERVER_KEY, raw);
  console.log(`\n【坐标系判定】${verify.reason}`);
  for (const s of verify.samples) {
    if (s.error) { console.log(`   ! ${s.mark}: ${s.error}`); continue; }
    if (typeof s.distM === "number")
      console.log(`   · ${s.mark} → 高德「${s.poi}」  纠偏后 ${s.distM} m / 未纠偏 ${s.distRaw} m`);
  }

  // ---------- 纠偏 ----------
  const needFix = verify.system === "wgs84";
  const fix = (lng, lat) => (needFix ? wgs84ToGcj02(lng, lat) : { lng, lat });

  const geo = track.coords
    .map((c) => {
      if (!Number.isFinite(c.lng) || !Number.isFinite(c.lat)) return null;
      const p = fix(c.lng, c.lat);
      return { lng: p.lng, lat: p.lat, ele: Number.isFinite(c.ele) ? c.ele : null, x: mercX(p.lng), y: mercY(p.lat) };
    })
    .filter(Boolean);
  if (geo.length < 2) { console.error("✗ 有效轨迹点不足"); process.exit(1); }

  // ---------- 累计里程（用 GCJ-02 后的坐标，与底图同一度量） ----------
  const cum = [0];
  for (let i = 1; i < geo.length; i++) cum.push(cum[i - 1] + distM(geo[i - 1], geo[i]));
  const totalM = cum[cum.length - 1];

  // ---------- 等里程重采样（海拔 + 墨卡托共用下标） ----------
  const rs = resampleByDistance(geo, cum, stepM);
  fillEleGaps(rs.ele);
  const N = rs.dist.length;
  console.log(`\n✓ 等里程重采样：每 ${stepM} m 一点 → ${N} 点（覆盖 ${(rs.dist[N - 1] / 1000).toFixed(3)} km）`);

  // ---------- 统计 ----------
  let up = 0, down = 0, minEle = Infinity, maxEle = -Infinity, minAt = 0, maxAt = 0;
  for (let i = 0; i < N; i++) {
    const e = rs.ele[i];
    if (e < minEle) { minEle = e; minAt = i; }
    if (e > maxEle) { maxEle = e; maxAt = i; }
    if (i > 0) {
      const d = e - rs.ele[i - 1];
      if (d > 0) up += d; else down -= d;
    }
  }
  // 累计爬升会被 GPS 噪声灌水，给一个按 30 点（= 300 m）平滑后的口径作参考
  let upS = 0, downS = 0;
  const sm30 = smooth(rs.ele, 30);
  for (let i = 1; i < N; i++) {
    const d = sm30[i] - sm30[i - 1];
    if (d > 0) upS += d; else downS -= d;
  }
  function smooth(a, w) {
    const half = Math.floor(w / 2);
    const out = new Array(a.length);
    // 前缀和 O(n)
    const pre = new Array(a.length + 1).fill(0);
    for (let i = 0; i < a.length; i++) pre[i + 1] = pre[i] + a[i];
    for (let i = 0; i < a.length; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(a.length - 1, i + half);
      out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
    }
    return out;
  }

  // ---------- 具名标注吸附到轨迹最近点 ----------
  // ⚠ 标注点必须与轨迹点一起纠偏后再做吸附。若拿「未纠偏的标注」去吸附
  // 「已纠偏的轨迹」，两者的 GCJ-02 偏移（本地约 500 m）会全部变成吸附误差 ——
  // 症状是 snapM 齐刷刷几百米、多个相邻标注挤到同一个轨迹点上。
  const marksOut = [];
  for (const m of marks) {
    if (!m.name) continue;
    const mp = fix(m.lng, m.lat);
    let bi = 0, bd = Infinity;
    for (let i = 0; i < geo.length; i++) {
      const d = distM(mp, geo[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    // 落在轨迹外太远的标注（拍照点/无关点）丢弃
    if (bd > 1500) continue;
    const idx = Math.min(N - 1, Math.round(cum[bi] / stepM));
    marksOut.push({
      name: m.name,
      distM: +rs.dist[idx].toFixed(1),
      ele: +rs.ele[idx].toFixed(1),
      lng: +geo[bi].lng.toFixed(7),
      lat: +geo[bi].lat.toFixed(7),
      x: +rs.x[idx].toFixed(9),
      y: +rs.y[idx].toFixed(9),
      snapM: Math.round(bd),
    });
  }
  marksOut.sort((a, b) => a.distM - b.distM);
  // 同名去重（加序号）
  const seen = new Map();
  for (const m of marksOut) {
    const n = seen.get(m.name) ?? 0;
    seen.set(m.name, n + 1);
    if (n > 0) m.name = `${m.name}(${n + 1})`;
  }

  // 精选标注：KML 里 97 个标注大多是行进手记（「左转」「很陡」「喵喵」），全画出来会糊成一片。
  // 用显式白名单把真正的「地点」挑出来 —— 比正则启发式可靠，且改起来一目了然。
  // 匹配用「包含」而非相等：KML 里的名字常带前后缀（「这才是卢崖瀑布」「台阶路终于走完了」）。
  const CURATED = [
    "起点", "南天门", "一线天", "石门", "吊桥", "塔林",
    "少林寺", "卧龙峰", "西流泉", "卢崖瀑布",
  ];
  const nameNorm = (n) => n.replace(/\(\d+\)$/, "");
  const curated = [];
  for (const kw of CURATED) {
    const hit = marksOut.find(
      (m) => nameNorm(m.name).includes(kw) &&
        !curated.some((c) => nameNorm(c.name).includes(kw))
    );
    if (hit) curated.push(hit);
  }
  const names = new Set(curated.map((c) => c.name));

  const data = {
    meta: {
      source: kmlPath.replace(/\\/g, "/"),
      trackName: docName || track.name,
      title: docName || "轨迹",
      coordSystem: verify.system,
      coordFixApplied: needFix,
      verifyReason: verify.reason,
      verifySamples: verify.samples,
      stepM,
      generatedAt: new Date().toISOString(),
      note: "数组按等里程重采样：下标 i ↔ 里程 i×stepM。地图(mercator)与海拔(ele)共用同一下标 → 一一对应。",
    },
    stats: {
      points: geo.length,
      samples: N,
      distM: +totalM.toFixed(1),
      distKm: +(totalM / 1000).toFixed(3),
      upM: Math.round(up),
      downM: Math.round(down),
      upSmoothedM: Math.round(upS),
      downSmoothedM: Math.round(downS),
      minEle: +minEle.toFixed(1),
      maxEle: +maxEle.toFixed(1),
      minEleAtM: rs.dist[minAt],
      maxEleAtM: rs.dist[maxAt],
    },
    /** 等里程里程表（米），长度 = samples */
    dist: rs.dist.map((v) => +v.toFixed(1)),
    /** 海拔（米），与 dist 同下标 */
    ele: rs.ele.map((v) => +v.toFixed(2)),
    /** 归一化 Web 墨卡托（x=(lng+180)/360, y=mercY(lat)，两轴世界尺寸同为 1） */
    mercator: rs.x.map((x, i) => [+x.toFixed(9), +rs.y[i].toFixed(9)]),
    /** 具名标注（含精选标记） */
    marks: marksOut.map((m) => ({ ...m, highlight: names.has(m.name) })),
    bbox: {
      minX: Math.min(...rs.x),
      maxX: Math.max(...rs.x),
      minY: Math.min(...rs.y),
      maxY: Math.max(...rs.y),
    },
    start: { distM: 0, ele: +rs.ele[0].toFixed(1), merc: [+rs.x[0].toFixed(9), +rs.y[0].toFixed(9)] },
    end: {
      distM: +totalM.toFixed(1),
      ele: +rs.ele[N - 1].toFixed(1),
      merc: [+rs.x[N - 1].toFixed(9), +rs.y[N - 1].toFixed(9)],
    },
  };

  writeFileSync(outPath, JSON.stringify(data), "utf8");
  const rel = outPath.replace(root + "\\", "").replace(/\\/g, "/");
  console.log(`\n✓ 输出 ${rel}`);
  console.log(`  点 ${geo.length} → 等距样本 ${N} | 里程 ${data.stats.distKm} km`);
  console.log(`  海拔 ${data.stats.minEle} ~ ${data.stats.maxEle} m（最高点 @ ${(data.stats.maxEleAtM / 1000).toFixed(2)} km）`);
  console.log(`  爬升 ${data.stats.upM} m（原始）/ ${data.stats.upSmoothedM} m（平滑口径）`);
  console.log(`  标注 ${marksOut.length} 个（精选 ${names.size} 个）：${[...names].join(" / ")}`);
  console.log(`  坐标：${needFix ? "WGS-84 → GCJ-02 已纠偏" : "GCJ-02 原样"}`);
  console.log(`  墨卡托包围盒 X=${data.bbox.minX.toFixed(6)}~${data.bbox.maxX.toFixed(6)} Y=${data.bbox.minY.toFixed(6)}~${data.bbox.maxY.toFixed(6)}`);
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
