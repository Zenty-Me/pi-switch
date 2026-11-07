import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir, withFileMutationQueue, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth, type AutocompleteItem, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { assertProjectUnchanged, assertUnchanged, commitFiles, dirtyRows, savedEnabled,
  type FileSnapshot, type ProjectModel } from "./model.ts";
import { applyPreset, captureAgents, capturePreset, listPresets, preparePreset, presetPath,
  readPreset, readSnapshot } from "./presets.ts";

const HELP = "/switch save <名称> 保存模板；/switch init [名称] 预览并初始化；/switch presets 选择模板；/switch 管理开关。";
const enabled = (value: boolean) => value ? "开启" : "关闭";
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

function ensureReady(ctx: ExtensionCommandContext): void {
  if (ctx.mode !== "tui" || !ctx.isProjectTrusted() || !ctx.isIdle()) {
    throw new Error("请在已信任、空闲的 Pi 交互终端中使用模板；未修改任何文件。");
  }
}

export function presetCompletions(prefix: string): AutocompleteItem[] | null {
  const commands = ["save", "init", "presets", "help"];
  let values = commands;
  if (prefix.startsWith("init ") || prefix.startsWith("save ")) {
    const command = prefix.slice(0, prefix.indexOf(" "));
    try { values = listPresets(getAgentDir()).map((name) => `${command} ${name}`); }
    catch { return null; }
  }
  const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
  return items.length ? items : null;
}

export async function confirmPreview(ctx: ExtensionCommandContext, title: string, content: string, action: string): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, theme, kb, done) => {
    const body = new Text(clean(content), 0, 0);
    let offset = 0;
    let maximum = 0;
    let height = 8;
    let buttonRow = -1;
    let confirmEnd = 0;
    let cancelStart = 0;
    let cancelEnd = 0;
    return {
      capturesViewportInput: true,
      render(width) {
        height = Math.max(1, tui.terminal.rows - 8);
        const lines = body.render(Math.max(1, width));
        maximum = Math.max(0, lines.length - height);
        offset = Math.min(offset, maximum);
        const viewport = lines.slice(offset, offset + height);
        buttonRow = viewport.length + 2;
        const confirmLabel = ` ${action} `;
        confirmEnd = Math.min(width, visibleWidth(confirmLabel));
        cancelStart = visibleWidth(confirmLabel) + 2;
        cancelEnd = Math.min(width, cancelStart + visibleWidth(" 取消 "));
        return [
          theme.fg("accent", theme.bold(clean(title))),
          ...viewport,
          theme.fg("dim", `预览 ${offset + 1}–${Math.min(offset + height, lines.length)} / ${lines.length} 行 · ↑↓ / PageUp / PageDown 滚动`),
          theme.bg("selectedBg", theme.fg("accent", confirmLabel)) + "  " + theme.fg("muted", " 取消 "),
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data) {
        if (kb.matches(data, "tui.select.cancel")) { done(false); return; }
        if (kb.matches(data, "tui.select.confirm")) { done(true); return; }
        if (kb.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
        else if (kb.matches(data, "tui.select.down")) offset = Math.min(maximum, offset + 1);
        else if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - height);
        else if (matchesKey(data, "pageDown")) offset = Math.min(maximum, offset + height);
        else return;
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel") {
          offset = Math.max(0, Math.min(maximum, offset + (event.wheelDelta ?? 0)));
        } else if (event.type === "click" && event.button === "left" && event.y === buttonRow) {
          if (event.x >= 0 && event.x < confirmEnd) done(true);
          else if (event.x >= cancelStart && event.x < cancelEnd) done(false);
          else return undefined;
        } else return undefined;
        tui.requestRender();
        return { handled: true, focus: true };
      },
      invalidate() { body.invalidate(); },
    };
  }, { overlay: true, overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" } });
}

