import { z } from "zod";
import { zColor } from "@remotion/zod-types";

// 缓动曲线选项（中文显示，映射到低层 Easing 函数见 MapGrowth.tsx）
export const EASING_OPTIONS = [
  "线性",
  "缓入缓出正弦",
  "缓出立方",
  "缓入缓出立方",
  "缓入立方",
] as const;

// 配置项 schema：分组 + 中文标签
// Remotion Studio 会把嵌套 z.object 渲染为可折叠的分组，字段键名即显示标签。
export const mapGrowthSchema = z.object({
  // ① 颜色分组（含取色面板）
  "颜色": z.object({
    "路线荧光色": zColor(),
    "路线核心色": zColor(),
    "起点颜色": zColor(),
    "终点颜色": zColor(),
    "背景颜色": zColor(),
    "标题颜色": zColor(),
  }),

  // ② 动画节奏分组
  "动画节奏": z.object({
    "开场帧数": z.number().step(1).min(0).max(150),
    "收尾帧数": z.number().step(1).min(0).max(150),
    "行进缩放": z.number().step(0.01).min(1).max(3),
    "生长缓动": z.enum(EASING_OPTIONS),
    "镜头缓动": z.enum(EASING_OPTIONS),
  }),

  // ③ 路线样式分组
  "路线样式": z.object({
    "光晕线宽": z.number().step(1).min(1).max(60),
    "核心线宽": z.number().step(1).min(1).max(30),
    "填充画面": z.boolean(),
    "路线边距系数": z.number().step(0.01).min(1).max(3),
  }),

  // ③-b 3D 相机（脚本化立体镜头；仅作用于地图层，UI 覆盖层保持平面）
  "3D 相机": z.object({
    "启用3D": z.boolean(),
    "起始俯仰": z.number().step(1).min(10).max(75),
    "结束俯仰": z.number().step(1).min(10).max(75),
    "旋转角度": z.number().step(1).min(0).max(90),
    "起始缩放": z.number().step(0.01).min(0.6).max(2),
    "结束缩放": z.number().step(0.01).min(0.6).max(2),
    "透视距离": z.number().step(50).min(600).max(4000),
  }),

  // ④ 文字标题分组
  "文字标题": z.object({
    "主标题": z.string(),
    "副标题": z.string(),
    "标题字号": z.number().step(1).min(20).max(120),
  }),

  // ⑤ 开场聚焦分组（中国地图 → 甘南藏族自治州 俯冲点亮）
  "开场聚焦": z.object({
    "聚焦帧数": z.number().step(1).min(15).max(200),
    "中国底色": zColor(),
    "甘南亮色": zColor(),
  }),
});

export type MapGrowthProps = z.infer<typeof mapGrowthSchema>;

// —— 古卷（羊皮纸）轨迹动画配置 ——
export const antiqueSchema = z.object({
  // ① 颜色分组（古卷配色：朱砂路线 + 墨色文字）
  "颜色": z.object({
    "路线主色": zColor(),
    "路线晕色": zColor(),
    "核心提亮色": zColor(),
    "印章颜色": zColor(),
    "文字墨色": zColor(),
    "背景颜色": zColor(),
  }),

  // ② 动画节奏分组
  "动画节奏": z.object({
    "开场帧数": z.number().step(1).min(0).max(150),
    "收尾帧数": z.number().step(1).min(0).max(200),
    "生长缓动": z.enum(EASING_OPTIONS),
    "镜头缓动": z.enum(EASING_OPTIONS),
  }),

  // ③ 路线样式分组
  "路线样式": z.object({
    "光晕线宽": z.number().step(1).min(1).max(60),
    "核心线宽": z.number().step(1).min(1).max(30),
    "路线边距系数": z.number().step(0.01).min(1).max(3),
  }),

  // ④ 途经点分组（编辑实际数据请改 src/waypoints.json）
  "途经点": z.object({
    "显示标签": z.boolean(),
    "标签显示帧数": z.number().step(1).min(0).max(1200),
    "标签字号": z.number().step(1).min(10).max(40),
    "显示海拔": z.boolean(),
    "点半径": z.number().step(1).min(2).max(14),
  }),

  // ⑤ 文字标题分组
  "文字标题": z.object({
    "主标题": z.string(),
    "副标题": z.string(),
    "标题字号": z.number().step(1).min(20).max(120),
  }),
});

export type AntiqueProps = z.infer<typeof antiqueSchema>;

