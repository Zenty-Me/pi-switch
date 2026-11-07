import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { CapabilitiesPanel, type PanelPage, type PanelResult } from "../src/panel.ts";
import type { ProjectModel } from "../src/model.ts";
import { loadWorkspace, presetPath, readPreset, readSnapshot, type Workspace } from "../src/presets.ts";
import { openWorkbench } from "../src/workbench.ts";
import { PresetDraftStore } from "../src/preset-drafts.ts";

const theme = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value,
  bold: (value: string) => value, italic: (value: string) => value,
  underline: (value: string) => value, strikethrough: (value: string) => value } as Theme;
const terminal = { rows: 36 };
const tui = { terminal, requestRender() {} } as unknown as TUI;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-switch-workbench-"));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agent);
  const skillPath = join(root, "SKILL.md");
  const skillBody = "---\nname: example\ndescription: Example skill\n---\n# Full skill\nRead the existing implementation.\n\u001b[31mREAD_ONLY_END";
  writeFileSync(skillPath, skillBody);
  const projectText = "# Project-only instructions\nBuild with npm run check.\n";
  writeFileSync(join(cwd, "AGENTS.md"), projectText);
  const mcpData = { mcpServers: { docs: { url: "https://private.invalid", headers: { Authorization: "PRIVATE_TOKEN" } } } };
  const mcpText = JSON.stringify(mcpData);
  writeFileSync(join(agent, "mcp.json"), mcpText);
  const model: ProjectModel = {
    cwd, settings: { path: join(cwd, ".pi", "settings.json"), text: undefined, data: {} },
    mcp: { path: join(cwd, ".pi", "mcp.json"), text: undefined, data: {} },
    globalSettings: { path: join(agent, "settings.json"), text: undefined, data: {} },
    globalMcp: { path: join(agent, "mcp.json"), text: mcpText, data: mcpData },
    rows: [
      { kind: "skill", id: `skill:${skillPath}`, name: "example", description: "Example skill", path: skillPath,
        source: "全局", group: "全局 Skills", state: "inherit", initial: "inherit", inheritedEnabled: true, editable: true },
      { kind: "mcp", id: "mcp:docs", name: "docs", description: "Document service", source: "全局 mcp.json",
        group: "全局 MCP", state: "inherit", initial: "inherit", inheritedEnabled: true, editable: true },
    ],
  };
  mkdirSync(join(agent, "switch-presets"));
  writeFileSync(presetPath(agent, "web-dev"), JSON.stringify({ version: 1,
    resources: [{ kind: "skill", name: "example", enabled: false }], agentsMd: "Reusable rules" }));
  const workspace = loadWorkspace(cwd, agent);
  return { root, cwd, agent, model, workspace, skillPath, skillBody, projectText, mcpText };
}
function panelFor(f: ReturnType<typeof fixture>, page: PanelPage = "overview", workspace: Workspace = f.workspace) {
  let result: PanelResult | undefined;
  const panel = new CapabilitiesPanel({ model: f.model, workspace, page, tui, theme, kb: getKeybindings(),
    done(value) { result = value; } });
  return { panel, result: () => result };
}
function click(component: Component, label: string, width = 120) {
  const lines = component.render(width);
  const target = ` ${label} `;
  const y = lines.findIndex((line) => line.includes(target));
  assert.ok(y >= 0, `Missing button ${label}\n${lines.join("\n")}`);
  const x = visibleWidth(lines[y].slice(0, lines[y].indexOf(target))) + 1;
  return component.handleMouse?.({ type: "click", button: "left", x, y, screenX: x, screenY: y,
    width, height: terminal.rows, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
}

test("the workbench opens on the project overview and navigation preserves pending resource changes", () => {
  const f = fixture();
  const { panel } = panelFor(f);
  const initial = panel.render(120).join("\n");
  for (const label of ["当前项目", "Skills / MCP", "项目规则", "我的模板", "从模板初始化", "保存为模板"]) assert.ok(initial.includes(label));
  click(panel, "Skills / MCP");
  panel.handleInput(" ");
  assert.equal(f.model.rows[0].state, "off");
  click(panel, "项目规则");
  assert.ok(panel.render(120).join("\n").includes("尚未添加通用规则"));
  click(panel, "当前项目");
  assert.ok(panel.render(120).join("\n").includes("1 项待保存"));
  click(panel, "Skills / MCP");
  assert.equal(f.model.rows[0].state, "off");
});

test("keyboard navigation and rule-only drafts expose edit, discard and save without command arguments", () => {
  const f = fixture();
  f.workspace.rules!.value = "Draft rule";
  const first = panelFor(f);
  first.panel.handleInput("\u001b3");
  first.panel.handleInput("\u0005");
  assert.deepEqual(first.result(), { action: "edit-rules", page: "rules" });
  const second = panelFor(f, "rules");
  click(second.panel, "放弃修改");
  assert.equal(second.result(), undefined);
  click(second.panel, "放弃修改");
  assert.equal(second.result(), "cancel");
});

test("template saving, updating and full-text inspection have keyboard paths", () => {
  const f = fixture();
  const save = panelFor(f);
  save.panel.handleInput("\u001b[17~"); // F6
  assert.deepEqual(save.result(), { action: "save-preset", page: "overview" });
  const update = panelFor(f, "presets");
  update.panel.handleInput("\u001b[18~"); // F7
  assert.deepEqual(update.result(), { action: "update-preset", page: "presets", name: "web-dev" });
  const template = panelFor(f, "presets");
  template.panel.handleInput("\u001bOR"); // F3
  assert.ok(template.panel.render(120).join("\n").includes("模板 web-dev · 只读"));
  template.panel.handleInput("\u001b");
  assert.equal(template.result(), undefined);
  const rules = panelFor(f, "rules");
  rules.panel.handleInput("\u001bOR");
  assert.ok(rules.panel.render(120).join("\n").includes("Project-only instructions"));
});

test("rule-only changes count as unsaved and can be saved or discarded by clicking", () => {
  const f = fixture();
  f.workspace.rules!.value = "Draft rule";
  const { panel, result } = panelFor(f, "rules");
  assert.ok(panel.render(120).join("\n").includes("保存并应用（1）"));
  click(panel, "放弃修改");
  assert.equal(result(), undefined);
  click(panel, "继续编辑");
  assert.equal(f.workspace.rules!.value, "Draft rule");
  click(panel, "保存并应用（1）");
  assert.equal(result(), "save");
});

test("full Skill text is read-only, sanitized and never changes switches or the file", () => {
  const f = fixture();
  const { panel } = panelFor(f, "resources");
  click(panel, "Skill 全文 ›");
  const output = panel.render(120).join("\n");
  assert.ok(output.includes("Skill 全文 · 只读"));
  assert.ok(output.includes("READ_ONLY_END"));
  assert.ok(!output.includes("\u001b[31m"));
  assert.equal(f.model.rows[0].state, "inherit");
  assert.equal(readFileSync(f.skillPath, "utf8"), f.skillBody);
  click(panel, "返回列表");
  assert.ok(!panel.render(120).join("\n").includes("READ_ONLY_END"));
});

test("template contents are visible, missing resources block initialization and drafts are not silently discarded", () => {
  const f = fixture();
  const ready = panelFor(f, "presets");
  const output = ready.panel.render(120).join("\n");
  assert.ok(output.includes("Reusable rules"));
  assert.ok(!output.includes("PRIVATE_TOKEN"));
  click(ready.panel, "应用到项目");
  assert.deepEqual(ready.result(), { action: "apply-preset", page: "presets", name: "web-dev" });
  f.workspace.presets[0].preset!.resources.push({ kind: "mcp", name: "missing", enabled: true });
  const missing = panelFor(f, "presets");
  assert.ok(missing.panel.render(120).join("\n").includes("缺少 mcp：missing"));
  click(missing.panel, "应用到项目");
  assert.equal(missing.result(), undefined);
  f.workspace.presets[0].preset!.resources.pop();
  f.workspace.rules!.value = "Unsaved rules";
  const pending = panelFor(f, "presets");
  click(pending.panel, "应用到项目");
  assert.equal(pending.result(), undefined);
  assert.ok(pending.panel.render(120).join("\n").includes("请先保存或放弃"));
  click(pending.panel, "更新此模板");
  assert.deepEqual(pending.result(), { action: "update-preset", page: "presets", name: "web-dev" });
});

test("all four pages fit narrow and wide terminals with visible navigation and save controls", () => {
  const f = fixture();
  f.workspace.rules!.value = "通用规则\n".repeat(120);
  for (const page of ["overview", "resources", "rules", "presets"] as const) {
    const { panel } = panelFor(f, page);
    for (const [width, rows] of [[40, 20], [60, 24], [104, 30], [140, 36]]) {
      terminal.rows = rows;
      const lines = panel.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.length <= Math.floor(rows * 0.95), `${page} ${width}x${rows}\n${lines.join("\n")}`);
      assert.ok(lines.join("\n").includes("保存并应用（1）"));
      click(panel, "当前项目", width);
      click(panel, { overview: "当前项目", resources: "Skills / MCP", rules: "项目规则", presets: "我的模板" }[page], width);
    }
  }
  terminal.rows = 36;
});

test("sidebar layout keeps checkbox clicks, search focus and wheel input in the correct pane after resize", () => {
  const f = fixture();
  const { panel } = panelFor(f, "resources");
  for (const width of [144, 60, 120]) {
    let lines = panel.render(width);
    const y = lines.findIndex((line) => /\[[x ]\]/.test(line) && line.includes("example"));
    assert.ok(y >= 0);
    const x = visibleWidth(lines[y].slice(0, lines[y].indexOf("[x]"))) + 1;
    panel.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y,
      width, height: terminal.rows, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
    assert.equal(f.model.rows[0].state, "off", `checkbox at ${width} columns`);
    click(panel, "按默认", width);
    assert.equal(f.model.rows[0].state, "inherit");
    lines = panel.render(width);
    if (width >= 120) {
      assert.ok(lines.some((line) => line.includes("工作区")));
      assert.equal(panel.handleMouse({ type: "wheel", button: "none", x: 8, y, screenX: 8, screenY: y,
        wheelDelta: 3, width, height: terminal.rows, shift: false, alt: false, ctrl: false } as TuiMouseEvent), undefined);
      const searchY = lines.findIndex((line) => line.includes("搜索"));
      const searchX = visibleWidth(lines[searchY].slice(0, lines[searchY].indexOf("搜索"))) + 3;
      assert.ok(panel.handleMouse({ type: "click", button: "left", x: searchX, y: searchY, screenX: searchX, screenY: searchY,
        width, height: terminal.rows, shift: false, alt: false, ctrl: false } as TuiMouseEvent)?.handled);
      panel.handleInput("example");
      assert.ok(panel.render(width).some((line) => /\[[x ]\]/.test(line) && line.includes("example")));
      panel.handleInput("\u0015");
    }
  }
});

test("template card metadata selects the intended card and paging moves across whole cards", () => {
  const f = fixture();
  f.workspace.presets = Array.from({ length: 30 }, (_, i) => ({ name: `preset-${String(i).padStart(2, "0")}`,
    preset: { version: 1 as const, resources: [], agentsMd: `Rules for ${i}` } }));
  const { panel } = panelFor(f, "presets");
  let lines = panel.render(144);
  const titleY = lines.findIndex((line) => line.includes("preset-02"));
  assert.ok(titleY >= 0);
  const x = visibleWidth(lines[titleY].slice(0, lines[titleY].indexOf("preset-02"))) + 1;
  panel.handleMouse({ type: "click", button: "left", x, y: titleY + 1, screenX: x, screenY: titleY + 1,
    width: 144, height: terminal.rows, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
  assert.ok(panel.render(144).join("\n").includes("Rules for 2"));
  panel.handleInput("\u001b[6~");
  lines = panel.render(144);
  assert.ok(!lines.join("\n").includes("Rules for 2"));
  assert.ok(lines.some((line) => /› preset-\d+/.test(line)));
  assert.ok(lines.every((line) => visibleWidth(line) <= 144));
});

test("Markdown rule previews format headings and inline styles without changing stored text", () => {
  const f = fixture();
  const content = "# Conventions\n\nKeep **small changes** and *clear names*.\n\n- Run `npm test`.\n- Preserve ~~old~~ current behavior.";
  f.workspace.rules!.value = content;
  const { panel } = panelFor(f, "rules");
  const output = panel.render(144).join("\n");
  for (const expected of ["Conventions", "small changes", "npm test", "current behavior"]) assert.ok(output.includes(expected));
  assert.ok(!output.includes("# Conventions"));
  assert.ok(!output.includes("**small changes**"));
  panel.invalidate();
  assert.equal(panel.render(144).join("\n"), output);
  assert.equal(f.workspace.rules!.value, content);
  assert.equal(readFileSync(join(f.cwd, "AGENTS.md"), "utf8"), f.projectText);
});

test("invalid rules and individual templates remain visible without disabling resource management", () => {
  const f = fixture();
  writeFileSync(join(f.cwd, "AGENTS.md"), "<!-- pi-switch:preset:start -->");
  writeFileSync(presetPath(f.agent, "broken"), "{bad");
  const workspace = loadWorkspace(f.cwd, f.agent);
  assert.ok(workspace.rulesError);
  assert.ok(workspace.presets.find((item) => item.name === "broken")?.error);
  const { panel } = panelFor(f, "rules", workspace);
  assert.ok(panel.render(120).join("\n").includes("管理标记"));
  click(panel, "Skills / MCP");
  panel.handleInput(" ");
  assert.equal(f.model.rows[0].state, "off");
});

async function driveWorkbench(steps: ((panel: Component, f: ReturnType<typeof fixture>) => void)[],
  options: { rule?: string; afterEditor?: (f: ReturnType<typeof fixture>) => void; draft?: "save" | "apply" } = {}) {
  const f = fixture();
  const drafts = new PresetDraftStore();
  if (options.draft) {
    const source = readSnapshot(presetPath(f.agent, "web-dev"));
    drafts.stage(f.model, source, "web-dev", readPreset(source), options.draft, "draft-user");
  }
  let index = 0;
  const messages: string[] = [];
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agent;
  const ctx = {
    cwd: f.cwd, mode: "tui", isIdle: () => true, isProjectTrusted: () => true,
    ui: {
      notify(message: string) { messages.push(message); },
      async input() { return "saved-from-ui"; },
      async editor(_title: string, initial: string) {
        assert.equal(initial, "");
        options.afterEditor?.(f);
        return options.rule ?? "Shared edited rules";
      },
      async custom(factory: (...args: any[]) => Component) {
        let result: PanelResult | boolean | undefined;
        const component = factory(tui, theme, getKeybindings(), (value: typeof result) => { result = value; });
        const step = steps[index++];
        assert.ok(step, "Unexpected extra UI prompt");
        component.render(120);
        step(component, f);
        assert.notEqual(result, undefined, "UI interaction must finish this screen");
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
  try {
    const result = await openWorkbench(ctx, f.model, drafts);
    assert.equal(index, steps.length);
    return { ...f, result, messages };
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}

test("select resources → edit rules → save a template → save the project works entirely through UI buttons", async () => {
  const f = await driveWorkbench([
    (panel) => { click(panel, "Skills / MCP"); panel.handleInput?.(" "); click(panel, "项目规则"); click(panel, "编辑规则"); },
    (panel, f) => {
      assert.ok(panel.render(120).join("\n").includes("Shared edited rules"));
      assert.ok(!existsSync(f.model.settings.path));
      click(panel, "保存为模板");
    },
    (panel) => { assert.ok(panel.render(120).join("\n").includes("此次只写模板")); click(panel, "保存模板"); },
    (panel, f) => {
      assert.equal(readFileSync(join(f.cwd, "AGENTS.md"), "utf8"), f.projectText);
      assert.equal(existsSync(f.model.settings.path), false);
      const preset = readPreset(readSnapshot(presetPath(f.agent, "saved-from-ui")));
      assert.equal(preset.resources[0].enabled, false);
      assert.equal(preset.agentsMd, "Shared edited rules");
      assert.ok(!JSON.stringify(preset).includes("Project-only"));
      click(panel, "保存并应用（2）");
    },
  ]);
  assert.deepEqual(f.result, { skills: 1, mcp: 0, rules: 1 });
  assert.ok(readFileSync(join(f.cwd, "AGENTS.md"), "utf8").startsWith(f.projectText));
  assert.ok(readFileSync(join(f.cwd, "AGENTS.md"), "utf8").includes("Shared edited rules"));
  assert.equal(readFileSync(f.model.globalMcp.path, "utf8"), f.mcpText);
});

test("cancelling template preview returns to the same draft, which can be discarded without writing files", async () => {
  const f = await driveWorkbench([
    (panel) => { click(panel, "项目规则"); click(panel, "编辑规则"); },
    (panel) => click(panel, "保存为模板"),
    (panel) => click(panel, "取消"),
    (panel) => {
      assert.ok(panel.render(120).join("\n").includes("Shared edited rules"));
      click(panel, "放弃修改"); click(panel, "放弃修改");
    },
  ]);
  assert.equal(f.result, undefined);
  assert.equal(existsSync(presetPath(f.agent, "saved-from-ui")), false);
  assert.equal(readFileSync(join(f.cwd, "AGENTS.md"), "utf8"), f.projectText);
});

test("rules changed outside the editor block the entire project save and leave the draft reviewable", async () => {
  const f = await driveWorkbench([
    (panel) => { click(panel, "Skills / MCP"); panel.handleInput?.(" "); click(panel, "项目规则"); click(panel, "编辑规则"); },
    (panel) => click(panel, "保存并应用（2）"),
    (panel) => { click(panel, "放弃修改"); click(panel, "放弃修改"); },
  ], { afterEditor: (f) => writeFileSync(join(f.cwd, "AGENTS.md"), "Changed outside") });
  assert.ok(f.messages.some((message) => message.includes("已被修改")));
  assert.equal(readFileSync(join(f.cwd, "AGENTS.md"), "utf8"), "Changed outside");
  assert.equal(existsSync(f.model.settings.path), false);
});

test("a model application draft cannot overwrite unsaved rule edits made inside the workbench", async () => {
  const f = await driveWorkbench([
    (panel) => { click(panel, "项目规则"); click(panel, "编辑规则"); },
    (panel) => { click(panel, "我的模板"); panel.handleInput?.("\u001b[18~"); },
    (panel) => { click(panel, "放弃修改"); click(panel, "放弃修改"); },
  ], { draft: "apply" });
  assert.ok(f.messages.some((message) => message.includes("通用规则草稿")));
  assert.equal(existsSync(f.model.settings.path), false);
  assert.equal(readFileSync(join(f.cwd, "AGENTS.md"), "utf8"), f.projectText);
});

test("a model application draft can be manually reviewed and applied through the same snapshot checks", async () => {
  const f = await driveWorkbench([
    (panel) => click(panel, "复核并应用"),
    (panel) => click(panel, "应用并重载"),
  ], { draft: "apply" });
  assert.equal(f.result, "initialized");
  assert.ok(existsSync(f.model.settings.path));
  assert.ok(readFileSync(join(f.cwd, "AGENTS.md"), "utf8").includes("Reusable rules"));
});

test("template initialization can be selected and confirmed with mouse clicks", async () => {
  const f = await driveWorkbench([
    (panel) => { click(panel, "我的模板"); click(panel, "应用到项目"); },
    (panel) => click(panel, "应用并重载"),
  ]);
  assert.equal(f.result, "initialized");
  assert.ok(readFileSync(join(f.cwd, "AGENTS.md"), "utf8").includes("Reusable rules"));
  assert.ok(existsSync(f.model.settings.path));
  assert.equal(readFileSync(f.model.globalMcp.path, "utf8"), f.mcpText);
});
