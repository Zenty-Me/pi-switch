import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CapabilitiesPanel, type PanelPage, type PanelResult } from "../src/panel.ts";
import type { Workspace } from "../src/presets.ts";
import { type ProjectModel, type ResourceRow } from "../src/model.ts";

function resource(name: string, options: Partial<ResourceRow> = {}): ResourceRow {
  return { id: `skill:${name}`, kind: "skill", name, description: "论文与测试说明", source: "全局",
    group: "全局 Skills", state: "inherit", initial: "inherit", inheritedEnabled: true, editable: true, ...options };
}
function setup(rows = [resource("中文测试技能"), resource("web", { source: "项目", group: "项目 Skills" }),
  resource("docs", { id: "mcp:docs", kind: "mcp", description: "文档服务", source: "全局 mcp.json", group: "全局 MCP" })],
  page: PanelPage = "resources", workspace?: Workspace) {
  const file = { path: "/project/.pi/config.json", text: undefined, data: {} };
  const model: ProjectModel = { cwd: "D:/中文项目", settings: file, mcp: file, globalSettings: file, globalMcp: file, rows };
  let result: PanelResult | undefined;
  const terminal = { rows: 30 };
  const tui = { terminal, requestRender() {} } as unknown as TUI;
  const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value,
    bold: (value: string) => value } as Theme;
  const panel = new CapabilitiesPanel({ model, workspace, page, tui, theme, kb: getKeybindings(), done(value) { result = value; } });
  return { model, panel, terminal, result: () => result };
}
function click(panel: CapabilitiesPanel, x: number, y: number) {
  return panel.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y,
    width: 110, height: 30, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
}
function button(panel: CapabilitiesPanel, label: string, width = 110) {
  const lines = panel.render(width);
  const target = ` ${label.trim()} `;
  const y = lines.findIndex((line) => line.includes(target));
  assert.ok(y >= 0, `Missing action: ${label}\n${lines.join("\n")}`);
  const x = visibleWidth(lines[y].slice(0, lines[y].indexOf(target))) + 1;
  return click(panel, x, y);
}
function itemY(panel: CapabilitiesPanel, name: string, width = 110) {
  const y = panel.render(width).findIndex((line) => /\[[x ]\]/.test(line) && line.includes(name));
  assert.ok(y >= 0, `Missing row ${name}`);
  return y;
}

test("keyboard searches, switches tabs, toggles and restores the default setting", () => {
  const { model, panel } = setup();
  panel.handleInput("中文");
  assert.ok(panel.render(80).join("\n").includes("中文测试技能"));
  panel.handleInput(" ");
  assert.equal(model.rows[0].state, "off");
  panel.handleInput("\u0012");
  assert.equal(model.rows[0].state, "inherit");
  panel.handleInput("\u0015");
  panel.handleInput("\t");
  panel.handleInput(" ");
  assert.equal(model.rows[2].state, "off");
});

test("wide view separates list and inline details while hiding batch actions and key tables", () => {
  const { panel } = setup();
  const lines = panel.render(110);
  assert.ok(lines.some((line) => /\[[x ]\]/.test(line) && line.includes(" │ ")));
  for (const label of ["本项目设置", "用途", "按默认", "批量操作", "保存并应用"]) {
    assert.ok(lines.join("\n").includes(label), label);
  }
  for (const label of ["全部开启（", "全部关闭（", "Ctrl+S", "Alt+E", "继承"]) {
    assert.ok(!lines.join("\n").includes(label), label);
  }
  const row = lines[itemY(panel, "中文测试技能")];
  assert.ok(row.includes("开启"));
  assert.ok(!row.includes("项目启用"));
});

test("closing pending edits offers return, discard and save without keyboard-only buttons", () => {
  const { panel, result } = setup();
  panel.handleInput(" ");
  button(panel, "放弃修改");
  assert.equal(result(), undefined);
  assert.ok(panel.render(80).join("\n").includes("尚未保存"));
  button(panel, "继续编辑");
  button(panel, "放弃修改");
  button(panel, "保存并应用");
  assert.equal(result(), "save");
});

