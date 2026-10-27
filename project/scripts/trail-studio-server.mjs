#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 调参台本地服务：让 trail-studio.html 在「本地服务」下打开，
// 并暴露 POST /api/save-props，实现浏览器内一键保存参数到
// src/trail-profile-defaults.json（无需手动复制 + 终端命令）。
//
// 为什么必须走本地服务：浏览器 JS 不能直接写本地文件；而且 file:// 下
// ES 模块会被 CORS 拦掉（调参台要 import src/trail-scene.mjs）。
//
// 顺带做一件安全的事：保存前用 src/trail-params.mjs 的 clampPropsToSpec()
// 把每个值裁剪到参数表范围内 —— 防止手抖把「视野宽度米」写成 99999，
// 那样出片时会请求到没预取过的瓦片，画面出现空白。
//
// 用法：
//   npm run studio-trail                  # http://localhost:5232/trail-studio.html
//   npm run studio-trail -- --port 8080
// ---------------------------------------------------------------------------
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, sep, extname } from "node:path";
import { exec } from "node:child_process";
import { clampPropsToSpec, PARAM_GROUPS } from "../src/trail-params.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULTS_PATH = join(ROOT, "src", "trail-profile-defaults.json");

let PORT = 5232;
const pi = process.argv.indexOf("--port");
if (pi !== -1 && process.argv[pi + 1]) {
  const p = Number(process.argv[pi + 1]);
  if (Number.isFinite(p)) PORT = p;
}

const ALLOWED_EXT = new Set([
  ".html", ".js", ".mjs", ".css", ".json", ".png", ".jpg", ".jpeg",
  ".svg", ".ico", ".map", ".ts", ".webp", ".gif",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/" || urlPath === "") urlPath = "/trail-studio.html";
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");

  // 先在项目根找；找不到再退到 public/ 下找。
  // 这样数据里的瓦片路径（"trail-tiles/sat/16/x/y.jpg"）在调参台与 Remotion 里
  // **完全一致** —— Remotion 的 staticFile() 本身就映射到 public/，
  // 若在调参台给路径加 "public/" 前缀，两边就会出现「同一份数据、两个路径」的隐患。
  const candidates = [join(ROOT, safe), join(ROOT, "public", safe)];
  let filePath = null;
  for (const c of candidates) {
    if (c !== ROOT && !c.startsWith(ROOT + sep)) continue;
    const ext = extname(c).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    if (existsSync(c)) { filePath = c; break; }
  }
  if (!filePath) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = extname(filePath).toLowerCase();
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 5e6) req.destroy();
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = req.url.split("?")[0];

  if (req.method === "POST" && path === "/api/save-props") {
    try {
      const props = JSON.parse(await readBody(req));
      if (typeof props !== "object" || props === null || Array.isArray(props)) {
        throw new Error("参数必须是包含分组键的对象。");
      }
      const known = PARAM_GROUPS.map((g) => g.group);
      if (!known.some((k) => k in props)) {
        throw new Error("未识别到任何分组键（" + known.join("、") + "）。");
      }
      const defaults = JSON.parse(readFileSync(DEFAULTS_PATH, "utf8"));
      const merged = { ...defaults };
      for (const g of PARAM_GROUPS) {
        merged[g.group] = { ...(defaults[g.group] ?? {}), ...(props[g.group] ?? {}) };
      }
      // 裁剪到参数表范围后再落盘
      const clamped = clampPropsToSpec(merged, defaults);
      writeFileSync(DEFAULTS_PATH, JSON.stringify(clamped, null, 2) + "\n", "utf8");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, groups: Object.keys(clamped) }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

function listenOn(port) {
  server.listen(port, () => {
    const url = `http://localhost:${port}/trail-studio.html`;
    console.log("✓ 调参台已启动：" + url);
    console.log("  调好参数后点「保存到文件」即写回 src/trail-profile-defaults.json。");
    console.log("  Ctrl+C 停止。");
    try {
      exec(`cmd /c start "" "${url}"`, () => {});
    } catch {
      /* 打不开浏览器不影响使用，手动访问上面的链接即可 */
    }
  });
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 被占用，尝试 ${PORT + 1} …`);
    PORT += 1;
    listenOn(PORT);
  } else {
    console.error(e);
    process.exit(1);
  }
});

if (!existsSync(DEFAULTS_PATH)) {
  console.error("未找到 src/trail-profile-defaults.json，请先在项目根目录运行本脚本。");
  process.exit(1);
}

listenOn(PORT);