export async function savePresetWithPreview(ctx: ExtensionCommandContext, model: ProjectModel,
  name: string, agents: FileSnapshot, rules: string): Promise<boolean> {
  ensureReady(ctx);
  const source = readSnapshot(presetPath(getAgentDir(), name));
  const preset = capturePreset(model, rules);
  const preview = [
    source.text === undefined ? "创建个人模板。" : "更新同名个人模板，将替换原模板内容。",
    "保存面板中的当前选择。此次只写模板，不应用当前项目的待保存修改。",
    "资源需事先安装，MCP 连接配置与凭据留在原处。",
    ...preset.resources.map((item) => `${item.kind === "skill" ? "Skill" : "MCP"} · ${item.name}：${enabled(item.enabled)}`),
    "", "AGENTS.md 模板内容：", preset.agentsMd ?? "（不包含规则）",
  ].join("\n");
  if (!await confirmPreview(ctx, `保存模板 · ${name}`, preview, "保存模板")) return false;
  await withFileMutationQueue(source.path, async () => {
    ensureReady(ctx);
    assertProjectUnchanged(model);
    assertUnchanged(agents);
    readSnapshot(source.path);
    commitFiles([{ file: source, text: `${JSON.stringify(preset, null, 2)}\n` }]);
  });
  ctx.ui.notify(`已保存模板 ${name}：${preset.resources.length} 项能力${preset.agentsMd ? "，含通用规则" : ""}。`, "info");
  return true;
}

/** Returns true only when project files changed and the caller should reload. */
export async function runPresetCommand(args: string, ctx: ExtensionCommandContext, model: ProjectModel): Promise<boolean> {
  ensureReady(ctx);
  const [command, givenName, ...extra] = args.trim().split(/\s+/);
  if (command === "help" && !givenName) { ctx.ui.notify(HELP, "info"); return false; }
  if (!["save", "init", "presets"].includes(command) || extra.length || (command === "presets" && givenName)) {
    throw new Error(HELP);
  }
  if (dirtyRows(model).length) throw new Error("请先在 /switch 保存或放弃待修改项，再使用模板。");
  const agentDir = getAgentDir();
  let name: string | undefined = givenName;
  if (!name) {
    if (command === "save") name = await ctx.ui.input("保存初始化模板", "例如 web-dev、research、writing");
    else {
      const names = listPresets(agentDir);
      if (!names.length) { ctx.ui.notify("还没有模板。先配置好项目，再用 /switch save <名称> 保存。", "info"); return false; }
      name = await ctx.ui.select("选择初始化模板", names);
    }
  }
  if (!name) return false;
  name = name.trim();
  if (command === "save") {
    const agents = readSnapshot(join(model.cwd, "AGENTS.md"));
    const rules = await ctx.ui.editor("模板通用规则：去掉项目专属内容；留空仅保存能力组合；Esc 取消", captureAgents(agents));
    if (rules === undefined) return false;
    await savePresetWithPreview(ctx, model, name, agents, rules);
    return false;
  }

  const source = readSnapshot(presetPath(agentDir, name));
  const preset = readPreset(source);
  const plan = preparePreset(model, preset);
  const changes = dirtyRows(plan.model);
  if (!changes.length && !plan.agentsWrite) {
    ctx.ui.notify(`项目已经符合模板 ${name}，无需修改或重载。`, "info");
    return false;
  }
  const preview = [
    `项目：${model.cwd}`,
    `本次修改 ${changes.length} 项能力；模板未列出的资源保持现状。`,
    ...changes.map((row) => `${row.kind === "skill" ? "Skill" : "MCP"} · ${row.name}：${enabled(savedEnabled(row))}${row.initial === "inherit" ? "（按默认）" : ""} → ${enabled(row.state === "on")}（项目设置）`),
    "", plan.agentsWrite ? `AGENTS.md：${preset.agentsMd ? "新增或更新" : "移除旧"}模板区块，区块外的项目内容保留。应用后完整内容：` : "AGENTS.md：保持现状。",
    ...(plan.agentsWrite ? [plan.agentsWrite.text] : []),
  ].join("\n");
  if (!await confirmPreview(ctx, `初始化预览 · ${name}`, preview, "应用并重载")) return false;
  const changed = await withFileMutationQueue(model.settings.path, () =>
    withFileMutationQueue(model.mcp.path, () => withFileMutationQueue(plan.agents.path, async () => {
      ensureReady(ctx);
      for (const file of [source, plan.agents, plan.override]) readSnapshot(file.path);
      return applyPreset(plan, source);
    })));
  if (changed) ctx.ui.notify(`已应用模板 ${name}，正在重新加载；MCP 连接请用 /mcp 检查。`, "info");
  return changed;
}
