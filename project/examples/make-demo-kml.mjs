// 生成一条**虚构**的环形轨迹 KML，用于验证整条流水线（不涉及任何真实地点）。
//
//   node examples/make-demo-kml.mjs            → examples/demo-loop.kml
//   node scripts/build-trail-profile.mjs examples/demo-loop.kml --step=10 --no-verify
//
// 为什么要虚构：真实 KML 会暴露你的常去地点。示例只求「能跑通」，
// 形状/里程/海拔自洽即可，坐标落在远离陆地的海面。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "demo-loop.kml");

// 中心点：几内亚湾海面，纯虚构，不对应任何地点
const C_LNG = 0.02;
const C_LAT = 0.02;
const R_DEG = 0.00972; // ≈1082 m → 周长约 6.8 km

const N = 360;
const pts = [];
for (let i = 0; i <= N; i++) {
  const t = i / N;
  const a = t * Math.PI * 2;
  // 轻微不规则，避免像圆规画的
  const r = 1 + 0.18 * Math.sin(a * 2 + 0.7) + 0.07 * Math.sin(a * 5);
  const lng = C_LNG + R_DEG * r * Math.cos(a);
  const lat = C_LAT + R_DEG * r * Math.sin(a);
  // 海拔：一圈两起两落，600~760 m
  const ele = 620 + 90 * Math.sin(a) + 55 * Math.sin(a * 2 + 1.1);
  pts.push(`${lng.toFixed(6)},${lat.toFixed(6)},${ele.toFixed(1)}`);
}

const coords = pts.join(" ");
const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>示例环线（虚构坐标）</name>
    <description>由 examples/make-demo-kml.mjs 生成，坐标为虚构值，仅用于验证渲染流程。</description>
    <Placemark>
      <name>示例环线 Demo Loop</name>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>
    <Placemark>
      <name>起点</name>
      <Point>
        <coordinates>${C_LNG + R_DEG},${C_LAT},620</coordinates>
      </Point>
    </Placemark>
    <Placemark>
      <name>垭口</name>
      <Point>
        <coordinates>${C_LNG - R_DEG * 0.2},${C_LAT + R_DEG},765</coordinates>
      </Point>
    </Placemark>
  </Document>
</kml>
`;

writeFileSync(OUT, kml, "utf8");
console.log(`✓ 已生成 ${OUT}`);
console.log(`  ${N + 1} 个坐标点 / 周长约 6.8 km / 海拔 600~765 m`);
console.log(`  下一步：node scripts/build-trail-profile.mjs examples/demo-loop.kml --step=10 --no-verify`);
