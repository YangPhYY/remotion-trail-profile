import React from "react";
import { staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import trailData from "./trail-profile-data.json";
import trailDefaults from "./trail-profile-defaults.json";
import { makeGeo } from "./trail-geo.mjs";
import { buildTrailScene, trailDurationInFrames } from "./trail-scene.mjs";
import type { TrailProfileProps } from "./trail-profile-schema";

// ---------------------------------------------------------------------------
// TrailProfile —— 轨迹运动 与 海拔剖面 严格同步的动画
//
// 本文件**只有渲染**，不含任何几何/时序计算。所有参数解析、钳制、相机、
// 瓦片清单、轨迹路径、剖面折线、游标位置、文案与颜色都来自
// src/trail-scene.mjs 的 buildTrailScene() —— 调参台（trail-studio.html）
// 渲染的是同一个函数的输出，所以「调参台里长什么样，出片就是什么样」。
//
// ★ 严格对齐是怎么被保证的（而不是「努力做到」）
//   全局只有一个时间量：frame → progress → distM（累计里程，米）。
//   从同一个 distM 出发分别求值，但用的是同一个自变量：
//     ① 地图头部位置 = cam.toScreen(sampleAt(geo, distM))
//     ② 剖面游标海拔 = eleAt(geo, distM)（profileY 里用的 headPt.ele）
//     ③ 剖面曲线     = x = cursorX + (d − distM)·px/m
//   而 sampleAt 建立在「按等里程重采样」的数据上（下标 i ↔ i×stepM），
//   所以按里程取点是 O(1) 精确插值，不存在点密度差引起的错位。
//   右上角「海拔」读数取的也是 headPt.ele —— 与游标处曲线完全同值，
//   可以随时拿它做交叉验证：画面上的数字和曲线必然是同一个海拔。
// ---------------------------------------------------------------------------

export const TRAIL_FPS = 30;
export const TRAIL_WIDTH = 1920;
export const TRAIL_HEIGHT = 1080;

const GEO = makeGeo(trailData as unknown as Parameters<typeof makeGeo>[0]);
const DEFAULTS = trailDefaults as unknown as Record<string, Record<string, number>>;

/** 时长 = 走完时长 + 结尾定格；Studio 改「时长秒」时时间轴实时联动 */
export const trailCalculateMetadata: CalculateMetadataFunction<TrailProfileProps> = ({ props }) => ({
  durationInFrames: trailDurationInFrames(props, DEFAULTS, TRAIL_FPS),
});

/**
 * 标记图元 → SVG 元素。
 * ★ 形状几何（顶点、贝塞尔控制点、圆环粗细）一律来自 trail-scene.mjs 的 markShapes()，
 *   本组件只做「按 t 建元素」—— 与调参台是同一套图元，所以两边渲染必然一致。
 */
const MarkShapes: React.FC<{ shapes: any[] }> = ({ shapes }) => (
  <>
    {shapes.map((sh, i) => {
      if (sh.t === "circle")
        return (
          <circle
            key={i}
            cx={sh.cx}
            cy={sh.cy}
            r={sh.r}
            fill={sh.fill ?? "none"}
            stroke={sh.stroke}
            strokeWidth={sh.sw}
            strokeOpacity={sh.so}
          />
        );
      if (sh.t === "line")
        return (
          <line
            key={i}
            x1={sh.x1}
            y1={sh.y1}
            x2={sh.x2}
            y2={sh.y2}
            stroke={sh.stroke}
            strokeWidth={sh.sw}
            strokeLinecap="round"
          />
        );
      return (
        <path key={i} d={sh.d} fill={sh.fill ?? "none"} stroke={sh.stroke} strokeWidth={sh.sw} strokeOpacity={sh.so} />
      );
    })}
  </>
);

export const TrailProfile: React.FC<TrailProfileProps> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const s = buildTrailScene(GEO, DEFAULTS, props, frame, { width, height, fps });
  const m = s.map;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        width,
        height,
        backgroundColor: s.bgColor,
        overflow: "hidden",
        fontFamily: s.fontSans,
      }}
    >
      {/* ================= 地图：底图 + 轨迹，坐标系原点在地图区左上角 ================= */}
      {/* 地图区默认裁到剖面上沿（s.mapH），轨迹与头部标记不会压进 HUD */}
      <svg width={width} height={s.mapH} style={{ position: "absolute", left: 0, top: 0, opacity: s.fade }}>
        <defs>
          <linearGradient id="tp-darkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={m.darkTop} />
            <stop offset="100%" stopColor={m.darkBottom} />
          </linearGradient>
          <linearGradient id="tp-topFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(0,0,0,1)" stopOpacity={m.topFadeAlpha} />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </linearGradient>
          <clipPath id="tp-mapclip">
            <rect x={0} y={0} width={width} height={s.mapH} />
          </clipPath>
          <filter id="tp-glow" x="-25%" y="-25%" width="150%" height="150%">
            <feGaussianBlur stdDeviation={m.glow.std} />
          </filter>
        </defs>

        <g clipPath="url(#tp-mapclip)">
          {/* 离线瓦片（渲染零网络请求）。filter/brightness 走 CSS 滤镜，两侧渲染一致。
              ★ 默认「显示底图」= false —— 平面全景模式下不需要卫星影像，
                此时 tiles 为空数组，整层连同暗化一起不渲染（省掉几百张图的开销）。 */}
          {m.showBase && m.tiles.length ? (
            <>
              <g opacity={m.opacity} style={{ filter: m.filter }}>
                {m.tiles.map((t) => (
                  <image key={t.key} href={staticFile(t.src)} x={t.x} y={t.y} width={t.w} height={t.h} />
                ))}
              </g>

              {/* 暗化叠加（下重上轻，把视线压向剖面） */}
              <rect x={0} y={0} width={width} height={s.mapH} fill="url(#tp-darkGrad)" />
              {/* 顶部渐隐 */}
              <rect x={0} y={0} width={width} height={m.topFadeHeight} fill="url(#tp-topFade)" />
            </>
          ) : null}

          {/* 轨迹：整组吃一个 transform，相机移动不再逐帧重算 3100 个点。
              ★ 「轨迹 · 显示轨迹」= 总开关：关掉后这一组连同头部点/起终点/标注
                全部不渲染（后三者在场景模型里已按同一开关置空）。 */}
          {m.showTrack ? (
            <g transform={`translate(${m.gx.toFixed(3)} ${m.gy.toFixed(3)}) scale(${m.k})`}>
              {m.road ? (
                // ★ 路型模式：按里程分段画「路面带」。
                //   每段 = 包边（深色，模拟厚度）→ 未走底色（压暗）→ 已走底色（亮，dash 裁剪）。
                //   材质图元与徽标**不在这里**：它们是屏幕坐标（见下方独立一层），
                //   因为 scale(k) 下 1.8px 会变成 8e-8，踩到浮点精度下限直接画不出来。
                m.road.segments.map((seg: any) => (
                  <g key={seg.key}>
                    {seg.casing ? (
                      <path
                        d={seg.d}
                        fill="none"
                        stroke={seg.casing}
                        strokeWidth={seg.casingW}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={0.9}
                      />
                    ) : null}
                    <path
                      d={seg.d}
                      fill="none"
                      stroke={seg.base}
                      strokeWidth={seg.bandW}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={seg.baseAlpha ?? 0.4}
                    />
                    {seg.p > 0.01 ? (
                      <path
                        d={seg.d}
                        fill="none"
                        stroke={seg.done}
                        strokeWidth={seg.bandW}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        pathLength={1}
                        strokeDasharray={`${(seg.p / 100).toFixed(4)} 1`}
                      />
                    ) : null}
                  </g>
                ))
              ) : (
                <>
                  <path
                    d={m.trackPath}
                    fill="none"
                    stroke={m.ghost.color}
                    strokeOpacity={m.ghost.opacity}
                    strokeWidth={m.ghost.widthUser}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {m.glow.on ? (
                    <path
                      d={m.trackPath}
                      fill="none"
                      stroke={m.glow.color}
                      strokeOpacity={0.55}
                      strokeWidth={m.glow.widthUser}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      filter="url(#tp-glow)"
                      pathLength={1}
                      strokeDasharray={m.glow.dash}
                    />
                  ) : null}
                  {/* 已走部分：pathLength=1 + dasharray 局部绘制，比例按墨卡托弧长归一 */}
                  <path
                    d={m.trackPath}
                    fill="none"
                    stroke={m.done.color}
                    strokeWidth={m.done.widthUser}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pathLength={1}
                    strokeDasharray={m.done.dash}
                  />
                </>
              )}
            </g>
          ) : null}

          {/* 材质 + 徽标：屏幕坐标层（不随相机缩放）。位置由场景模型按 x*k+gx 算好，
              与上面那组 transform 是同一个仿射变换，所以严格重合。 */}
          {m.showTrack && m.road
            ? m.road.segments.map((seg: any) => (
                <g key={`m${seg.key}`} opacity={seg.decorAlpha ?? 1}>
                  {seg.decor.map((d: any, i: number) =>
                    d.t === "c" ? (
                      <circle key={`d${i}`} cx={d.cx} cy={d.cy} r={d.r} fill={d.f} opacity={d.o ?? 1} />
                    ) : (
                      <line
                        key={`d${i}`}
                        x1={d.x1}
                        y1={d.y1}
                        x2={d.x2}
                        y2={d.y2}
                        stroke={d.c}
                        strokeWidth={d.w}
                        strokeLinecap="round"
                      />
                    )
                  )}
                  {seg.badge ? (
                    <text
                      x={seg.badge.x}
                      y={seg.badge.y}
                      textAnchor={(seg.badge.anchor ?? "middle") as "start" | "middle" | "end"}
                      fontSize={seg.badge.fontSize}
                      fontWeight={600}
                      fill={seg.badge.color}
                      stroke={seg.badge.haloColor}
                      strokeWidth={seg.badge.haloWidth}
                      paintOrder="stroke"
                      opacity={seg.badge.opacity}
                    >
                      {seg.badge.text}
                    </text>
                  ) : null}
                </g>
              ))
            : null}

          {/* 起点 / 终点 / 头部光点（屏幕空间，不随相机缩放） */}
          {m.start ? (
            <>
              <circle cx={m.start.x} cy={m.start.y} r={7} fill="#FFD54F" />
              <circle cx={m.start.x} cy={m.start.y} r={13} fill="none" stroke="#FFD54F" strokeWidth={2} strokeOpacity={0.55} />
            </>
          ) : null}
          {m.end ? <circle cx={m.end.x} cy={m.end.y} r={13} fill="none" stroke="#FF4081" strokeWidth={4} /> : null}
          {m.head ? (
            <>
              <circle cx={m.head.x} cy={m.head.y} r={m.head.r * 2.1 * m.head.pulse} fill={m.head.color} opacity={0.2} />
              <circle cx={m.head.x} cy={m.head.y} r={m.head.r} fill={m.head.color} />
            </>
          ) : null}

          {/* 标注 / 自定义途经点：走到之后才出现（若开启「走到后出现」）。
              ★ 图元与标签几何全部由场景模型算好（buildMark / markShapes）：
                这里只做「平移到点位 + 按 t 建元素」，不推导任何形状或标签位置。
                每个点可以有自己的形状/大小/颜色/字号/标签位置/透明度。 */}
          {m.marks.list.map((mk) => (
            <g key={mk.key} opacity={mk.opacity}>
              {mk.shapes?.length ? (
                <g transform={`translate(${mk.x.toFixed(2)} ${mk.y.toFixed(2)})`}>
                  <MarkShapes shapes={mk.shapes} />
                </g>
              ) : null}
              {mk.label ? (
                <text
                  x={mk.label.x}
                  y={mk.label.y}
                  textAnchor={mk.label.anchor as "start" | "middle" | "end"}
                  fontSize={mk.label.fontSize}
                  fontWeight={mk.label.weight}
                  fill={mk.label.fill}
                  stroke={mk.label.haloColor}
                  strokeWidth={mk.label.haloWidth}
                  paintOrder="stroke"
                >
                  {mk.label.text}
                </text>
              ) : null}
            </g>
          ))}
        </g>
      </svg>

      {/* ================= 海拔剖面 HUD ================= */}
      {s.profile ? (
        <svg width={width} height={height} style={{ position: "absolute", left: 0, top: 0, opacity: s.fade }}>
          <defs>
            <linearGradient id="tp-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.profile.color} stopOpacity={s.profile.areaAlpha} />
              <stop offset="100%" stopColor={s.profile.color} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="tp-panel" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#000" stopOpacity={0} />
              <stop offset="45%" stopColor="#000" stopOpacity={0.42 * s.profile.panelAlpha} />
              <stop offset="100%" stopColor="#000" stopOpacity={0.72 * s.profile.panelAlpha} />
            </linearGradient>
            {/* 曲线裁剪：绝不越过左右留白压到轴标签上 */}
            <clipPath id="tp-profclip">
              <rect x={s.profile.plotLeft} y={s.profile.plotTop - 6} width={s.profile.plotW} height={s.profile.plotH + 12} />
            </clipPath>
            {/* 「已走」裁剪：以游标为界，左实右虚（同一路径切两段，首尾必然重合） */}
            <clipPath id="tp-profDone">
              <rect x={0} y={s.profile.plotTop - 200} width={s.profile.cursorX} height={s.profile.plotH + 400} />
            </clipPath>
          </defs>

          <rect x={0} y={s.profile.panelY} width={width} height={s.profile.panelH} fill="url(#tp-panel)" />

          {s.profile.axis?.lines ? (
            <>
              <line
                x1={s.profile.plotLeft}
                x2={s.profile.plotLeft + s.profile.plotW}
                y1={s.profile.axis.hiLineY}
                y2={s.profile.axis.hiLineY}
                stroke={s.profile.axis.color}
                strokeOpacity={0.28}
                strokeWidth={1.5}
              />
              <line
                x1={s.profile.plotLeft}
                x2={s.profile.plotLeft + s.profile.plotW}
                y1={s.profile.axis.loLineY}
                y2={s.profile.axis.loLineY}
                stroke={s.profile.axis.color}
                strokeOpacity={0.28}
                strokeWidth={1.5}
              />
            </>
          ) : null}

          <g clipPath="url(#tp-profclip)">
            {s.profile.areaAlpha > 0 ? <path d={s.profile.areaD} fill="url(#tp-area)" /> : null}
            <path
              d={s.profile.curveD}
              fill="none"
              stroke={s.profile.color}
              strokeOpacity={s.profile.ghostOpacity}
              strokeWidth={s.profile.lineWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <g clipPath="url(#tp-profDone)">
              <path
                d={s.profile.curveD}
                fill="none"
                stroke={s.profile.color}
                strokeWidth={s.profile.lineWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          </g>

          {s.profile.axis ? (
            <g
              fontSize={s.profile.axis.fontSize}
              fontWeight={500}
              fill={s.profile.axis.color}
              fillOpacity={0.92}
              textAnchor="end"
            >
              <text x={s.profile.axis.labelX} y={s.profile.axis.hiY}>
                {s.profile.axis.hiLabel}
              </text>
              <text x={s.profile.axis.labelX} y={s.profile.axis.loY}>
                {s.profile.axis.loLabel}
              </text>
            </g>
          ) : null}

          {s.profile.cursor ? (
            <g>
              <line
                x1={s.profile.cursor.x}
                x2={s.profile.cursor.x}
                y1={s.profile.cursor.y0}
                y2={s.profile.cursor.y1}
                stroke={s.profile.cursor.color}
                strokeWidth={s.profile.cursor.width}
                strokeOpacity={0.95}
              />
              {s.profile.cursor.r > 0 ? (
                <circle cx={s.profile.cursor.x} cy={s.profile.cursor.dotY} r={s.profile.cursor.r} fill={s.profile.cursor.color} />
              ) : null}
            </g>
          ) : null}

          {s.profile.readout ? (
            <text
              x={s.profile.readout.x}
              y={s.profile.readout.y}
              textAnchor="middle"
              fontSize={s.profile.readout.fontSize}
              fontWeight={700}
              fill={s.profile.readout.color}
              stroke="rgba(0,0,0,0.55)"
              strokeWidth={s.profile.readout.fontSize * 0.14}
              paintOrder="stroke"
              letterSpacing={1}
            >
              {s.profile.readout.text}
            </text>
          ) : null}

          {/* 游标坡度读数：海拔数字正下方一行，比读数小一半 */}
          {s.profile.slopeReadout ? (
            <text
              x={s.profile.readout?.x ?? s.profile.cursorX}
              y={s.profile.slopeReadout.y}
              textAnchor="middle"
              fontSize={s.profile.slopeReadout.fontSize}
              fontWeight={600}
              fill={s.profile.slopeReadout.color}
              fillOpacity={0.82}
              stroke="rgba(0,0,0,0.5)"
              strokeWidth={s.profile.slopeReadout.fontSize * 0.16}
              paintOrder="stroke"
            >
              {s.profile.slopeReadout.text}
            </text>
          ) : null}

          {/* 段坡度标注：只标 ≥ 下限的路型段，位置取段中点曲线正上方 */}
          {s.profile.slopeMarks?.map((sl: any, i: number) => (
            <text
              key={`sl${i}`}
              x={sl.x}
              y={sl.y}
              textAnchor="middle"
              fontSize={sl.fontSize}
              fontWeight={600}
              fill={sl.color}
              fillOpacity={0.9}
              stroke="rgba(0,0,0,0.5)"
              strokeWidth={sl.fontSize * 0.14}
              paintOrder="stroke"
              letterSpacing={0.5}
            >
              {sl.text}
            </text>
          ))}
        </svg>
      ) : null}

      {/* ================= 标题 ================= */}
      {s.title ? (
        <div style={{ position: "absolute", left: s.title.x, top: s.title.y, opacity: s.fade }}>
          <div
            style={{
              fontSize: s.title.main.fontSize,
              fontWeight: 700,
              color: s.title.main.color,
              letterSpacing: 4,
            }}
          >
            {s.title.main.text}
          </div>
          <div
            style={{
              fontSize: s.title.sub.fontSize,
              color: s.title.sub.color,
              opacity: 0.75,
              marginTop: 8,
              letterSpacing: 1,
            }}
          >
            {s.title.sub.text}
          </div>
        </div>
      ) : null}

      {/* ================= 实时数据（右上） ================= */}
      {s.hud ? (
        <div
          style={{
            position: "absolute",
            right: width - s.hud.x,
            top: s.hud.y,
            textAlign: "right",
            fontFamily: s.fontMono,
            color: s.hud.color,
            opacity: s.fade * 0.95,
            lineHeight: 1.5,
            textShadow: "0 2px 10px rgba(0,0,0,0.8)",
          }}
        >
          {s.hud.lines.map((l, i) => (
            <div key={i} style={{ fontSize: l.fontSize, fontWeight: l.weight, opacity: l.opacity }}>
              {l.text}
              {l.suffix ? <span style={{ fontSize: l.fontSize / 1.7, fontWeight: 400, opacity: 0.65 }}>{l.suffix}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