test("clicking a row only selects; its checkbox and right-side controls change the switch", () => {
  const { panel, model } = setup();
  let y = itemY(panel, "中文测试技能");
  click(panel, 15, y);
  assert.equal(model.rows[0].state, "inherit");
  y = itemY(panel, "中文测试技能");
  click(panel, 5, y);
  assert.equal(model.rows[0].state, "off");
  button(panel, "按默认");
  assert.equal(model.rows[0].state, "inherit");
});

test("inactive save, separators and blank space are not actionable", () => {
  const { panel, model, result } = setup();
  const lines = panel.render(110);
  const saveY = lines.findIndex((line) => line.includes("保存并应用"));
  click(panel, 100, saveY);
  click(panel, 0, saveY);
  const rowY = itemY(panel, "中文测试技能");
  const row = panel.render(110)[rowY];
  const divider = visibleWidth(row.slice(0, row.indexOf(" │ "))) + 1;
  assert.equal(click(panel, divider, rowY), undefined);
  assert.equal(result(), undefined);
  assert.ok(model.rows.every((row) => row.state === "inherit"));
});

test("batch menu states scope/count and applies all filtered rows, not just the viewport", () => {
  const targets = Array.from({ length: 24 }, (_, i) => resource(`fixture-lark-${i}`));
  const readOnly = resource("fixture-lark-readonly", { editable: false });
  const unrelated = resource("other");
  const mcp = resource("fixture-lark-mcp", { kind: "mcp" });
  const { panel } = setup([...targets, readOnly, unrelated, mcp]);
  panel.handleInput("fixture-lark");
  button(panel, "批量操作");
  assert.ok(panel.render(100).join("\n").includes("24 项可修改，1 项只读"));
  button(panel, "全部关闭（24）");
  assert.ok(targets.every((row) => row.state === "off"));
  assert.equal(readOnly.state, "inherit");
  assert.equal(unrelated.state, "inherit");
  assert.equal(mcp.state, "inherit");
  button(panel, "批量操作");
  button(panel, "全部按默认（24）");
  assert.ok(targets.every((row) => row.state === "inherit"));
});

test("filters are selectable explicitly, distinguish saved overrides from pending changes", () => {
  const { panel, model } = setup();
  model.rows[1].initial = "off"; model.rows[1].state = "off";
  button(panel, "全部 ▾");
  button(panel, "项目单独设置");
  assert.ok(!panel.render(100).some((line) => /\[[x ]\]/.test(line) && line.includes("中文测试技能")));
  assert.ok(panel.render(100).some((line) => /\[[x ]\]/.test(line) && line.includes("web")));
  panel.handleInput("\u001bOQ"); // F2: pending filter
  assert.ok(panel.render(100).join("\n").includes("没有待保存项"));
  panel.handleInput("\u001bOQ");
  itemY(panel, "中文测试技能", 100);
});

test("model proposals open the matching tab and show reasons, pending states and unknown MCP connection", () => {
  const row = resource("docs", { kind: "mcp", state: "off", reason: "这个项目暂不需要文档 MCP", group: "全局 MCP" });
  const { panel } = setup([row]);
  const lines = panel.render(110).join("\n");
  for (const label of ["待保存 ▾", "模型建议", "这个项目暂不需要文档 MCP", "已保存 开启 → 待应用 关闭", "保存并应用（1）"]) {
    assert.ok(lines.includes(label), label);
  }
  panel.handleInput("\u001bOR"); // F3
  assert.ok(panel.render(110).join("\n").includes("连接状态：未知"));
  assert.ok(!panel.render(110).join("\n").includes("连接状态：已连接"));
});

test("undo in the batch menu resets drafts without changing prior saved settings", () => {
  const first = resource("first", { initial: "off", state: "on", reason: "模型建议" });
  const second = resource("second", { state: "off" });
  const { panel } = setup([first, second]);
  button(panel, "批量操作");
  button(panel, "撤销全部待保存（2）");
  assert.equal(first.state, "off");
  assert.equal(second.state, "inherit");
  assert.equal(first.reason, undefined);
});

