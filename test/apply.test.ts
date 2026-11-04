import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { DefaultPackageManager, SettingsManager, loadSkills, withFileMutationQueue,
  type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
  type ExtensionToolContext, type RegisteredCommand, type SessionEntry } from "@earendil-works/pi-coding-agent";
import piSwitch from "../src/index.ts";
import { createCapabilitiesTool } from "../src/tool.ts";

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
  return { agent, ctx, run, user, stage, settle, flushReload, nativeSkill, assertGlobals,
    settings, mcp, entries, notifications, dispatches, statuses, reloads: () => reloads,
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
