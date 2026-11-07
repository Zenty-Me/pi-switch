import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager, loadSkills, type ExtensionAPI,
  type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import piSwitch from "../src/index.ts";
import { getKeybindings, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { runPresetCommand } from "../src/preset-command.ts";
import { commitFiles, dirtyRows, loadProject, saveProject, type ProjectModel } from "../src/model.ts";
import { applyPreset, captureAgents, capturePreset, listPresets, preparePreset, presetPath,
  readPreset, readSnapshot, validatePreset, type Preset } from "../src/presets.ts";

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
function presetFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-switch-presets-"));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agent);
  const path = join(agent, "skills", "fixture-skill", "SKILL.md");
  put(path, "---\nname: fixture-skill\ndescription: Fixture\n---\nPRIVATE_SKILL_BODY");
  const globalMcp = join(agent, "mcp.json");
  put(globalMcp, { mcpServers: { "fixture-docs": {
    url: "https://private.invalid/mcp", headers: { Authorization: "SECRET_TOKEN" },
  } } });
  const model: ProjectModel = {
    cwd,
    settings: { path: join(cwd, ".pi", "settings.json"), text: undefined, data: {} },
    mcp: { path: join(cwd, ".pi", "mcp.json"), text: undefined, data: {} },
    globalSettings: { path: join(agent, "settings.json"), text: undefined, data: {} },
    globalMcp: { path: globalMcp, text: readFileSync(globalMcp, "utf8"), data: JSON.parse(readFileSync(globalMcp, "utf8")) },
    rows: [
      { id: `skill:${path}`, kind: "skill", name: "fixture-skill", description: "Fixture", source: "全局", path,
        initial: "inherit", state: "inherit", inheritedEnabled: true, editable: true },
      { id: "mcp:fixture-docs", kind: "mcp", name: "fixture-docs", description: "Fixture", source: "全局",
        initial: "inherit", state: "inherit", inheritedEnabled: true, editable: true },
    ],
  };
  const preset: Preset = { version: 1, resources: model.rows.map(({ kind, name }) => ({ kind, name, enabled: false })),
    agentsMd: "Use concise answers.\nRun the project's tests." };
  const sourcePath = presetPath(agent, "web-dev");
  put(sourcePath, preset);
  return { root, cwd, agent, model, preset, source: readSnapshot(sourcePath) };
}

test("capture stores effective settings without paths, Skill bodies or MCP credentials", () => {
  const f = presetFixture();
  f.model.rows[0].inheritedEnabled = false;
  f.model.rows.push({ ...f.model.rows[1], name: "readonly", editable: false });
  const preset = capturePreset(f.model, "General rules");
  assert.deepEqual(preset.resources, [
    { kind: "skill", name: "fixture-skill", enabled: false },
    { kind: "mcp", name: "fixture-docs", enabled: true },
  ]);
  for (const secret of [f.cwd, f.agent, "SECRET_TOKEN", "private.invalid", "PRIVATE_SKILL_BODY"]) {
    assert.ok(!JSON.stringify(preset).includes(secret));
  }
  f.model.rows[0].state = "on";
  assert.equal(capturePreset(f.model).resources[0].enabled, true);
});

test("preset names and input schema reject traversal, reserved files, duplicates and connection configs", () => {
  const f = presetFixture();
  for (const name of ["../outside", "C:\\outside", "a/b", ".", "CON", "LPT1", "a b", "a".repeat(65)]) {
    assert.throws(() => presetPath(f.agent, name), /模板名称/);
  }
  assert.ok(presetPath(f.agent, "web-dev_2").endsWith("web-dev_2.json"));
  const invalid = [null, [], { ...f.preset, version: 2 }, { ...f.preset, mcp: { url: "secret" } },
    { ...f.preset, resources: [{ ...f.preset.resources[0], enabled: "false" }] },
    { ...f.preset, resources: [{ ...f.preset.resources[0], path: "/private" }] },
    { ...f.preset, resources: [f.preset.resources[0], f.preset.resources[0]] },
    { ...f.preset, agentsMd: "<!-- pi-switch:preset:start -->" },
    { ...f.preset, agentsMd: "x".repeat(65537) },
    { ...f.preset, resources: [{ ...f.preset.resources[0], name: "bad\u001bname" }] }];
  for (const value of invalid) assert.throws(() => validatePreset(value));
  assert.deepEqual(validatePreset({ version: 1, resources: [], agentsMd: "  " }), { version: 1, resources: [] });
});