// —— 途经点定义（TrackAnimation）：轨迹生长经过时依次弹出 ——
// 定位二选一：「轨迹进度」按沿轨迹里程百分比（0=起点，100=终点）；
// 「经纬度」按坐标吸附到最近轨迹点。两个都填时进度优先。
export const trackWaypointSchema = z.object({
  "名称": z.string().describe("显示在标记旁的名称，留空则按序号显示为「途经点 N」"),
  "定位方式": z.enum(["轨迹进度", "经纬度"]).describe("轨迹进度=按沿轨迹里程百分比；经纬度=吸附到最近的轨迹点"),
  "进度百分比": z.number().step(0.1).min(0).max(100).describe("0=起点，100=终点（定位方式为轨迹进度时生效）"),
  "经度": z.number().describe("定位方式为经纬度时生效（如 113.5123）"),
  "纬度": z.number().describe("定位方式为经纬度时生效（如 35.7841）"),
});

// —— 轨迹动画组件（TrackAnimation）配置：颜色 / 粗细 / 速度 / 画面占比 ——
export const trackAnimationSchema = z.object({
  // ① 轨迹样式分组（取色面板 + 线宽滑块）
  "轨迹样式": z.object({
    "轨迹颜色": zColor(),
    "轨迹粗细": z.number().step(0.5).min(1).max(40),
    "显示光晕": z.boolean(),
    "背景颜色": zColor(),
  }),

  // ② 动画节奏分组（速度倍率：0.25x 慢速 ~ 4x 快速）
  "动画节奏": z.object({
    "运动速度": z.number().step(0.05).min(0.25).max(4),
    "生长缓动": z.enum(EASING_OPTIONS),
  }),

  // ③ 画面布局分组（轨迹在画面中的占比，0.2 ~ 1.0；整体旋转）
  "画面布局": z.object({
    "画面占比": z.number().step(0.01).min(0.2).max(1),
    "显示信息卡片": z.boolean(),
    "旋转角度": z
      .number()
      .step(1)
      .min(-180)
      .max(180)
      .describe("整条轨迹（含路径线、起终点、途经点及其标签）顺时针旋转度数，0 = 不旋转"),
    "旋转基准": z
      .enum(["轨迹中心", "起点"])
      .describe("旋转中心：轨迹中心=绕轨迹包围盒中心（默认，与画面中心重合）；起点=绕轨迹起点"),
    "旋转后重新适配": z
      .boolean()
      .describe("开启：旋转后自动等比缩放，保证整条轨迹始终完整可见（默认）。关闭：严格绕基准点旋转，可能超出画面"),
  }),

  // ④ 文字标题分组
  "文字标题": z.object({
    "主标题": z.string(),
    "副标题": z.string(),
  }),

  // ⑤ 途经点（Studio Props 面板可点「添加」逐条输入；调参台支持点击轨迹添加）
  "途经点": z
    .array(trackWaypointSchema)
    .max(24)
    .default([])
    .describe("点右侧「+」逐条添加。更快的做法：打开 track-studio.html，点击画面轨迹添加后点「复制 Props JSON」，粘贴到此处"),

  // ⑥ 途经点样式
  "途经点样式": z.object({
    "显示": z.boolean(),
    "颜色": zColor(),
    "点半径": z.number().step(1).min(2).max(20),
    "显示名称": z.boolean(),
    "标签字号": z
      .number()
      .step(1)
      .min(8)
      .max(72)
      .describe("途经点名称标签的字号（px，基于 1920×1080 画布）；默认 18 与旧版一致"),
    "标签随轨迹旋转": z
      .boolean()
      .describe("开启：标签文字随轨迹一起旋转（严格整体旋转）；关闭：标签始终水平，保证可读性（默认）"),
    "随进度弹出": z
      .boolean()
      .describe("关闭（默认）：途经点添加后立即显示并全程可见；开启：等轨迹生长到该位置时才出现"),
  }),
});

export type TrackAnimationProps = z.infer<typeof trackAnimationSchema>;

// zzmap 镜头飞行：底图 + 叠加 + 信息卡片
export const FLIGHT_EASING_OPTIONS = ["线性", "缓入缓出正弦", "缓出", "缓入缓出立方", "缓入"] as const;
export const FLIGHT_COORD_OPTIONS = ["不转换（源即 GCJ-02）", "WGS-84 → GCJ-02"] as const;

export const zzmapFlightSchema = z.object({
  "底图": z.object({
    "卫星影像": z.boolean(),
    "路网标注": z.boolean(),
    "标注不透明度": z.number().step(0.05).min(0).max(1),
    "背景颜色": zColor(),
  }),
  "镜头": z.object({
    "播放速度": z.number().step(0.05).min(0.25).max(4),
    "缓动": z.enum(FLIGHT_EASING_OPTIONS),
  }),
  "叠加": z.object({
    "显示路线": z.boolean(),
    "路线颜色": zColor(),
    "路线粗细": z.number().step(0.5).min(1).max(20),
    "显示起终点": z.boolean(),
  }),
  "信息卡片": z.object({
    "显示": z.boolean(),
    "主标题": z.string(),
    "副标题": z.string(),
    "文字颜色": zColor(),
    "卡片底色": zColor(),
  }),
  "坐标系": z.enum(FLIGHT_COORD_OPTIONS),
});
