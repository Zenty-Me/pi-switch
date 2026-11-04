import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createCapabilitiesTool } from "../src/tool.ts";
import { ProposalStore, resourceId } from "../src/proposals.ts";
import { type ProjectModel, type ResourceRow } from "../src/model.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-capabilities-proposal-"));
  const file = (name: string, data: Record<string, unknown>) => {
    const path = join(root, name);
    const text = JSON.stringify(data);
    writeFileSync(path, text);
    return { path, text, data };
  };
  const resources: ResourceRow[] = [
    { id: "skill:/private/full/path/nextjs", name: "nextjs", kind: "skill", source: "/private/source",
      group: "全局 Skills", description: "Next.js development", initial: "inherit", state: "inherit", editable: true, inheritedEnabled: true },
    { id: "mcp:docs", name: "docs", kind: "mcp", source: "全局 mcp.json", group: "全局 MCP",
      description: "Search docs", initial: "off", state: "off", editable: true, inheritedEnabled: true },
    { id: "mcp:registered", name: "registered", kind: "mcp", source: "扩展注册", group: "只读 MCP",
      description: "Read only", initial: "inherit", state: "inherit", editable: false, inheritedEnabled: true },
  ];
  const base: ProjectModel = { cwd: root, rows: resources,
    settings: file("project-settings.json", { theme: "dark" }), mcp: file("project-mcp.json", {}),
    globalSettings: file("global-settings.json", {}),
    globalMcp: file("global-mcp.json", { mcpServers: { docs: {
      url: "https://private.invalid/secret-url", headers: { Authorization: "SECRET_HEADER" },
      env: { API_KEY: "SECRET_ENV" }, oauth: { clientSecret: "SECRET_OAUTH" }, command: "SECRET_COMMAND",
    } } }),
  };
  const store = new ProposalStore();
  let loads = 0;
  let notices = 0;
  const tool = createCapabilitiesTool({ store, load: async () => { loads++; return structuredClone(base); }, status() {},
    applied() {} });
  const ctx = {
    cwd: root, mode: "tui", isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "session-one",
      getBranch: () => [{ id: "proposal-user", type: "message", message: { role: "user", content: "用户消息" } }] },
    ui: { notify() { notices++; } },
  } as unknown as ExtensionToolContext;
  const run = async (args: Parameters<typeof tool.execute>[1], signal?: AbortSignal) => {
    const result = await tool.execute("test-call", args, signal, undefined, ctx);
    const content = result.content[0];
    assert.equal(content.type, "text");
    if (content.type !== "text") throw new Error("Expected text");
    return JSON.parse(content.text);
  };
  const pending = () => store.get(`${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`, async () => structuredClone(base));
  return { base, tool, ctx, run, pending, loads: () => loads, notices: () => notices };
}

test("list exports only metadata and opaque IDs, never raw MCP configuration or file paths", async () => {
  const f = setup();
  const payload = await f.run({ action: "list" });
  assert.equal(payload.total, 3);
  assert.equal(payload.saved, false);
  assert.equal(payload.items[0].id, resourceId(f.base.rows[0]));
  const serialized = JSON.stringify(payload);
  for (const secret of ["SECRET_HEADER", "SECRET_ENV", "SECRET_OAUTH", "SECRET_COMMAND", "secret-url", "/private/full/path", "/private/source"]) {
    assert.ok(!serialized.includes(secret), secret);
  }
  assert.equal(payload.items[1].connection, "unknown");
});

test("model suggestions stage reasons only; unmentioned resources, disk and global config are unchanged", async () => {
  const f = setup();
  const id = resourceId(f.base.rows[0]);
  const payload = await f.run({ action: "stage", changes: [{ id, state: "off", reason: "此项目不使用 Next.js" }] });
  assert.equal(payload.saved, false);
  assert.equal(payload.pendingCount, 1);
  assert.ok(payload.nextStep.includes("/switch"));
  assert.equal(f.notices(), 1);
  const model = await f.pending();
  assert.equal(model.rows[0].state, "off");
  assert.equal(model.rows[0].reason, "此项目不使用 Next.js");
  assert.equal(model.rows[1].state, "off");
  assert.equal(model.rows[2].state, "inherit");
  for (const file of [f.base.settings, f.base.mcp, f.base.globalSettings, f.base.globalMcp]) {
    assert.equal(readFileSync(file.path, "utf8"), file.text);
  }
});