test("template loading is local, bounded and validates BOM JSON and missing files", () => {
  const f = presetFixture();
  assert.deepEqual(listPresets(f.agent), ["web-dev"]);
  assert.deepEqual(listPresets(join(f.root, "absent")), []);
  assert.deepEqual(readPreset({ ...f.source, text: `\uFEFF${f.source.text}` }), f.preset);
  assert.throws(() => readPreset({ ...f.source, text: "{invalid" }), /JSON/);
  assert.throws(() => readPreset({ ...f.source, text: undefined }), /不存在/);
  assert.throws(() => readSnapshot(f.cwd), /普通文件/);
  put(join(f.cwd, "large"), "x".repeat(1024 * 1024 + 1));
  assert.throws(() => readSnapshot(join(f.cwd, "large")), /MiB/);
});

test("planning is read-only, application preserves project text and credentials, and repeats are idempotent", () => {
  const f = presetFixture();
  const agents = join(f.cwd, "AGENTS.md");
  const original = "# Project\r\nUse npm test.\r\n";
  put(agents, original);
  const plan = preparePreset(f.model, f.preset);
  assert.equal(dirtyRows(f.model).length, 0);
  assert.equal(existsSync(f.model.settings.path), false);
  assert.equal(readFileSync(agents, "utf8"), original);
  assert.equal(applyPreset(plan, f.source), true);
  const text = readFileSync(agents, "utf8");
  assert.ok(text.startsWith(original));
  assert.ok(text.includes(f.preset.agentsMd!));
  assert.deepEqual(JSON.parse(readFileSync(f.model.mcp.path, "utf8")), { mcpServers: { "fixture-docs": { enabled: false } } });
  assert.equal(readFileSync(f.model.globalMcp.path, "utf8"), f.model.globalMcp.text);
  const again = preparePreset(plan.model, f.preset);
  assert.equal(again.agentsWrite, undefined);
  assert.equal(applyPreset(again, f.source), false);
  const next = preparePreset(plan.model, { ...f.preset, agentsMd: "Write in Chinese." });
  applyPreset(next, f.source);
  const updated = readFileSync(agents, "utf8");
  assert.equal(updated.split("<!-- pi-switch:preset:start -->").length, 2);
  assert.ok(updated.startsWith(original));
  assert.ok(!updated.includes(f.preset.agentsMd!));
  assert.equal(captureAgents(readSnapshot(agents)), "Write in Chinese.");
  const remove = preparePreset(next.model, { version: 1, resources: [] });
  applyPreset(remove, f.source);
  assert.ok(readFileSync(agents, "utf8").startsWith(original));
  assert.ok(!readFileSync(agents, "utf8").includes("pi-switch:preset"));
});

test("rules-only templates create AGENTS.md without creating empty resource config files", () => {
  const f = presetFixture();
  const plan = preparePreset(f.model, { version: 1, resources: [], agentsMd: "Personal conventions" });
  assert.equal(applyPreset(plan, f.source), true);
  assert.ok(readFileSync(join(f.cwd, "AGENTS.md"), "utf8").includes("Personal conventions"));
  assert.equal(existsSync(f.model.settings.path), false);
  assert.equal(existsSync(f.model.mcp.path), false);
});

