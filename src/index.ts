import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirtyRows, loadProject, type ProjectModel } from "./model.ts";
import { openWorkbench, type SaveCounts } from "./workbench.ts";
import { ProposalStore, projectFingerprint, resourceId, stageChanges, type ProposedChange } from "./proposals.ts";
import { createCapabilitiesTool, latestUserMessageId } from "./tool.ts";
import { presetCompletions, runPresetCommand } from "./preset-command.ts";
import { PresetDraftStore } from "./preset-drafts.ts";

const STATUS_KEY = "pi-switch";
const RECEIPT = "pi-switch-save";

export default function piSwitch(pi: ExtensionAPI): void {
  const store = new ProposalStore();
  const presetStore = new PresetDraftStore();
  let reloadRequested = false;
  const status = (ctx: ExtensionContext, model?: ProjectModel) => {
    const count = model ? dirtyRows(model).length : 0;
    const draft = presetStore.current;
    ctx.ui.setStatus(STATUS_KEY, draft ? `模板 ${draft.name} 待${draft.operation === "save" ? "保存" : "应用"} · /switch`
      : count ? `能力开关 ${count} 项待复核 · /switch` : undefined);
  };
  const load = async (ctx: ExtensionContext) => {
    try { return await loadProject(ctx.cwd, getAgentDir(), pi.getMcpServers()); }
    catch { throw new Error("无法读取项目开关配置，请检查 settings.json 和 mcp.json 的格式及读取权限。"); }
  };
  const receipt = (ctx: ExtensionContext, model: ProjectModel, counts: SaveCounts) => {
    const pending = dirtyRows(model).map((row) => ({ id: resourceId(row), state: row.state, reason: row.reason! }));
    pi.appendEntry(RECEIPT, { status: "saved", ...counts, cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      ...(pending.length ? { pending, fingerprint: projectFingerprint(model),
        proposalId: store.proposalId, userMessageId: latestUserMessageId(ctx) } : {}) });
  };
  pi.registerTool(createCapabilitiesTool({ store, presetStore, load, status,
    applied(ctx, model, counts) {
      receipt(ctx, model, counts);
      reloadRequested = true;
    },
  }));

  pi.on("session_start", async (event, ctx) => {
    store.clear();
    presetStore.clear();
    reloadRequested = false;
    status(ctx);
    if (event.reason !== "reload") return;
    const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === RECEIPT);
    if (last?.type !== "custom") return;
    const data = last.data as { status?: string; skills?: number; mcp?: number; rules?: number;
      cwd?: string; sessionId?: string; pending?: ProposedChange[]; fingerprint?: string;
      proposalId?: string; userMessageId?: string } | undefined;
    if (data?.status !== "saved" || typeof data.skills !== "number" || typeof data.mcp !== "number") return;
    ctx.ui.notify(`已保存并重新加载项目配置：Skills ${data.skills} 项，MCP ${data.mcp} 项${data.rules ? "，通用规则已更新" : ""}。MCP 连接请用 /mcp 检查。`, "info");
    pi.appendEntry(RECEIPT, { status: "reloaded", skills: data.skills, mcp: data.mcp, ...(data.rules ? { rules: data.rules } : {}) });
    if (!data.pending?.length || data.cwd !== ctx.cwd || data.sessionId !== ctx.sessionManager.getSessionId()
      || !ctx.isProjectTrusted()) return;
    try {
      const model = await store.get(`${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`, () => load(ctx));
      if (projectFingerprint(model) !== data.fingerprint) throw new Error("配置已改变");
      for (let offset = 0; offset < data.pending.length; offset += 200) {
        stageChanges(model, data.pending.slice(offset, offset + 200));
      }
      store.revise(data.userMessageId, data.proposalId);
      status(ctx, model);
    } catch {
      store.clear();
      status(ctx);
      ctx.ui.notify("已保存的修改不受影响；剩余建议已失效，请重新读取清单、展示建议并确认。", "warning");
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    store.clear();
    presetStore.clear();
    reloadRequested = false;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!reloadRequested) return;
    reloadRequested = false;
    try { pi.sendUserMessage("/switch --reload", { expandPromptTemplates: true }); }
    catch { ctx.ui.notify("配置已保存，但未能启动自动重载。请执行 /reload 或重启 Pi。", "error"); }
  });

  pi.registerCommand("switch", {
    description: "打开 Pi Switch 工作台：项目、Skills/MCP、规则和模板",
    getArgumentCompletions: presetCompletions,
    handler: async (args, ctx) => {
      if (args.trim() === "--reload") {
        if (!ctx.isIdle()) {
          ctx.ui.notify("配置已保存，当前仍在运行；请空闲后执行 /reload。", "warning");
          return;
        }
        try { await ctx.reload(); return; }
        catch { ctx.ui.notify("配置已保存，但重新加载失败。请执行 /reload 或重启 Pi。", "error"); }
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("请在 Pi 交互终端中运行 /switch", "warning");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("请先通过 Pi 的项目信任流程，再打开能力开关。", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("请等待当前任务完成后再打开能力开关。", "info");
        return;
      }
      try {
        const owner = `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;
        presetStore.use(owner);
        let model: ProjectModel;
        try { model = await store.get(owner, () => load(ctx)); }
        catch (error) { presetStore.clear(); status(ctx); throw error; }
        if (args.trim()) {
          if (!await runPresetCommand(args, ctx, model)) return;
          store.clear();
          presetStore.clear();
          status(ctx);
          try { await ctx.reload(); return; }
          catch { ctx.ui.notify("模板已保存到项目，但重新加载失败。请执行 /reload 或重启 Pi。", "error"); }
          return;
        }
        const result = await openWorkbench(ctx, model, presetStore);
        store.clear();
        if (result) presetStore.clear();
        status(ctx);
        if (!result) return;
        if (result !== "initialized") receipt(ctx, model, result);
      } catch (error) {
        ctx.ui.notify(error instanceof SyntaxError ? "配置 JSON 格式有误，请修复后重新打开面板。"
          : error instanceof Error ? error.message : "无法保存项目开关配置。", "error");
        return;
      }
      try {
        await ctx.reload();
        return;
      } catch {
        ctx.ui.notify("配置已保存，但重新加载失败。请执行 /reload 或重启 Pi。", "error");
      }
    },
  });
}
