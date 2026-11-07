import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { compile } from "@earendil-works/pi-schema";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { DefaultPackageManager, SettingsManager, loadSkills, withFileMutationQueue,
  type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
  type ExtensionToolContext, type RegisteredCommand, type SessionEntry } from "@earendil-works/pi-coding-agent";
import piSwitch from "../src/index.ts";
import { createCapabilitiesTool } from "../src/tool.ts";
import { presetPath } from "../src/presets.ts";
import { getKeybindings, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

type ListedItem = { id: string; name: string; savedSetting: string; proposedSetting: string; pending: boolean };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-switch-apply-"));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  const pkg = join(root, "fixture-package");
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  mkdirSync(cwd);
  put(join(pkg, "package.json"), { name: "fixture-package", pi: { skills: ["skills"] } });
  for (const name of ["fixture-ai", "fixture-sibling"]) {
    put(join(pkg, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture skill\n---\nPRIVATE_SKILL_BODY`);
  }
  const globalSettings = join(agent, "settings.json");
  put(globalSettings, { packages: [pkg] });
  const globalMcp = join(agent, "mcp.json");
  put(globalMcp, { mcpServers: { "fixture-docs": {
    url: "https://private.invalid/mcp", headers: { Authorization: "PRIVATE_AUTH" },
  } } });
  const originalSettings = readFileSync(globalSettings, "utf8");
  const originalMcp = readFileSync(globalMcp, "utf8");
  const settings = join(cwd, ".pi", "settings.json");
  const mcp = join(cwd, ".pi", "mcp.json");
  let tool!: ReturnType<typeof createCapabilitiesTool>;
  let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
  let reloads = 0;
  let failReload = false;
  let serial = 0;
  const entries: SessionEntry[] = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const notifications: string[] = [];
  const dispatches: { content: string; options: unknown }[] = [];
  const statuses: (string | undefined)[] = [];
  const api = {
    registerTool(definition: typeof tool) { tool = definition; },
    registerCommand(_name: string, definition: typeof command) { command = definition; },
    getMcpServers: () => [],
    appendEntry(customType: string, data: unknown) {
      entries.push({ id: `custom-${serial++}`, type: "custom", parentId: null,
        timestamp: new Date().toISOString(), customType, data });
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
    sendUserMessage(content: string, options: unknown) { dispatches.push({ content, options }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, mode: "tui", isProjectTrusted: () => true, isIdle: () => true,
    sessionManager: { getSessionId: () => "apply-session", getBranch: () => entries },
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus(_name: string, value: string | undefined) { statuses.push(value); },
    },
    async reload() {
      reloads++;
      if (failReload) throw new Error("Fixture reload failure");
      piSwitch(api); // A real reload creates a new extension instance.
      await handlers.get("session_start")?.({ reason: "reload" }, ctx);
    },
  } as unknown as ExtensionCommandContext;
  const user = (text = "确认应用") => {
    entries.push({ id: `user-${serial++}`, type: "message", parentId: null,
      timestamp: new Date().toISOString(), message: { role: "user", content: text, timestamp: Date.now() } });
  };
  user("帮我整理能力，先给建议");
  piSwitch(api);
  const run = async (args: Parameters<typeof tool.execute>[1], signal?: AbortSignal) => {
    const result = await tool.execute("fixture-call", args, signal, undefined, ctx as unknown as ExtensionToolContext);
    const content = result.content[0];
    assert.equal(content.type, "text");
    if (content.type !== "text") throw new Error("Expected text");
    return JSON.parse(content.text);
  };
  const strictRun = async (args: JsonObject) => {
    // Reproduce providers that require every advertised property, including irrelevant arguments.
    const properties = tool.parameters.properties;
    const arguments_ = { ...Object.fromEntries(Object.keys(properties).map((key) => [key, null])), ...args };
    const parameters = { ...tool.parameters, required: Object.keys(properties) };
    assert.equal(compile(parameters).check(arguments_), true, "all unused properties must accept null");
    const validated = validateToolArguments(tool, { type: "toolCall", id: "strict-call", name: tool.name, arguments: arguments_ });
    assert.deepEqual(validated, arguments_, "host validation must preserve null, false, zero and empty strings");
    return run(validated);
  };
  const stage = async () => {
    const list = await run({ action: "list", query: "fixture-" });
    const selected = (list.items as ListedItem[]).filter((row) => row.name !== "fixture-sibling");
    return run({ action: "stage", changes: selected.map((row) => ({
      id: row.id, state: "off", reason: "本项目无需此能力",
    })) });
  };
  const settle = () => handlers.get("agent_settled")?.({}, ctx);
  const flushReload = async () => {
    const next = dispatches.shift();
    assert.deepEqual(next, { content: "/switch --reload", options: { expandPromptTemplates: true } });
    await command.handler("--reload", ctx);
  };
  const nativeSkill = async (name: string) => {
    const settingsManager = SettingsManager.create(cwd, agent, { projectTrusted: true });
    const manager = new DefaultPackageManager({ cwd, agentDir: agent, settingsManager });
    const resources = await manager.resolve(async () => "skip");
    return loadSkills({ cwd, agentDir: agent, includeDefaults: false,
      skillPaths: resources.skills.filter((row) => row.enabled).map((row) => row.path) })
      .skills.some((skill) => skill.name === name);
  };
  const assertGlobals = () => {
    assert.equal(readFileSync(globalSettings, "utf8"), originalSettings);
    assert.equal(readFileSync(globalMcp, "utf8"), originalMcp);
  };
  return { agent, ctx, run, strictRun, user, stage, settle, flushReload, nativeSkill, assertGlobals,
    settings, mcp, entries, notifications, dispatches, statuses, reloads: () => reloads,
    openPanel: () => command.handler("", ctx), emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    setReloadFailure() { failReload = true; } };
}

async function withFixture(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const f = fixture();
  process.env.PI_CODING_AGENT_DIR = f.agent;
  try { await run(f); f.assertGlobals(); }
  finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
  }
}

test("required nullable arguments support list, stage and confirmed full apply through native validation", () => withFixture(async (f) => {
  const list = await f.strictRun({ action: "list", query: "", kind: "skill", pendingOnly: false, offset: 0, limit: 1 });
  assert.equal(list.items.length, 1);
  assert.equal(list.offset, 0);
  assert.equal(list.nextOffset, 1);
  assert.equal(list.pendingCount, 0);
  const all = await f.strictRun({ action: "list", query: "fixture-" });
  assert.equal(all.total, 3);
  const proposal = await f.strictRun({ action: "stage", changes: all.items.map((row: ListedItem) => ({
    id: row.id, state: "off", reason: "本项目无需此能力",
  })) });
  assert.equal(proposal.pendingCount, 3);
  assert.equal(existsSync(f.settings), false);
  assert.equal(existsSync(f.mcp), false);
  await assert.rejects(f.strictRun({ action: "apply", proposalId: proposal.proposalId }), /后续消息/);
  f.user();
  const result = await f.strictRun({ action: "apply", proposalId: proposal.proposalId });
  assert.equal(result.saved, true);
  assert.equal(result.appliedCount, 3);
  assert.equal(result.pendingCount, 0);
  assert.equal(await f.nativeSkill("fixture-ai"), false);
  assert.equal(await f.nativeSkill("fixture-sibling"), false);
  assert.equal(JSON.parse(readFileSync(f.mcp, "utf8")).mcpServers["fixture-docs"].enabled, false);
  await f.settle();
  await f.flushReload();
  assert.equal(f.reloads(), 1);
}));

test("nullable arguments preserve partial apply and reject actual unrelated values", () => withFixture(async (f) => {
  const proposal = await f.stage();
  const id = proposal.preview[0].id;
  await assert.rejects(f.strictRun({ action: "list", ids: [id] }), /list 只读取清单/);
  await assert.rejects(f.strictRun({ action: "stage", changes: [{ id, state: "off", reason: "建议" }],
    proposalId: proposal.proposalId }), /stage 不接受/);
  f.user();
  const unrelated: JsonObject[] = [{ query: "" }, { pendingOnly: false }, { offset: 0 }, { kind: "skill" }, { limit: 1 },
    { changes: [{ id, state: "on", reason: "未确认的新修改" }] }];
  for (const args of unrelated) {
    await assert.rejects(f.strictRun({ action: "apply", proposalId: proposal.proposalId, ...args }), /apply 只接受/);
  }
  assert.equal(existsSync(f.settings), false);
  assert.equal(existsSync(f.mcp), false);
  const partial = await f.strictRun({ action: "apply", proposalId: proposal.proposalId, ids: [id] });
  assert.equal(partial.appliedCount, 1);
  assert.equal(partial.pendingCount, 1);
}));

test("stage waits for a later user message; confirmation saves and schedules exactly one idle reload", () => withFixture(async (f) => {
  const proposal = await f.stage();
  assert.equal(proposal.saved, false);
  await assert.rejects(f.run({ action: "apply", proposalId: proposal.proposalId }), /后续消息/);
  assert.equal(existsSync(f.settings), false);
  assert.equal(existsSync(f.mcp), false);
  f.user();
  const result = await f.run({ action: "apply", proposalId: proposal.proposalId });
  assert.equal(result.saved, true);
  assert.equal(result.appliedCount, 2);
  assert.equal(result.pendingCount, 0);
  assert.equal(result.reload, "scheduled");
  assert.equal(f.reloads(), 0);
  assert.equal(f.dispatches.length, 0);
  assert.equal(await f.nativeSkill("fixture-ai"), false);
  assert.equal(await f.nativeSkill("fixture-sibling"), true);
  assert.deepEqual(JSON.parse(readFileSync(f.mcp, "utf8")), { mcpServers: { "fixture-docs": { enabled: false } } });
  const exported = JSON.stringify({ result, entries: f.entries.filter((entry) => entry.type === "custom") });
  for (const secret of ["PRIVATE_AUTH", "PRIVATE_SKILL_BODY", "private.invalid"]) assert.ok(!exported.includes(secret));
  await f.settle();
  await f.settle();
  assert.equal(f.dispatches.length, 1);
  await f.flushReload();
  assert.equal(f.reloads(), 1);
  assert.ok(f.notifications.some((message) => message.includes("已保存并重新加载")));
}));

test("partial confirmation applies only selected IDs and restores remaining suggestions across a fresh runtime", () => withFixture(async (f) => {
  const proposal = await f.stage();
  const list = await f.run({ action: "list", pendingOnly: true });
  const selected = (list.items as ListedItem[]).find((row) => row.name === "fixture-docs")!;
  f.user("只应用文档 MCP，其他建议先保留");
  const result = await f.run({ action: "apply", proposalId: proposal.proposalId, ids: [selected.id] });
  assert.equal(result.appliedCount, 1);
  assert.equal(result.pendingCount, 1);
  assert.equal(existsSync(f.settings), false);
  assert.equal(await f.nativeSkill("fixture-ai"), true);
  await f.settle();
  await f.flushReload();
  const remaining = await f.run({ action: "list", pendingOnly: true });
  assert.equal(remaining.pendingCount, 1);
  assert.equal(remaining.proposalId, result.proposalId);
  assert.equal(remaining.items[0].name, "fixture-ai");
  assert.equal(remaining.items[0].reason, "本项目无需此能力");
  assert.equal(remaining.items[0].savedSetting, "inherit");
  assert.equal(remaining.items[0].proposedSetting, "off");
  assert.ok(f.statuses.at(-1)?.includes("1 项待复核"));
  await assert.rejects(f.run({ action: "apply", proposalId: proposal.proposalId }), /方案版本/);
  await assert.rejects(f.run({ action: "apply", proposalId: remaining.proposalId }), /后续消息/);
  f.user("剩下的建议也确认应用");
  const last = await f.run({ action: "apply", proposalId: remaining.proposalId });
  assert.equal(last.appliedCount, 1);
  assert.equal(last.pendingCount, 0);
  assert.equal(await f.nativeSkill("fixture-ai"), false);
  await f.settle();
  await f.flushReload();
  assert.equal((await f.run({ action: "list", pendingOnly: true })).pendingCount, 0);
}));

test("revising a proposal invalidates its old ID and requires a new user confirmation", () => withFixture(async (f) => {
  const first = await f.stage();
  f.user("改一下理由，继续给建议");
  const second = await f.run({ action: "stage", changes: [{
    id: first.preview[0].id, state: "off", reason: "更新后的理由",
  }] });
  assert.notEqual(first.proposalId, second.proposalId);
  await assert.rejects(f.run({ action: "apply", proposalId: first.proposalId }), /方案版本/);
  await assert.rejects(f.run({ action: "apply", proposalId: second.proposalId }), /后续消息/);
  assert.equal(existsSync(f.settings), false);
  assert.equal(existsSync(f.mcp), false);
  f.user();
  assert.equal((await f.run({ action: "apply", proposalId: second.proposalId })).saved, true);
}));

test("unknown, duplicated, filtered or new changes cannot expand a confirmed apply", () => withFixture(async (f) => {
  const proposal = await f.stage();
  f.user();
  const id = proposal.preview[0].id;
  for (const args of [
    { ids: [id, id] }, { ids: [id, "unknown"] }, { query: "fixture-ai" },
    { changes: [{ id, state: "on", reason: "未展示的新修改" }] },
  ]) {
    await assert.rejects(f.run({ action: "apply", proposalId: proposal.proposalId, ...args }));
    assert.equal(existsSync(f.settings), false);
    assert.equal(existsSync(f.mcp), false);
  }
  await assert.rejects(f.run({ action: "apply", proposalId: proposal.proposalId }, AbortSignal.abort()));
  assert.equal(f.dispatches.length, 0);
}));

test("external configuration edits invalidate the proposal before saving either file", () => withFixture(async (f) => {
  const proposal = await f.stage();
  mkdirSync(dirname(f.settings), { recursive: true });
  writeFileSync(f.settings, '{"theme":"changed-outside"}');
  f.user();
  await assert.rejects(f.run({ action: "apply", proposalId: proposal.proposalId }), /旧建议已作废/);
  assert.equal(readFileSync(f.settings, "utf8"), '{"theme":"changed-outside"}');
  assert.equal(existsSync(f.mcp), false);
  assert.equal((await f.run({ action: "list" })).pendingCount, 0);
  await assert.rejects(f.run({ action: "apply", proposalId: proposal.proposalId }), /方案版本/);
}));

test("a newer user message while waiting for a file lock stops the previous apply", () => withFixture(async (f) => {
  const proposal = await f.stage();
  f.user();
  let release!: () => void;
  let ready!: () => void;
  const locked = new Promise<void>((resolve) => { ready = resolve; });
  const hold = withFileMutationQueue(f.settings, () => new Promise<void>((resolve) => {
    release = resolve;
    ready();
  }));
  await locked;
  const applying = f.run({ action: "apply", proposalId: proposal.proposalId });
  const rejected = assert.rejects(applying, /用户消息已改变/);
  try {
    await setImmediate();
    f.user("先别应用，我还要修改方案");
  } finally { release(); }
  await hold;
  await rejected;
  assert.equal(existsSync(f.settings), false);
  assert.equal(existsSync(f.mcp), false);
  assert.equal(f.dispatches.length, 0);
}));

test("configuration changes during reload discard remaining suggestions without undoing saved changes", () => withFixture(async (f) => {
  const proposal = await f.stage();
  const mcp = proposal.preview.find((row: ListedItem) => row.name === "fixture-docs")!;
  f.user();
  await f.run({ action: "apply", proposalId: proposal.proposalId, ids: [mcp.id] });
  writeFileSync(f.settings, '{"theme":"newer-config"}');
  await f.settle();
  await f.flushReload();
  assert.equal((await f.run({ action: "list", pendingOnly: true })).pendingCount, 0);
  assert.ok(f.notifications.some((message) => message.includes("剩余建议已失效")));
  assert.equal(readFileSync(f.settings, "utf8"), '{"theme":"newer-config"}');
  assert.equal(JSON.parse(readFileSync(f.mcp, "utf8")).mcpServers["fixture-docs"].enabled, false);
}));

test("reload failure reports saved configuration separately from failed activation", () => withFixture(async (f) => {
  const proposal = await f.stage();
  f.user();
  assert.equal((await f.run({ action: "apply", proposalId: proposal.proposalId })).saved, true);
  f.setReloadFailure();
  await f.settle();
  await f.flushReload();
  assert.ok(f.notifications.some((message) => message.includes("配置已保存，但重新加载失败")));
  assert.ok(!f.notifications.some((message) => message.includes("已保存并重新加载")));
  assert.equal(JSON.parse(readFileSync(f.mcp, "utf8")).mcpServers["fixture-docs"].enabled, false);
}));

async function stageTemplate(f: ReturnType<typeof fixture>, agentsMd = "Prefer small changes.\nRun project checks.") {
  const list = await f.strictRun({ action: "list", query: "fixture-" });
  return f.strictRun({ action: "preset_stage", name: "web-dev", agentsMd,
    changes: list.items.map((row: ListedItem) => ({ id: row.id, state: "off", reason: "模板暂不需要" })) });
}

test("conversation drafts and saves a template without project changes, then applies it after separate confirmation", () => withFixture(async (f) => {
  const agents = join(f.ctx.cwd, "AGENTS.md");
  writeFileSync(agents, "# Project private instructions\nKeep project prose.\n");
  const first = await stageTemplate(f);
  const path = presetPath(f.agent, "web-dev");
  assert.equal(existsSync(path), false);
  assert.equal((await f.run({ action: "list", pendingOnly: true })).pendingCount, 0);
  const preview = await f.strictRun({ action: "preset_show", proposalId: first.proposalId });
  assert.equal(preview.operation, "save");
  assert.equal(preview.agentsMd.text, "Prefer small changes.\nRun project checks.");
  assert.ok(preview.resources.items.every((item: { enabled: boolean }) => !item.enabled));
  assert.ok(!JSON.stringify(preview).includes("Project private instructions"));
  await assert.rejects(f.strictRun({ action: "preset_save", proposalId: first.proposalId }), /后续消息/);
  f.user("确认保存模板，不应用项目");
  await assert.rejects(f.strictRun({ action: "preset_apply", proposalId: first.proposalId }), /操作不匹配/);
  const saved = await f.strictRun({ action: "preset_save", proposalId: first.proposalId });
  assert.equal(saved.projectChanged, false);
  assert.equal(saved.reload, "not-needed");
  assert.equal(existsSync(f.settings), false);
  assert.equal(existsSync(f.mcp), false);
  assert.equal(readFileSync(agents, "utf8"), "# Project private instructions\nKeep project prose.\n");
  await f.settle(); assert.equal(f.dispatches.length, 0);
  assert.equal((await f.strictRun({ action: "preset_list" })).items[0].name, "web-dev");
  const applying = await f.strictRun({ action: "preset_preview", name: "web-dev" });
  await assert.rejects(f.strictRun({ action: "preset_apply", proposalId: applying.proposalId }), /后续消息/);
  f.user("确认把模板应用到当前项目");
  const applied = await f.strictRun({ action: "preset_apply", proposalId: applying.proposalId });
  assert.equal(applied.projectChanged, true);
  assert.equal(applied.rules, 1);
  assert.equal(applied.reload, "scheduled");
  assert.equal(await f.nativeSkill("fixture-ai"), false);
  assert.equal(await f.nativeSkill("fixture-sibling"), false);
  assert.ok(readFileSync(agents, "utf8").startsWith("# Project private instructions\nKeep project prose.\n"));
  for (const secret of ["PRIVATE_AUTH", "PRIVATE_SKILL_BODY", "private.invalid"]) {
    assert.ok(!JSON.stringify({ preview, saved, applied, file: readFileSync(path, "utf8"), receipts: f.entries.filter((entry) => entry.type === "custom") }).includes(secret));
  }
  await f.settle(); await f.flushReload();
  assert.equal(f.reloads(), 1);
  assert.ok(f.notifications.some((message) => message.includes("通用规则已更新")));
  const again = await f.run({ action: "preset_preview", name: "web-dev" });
  f.user();
  const noOp = await f.run({ action: "preset_apply", proposalId: again.proposalId });
  assert.equal(noOp.changed, false);
  assert.equal(noOp.reload, "not-needed");
}));

test("template revisions preserve earlier edits and require fresh confirmation; empty rules and inherit remove content", () => withFixture(async (f) => {
  const first = await stageTemplate(f, "Original rules");
  const one = (await f.run({ action: "list", query: "fixture-ai" })).items[0];
  f.user("调整模板，先别保存");
  const second = await f.strictRun({ action: "preset_stage", name: "web-dev", changes: [{ id: one.id, state: "on", reason: "保留该技能" }] });
  let view = await f.run({ action: "preset_show" });
  assert.equal(view.agentsMd.text, "Original rules");
  assert.equal(view.resources.items.find((item: { name: string }) => item.name === "fixture-ai").enabled, true);
  assert.equal(view.resources.items.find((item: { name: string }) => item.name === "fixture-docs").enabled, false);
  await assert.rejects(f.run({ action: "preset_save", proposalId: first.proposalId }), /方案版本/);
  await assert.rejects(f.run({ action: "preset_save", proposalId: second.proposalId }), /后续消息/);
  f.user("确认保存");
  await f.run({ action: "preset_save", proposalId: second.proposalId });
  const third = await f.strictRun({ action: "preset_stage", name: "web-dev", agentsMd: "",
    changes: [{ id: one.id, state: "inherit", reason: "不在模板中管理" }] });
  assert.equal(third.overwrites, true);
  view = await f.run({ action: "preset_show" });
  assert.equal(view.agentsMd.text, "");
  assert.ok(!view.resources.items.some((item: { name: string }) => item.name === "fixture-ai"));
  f.user(); await f.run({ action: "preset_save", proposalId: third.proposalId });
  assert.equal((await f.run({ action: "preset_show", name: "web-dev" })).agentsMd.text, "");
  assert.equal(existsSync(f.settings), false);
}));

test("template saving preserves existing project suggestions and template application refuses to discard them", () => withFixture(async (f) => {
  const project = await f.stage();
  const draft = await f.run({ action: "preset_stage", name: "with-pending", agentsMd: "Shared rules" });
  f.user("只保存模板"); await f.run({ action: "preset_save", proposalId: draft.proposalId });
  const pending = await f.run({ action: "list", pendingOnly: true });
  assert.equal(pending.proposalId, project.proposalId);
  assert.equal(pending.pendingCount, 2);
  await assert.rejects(f.run({ action: "preset_preview", name: "with-pending" }), /待修改/);
  assert.equal(existsSync(f.settings), false);
  assert.equal(f.dispatches.length, 0);
}));

test("external template or AGENTS changes invalidate confirmed actions before any project write", () => withFixture(async (f) => {
  const first = await stageTemplate(f);
  const path = presetPath(f.agent, "web-dev");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, resources: [], agentsMd: "Written outside" }));
  f.user();
  await assert.rejects(f.run({ action: "preset_save", proposalId: first.proposalId }), /已失效/);
  assert.ok(readFileSync(path, "utf8").includes("Written outside"));
  assert.equal((await f.run({ action: "preset_list" })).draft, null);
  const applying = await f.run({ action: "preset_preview", name: "web-dev" });
  writeFileSync(join(f.ctx.cwd, "AGENTS.md"), "Changed after preview");
  f.user();
  await assert.rejects(f.run({ action: "preset_apply", proposalId: applying.proposalId }), /已失效/);
  assert.equal(existsSync(f.settings), false);
  assert.equal(existsSync(f.mcp), false);
  assert.equal(readFileSync(join(f.ctx.cwd, "AGENTS.md"), "utf8"), "Changed after preview");
}));

test("template drafts do not survive branch, project, session or runtime changes", () => withFixture(async (f) => {
  let draft = await stageTemplate(f);
  await f.emit("session_tree");
  await assert.rejects(f.run({ action: "preset_save", proposalId: draft.proposalId }), /没有模板草稿/);
  draft = await stageTemplate(f);
  f.ctx.sessionManager.getSessionId = () => "another-session";
  assert.equal((await f.run({ action: "preset_list" })).draft, null);
  draft = await stageTemplate(f);
  const cwd = f.ctx.cwd;
  f.ctx.cwd = join(cwd, "subproject"); mkdirSync(f.ctx.cwd);
  assert.equal((await f.run({ action: "preset_list" })).draft, null);
  f.ctx.cwd = cwd;
  draft = await stageTemplate(f);
  await f.ctx.reload();
  await assert.rejects(f.run({ action: "preset_show", proposalId: draft.proposalId }), /没有模板草稿/);
  assert.equal(existsSync(presetPath(f.agent, "web-dev")), false);
}));

test("template actions reject irrelevant arguments and invalid names; cancellation and discard cannot write", () => withFixture(async (f) => {
  const draft = await stageTemplate(f);
  for (const args of [
    { action: "preset_save", proposalId: draft.proposalId, agentsMd: "unreviewed" },
    { action: "preset_apply", proposalId: draft.proposalId, name: "another" },
    { action: "preset_show", name: "web-dev", changes: [] },
    { action: "preset_list", pendingOnly: false },
    { action: "apply", proposalId: draft.proposalId, agentsMd: "unreviewed" },
    { action: "preset_stage", name: "../outside" },
    { action: "preset_stage", name: "web-dev", agentsMd: "x".repeat(65537) },
  ]) await assert.rejects(f.run(args));
  f.user();
  await assert.rejects(f.run({ action: "preset_save", proposalId: draft.proposalId }, AbortSignal.abort()));
  assert.equal(existsSync(presetPath(f.agent, "web-dev")), false);
  await assert.rejects(f.run({ action: "preset_discard", proposalId: "stale" }), /proposalId/);
  assert.equal((await f.strictRun({ action: "preset_discard", proposalId: draft.proposalId })).discarded, true);
  await assert.rejects(f.run({ action: "preset_save", proposalId: draft.proposalId }), /没有模板草稿/);
}));

test("long template rules and resource lists remain fully recoverable through bounded pages", () => withFixture(async (f) => {
  const rules = "规则内容包含中文和🌐，请保留完整文本。\n".repeat(180);
  const draft = await stageTemplate(f, rules);
  let offset = 0, textOffset = 0, text = "";
  const names = new Set<string>();
  while (true) {
    const view = await f.strictRun({ action: "preset_show", proposalId: draft.proposalId, limit: 1, offset, textOffset });
    assert.ok(Buffer.byteLength(JSON.stringify(view)) < 30000);
    for (const item of view.resources.items) names.add(item.name);
    text += view.agentsMd.text;
    if (view.resources.nextOffset === null && view.agentsMd.nextOffset === null) break;
    offset = view.resources.nextOffset ?? view.resources.total;
    textOffset = view.agentsMd.nextOffset ?? view.agentsMd.total;
  }
  assert.equal(text, rules.trim());
  assert.ok(names.has("fixture-ai") && names.has("fixture-docs"));
  assert.equal(existsSync(f.settings), false);
}));

for (const action of ["preset_save", "preset_apply"] as const) {
  test(`${action} rechecks the latest user message after waiting for file mutation locks`, () => withFixture(async (f) => {
    let draft = await stageTemplate(f);
    if (action === "preset_apply") {
      f.user(); await f.run({ action: "preset_save", proposalId: draft.proposalId });
      draft = await f.run({ action: "preset_preview", name: "web-dev" });
    }
    f.user();
    let release!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const path = action === "preset_save" ? presetPath(f.agent, "web-dev") : f.settings;
    const held = withFileMutationQueue(path, () => new Promise<void>((resolve) => { release = resolve; ready(); }));
    await locked;
    const rejected = assert.rejects(f.run({ action, proposalId: draft.proposalId }), /用户消息已改变/);
    try { await setImmediate(); f.user("先别执行，还要调整"); } finally { release(); }
    await held; await rejected;
    assert.equal(existsSync(f.settings), false);
    if (action === "preset_save") assert.equal(existsSync(path), false);
    assert.equal(f.dispatches.length, 0);
  }));
}

test("model-created template draft can be reviewed and saved from the workbench without changing the project", () => withFixture(async (f) => {
  await stageTemplate(f);
  let screens = 0;
  f.ctx.ui.custom = (async (factory: (...args: any[]) => Component) => {
    let result: unknown;
    const panel = factory({ terminal: { rows: 38 }, requestRender() {} },
      { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text },
      getKeybindings(), (value: unknown) => { result = value; });
    const lines = panel.render(144);
    const click = (label: string) => {
      const target = ` ${label} `;
      const y = lines.findIndex((line) => line.includes(target));
      assert.ok(y >= 0, lines.join("\n"));
      const x = visibleWidth(lines[y].slice(0, lines[y].indexOf(target))) + 1;
      panel.handleMouse?.({ type: "click", button: "left", x, y, screenX: x, screenY: y,
        width: 144, height: 38, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
    };
    if (screens === 0) {
      assert.ok(lines.join("\n").includes("模型草稿"));
      click("复核并保存模板");
    } else if (screens === 1) click("保存模板");
    else panel.handleInput?.("\u001b");
    screens++;
    return result;
  }) as typeof f.ctx.ui.custom;
  await f.openPanel();
  assert.equal(screens, 3);
  assert.ok(existsSync(presetPath(f.agent, "web-dev")));
  assert.equal(existsSync(f.settings), false);
  assert.equal(f.reloads(), 0);
  assert.equal((await f.run({ action: "preset_list" })).draft, null);
}));