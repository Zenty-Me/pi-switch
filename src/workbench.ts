import { join } from "node:path";
import { getAgentDir, withFileMutationQueue, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertUnchanged, dirtyRows, saveProject, type ProjectModel } from "./model.ts";
import { CapabilitiesPanel, type PanelPage, type PanelResult } from "./panel.ts";
import { confirmPreview, runPresetCommand, savePresetWithPreview } from "./preset-command.ts";
import { PresetDraftStore } from "./preset-drafts.ts";
import { loadWorkspace, projectRulesWrite, readSnapshot, rulesChanged, validatePreset } from "./presets.ts";

export interface SaveCounts { skills: number; mcp: number; rules?: number; }

function ensureReady(ctx: ExtensionCommandContext, model: ProjectModel): void {
  if (ctx.mode !== "tui" || !ctx.isIdle() || !ctx.isProjectTrusted() || ctx.cwd !== model.cwd) {
    throw new Error("项目或运行状态已改变，未保存。请在已信任、空闲的项目中重新打开面板。");
  }
}

export async function openWorkbench(ctx: ExtensionCommandContext, model: ProjectModel,
  drafts?: PresetDraftStore): Promise<SaveCounts | "initialized" | undefined> {
  ensureReady(ctx, model);
  const workspace = loadWorkspace(model.cwd, getAgentDir());
  const refreshTemplates = () => {
    const fresh = loadWorkspace(model.cwd, getAgentDir());
    workspace.draft = drafts?.item;
    workspace.presets = workspace.draft ? [workspace.draft, ...fresh.presets.filter((item) => item.name !== workspace.draft!.name)] : fresh.presets;
    workspace.presetsError = fresh.presetsError;
  };
  if (drafts?.current) {
    try { drafts.checked(model); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "模板草稿已失效。", "warning"); }
  }
  refreshTemplates();
  let page: PanelPage = workspace.draft ? "presets" : dirtyRows(model).length ? "resources" : "overview";
  while (true) {
    ensureReady(ctx, model);
    const result = await ctx.ui.custom<PanelResult>((tui, theme, kb, done) =>
      new CapabilitiesPanel({ model, workspace, page, tui, theme, kb, done }), {
        overlay: true, overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" },
      });
    if (!result || result === "cancel") return undefined;
    try {
      ensureReady(ctx, model);
      if (result === "save") {
        const changes = dirtyRows(model);
        const rules = workspace.rules;
        const ruleWrite = rules && rulesChanged(workspace) ? projectRulesWrite(rules) : undefined;
        const saved = await withFileMutationQueue(model.settings.path, () =>
          withFileMutationQueue(model.mcp.path, () => withFileMutationQueue(join(model.cwd, "AGENTS.md"), async () => {
            ensureReady(ctx, model);
            if (ruleWrite && rules) {
              for (const file of [rules.file, rules.override]) { readSnapshot(file.path); assertUnchanged(file); }
            }
            return saveProject(model, undefined, ruleWrite ? [ruleWrite] : []);
          })));
        if (!saved) { ctx.ui.notify("没有需要保存的修改。", "info"); return undefined; }
        return { skills: changes.filter((row) => row.kind === "skill").length,
          mcp: changes.filter((row) => row.kind === "mcp").length, rules: Number(Boolean(ruleWrite)) };
      }
      page = result.page;
      if (result.action === "review-draft") {
        const draft = drafts?.checked(model);
        if (!draft || result.name !== draft.name) throw new Error("模板草稿已改变，请重新选择。");
        if (draft.operation === "apply" && rulesChanged(workspace)) throw new Error("请先保存或放弃通用规则草稿，再应用模板。");
        const preview = [
          draft.operation === "save" ? `只保存模板${draft.source.text === undefined ? "" : "，将覆盖同名模板"}，不修改当前项目。` : "将此模板应用到当前项目，保留 AGENTS.md 中的项目说明。",
          ...draft.preset.resources.map((item) => `${item.kind} · ${item.name}：${item.enabled ? "开启" : "关闭"}`),
          "", "通用规则：", draft.preset.agentsMd ?? "（不包含规则；应用时将移除旧模板规则区块）",
        ].join("\n");
        if (!await confirmPreview(ctx, `复核模型模板 · ${draft.name}`, preview, draft.operation === "save" ? "保存模板" : "应用并重载")) continue;
        const commit = () => { ensureReady(ctx, model); return drafts!.commit(model, draft); };
        const changed = draft.operation === "save" ? await withFileMutationQueue(draft.source.path, async () => commit())
          : await withFileMutationQueue(model.settings.path, () => withFileMutationQueue(model.mcp.path, () =>
            withFileMutationQueue(draft.plan!.agents.path, () => withFileMutationQueue(draft.source.path, async () => commit()))));
        ctx.ui.notify(draft.operation === "save" ? `已保存模板 ${draft.name}，项目未修改。` : changed ? "模板已应用，正在重新加载。" : "项目已符合模板，无需修改。", "info");
        if (changed && draft.operation === "apply") return "initialized";
        refreshTemplates();
        continue;
      }
      if (result.action === "edit-rules") {
        const rules = workspace.rules;
        if (!rules) throw new Error(workspace.rulesError ?? "无法读取项目规则。");
        if (rules.override.text !== undefined) throw new Error("请先处理 AGENTS.override.md，再编辑通用规则。");
        const value = await ctx.ui.editor("项目通用规则 · 仅更新模板区块；留空移除该区块", rules.value);
        if (value !== undefined) {
          rules.value = validatePreset({ version: 1, resources: [], agentsMd: value }).agentsMd ?? "";
          ctx.ui.notify("规则已暂存。保存并应用后生效，也可先保存为模板。", "info");
        }
        continue;
      }
      if (result.action === "apply-preset") {
        if (dirtyRows(model).length || rulesChanged(workspace)) throw new Error("请先保存或放弃待修改项，再初始化模板。");
        if (!result.name) throw new Error("请先选择模板。");
        if (await runPresetCommand(`init ${result.name}`, ctx, model)) return "initialized";
      } else {
        const rules = workspace.rules;
        if (!rules) throw new Error(workspace.rulesError ?? "无法读取通用规则，未保存模板。");
        const name = result.action === "update-preset" ? result.name
          : await ctx.ui.input("保存当前选择为模板", "例如 web-dev、research、writing");
        if (name) await savePresetWithPreview(ctx, model, name.trim(), rules.file, rules.value);
      }
      refreshTemplates();
    } catch (error) {
      refreshTemplates();
      ctx.ui.notify(error instanceof Error ? error.message : "操作失败，未保存项目修改。", "error");
    }
  }
}
