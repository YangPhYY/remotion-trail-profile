// ---------------------------------------------------------------------------
// TrailProfile 参数表 —— 调参台（trail-studio.html）与本地保存服务共用。
//
// 为什么单独一份：调参台的滑块范围必须和 src/trail-profile-schema.ts 里 zod 的
// min/max 一致，否则会出现「调参台里能拉到 4000、粘到 Remotion Studio 被 schema 拒绝」。
// 这里只放**控件元信息**（类型/范围/步长/单位），数值本身一律来自
// src/trail-profile-defaults.json，不放第二份默认值。
//
// type: range | color | bool | select | text
//   ui: "waypoints" 表示该键不是标量，交给调参台的专用编辑器（列表式增删改）
// ---------------------------------------------------------------------------

// 形状 / 标签位置的枚举列表**从场景模型 import**：
// 渲染方与参数表各写一份必然分叉（调参台能选到、渲染却不认）。这里只做转发。
import { WP_SHAPES, WP_LABEL_POS } from "./trail-scene.mjs";

export const PARAM_GROUPS = [
  {
    group: "地图",
    hint: "平面全景：整条轨迹一屏展示，无镜头跟随。占比按「整条完整可见」计算，轨迹比画面更扁时横向占比会小于设定值",
    items: [
      { key: "轨迹占比", type: "range", min: 0.4, max: 1, step: 0.01 },
      { key: "轨迹位置X", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "轨迹位置Y", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "显示底图", type: "bool" },
      { key: "底图不透明度", type: "range", min: 0, max: 1, step: 0.02 },
      { key: "底图暗化", type: "range", min: 0, max: 1, step: 0.02 },
      { key: "底图去色", type: "range", min: 0, max: 1, step: 0.02 },
      { key: "底图模糊", type: "range", min: 0, max: 24, step: 0.5, unit: "px" },
      { key: "背景色", type: "color" },
      { key: "透明背景", type: "bool" },
    ],
  },
  {
    group: "轨迹",
    hint: "路线本体。白色=已走，半透明=未走；「自定义途经点」在下方单独编辑",
    items: [
      // 总开关放组内第一项并给人话标签：它是「只出海拔图」时最常按的那个键。
      // 关掉后线 / 头部点 / 起终点 / 标注 / 途经点整层消失（底图另由「显示底图」控制）。
      { key: "显示轨迹", type: "bool", label: "显示轨迹" },
      { key: "已走颜色", type: "color" },
      { key: "轨迹颜色", type: "color" },
      { key: "线宽", type: "range", min: 1, max: 30, step: 0.5, unit: "px" },
      { key: "未走不透明度", type: "range", min: 0, max: 1, step: 0.02 },
      { key: "显示光晕", type: "bool" },
      { key: "光晕倍数", type: "range", min: 1, max: 6, step: 0.1 },
      { key: "头部点半径", type: "range", min: 0, max: 40, step: 1, unit: "px" },
      { key: "显示起终点", type: "bool" },
      { key: "标注显示", type: "select", options: ["关闭", "精选", "全部"] },
      { key: "标注字号", type: "range", min: 8, max: 48, step: 1, unit: "px" },
      { key: "标注颜色", type: "color" },
      { key: "途经点显示", type: "bool" },
      { key: "途经点颜色", type: "color" },
      { key: "途经点字号", type: "range", min: 8, max: 48, step: 1, unit: "px" },
      { key: "途经点形状", type: "select", options: [...WP_SHAPES] },
      { key: "途经点大小", type: "range", min: 1, max: 40, step: 0.5, unit: "px" },
      { key: "途经点标签位置", type: "select", options: [...WP_LABEL_POS] },
      { key: "途经点标签偏移", type: "range", min: 0, max: 120, step: 1, unit: "px" },
      { key: "途经点透明度", type: "range", min: 0, max: 1, step: 0.02 },
      { key: "走到后出现", type: "bool" },
      { key: "自定义途经点", type: "text", ui: "waypoints" },
    ],
  },
  {
    group: "路型",
    hint: "把轨迹按里程切成不同路面：机耕路 / 土路 / 步道台阶 / 陡坡山路 / 攀爬。起止可写途经点名称，也可直接写里程 km",
    items: [
      { key: "显示路型", type: "bool" },
      { key: "路型分段", type: "text", ui: "roads" },
      { key: "路型带宽倍数", type: "range", min: 1, max: 6, step: 0.1, unit: "× 线宽" },
      { key: "路型色相强度", type: "range", min: 0, max: 1, step: 0.02 },
      { key: "纹理密度", type: "range", min: 0.2, max: 3, step: 0.05 },
      { key: "段首徽标", type: "bool" },
      { key: "徽标位置", type: "select", options: ["自动", "上", "下", "左", "右"] },
      { key: "徽标偏移", type: "range", min: -120, max: 200, step: 2, unit: "px" },
      { key: "徽标字号", type: "range", min: 10, max: 40, step: 1, unit: "px" },
      { key: "徽标颜色", type: "color" },
    ],
  },
  {
    group: "海拔剖面",
    hint: "参考图那一层。「整条显示」= 全程曲线一屏铺满、游标随里程从左到右扫；「跟随窗口」= 只显示游标附近一段",
    items: [
      // 「显示」放在组内第一项，并给一个人话标签 —— 它是最常被单独切开的开关，
      // 藏在「剖面模式」下面、标签只写「显示」时没人找得到。
      // 键名保持 "显示" 不变（默认值 / schema / 场景模型 / 顶部快捷开关全部按这个键）。
      { key: "显示", type: "bool", label: "显示海拔图" },
      { key: "剖面模式", type: "select", options: ["整条显示", "跟随窗口"] },
      { key: "高度", type: "range", min: 80, max: 720, step: 5, unit: "px" },
      { key: "离底距离", type: "range", min: 0, max: 700, step: 5, unit: "px" },
      { key: "左留白", type: "range", min: 0, max: 600, step: 5, unit: "px" },
      { key: "右留白", type: "range", min: 0, max: 600, step: 5, unit: "px" },
      { key: "游标位置", type: "range", min: 0.05, max: 0.95, step: 0.01 },
      { key: "显示里程窗口米", type: "range", min: 500, max: 31000, step: 250, unit: "m" },
      { key: "平滑窗口", type: "range", min: 1, max: 81, step: 1, unit: "点" },
      { key: "线宽", type: "range", min: 1, max: 20, step: 0.5, unit: "px" },
      { key: "线颜色", type: "color" },
      { key: "填充不透明度", type: "range", min: 0, max: 1, step: 0.02 },
      { key: "未走不透明度", type: "range", min: 0, max: 1, step: 0.02 },
      { key: "内衬不透明度", type: "range", min: 0, max: 1, step: 0.02 },
      { key: "剖面坡度标注", type: "bool" },
      { key: "坡度标注下限", type: "range", min: 0, max: 60, step: 1, unit: "°" },
      { key: "坡度标注字号", type: "range", min: 10, max: 60, step: 1, unit: "px" },
      { key: "坡度标注上移", type: "range", min: -60, max: 300, step: 2, unit: "px" },
      { key: "坡度标注颜色", type: "color" },
    ],
  },
  {
    group: "剖面游标",
    hint: "游标竖线 + 上方读数字（参考图里的「39 m」）",
    items: [
      { key: "显示", type: "bool" },
      { key: "读数显示", type: "bool" },
      { key: "坡度读数", type: "bool" },
      { key: "坡度读数字号", type: "range", min: 8, max: 60, step: 1, unit: "px" },
      { key: "坡度读数上移", type: "range", min: -40, max: 200, step: 2, unit: "px" },
      { key: "坡度读数颜色", type: "color" },
      { key: "读数字号", type: "range", min: 16, max: 140, step: 1, unit: "px" },
      { key: "读数上移", type: "range", min: 0, max: 300, step: 2, unit: "px" },
      { key: "线宽", type: "range", min: 1, max: 12, step: 0.5, unit: "px" },
      { key: "点半径", type: "range", min: 0, max: 24, step: 0.5, unit: "px" },
      { key: "线颜色", type: "color" },
      { key: "读数颜色", type: "color" },
    ],
  },
  {
    group: "坐标轴",
    hint: "左侧上下限标签。改为「固定」可以把纵向放大到某个海拔带",
    items: [
      { key: "显示上下限", type: "bool" },
      { key: "上限模式", type: "select", options: ["自动", "固定"] },
      { key: "固定上限", type: "range", min: 100, max: 6000, step: 10, unit: "m" },
      { key: "下限模式", type: "select", options: ["自动", "固定"] },
      { key: "固定下限", type: "range", min: 0, max: 4000, step: 10, unit: "m" },
      { key: "字号", type: "range", min: 10, max: 72, step: 1, unit: "px" },
      { key: "显示上下基线", type: "bool" },
      { key: "颜色", type: "color" },
    ],
  },
  {
    group: "动画节奏",
    hint: "时长秒直接决定合成时长（改这里时间轴实时联动）",
    items: [
      { key: "时长秒", type: "range", min: 3, max: 180, step: 0.5, unit: "s" },
      { key: "生长缓动", type: "select", options: ["线性", "缓入缓出正弦", "缓出立方", "缓入缓出立方", "缓入立方"] },
      { key: "开场淡入帧", type: "range", min: 0, max: 90, step: 1, unit: "帧" },
      { key: "结尾定格帧", type: "range", min: 0, max: 180, step: 1, unit: "帧" },
    ],
  },
  {
    group: "文字标题",
    items: [
      { key: "显示", type: "bool" },
      { key: "主标题", type: "text" },
      { key: "副标题", type: "text" },
      { key: "字号", type: "range", min: 16, max: 120, step: 1, unit: "px" },
      { key: "颜色", type: "color" },
    ],
  },
  {
    group: "数据读数",
    hint: "右上角实时数据。海拔读数与剖面游标处取的是同一个值，可用来交叉验证对齐",
    items: [
      { key: "显示", type: "bool" },
      { key: "显示里程", type: "bool" },
      { key: "显示海拔", type: "bool" },
      { key: "显示进度", type: "bool" },
      { key: "字号", type: "range", min: 12, max: 80, step: 1, unit: "px" },
      { key: "颜色", type: "color" },
    ],
  },
];

