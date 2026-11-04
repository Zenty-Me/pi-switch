import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions, type ExtensionAPI, type ExtensionCommandContext,
  type RegisteredCommand, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import piSwitch from "../src/index.ts";
import { createCapabilitiesTool } from "../src/tool.ts";
import { CapabilitiesPanel, type PanelResult } from "../src/panel.ts";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

test("Pi's native extension loader registers the panel and tool without local node_modules", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-capabilities-loader-"));
  const isolated = join(temporary, "isolated-package");
  cpSync(resolve(import.meta.dirname, "../src"), join(isolated, "src"), { recursive: true });
  assert.equal(existsSync(join(isolated, "node_modules")), false);
  const result = await discoverAndLoadExtensions([
    join(isolated, "src", "index.ts"),
  ], temporary, temporary);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.deepEqual([...result.extensions[0].commands.keys()], ["switch"]);
  assert.deepEqual([...result.extensions[0].tools.keys()], ["pi_switch"]);
});

for (const decision of ["save", "cancel"] as const) {
  test(`conversation → proposal → panel ${decision}: only user save writes files and reloads`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-capabilities-workflow-"));
    const agent = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(join(agent, "skills", "fixture-ai"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(agent, "skills", "fixture-ai", "SKILL.md"),
      "---\nname: fixture-ai\ndescription: Fixture AI workflow\n---\nPRIVATE_SKILL_BODY");
    const globalPath = join(agent, "mcp.json");
    const globalText = JSON.stringify({ mcpServers: { "fixture-docs": {
      url: "https://example.invalid/mcp", headers: { Authorization: "PRIVATE_AUTH_VALUE" },
    } } });
    writeFileSync(globalPath, globalText);
    const oldAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    try {
      let tool!: ReturnType<typeof createCapabilitiesTool>;
      let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
      let reloads = 0;
      let preview = "";
      const notifications: string[] = [];
      const entries: { type: string; customType: string; data: unknown }[] = [];
      const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void>();
      const api = {
        registerTool(definition: typeof tool) { tool = definition; },
        registerCommand(_name: string, definition: typeof command) { command = definition; },
        getMcpServers: () => [],
        appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
        on(name: string, handler: (event: unknown, context: ExtensionContext) => void) { handlers.set(name, handler); },
      } as unknown as ExtensionAPI;
      piSwitch(api);
      const ctx = {
        cwd, mode: "tui", isProjectTrusted: () => true, isIdle: () => true,
        sessionManager: { getSessionId: () => "workflow-session", getBranch: () => entries },
        ui: {
          notify(message: string) { notifications.push(message); }, setStatus() {},
          async custom(factory: (tui: TUI, theme: Theme, kb: KeybindingsManager,
            done: (value: PanelResult) => void) => CapabilitiesPanel) {
            let result: PanelResult | undefined;
            const panel = factory({ terminal: { rows: 36 }, requestRender() {} } as unknown as TUI,
              { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value,
                bold: (value: string) => value } as Theme,
              getKeybindings() as unknown as KeybindingsManager, (value) => { result = value; });
            preview = panel.render(110).join("\n");
            if (decision === "save") panel.handleInput("\u0013");
            else { panel.handleInput("\u001b"); panel.handleInput("\r"); }
            return result;
          },
        },
        async reload() {
          reloads++;
          handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
        },
      } as unknown as ExtensionCommandContext;
      const run = async (args: Parameters<typeof tool.execute>[1]) => {
        const result = await tool.execute("workflow", args, undefined, undefined, ctx as unknown as ExtensionToolContext);
        const item = result.content[0];
        assert.equal(item.type, "text");
        return item.type === "text" ? JSON.parse(item.text) : undefined;
      };
      const list = await run({ action: "list", query: "fixture-" });
      assert.equal(list.total, 2);
      assert.ok(!JSON.stringify(list).includes("PRIVATE_AUTH_VALUE"));
      assert.ok(!JSON.stringify(list).includes("PRIVATE_SKILL_BODY"));
      await run({ action: "stage", changes: list.items.map((row: { id: string }) => ({
        id: row.id, state: "off", reason: "本项目无需此能力，等待用户复核",
      })) });
      assert.equal(existsSync(join(cwd, ".pi", "settings.json")), false);
      assert.equal(existsSync(join(cwd, ".pi", "mcp.json")), false);
      await command.handler("", ctx);
      assert.ok(preview.includes("模型建议"));
      assert.ok(preview.includes("本项目无需此能力"));
      if (decision === "save") {
        assert.ok(readFileSync(join(cwd, ".pi", "settings.json"), "utf8").includes("fixture-ai"));
        assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8")), {
          mcpServers: { "fixture-docs": { enabled: false } },
        });
        assert.equal(reloads, 1);
        assert.ok(notifications.some((message) => message.includes("Skills 1 项，MCP 1 项")));
      } else {
        assert.equal(existsSync(join(cwd, ".pi", "settings.json")), false);
        assert.equal(existsSync(join(cwd, ".pi", "mcp.json")), false);
        assert.equal(reloads, 0);
      }
      assert.equal(readFileSync(globalPath, "utf8"), globalText);
    } finally {
      if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgent;
    }
  });
}
