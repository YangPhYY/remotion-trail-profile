#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 提交前自检：仓库里是否混入了凭据。
//
//   node scripts/check-secrets.mjs
//
// 退出码 0 = 干净；1 = 发现可疑内容（会列出 文件:行号 + 命中片段前 6 位）。
//
// 检查三类：
//   1) 32 位十六进制串 —— 高德 key / jscode 就是这个格式
//   2) AMAP_XXX_KEY=非空值
//   3) securityJsCode 明文赋值
//
// 用 git 钩子自动跑：
//   echo 'node scripts/check-secrets.mjs || exit 1' > .git/hooks/pre-commit
//   chmod +x .git/hooks/pre-commit      # Windows 下 git 也会执行
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "out", ".bundle", "dist", ".cache"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mov", ".mp4", ".webm", ".zip"]);

const RULES = [
  { re: /\b[0-9a-f]{32}\b/gi, why: "32 位十六进制串（高德 key / 安全密钥的格式）" },
  { re: /AMAP_[A-Z_]*(?:KEY|CODE)\s*=\s*[0-9a-zA-Z]{16,}/g, why: "环境变量被填了真实值（.env.example 里必须留空）" },
  { re: /securityJsCode\s*[:=]\s*["'][0-9a-zA-Z]{8,}/g, why: "JS API 安全密钥明文" },
  { re: /key=[0-9a-f]{32}/gi, why: "URL 里内联了 key" },
];

const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full);
      continue;
    }
    if (SKIP_FILES.has(name)) continue;
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
    if (SKIP_EXT.has(ext)) continue;
    if (st.size > 4 * 1024 * 1024) continue;

    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        if (!rule.re.test(lines[i])) continue;
        rule.re.lastIndex = 0;
        const m = rule.re.exec(lines[i]);
        hits.push({
          file: rel,
          line: i + 1,
          why: rule.why,
          frag: m ? `${m[0].slice(0, 6)}…` : "",
        });
      }
    }
  }
}

walk(ROOT);

if (hits.length === 0) {
  console.log("✓ 未发现凭据。可以提交。");
  process.exit(0);
}

console.error(`✗ 发现 ${hits.length} 处可疑内容：\n`);
const byFile = new Map();
for (const h of hits) {
  if (!byFile.has(h.file)) byFile.set(h.file, []);
  byFile.get(h.file).push(h);
}
for (const [file, list] of byFile) {
  console.error(`  ${file}`);
  for (const h of list) console.error(`    L${h.line}  ${h.why}   ${h.frag}`);
}
console.error(`
处理方式：
  · .env 里的真实值 → 删掉，只留 .env.example 的空键
  · 生成的 HTML（如 path-viewer-3d.html）→ 不要提交，它在 .gitignore 里
  · 已经 commit 过 → 光删文件没用，历史里还在，必须去高德控制台重置 key
`);
process.exit(1);