/** 把一份 props（分组对象）按参数表裁剪到合法范围，用于保存前校验 */
export function clampPropsToSpec(props, defaults) {
  const out = {};
  const knownGroups = new Set(PARAM_GROUPS.map((g) => g.group));
  for (const g of PARAM_GROUPS) {
    const src = { ...(defaults[g.group] ?? {}), ...((props ?? {})[g.group] ?? {}) };
    const dg = defaults[g.group] ?? {}; // 缺组时不能直接下标，否则 defaults.json 少一组就整条保存崩掉
    const dst = {};
    for (const it of g.items) {
      const v = src[it.key];
      const fb = dg[it.key] ?? v; // 兜底顺序：默认值 → 传入值
      if (it.type === "range") {
        const n = Number(v);
        dst[it.key] = Number.isFinite(n) ? Math.min(it.max, Math.max(it.min, n)) : fb;
      } else if (it.type === "bool") {
        dst[it.key] = typeof v === "boolean" ? v : typeof fb === "boolean" ? fb : false;
      } else if (it.type === "select") {
        dst[it.key] = it.options.includes(v) ? v : fb;
      } else {
        dst[it.key] = String(v ?? fb ?? "");
      }
    }
    // ★ 必须保留「参数表之外的键」，原样带过。
    //   为什么：调参台服务是长驻进程，PARAM_GROUPS 只在**启动时**读一次。
    //   若在服务运行期间给参数表加了新参数（页面刷新后已能显示、也能填值），
    //   而落盘走的是旧进程内存里的参数表 —— 重建对象时新键会被无声丢掉。
    //   （实测踩过：新加的「头部安全边距」被一次保存整键抹掉。）
    //   保留未知键后，旧服务保存也不会破坏它不认识的数据。
    for (const k of Object.keys(src)) {
      if (!(k in dst)) dst[k] = src[k];
    }
    out[g.group] = dst;
  }
  // 连整个未知分组也保留（同理，防旧服务抹掉新增分组）
  for (const k of Object.keys({ ...(defaults ?? {}), ...(props ?? {}) })) {
    if (knownGroups.has(k)) continue;
    out[k] = props?.[k] ?? defaults?.[k];
  }
  return out;
}
