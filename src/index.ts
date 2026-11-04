import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirtyRows, loadProject, saveProject, type ProjectModel } from "./model.ts";
import { CapabilitiesPanel, type PanelResult } from "./panel.ts";
import { ProposalStore } from "./proposals.ts";
import { createCapabilitiesTool } from "./tool.ts";

const STATUS_KEY = "pi-switch";
const RECEIPT = "pi-switch-save";

export default function piSwitch(pi: ExtensionAPI): void {
  const store = new ProposalStore();
  const status = (ctx: ExtensionContext, model?: ProjectModel) => {
    const count = model ? dirtyRows(model).length : 0;
    ctx.ui.setStatus(STATUS_KEY, count ? `能力开关 ${count} 项待复核 · /switch` : undefined);
  };
  const load = async (ctx: ExtensionContext) => {
    try { return await loadProject(ctx.cwd, getAgentDir(), pi.getMcpServers()); }
    catch { throw new Error("无法读取项目开关配置，请检查 settings.json 和 mcp.json 的格式及读取权限。"); }
  };
  pi.registerTool(createCapabilitiesTool({ store, load, status }));

  pi.on("session_start", (event, ctx) => {
    store.clear();
    if (event.reason !== "reload") return;
    const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === RECEIPT);
    if (last?.type !== "custom") return;
    const data = last.data as { status?: string; skills?: number; mcp?: number } | undefined;
    if (data?.status !== "saved" || typeof data.skills !== "number" || typeof data.mcp !== "number") return;
    ctx.ui.notify(`已保存并重新加载项目配置：Skills ${data.skills} 项，MCP ${data.mcp} 项。MCP 连接请用 /mcp 检查。`, "info");
    pi.appendEntry(RECEIPT, { ...data, status: "reloaded" });
  });
  pi.on("session_tree", (_event, ctx) => {
    store.clear();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("switch", {
    description: "能力开关：复核 AI 建议，管理本项目 Skills / MCP",
    handler: async (_args, ctx) => {
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
        let model: ProjectModel;
        try { model = await store.get(owner, () => load(ctx)); }
        catch (error) { status(ctx); throw error; }
        const result = await ctx.ui.custom<PanelResult>((tui, theme, kb, done) =>
          new CapabilitiesPanel({ model, tui, theme, kb, done }), {
            overlay: true,
            overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" },
          });
        if (result !== "save") {
          store.clear();
          ctx.ui.setStatus(STATUS_KEY, undefined);
          return;
        }
        if (!ctx.isIdle() || !ctx.isProjectTrusted()) {
          status(ctx, model);
          ctx.ui.notify("当前状态已改变，未保存；建议仍暂存，请空闲时重新打开面板。", "warning");
          return;
        }
        const changes = dirtyRows(model);
        if (!saveProject(model)) {
          store.clear();
          ctx.ui.setStatus(STATUS_KEY, undefined);
          ctx.ui.notify("没有需要保存的修改。", "info");
          return;
        }
        store.clear();
        ctx.ui.setStatus(STATUS_KEY, undefined);
        pi.appendEntry(RECEIPT, { status: "saved",
          skills: changes.filter((row) => row.kind === "skill").length,
          mcp: changes.filter((row) => row.kind === "mcp").length });
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
