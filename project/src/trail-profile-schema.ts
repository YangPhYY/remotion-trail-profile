import { z } from "zod";
import { zColor } from "@remotion/zod-types";
import { EASING_OPTIONS } from "./schema";
// ★ 形状 / 标签位置的枚举从场景模型 import —— 绝不在 schema 里另写一份。
//   写两份的后果是「调参台能选到某个形状、渲染却不认」，而且只在出片时才发现。
import { WP_SHAPES, WP_LABEL_POS } from "./trail-scene.mjs";

// ---------------------------------------------------------------------------
// TrailProfile（轨迹 + 海拔剖面同步动画）参数 schema
//
// 设计原则：**一切影响观感的量都可调**，且每一项都给出与下方 defaults 一致的默认值。
// 分 8 组，与调参台 trail-studio.html 的折叠面板一一对应。
//
// ⚠ 本合成是**平面全景**：整条轨迹一屏静止展示，没有镜头滑动/跟随。
//   唯一的动态是「轨迹从左到右生长」+「剖面游标同步推进」，因此也不依赖卫星底图
//   （「显示底图」默认关闭；一旦打开，需要先跑 scripts/fetch-trail-tiles.mjs 取瓦片）。
// ---------------------------------------------------------------------------

export const TRAIL_MARK_MODES = ["关闭", "精选", "全部"] as const;
export const TRAIL_AXIS_MODES = ["自动", "固定"] as const;
export const TRAIL_PROFILE_MODES = ["整条显示", "跟随窗口"] as const;
/** 与 src/trail-scene.mjs 的 WP_SHAPES / WP_LABEL_POS 同源（见文件头 import 注释） */
const SHAPE_ENUM = WP_SHAPES as unknown as [string, ...string[]];
const LABEL_POS_ENUM = WP_LABEL_POS as unknown as [string, ...string[]];