test("help opens on demand and returning does not mutate settings", () => {
  const { panel, model } = setup();
  button(panel, "帮助");
  assert.ok(panel.render(100).join("\n").includes("Ctrl+S"));
  button(panel, " 返回 ");
  assert.ok(!panel.render(100).join("\n").includes("Ctrl+S"));
  assert.ok(model.rows.every((row) => row.state === row.initial));
});

test("single-column layout preserves switches and primary save on narrow terminals", () => {
  const { panel, terminal, result } = setup([resource("docs", { kind: "mcp", state: "off", reason: "建议关闭" })]);
  terminal.rows = 20;
  const lines = panel.render(40);
  assert.ok(lines.length <= 19, `${lines.length} rows\n${lines.join("\n")}`);
  assert.ok(!lines.some((line) => /\[[x ]\]/.test(line) && line.includes(" │ ")));
  assert.ok(lines.join("\n").includes("按默认"));
  button(panel, "保存并应用（1）", 40);
  assert.equal(result(), "save");
});

test("all sheets and long Chinese labels fit resize breakpoints without stale mouse targets", () => {
  const many = Array.from({ length: 105 }, (_, i) => resource(`长中文技能-${i}`, {
    description: "很长的说明".repeat(50), source: "全局\u001b[31m\n注入", group: "全局 Skills" }));
  const { panel, terminal } = setup(many);
  panel.focused = true;
  for (const [width, height] of [[24, 24], [40, 20], [60, 24], [104, 24], [110, 30], [160, 40]]) {
    terminal.rows = height;
    const lines = panel.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    assert.ok(lines.length <= Math.floor(height * 0.95), `${width}x${height}: ${lines.length}`);
  }
  terminal.rows = 20;
  button(panel, "帮助", 40);
  for (const line of panel.render(40)) assert.ok(visibleWidth(line) <= 40);
  panel.handleInput("\u001b");
  button(panel, "MCP 0", 60);
  assert.ok(panel.render(60).join("\n").includes("没有匹配的 MCP"));
});

test("full details are scrollable and viewing them does not change any switch", () => {
  const reason = `${"长建议说明".repeat(100)}最后一段理由`;
  const row = resource("long-reason", { state: "off", reason });
  const { panel } = setup([row]);
  button(panel, "详情 ›", 60);
  assert.ok(panel.render(60).join("\n").includes("资源详情"));
  for (let i = 0; i < 40; i++) { panel.render(60); panel.handleInput("\u001b[6~"); }
  const lines = panel.render(60);
  assert.ok(lines.map((line) => line.replace(/[│\s]/g, "")).join("").includes("最后一段理由"));
  assert.equal(row.state, "off");
  button(panel, "返回列表", 60);
  assert.ok(!panel.render(60).join("\n").includes("资源详情"));
});

test("scrolling the right detail pane never moves or toggles the selected list row", () => {
  const row = resource("long-reason", { state: "off", reason: "长建议说明".repeat(100) });
  const { panel } = setup([row, resource("other")]);
  let lines = panel.render(110);
  const selected = lines.find((line) => line.includes("› ["));
  const y = lines.findIndex((line) => line.includes("模型建议"));
  panel.handleMouse({ type: "wheel", button: "none", x: 90, y: y + 1, screenX: 90, screenY: y + 1,
    width: 110, height: 30, shift: false, alt: false, ctrl: false, wheelDelta: 3 });
  lines = panel.render(110);
  assert.equal(lines.find((line) => line.includes("› ["))?.split(" │ ")[0], selected?.split(" │ ")[0]);
  assert.equal(row.state, "off");
});

test("search accepts mouse focus without changing resource switches", () => {
  const { panel, model } = setup();
  const y = panel.render(110).findIndex((line) => line.includes("搜索"));
  assert.equal(click(panel, 13, y)?.handled, true);
  panel.handleInput("中文");
  const lines = panel.render(110);
  assert.ok(lines.some((line) => /\[[x ]\]/.test(line) && line.includes("中文测试技能")));
  assert.ok(!lines.some((line) => /\[[x ]\]/.test(line) && line.includes("web")));
  assert.ok(model.rows.every((row) => row.state === row.initial));
});
