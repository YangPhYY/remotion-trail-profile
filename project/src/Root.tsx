import React from "react";
import { Composition } from "remotion";
import {
  TrailProfile,
  trailCalculateMetadata,
  TRAIL_FPS,
  TRAIL_WIDTH,
  TRAIL_HEIGHT,
} from "./TrailProfile";
import { trailProfileSchema } from "./trail-profile-schema";
import type { TrailProfileProps } from "./trail-profile-schema";
import trailProfileDefaults from "./trail-profile-defaults.json";

/**
 * 本仓库只注册一个合成：TrailProfile（轨迹生长 + 海拔剖面同步）。
 *
 * 几何/海拔全部来自 src/trail-profile-data.json，
 * 由 scripts/build-trail-profile.mjs 从 KML/GPX 生成 —— 组件本身不持坐标。
 *
 * 时长由默认参数「动画节奏 · 时长秒」经 calculateMetadata 联动，
 * 所以改时长不用动这里。
 */
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="TrailProfile"
      component={TrailProfile}
      schema={trailProfileSchema}
      calculateMetadata={trailCalculateMetadata}
      durationInFrames={Math.round(45 * TRAIL_FPS) + 45}
      fps={TRAIL_FPS}
      width={TRAIL_WIDTH}
      height={TRAIL_HEIGHT}
      defaultProps={trailProfileDefaults as unknown as TrailProfileProps}
    />
  );
};