export const trailProfileSchema = z.object({
  // ① 画布与轨迹摆放
  "地图": z.object({
    "轨迹占比": z
      .number()
      .step(0.01)
      .min(0.4)
      .max(1)
      .describe(
        "轨迹在画面里的目标占比（0.4~1）。因为必须保证整条完整可见，实际取「横向」与「纵向」里更受限的那一边 —— 轨迹越扁，横向实际占比越小"
      ),
    "轨迹位置X": z.number().step(0.01).min(0).max(1).describe("0=贴左，0.5=居中，1=贴右"),
    "轨迹位置Y": z.number().step(0.01).min(0).max(1).describe("0=贴顶，0.5=居中，1=贴底"),
    "显示底图": z.boolean().describe("卫星底图。默认关闭（平面展示）。开启前需先跑 fetch-trail-tiles 取瓦片，否则整片空白"),
    "底图不透明度": z.number().step(0.02).min(0).max(1),
    "底图暗化": z.number().step(0.02).min(0).max(1).describe("叠一层黑，压掉卫星影像的亮部，让轨迹与剖面更突出"),
    "底图去色": z.number().step(0.02).min(0).max(1).describe("0=保留原色，1=完全灰度"),
    "底图模糊": z.number().step(0.5).min(0).max(24).describe("px。轻微模糊能让卫星图的细节退后"),
    "背景色": zColor().describe("画布底色"),
    "透明背景": z
      .boolean()
      .describe("开启后画布不铺底色（alpha=0），用于剪映等剪辑软件叠加；此时「背景色」不生效"),
  }),

  // ② 轨迹绘制
  "轨迹": z.object({
    "显示轨迹": z
      .boolean()
      .describe(
        "轨迹总开关。关掉后轨迹线、头部光点、起终点、标注、自定义途经点一起隐藏（底图不受影响），可只留海拔剖面"
      ),
    "轨迹颜色": zColor().describe("未走路段（幽灵路径）的颜色"),
    "已走颜色": zColor().describe("已走路段的颜色"),
    "线宽": z.number().step(0.5).min(1).max(30),
    "未走不透明度": z.number().step(0.02).min(0).max(1).describe("尚未走到的路段的不透明度（幽灵路径）"),
    "显示光晕": z.boolean(),
    "光晕倍数": z.number().step(0.1).min(1).max(6),
    "头部点半径": z.number().step(1).min(0).max(40),
    "显示起终点": z.boolean(),
    "标注显示": z
      .enum(TRAIL_MARK_MODES)
      .describe("KML 自带的途经标注。默认关闭 —— 需要什么点由「自定义途经点」自己加"),
    "标注字号": z.number().step(1).min(8).max(48),
    "标注颜色": zColor(),
    "途经点显示": z.boolean().describe("显示自己添加的途经点"),
    "途经点颜色": zColor().describe("途经点的默认颜色（单个点可在数据里覆盖）"),
    "途经点字号": z.number().step(1).min(8).max(48).describe("途经点标签的默认字号（单个点可覆盖）"),
    "途经点形状": z.enum(SHAPE_ENUM).describe("标记形状的默认值。「无」= 只显示文字标签，不画标记"),
    "途经点大小": z.number().step(0.5).min(1).max(40).describe("标记大小的默认值（px，语义=半径；图钉/菱形等按各自比例缩放）"),
    "途经点标签位置": z.enum(LABEL_POS_ENUM).describe("文字相对标记的位置。偏移量会自动加上标记自身的外沿，所以换形状不会压字"),
    "途经点标签偏移": z.number().step(1).min(0).max(120).describe("标签与标记外沿之间的额外间隙（px）"),
    "途经点透明度": z.number().step(0.02).min(0).max(1).describe("途经点的整体不透明度（单个点可覆盖）"),
    "走到后出现": z.boolean().describe("自定义途经点是否等轨迹走到才出现。关闭=全程一直可见"),
    "自定义途经点": z
      .string()
      .describe(
        'JSON 数组。定位二选一：{"名称":"南天门","里程km":2.1} 或 {"名称":"营地","经纬度":[113.05,34.48]}；' +
          '每点可选样式：「颜色」「标签颜色」「形状」「大小」「字号」「标签位置」「标签偏移」「透明度」「显示(false 可临时隐藏)」。' +
          "缺省的字段跟随上面的全局默认"
      ),
  }),

  // ③ 海拔剖面
  "海拔剖面": z.object({
    "剖面模式": z
      .enum(TRAIL_PROFILE_MODES)
      .describe("整条显示=全程曲线一屏铺满，游标随里程从左到右扫（配合平面全景，一页看完）；跟随窗口=只画游标附近一段"),
    "显示": z.boolean(),
    "离底距离": z.number().step(5).min(0).max(700).describe("剖面绘图区底边距画面底部的像素"),
    "高度": z.number().step(5).min(80).max(720),
    "左留白": z.number().step(5).min(0).max(600).describe("给左侧「上限/下限 m」标签留出的宽度"),
    "右留白": z.number().step(5).min(0).max(600),
    "线颜色": zColor(),
    "线宽": z.number().step(0.5).min(1).max(20),
    "平滑窗口": z.number().step(1).min(1).max(81).describe("沿里程的对称滑动平均窗口（单位=采样点，每点 10 m）。手机 GPS 海拔噪声很大，默认 11 点≈110 m"),
    "显示里程窗口米": z.number().step(250).min(500).max(31000).describe("仅「跟随窗口」模式生效：剖面横向铺开多少米的地面"),
    "游标位置": z.number().step(0.01).min(0.05).max(0.95).describe("仅「跟随窗口」模式生效：游标在绘图区里的横向占比"),
    "填充不透明度": z.number().step(0.02).min(0).max(1).describe("曲线下方的渐变面积"),
    "未走不透明度": z.number().step(0.02).min(0).max(1),
    "内衬不透明度": z.number().step(0.02).min(0).max(1).describe("绘图区底衬黑幕，保证曲线在底图上可读"),
  }),

  // ④ 剖面游标与读数
  "剖面游标": z.object({
    "显示": z.boolean(),
    "线颜色": zColor(),
    "线宽": z.number().step(0.5).min(1).max(12),
    "点半径": z.number().step(0.5).min(0).max(24),
    "读数显示": z.boolean(),
    "读数字号": z.number().step(1).min(16).max(140).describe("游标上方的实时海拔数字（参考图里的「39 m」）"),
    "读数颜色": zColor(),
    "读数上移": z.number().step(2).min(0).max(300).describe("读数整体相对绘图区顶边上移的像素"),
  }),

  // ⑤ 纵轴刻度
  "坐标轴": z.object({
    "显示上下限": z.boolean(),
    "下限模式": z.enum(TRAIL_AXIS_MODES),
    "固定下限": z.number().step(10).min(0).max(4000),
    "上限模式": z.enum(TRAIL_AXIS_MODES),
    "固定上限": z.number().step(10).min(100).max(6000),
    "字号": z.number().step(1).min(10).max(72),
    "颜色": zColor(),
    "显示上下基线": z.boolean(),
  }),

  // ⑥ 动画节奏
  "动画节奏": z.object({
    "时长秒": z.number().step(0.5).min(3).max(180).describe("整条轨迹走完的时长，直接决定合成时长（改这里时间轴会实时联动）"),
    "生长缓动": z.enum(EASING_OPTIONS),
    "开场淡入帧": z.number().step(1).min(0).max(90),
    "结尾定格帧": z.number().step(1).min(0).max(180),
  }),

  // ⑦ 标题
  "文字标题": z.object({
    "显示": z.boolean(),
    "主标题": z.string(),
    "副标题": z.string(),
    "字号": z.number().step(1).min(16).max(120),
    "颜色": zColor(),
  }),

  // ⑧ 实时数据读数（右上角）
  "数据读数": z.object({
    "显示": z.boolean(),
    "显示里程": z.boolean(),
    "显示海拔": z.boolean(),
    "显示进度": z.boolean(),
    "字号": z.number().step(1).min(12).max(80),
    "颜色": zColor(),
  }),
});

export type TrailProfileProps = z.infer<typeof trailProfileSchema>;

// ---------------------------------------------------------------------------
// ⚠ 默认值不在这里，在 src/trail-profile-defaults.json —— 唯一真相源。
//   Root.tsx 用它做 defaultProps、调参台读它/写它、组件用它兜底缺失字段。
//   若把默认值写在这里，就会出现「调参台保存后不生效（组件还在用代码里的默认值）」
//   这类最难查的分叉，故一律从 JSON 取。
//
//   另：默认值对应 src/trail-profile-defaults.json 里的数值，
//   改 schema 的上下限后必须重跑 node scripts/fetch-trail-tiles.mjs，
//   因为瓦片是按「视野宽度 / 前瞻距离 的参数区间并集」预取的。
// ---------------------------------------------------------------------------