test("missing, ambiguous and read-only resources fail without mutating the model or disk", () => {
  const f = presetFixture();
  assert.throws(() => preparePreset(f.model, { ...f.preset, resources: [...f.preset.resources,
    { kind: "skill", name: "missing", enabled: true }] }), /缺少资源/);
  f.model.rows.push({ ...f.model.rows[0], id: "duplicate" });
  assert.throws(() => preparePreset(f.model, f.preset), /同名/);
  assert.throws(() => capturePreset(f.model), /同名/);
  f.model.rows.pop();
  f.model.rows[1].editable = false;
  assert.throws(() => preparePreset(f.model, f.preset), /只读/);
  assert.equal(dirtyRows(f.model).length, 0);
  assert.equal(existsSync(f.model.settings.path), false);
});

for (const target of ["preset", "agents", "override", "settings", "global"] as const) {
  test(`edits to ${target} after preview invalidate the entire initialization`, () => {
    const f = presetFixture();
    const plan = preparePreset(f.model, f.preset);
    const path = { preset: f.source.path, agents: plan.agents.path, override: plan.override.path,
      settings: f.model.settings.path, global: f.model.globalMcp.path }[target];
    put(path, "changed outside");
    assert.throws(() => applyPreset(plan, f.source), /已被修改/);
    assert.equal(readFileSync(path, "utf8"), "changed outside");
    assert.equal(existsSync(f.model.mcp.path), false);
    if (target !== "agents") assert.equal(existsSync(plan.agents.path), false);
  });
}

test("AGENTS override and malformed managed blocks prevent invisible or destructive rule updates", () => {
  const f = presetFixture();
  put(join(f.cwd, "AGENTS.override.md"), "Existing override");
  assert.throws(() => preparePreset(f.model, f.preset), /AGENTS.override.md/);
  fs.unlinkSync(join(f.cwd, "AGENTS.override.md"));
  for (const text of ["<!-- pi-switch:preset:start -->", "<!-- pi-switch:preset:end -->",
    "<!-- pi-switch:preset:start --><!-- pi-switch:preset:start --><!-- pi-switch:preset:end -->"]) {
    put(join(f.cwd, "AGENTS.md"), text);
    assert.throws(() => preparePreset(f.model, f.preset), /管理标记/);
    assert.equal(readFileSync(join(f.cwd, "AGENTS.md"), "utf8"), text);
  }
  assert.equal(existsSync(f.model.settings.path), false);
});

test("a failure during the AGENTS commit rolls back earlier Skill and MCP writes", (t) => {
  const f = presetFixture();
  const plan = preparePreset(f.model, f.preset);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to === plan.agents.path) throw new Error("Simulated disk failure");
    rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => applyPreset(plan, f.source), /已恢复/);
    for (const path of [f.model.settings.path, f.model.mcp.path, plan.agents.path]) assert.equal(existsSync(path), false);
    assert.equal(readFileSync(f.model.globalMcp.path, "utf8"), f.model.globalMcp.text);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("a named template transfers loose and packaged Skill states to another project using native Pi loading", async () => {
  const f = presetFixture();
  const pkg = join(f.root, "skill-package");
  put(join(pkg, "package.json"), { name: "fixture-package", pi: { skills: ["skills"] } });
  put(join(pkg, "skills", "fixture-package", "SKILL.md"), "---\nname: fixture-package\ndescription: Fixture\n---\nBody");
  put(f.model.globalSettings.path, { packages: [pkg] });
  const sourceModel = await loadProject(f.cwd, f.agent);
  sourceModel.rows = sourceModel.rows.filter((row) => row.name.startsWith("fixture-"));
  for (const row of sourceModel.rows) row.state = "off";
  saveProject(sourceModel);
  const preset = capturePreset(sourceModel, "Shared rules");
  commitFiles([{ file: f.source, text: JSON.stringify(preset) }]);
  const source = readSnapshot(f.source.path);
  const other = join(f.root, "other-project");
  put(join(other, ".pi", "settings.json"), { theme: "light" });
  put(join(other, ".pi", "mcp.json"), { mcpServers: { "fixture-docs": { exposure: "deferred" } } });
  const otherModel = await loadProject(other, f.agent);
  applyPreset(preparePreset(otherModel, readPreset(source)), source);
  const manager = new DefaultPackageManager({ cwd: other, agentDir: f.agent,
    settingsManager: SettingsManager.create(other, f.agent, { projectTrusted: true }) });
  const resources = await manager.resolve(async () => "skip");
  const loaded = loadSkills({ cwd: other, agentDir: f.agent, includeDefaults: false,
    skillPaths: resources.skills.filter((resource) => resource.enabled).map((resource) => resource.path) });
  assert.equal(loaded.skills.some((skill) => skill.name.startsWith("fixture-")), false);
  const settings = JSON.parse(readFileSync(join(other, ".pi", "settings.json"), "utf8"));
  assert.equal(settings.theme, "light");
  assert.deepEqual(JSON.parse(readFileSync(join(other, ".pi", "mcp.json"), "utf8")), {
    mcpServers: { "fixture-docs": { exposure: "deferred", enabled: false } },
  });
  assert.ok(!source.text!.includes(f.cwd));
});