test("follow-up conversation refines existing suggestions without losing other staged items", async () => {
  const f = setup();
  const first = resourceId(f.base.rows[0]);
  const second = resourceId(f.base.rows[1]);
  await f.run({ action: "stage", changes: [{ id: first, state: "off", reason: "先关闭" }] });
  await f.run({ action: "stage", changes: [{ id: second, state: "on", reason: "保留文档服务" }] });
  let payload = await f.run({ action: "list", pendingOnly: true });
  assert.equal(payload.pendingCount, 2);
  await f.run({ action: "stage", changes: [{ id: first, state: "inherit", reason: "还是保留原设置" }] });
  payload = await f.run({ action: "list", pendingOnly: true });
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].name, "docs");
  assert.equal(payload.items[0].reason, "保留文档服务");
});

test("invalid, duplicated, readonly or reasonless proposals reject the entire batch", async () => {
  const f = setup();
  const valid = { id: resourceId(f.base.rows[0]), state: "off", reason: "合理理由" };
  for (const invalid of [
    { ...valid, id: "unknown" },
    { ...valid, id: resourceId(f.base.rows[2]) },
    { ...valid, reason: "  " },
    { ...valid, state: "save" },
    valid,
  ]) {
    await assert.rejects(f.run({ action: "stage", changes: [valid, invalid] }));
    assert.equal((await f.pending()).rows[0].state, "inherit");
  }
  await assert.rejects(f.run({ action: "save" }), /只支持 list、stage 和 apply/);
});

test("pagination and kind/query/pending filters are explicit and bounded", async () => {
  const f = setup();
  const first = await f.run({ action: "list", limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.nextOffset, 1);
  const rest = await f.run({ action: "list", offset: first.nextOffset, kind: "mcp", limit: 1 });
  assert.equal(rest.items.length, 1);
  assert.equal(rest.nextOffset, null);
  const query = await f.run({ action: "list", query: "Next.js", kind: "skill" });
  assert.equal(query.items.length, 1);
  assert.equal(query.items[0].name, "nextjs");
});

test("untrusted projects, noninteractive mode and aborted calls do not load resources", async () => {
  for (const mode of ["untrusted", "print", "aborted"]) {
    const f = setup();
    if (mode === "untrusted") f.ctx.isProjectTrusted = () => false;
    if (mode === "print") f.ctx.mode = "print";
    const signal = mode === "aborted" ? AbortSignal.abort() : undefined;
    await assert.rejects(f.run({ action: "list" }, signal));
    assert.equal(f.loads(), 0);
  }
});

test("external configuration edits invalidate staged suggestions instead of overwriting new settings", async () => {
  const f = setup();
  await f.run({ action: "stage", changes: [{ id: resourceId(f.base.rows[0]), state: "off", reason: "暂存" }] });
  writeFileSync(f.base.settings.path, '{"theme":"changed-outside"}');
  await assert.rejects(f.run({ action: "list" }), /旧建议已作废/);
  assert.equal(readFileSync(f.base.settings.path, "utf8"), '{"theme":"changed-outside"}');
});

test("suggestions never leak into another session or project", async () => {
  const f = setup();
  await f.run({ action: "stage", changes: [{ id: resourceId(f.base.rows[0]), state: "off", reason: "只针对当前会话" }] });
  f.ctx.sessionManager.getSessionId = () => "session-two";
  let payload = await f.run({ action: "list" });
  assert.equal(payload.pendingCount, 0);
  await f.run({ action: "stage", changes: [{ id: resourceId(f.base.rows[0]), state: "off", reason: "只针对当前项目" }] });
  f.ctx.cwd += "-different";
  payload = await f.run({ action: "list" });
  assert.equal(payload.pendingCount, 0);
});

test("Chinese metadata and proposal previews stay within the tool output budget", async () => {
  const f = setup();
  f.base.rows = Array.from({ length: 40 }, (_, i) => ({ ...f.base.rows[0],
    id: `skill:large-${i}`, name: `长名称${i}`, description: "中".repeat(2000) }));
  const page = await f.run({ action: "list", limit: 40 });
  assert.ok(page.nextOffset !== null);
  assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8") < 50000);
  const preview = await f.run({ action: "stage", changes: f.base.rows.map((row) => ({
    id: resourceId(row), state: "off", reason: "理".repeat(500),
  })) });
  assert.equal(preview.pendingCount, 40);
  assert.equal(preview.previewTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(preview, null, 2), "utf8") < 50000);
});
