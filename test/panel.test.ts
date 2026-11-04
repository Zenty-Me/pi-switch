import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CapabilitiesPanel } from "../src/panel.ts";
import { type ProjectModel } from "../src/model.ts";

function setup() {
  const file = { path: "/project/.pi/config.json", text: undefined, data: {} };
  const model: ProjectModel = {
    cwd: "D:/中文项目", settings: file, mcp: file, globalSettings: file, globalMcp: file,
    rows: [
      { id: "skill:first", kind: "skill", name: "中文测试技能", description: "论文与测试说明", source: "全局", state: "inherit", initial: "inherit", inheritedEnabled: true, editable: true },
      { id: "skill:second", kind: "skill", name: "web", description: "网站", source: "项目", state: "inherit", initial: "inherit", inheritedEnabled: true, editable: true },
      { id: "mcp:docs", kind: "mcp", name: "docs", description: "文档服务", source: "全局 mcp.json", state: "inherit", initial: "inherit", inheritedEnabled: true, editable: true },
    ],
  };
  let result: string | undefined;
  const tui = { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI;
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as Theme;
  const panel = new CapabilitiesPanel({ model, tui, theme, kb: getKeybindings(), done(value) { result = value; } });
  return { model, panel, result: () => result };
}
function click(panel: CapabilitiesPanel, x: number, y: number) {
  panel.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y,
    width: 100, height: 30, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
}

test("keyboard switches tabs, filters, toggles and restores inheritance", () => {
  const { model, panel } = setup();
  panel.handleInput("论文");
  const lines = panel.render(80).join("\n");
  assert.ok(lines.includes("中文测试技能"));
  assert.ok(!lines.includes(" web ·"));
  panel.handleInput(" ");
  assert.equal(model.rows[0].state, "off");
  panel.handleInput("\u0012"); // Ctrl+R
  assert.equal(model.rows[0].state, "inherit");
  panel.handleInput("\u0015"); // Ctrl+U clears query
  panel.handleInput("\t");
  assert.ok(panel.render(80).join("\n").includes("docs"));
  panel.handleInput(" ");
  assert.equal(model.rows[2].state, "off");
});

test("closing with pending edits requires discard or save", () => {
  const { panel, result } = setup();
  panel.handleInput(" ");
  panel.handleInput("\u001b");
  assert.equal(result(), undefined);
  assert.ok(panel.render(80).join("\n").includes("有未保存修改"));
  panel.handleInput("\u001b");
  assert.equal(result(), undefined);
  panel.handleInput("\u0013");
  assert.equal(result(), "save");
});

test("full-screen mouse clicks toggle a row and activate save", () => {
  const { panel, model, result } = setup();
  const lines = panel.render(100);
  const y = lines.findIndex((line) => line.includes("中文测试技能"));
  click(panel, 6, y);
  assert.equal(model.rows[0].state, "off");
  const saveY = panel.render(100).findIndex((line) => line.includes("保存并重新加载"));
  click(panel, 5, saveY);
  assert.equal(result(), "save");
});

test("wide Chinese text fits narrow and normal terminal columns", () => {
  const { panel } = setup();
  panel.focused = true;
  for (const width of [24, 60, 100]) {
    for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});