function commandFixture() {
  const f = presetFixture();
  const messages: string[] = [];
  const previews: string[] = [];
  let confirm = true;
  let rules: string | undefined = "Shared conventions";
  let onPreview = () => {};
  const ctx = {
    cwd: f.cwd, mode: "tui", isProjectTrusted: () => true, isIdle: () => true,
    sessionManager: { getSessionId: () => "preset-session" },
    ui: {
      setStatus() {},
      notify(message: string) { messages.push(message); },
      async input() { return "saved"; },
      async select() { return "web-dev"; },
      async editor() { return rules; },
      async custom(factory: (...args: any[]) => Component) {
        let decision: boolean | undefined;
        const preview = factory({ terminal: { rows: 20 }, requestRender() {} } as TUI,
          { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text }, getKeybindings(),
          (result: boolean) => { decision = result; });
        const narrow = preview.render(42);
        assert.ok(narrow.every((line) => visibleWidth(line) <= 42));
        assert.ok(narrow.length <= 20);
        previews.push(narrow.join("\n"));
        preview.handleInput?.("\u001b[6~");
        assert.ok(preview.render(98).every((line) => visibleWidth(line) <= 98));
        preview.invalidate();
        onPreview();
        preview.handleInput?.(confirm ? "\r" : "\u001b");
        return decision;
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ...f, ctx, messages, previews,
    cancel() { confirm = false; }, cancelEditor() { rules = undefined; },
    duringPreview(fn: () => void) { onPreview = fn; } };
}
async function withCommandFixture(run: (f: ReturnType<typeof commandFixture>) => Promise<void>): Promise<void> {
  const f = commandFixture();
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agent;
  try { await run(f); }
  finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}

test("save command reviews rules and resource states, stores the template and leaves project config untouched", () =>
  withCommandFixture(async (f) => {
    assert.equal(await runPresetCommand("save", f.ctx, f.model), false);
    const file = readSnapshot(presetPath(f.agent, "saved"));
    const saved = readPreset(file);
    assert.equal(saved.agentsMd, "Shared conventions");
    assert.equal(saved.resources.length, 2);
    assert.ok(!file.text!.includes("SECRET_TOKEN"));
    assert.ok(f.previews[0].includes("保存模板"));
    assert.equal(existsSync(f.model.settings.path), false);
    assert.equal(existsSync(join(f.cwd, "AGENTS.md")), false);
  }));

for (const command of ["save web-dev", "init web-dev"] as const) {
  test(`${command}: cancelling preview never writes a template or project file`, () => withCommandFixture(async (f) => {
    f.cancel();
    assert.equal(await runPresetCommand(command, f.ctx, f.model), false);
    assert.equal(readFileSync(f.source.path, "utf8"), f.source.text);
    assert.equal(existsSync(f.model.settings.path), false);
    assert.equal(existsSync(join(f.cwd, "AGENTS.md")), false);
  }));
}

test("cancelling the rules editor aborts before any preview or template write", () => withCommandFixture(async (f) => {
  f.cancelEditor();
  assert.equal(await runPresetCommand("save saved", f.ctx, f.model), false);
  assert.equal(f.previews.length, 0);
  assert.equal(existsSync(presetPath(f.agent, "saved")), false);
}));

test("template selection applies only after preview, requests reload and keeps the draft model untouched", () =>
  withCommandFixture(async (f) => {
    f.duringPreview(() => assert.equal(existsSync(f.model.settings.path), false));
    assert.equal(await runPresetCommand("init", f.ctx, f.model), true);
    assert.ok(f.previews[0].includes("初始化预览"));
    assert.equal(dirtyRows(f.model).length, 0);
    assert.ok(existsSync(join(f.cwd, "AGENTS.md")));
    assert.ok(f.messages.some((message) => message.includes("已应用模板")));
  }));

test("template edits and loss of project trust during the preview reject application", () => withCommandFixture(async (f) => {
  f.duringPreview(() => put(f.source.path, { ...f.preset, agentsMd: "Changed after preview" }));
  await assert.rejects(runPresetCommand("init web-dev", f.ctx, f.model), /已被修改/);
  assert.equal(existsSync(f.model.settings.path), false);
  f.duringPreview(() => { f.ctx.isProjectTrusted = () => false; });
  await assert.rejects(runPresetCommand("init web-dev", f.ctx, f.model), /已信任/);
  assert.equal(existsSync(join(f.cwd, "AGENTS.md")), false);
}));

test("preset commands reject untrusted contexts, unfinished suggestions and invalid commands", () => withCommandFixture(async (f) => {
  await assert.rejects(runPresetCommand("unknown", f.ctx, f.model), /switch save/);
  await assert.rejects(runPresetCommand("save a b", f.ctx, f.model), /switch save/);
  f.model.rows[0].state = "off";
  await assert.rejects(runPresetCommand("init web-dev", f.ctx, f.model), /待修改项/);
  f.ctx.isProjectTrusted = () => false;
  await assert.rejects(runPresetCommand("save saved", f.ctx, f.model), /已信任/);
  assert.equal(f.previews.length, 0);
}));

for (const failReload of [false, true]) {
  test(`the registered /switch command applies a preset and handles reload ${failReload ? "failure" : "success"}`, () =>
    withCommandFixture(async (f) => {
      let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
      let reloads = 0;
      const api = {
        registerCommand(name: string, definition: typeof command) { assert.equal(name, "switch"); command = definition; },
        registerTool() {}, on() {}, getMcpServers: () => [],
      } as unknown as ExtensionAPI;
      piSwitch(api);
      f.ctx.reload = async () => { reloads++; if (failReload) throw new Error("Reload failed"); };
      await command.handler("init web-dev", f.ctx);
      assert.equal(reloads, 1);
      assert.ok(existsSync(join(f.cwd, "AGENTS.md")));
      assert.deepEqual(JSON.parse(readFileSync(f.model.mcp.path, "utf8")), { mcpServers: { "fixture-docs": { enabled: false } } });
      assert.equal(f.messages.some((message) => message.includes("重新加载失败")), failReload);
      assert.deepEqual(await command.getArgumentCompletions?.("init w"), [{ value: "init web-dev", label: "init web-dev" }]);
      if (!failReload) {
        await command.handler("init web-dev", f.ctx);
        assert.equal(reloads, 1);
        assert.ok(f.messages.some((message) => message.includes("无需修改或重载")));
      }
    }));
}