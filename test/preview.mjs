// Development-only visual snapshots, generated from the native panel renderer and Pi themes.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { CapabilitiesPanel } from "../src/panel.ts";

const hostTheme = join(getPackageDir(), "dist/modes/interactive/theme");
const { loadThemeFromPath, getResolvedThemeColors } = await import(pathToFileURL(join(hostTheme, "theme.js")).href);
const escape = (value) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const fixtures = [
  ["clean-code", "保持代码简洁，避免不必要的抽象和注释。"],
  ["nextjs", "Next.js 应用开发：路由、Server Components 与数据加载。"],
  ["supabase", "Supabase 数据库、身份认证和服务集成。"],
  ["lark-doc", "飞书云文档的读取、创建与编辑。", "off", "当前项目不涉及飞书文档，建议仅在本项目关闭；其他项目不受影响。"],
  ["lark-im", "飞书消息与群聊管理。", "off", "当前任务无需飞书消息能力。"],
  ["paper-review", "学术论文投稿前审阅。", "off", "该项目是 Web 应用，不涉及论文投稿。"],
  ["project-conventions", "当前项目的编码和提交约定。", undefined, undefined, "项目 Skills"],
  ["browser-policy", "浏览器自动化的安全规范。", undefined, undefined, "扩展包 Skills"],
].map(([name, description, state, reason, group]) => ({ id: `skill:${name}`, kind: "skill", name, description,
  source: group ?? "全局 Skills", group: group ?? "全局 Skills", state: state ?? "inherit", initial: "inherit", inheritedEnabled: true, editable: true, reason }));

function svg(lines, width, colors, background) {
  const cells = new Intl.Segmenter("zh", { granularity: "grapheme" });
  const cw = 8.4; const ch = 22; const pad = 20;
  const output = [`<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pi 项目能力面板原生渲染" width="${width * cw + pad * 2}" height="${lines.length * ch + pad * 2}"><rect width="100%" height="100%" fill="${background}"/>`];
  lines.forEach((line, y) => {
    const state = { fg: colors.text, bg: undefined, bold: false };
    let x = 0;
    for (const part of line.replace(/\x1b_[\s\S]*?\x07/g, "").split(/(\x1b\[[\d;]*m)/)) {
      if (part.startsWith("\x1b[")) {
        const codes = part.slice(2, -1).split(";").map(Number);
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i];
          if (code === 0) { state.fg = colors.text; state.bg = undefined; state.bold = false; }
          else if (code === 1) state.bold = true;
          else if (code === 22) state.bold = false;
          else if (code === 39) state.fg = colors.text;
          else if (code === 49) state.bg = undefined;
          else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
            state[code === 38 ? "fg" : "bg"] = `rgb(${codes.slice(i + 2, i + 5).join(",")})`; i += 4;
          }
        }
        continue;
      }
      for (const { segment } of cells.segment(part)) {
        const columns = visibleWidth(segment);
        if (state.bg) output.push(`<rect x="${pad + x * cw}" y="${pad + y * ch}" width="${columns * cw}" height="${ch}" fill="${state.bg}"/>`);
        if (segment.trim()) output.push(`<text x="${pad + x * cw}" y="${pad + y * ch + 16}" fill="${state.fg}" font-weight="${state.bold ? "700" : "400"}" font-family="Consolas, Microsoft YaHei, monospace" font-size="14">${escape(segment)}</text>`);
        x += columns;
      }
    }
  });
  return output.join("") + "</svg>";
}

const cases = [["dark", 116, 34, "宽窗口 · 模型建议复核"], ["light", 116, 34, "浅色主题"],
  ["dark", 60, 24, "窄窗口 · 单栏"], ["dark", 100, 30, "批量操作菜单"]];
const directory = join(tmpdir(), "pi-project-capabilities-preview");
mkdirSync(directory, { recursive: true });
const screens = [];
for (const [name, width, rows, label] of cases) {
  const theme = loadThemeFromPath(join(hostTheme, `${name}.json`), "truecolor");
  const colors = getResolvedThemeColors(name);
  const file = { path: "fixture.json", text: undefined, data: {} };
  const model = { cwd: "D:/projects/web-console", settings: file, mcp: file, globalSettings: file, globalMcp: file,
    rows: [...structuredClone(fixtures), { id: "mcp:github", kind: "mcp", name: "github", description: "管理 PR 与 Issue。",
      source: "全局 mcp.json", group: "全局 MCP", initial: "inherit", state: "inherit", editable: true, inheritedEnabled: true }] };
  const panel = new CapabilitiesPanel({ model, theme, tui: { terminal: { rows }, requestRender() {} }, kb: getKeybindings(), done() {} });
  panel.handleInput("\x1bOQ"); // pending → all
  let lines = panel.render(width);
  const y = lines.findIndex((line) => /\[[x ]\]/.test(line) && line.includes("lark-doc"));
  if (y >= 0) panel.handleMouse({ type: "click", button: "left", x: 15, y, screenX: 15, screenY: y,
    width, height: rows, shift: false, alt: false, ctrl: false });
  if (label.includes("菜单")) panel.handleInput("\x1bOS");
  lines = panel.render(width);
  writeFileSync(join(directory, `${screens.length}.txt`), lines.join("\n"));
  screens.push(`<section id="screen-${screens.length}"><h2>${escape(label)} · ${width} 列 × ${rows} 行</h2>${svg(lines, width, colors, name === "dark" ? "#202027" : "#ffffff")}</section>`);
}
const html = `<!doctype html><meta charset="utf-8"><title>Pi panel visual QA</title><style>body{margin:32px;background:#e8e8ed;color:#282831;font:14px system-ui}h1{font-size:20px}h2{font-size:14px;font-weight:500;color:#555}section{margin:24px 0}svg{display:block;max-width:100%;height:auto;border-radius:8px;box-shadow:0 8px 24px #0001}</style><h1>原生面板渲染预览</h1><p>由实际 render() 输出和 Pi 内置主题生成；使用示例数据，不是运行中的终端截图。</p>${screens.join("")}`;
const path = join(directory, "index.html");
writeFileSync(path, html);
for (const [index, name] of ["dark", "light", "narrow", "batch"].entries()) {
  writeFileSync(join(directory, `${name}.html`), html.replace(screens.join(""), screens[index]));
}
console.log(JSON.stringify({ path, url: pathToFileURL(path).href, screens: cases.length }));
