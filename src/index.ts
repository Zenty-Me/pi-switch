import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadProject, saveProject } from "./model.ts";
import { CapabilitiesPanel, type PanelResult } from "./panel.ts";

export default function projectCapabilities(pi: ExtensionAPI): void {
  pi.registerCommand("project-capabilities", {
    description: "管理当前项目的 Skills 和 MCP 开关",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("请在 Pi 交互终端中运行 /project-capabilities", "warning");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("请先通过 Pi 的项目信任流程，再管理项目能力。", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("请等待当前任务完成后再打开项目能力面板。", "info");
        return;
      }
      try {
        const model = await loadProject(ctx.cwd, getAgentDir(), pi.getMcpServers());
        const result = await ctx.ui.custom<PanelResult>((tui, theme, kb, done) =>
          new CapabilitiesPanel({ model, tui, theme, kb, done }), {
            overlay: true,
            overlayOptions: { width: "90%", maxHeight: "95%", anchor: "center" },
          });
        if (result !== "save") return;
        if (!ctx.isIdle() || !ctx.isProjectTrusted()) {
          ctx.ui.notify("当前状态已改变，未保存，请空闲时重新打开面板。", "warning");
          return;
        }
        if (!saveProject(model)) {
          ctx.ui.notify("没有需要保存的修改。", "info");
          return;
        }
      } catch (error) {
        // File paths are useful; never show raw configuration or credentials in errors.
        ctx.ui.notify(error instanceof SyntaxError ? "配置 JSON 格式有误，请修复后重新打开面板。"
          : error instanceof Error ? error.message : "无法保存项目能力配置。", "error");
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
