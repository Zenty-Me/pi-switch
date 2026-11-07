import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertUnchanged, dirtyRows, effectiveEnabled, saveProject,
  type FileSnapshot, type FileWrite, type ProjectModel } from "./model.ts";

export interface PresetResource {
  kind: "skill" | "mcp";
  name: string;
  enabled: boolean;
}
export interface Preset {
  version: 1;
  resources: PresetResource[];
  agentsMd?: string;
}
export interface PresetPlan {
  model: ProjectModel;
  agents: FileSnapshot;
  override: FileSnapshot;
  agentsWrite?: FileWrite;
}

export interface ProjectRules {
  file: FileSnapshot;
  override: FileSnapshot;
  initial: string;
  value: string;
}
export interface PresetItem {
  name: string;
  preset?: Preset;
  error?: string;
}
export interface Workspace {
  rules?: ProjectRules;
  rulesError?: string;
  presets: PresetItem[];
  presetsError?: string;
}

const START = "<!-- pi-switch:preset:start -->";
const END = "<!-- pi-switch:preset:end -->";
const MAX_BYTES = 1024 * 1024;
const MAX_RULE_BYTES = 64 * 1024;
const identifier = (item: PresetResource) => `${item.kind}\0${item.name}`;

export function validatePresetName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new Error("模板名称请使用 1–64 个英文字母、数字、横线或下划线，以字母或数字开头，且不能是系统保留名称。");
  }
}
export function presetPath(agentDir: string, name: string): string {
  validatePresetName(name);
  return join(agentDir, "switch-presets", `${name}.json`);
}
export function listPresets(agentDir: string): string[] {
  let names: string[];
  try { names = readdirSync(join(agentDir, "switch-presets")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((name) => {
    try { validatePresetName(name); return true; } catch { return false; }
  }).sort((a, b) => a.localeCompare(b));
}
export function readSnapshot(path: string): FileSnapshot {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} 不是普通文件，未读取或覆盖。`);
    if (stat.size > MAX_BYTES) throw new Error(`${path} 超过 1 MiB，请先缩小文件。`);
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`${path} 超过 1 MiB，请先缩小文件。`);
    return { path, text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: undefined };
    throw error;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export function validatePreset(value: unknown): Preset {
  if (!object(value) || value.version !== 1 || !onlyKeys(value, ["version", "resources", "agentsMd"])
    || !Array.isArray(value.resources) || value.resources.length > 2000) {
    throw new Error("模板格式无效：需要 version: 1 和最多 2000 项 resources，仅支持资源开关与 agentsMd。");
  }
  const seen = new Set<string>();
  const resources = value.resources.map((item): PresetResource => {
    if (!object(item) || !onlyKeys(item, ["kind", "name", "enabled"])
      || (item.kind !== "skill" && item.kind !== "mcp") || typeof item.name !== "string"
      || !item.name.trim() || item.name.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(item.name)
      || typeof item.enabled !== "boolean") throw new Error("模板资源必须只有 kind、name 和布尔值 enabled。");
    const resource: PresetResource = { kind: item.kind, name: item.name, enabled: item.enabled };
    const key = identifier(resource);
    if (seen.has(key)) throw new Error(`模板存在同名资源：${item.kind} ${item.name}。请先消除歧义。`);
    seen.add(key);
    return resource;
  });
  if (value.agentsMd !== undefined && (typeof value.agentsMd !== "string"
    || Buffer.byteLength(value.agentsMd) > MAX_RULE_BYTES || value.agentsMd.includes("\0")
    || value.agentsMd.includes(START) || value.agentsMd.includes(END))) {
    throw new Error("agentsMd 必须是最多 64 KiB 的文本，不能包含 Pi Switch 管理标记或空字符。");
  }
  const agentsMd = (value.agentsMd as string | undefined)?.trim();
  return { version: 1, resources, ...(agentsMd ? { agentsMd } : {}) };
}
export function readPreset(file: FileSnapshot): Preset {
  if (file.text === undefined) throw new Error("模板不存在，请先用 /switch save <名称> 保存。");
  let value: unknown;
  try { value = JSON.parse(file.text.replace(/^\uFEFF/, "")); }
  catch { throw new Error("模板 JSON 格式有误，请修复后重试。"); }
  return validatePreset(value);
}
export function capturePreset(model: ProjectModel, agentsMd?: string): Preset {
  // shortcut: presets reference installed resources by name; add source selectors if duplicate names are needed.
  return validatePreset({ version: 1, resources: model.rows.filter((row) => row.editable).map((row) => ({
    kind: row.kind, name: row.name, enabled: effectiveEnabled(row),
  })), ...(agentsMd ? { agentsMd } : {}) });
}
function section(text: string): { start: number; end: number; body: string } | undefined {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return undefined;
  if (start < 0 || end < start || text.indexOf(START, start + START.length) >= 0
    || text.indexOf(END, end + END.length) >= 0) {
    throw new Error("AGENTS.md 中的 Pi Switch 管理标记不完整或重复，请先修复；未修改文件。");
  }
  return { start, end: end + END.length, body: text.slice(start + START.length, end).trim() };
}
export function loadWorkspace(cwd: string, agentDir: string): Workspace {
  const workspace: Workspace = { presets: [] };
  try {
    const file = readSnapshot(join(cwd, "AGENTS.md"));
    const override = readSnapshot(join(cwd, "AGENTS.override.md"));
    const initial = section(file.text ?? "")?.body ?? "";
    workspace.rules = { file, override, initial, value: initial };
  } catch (error) { workspace.rulesError = error instanceof Error ? error.message : "无法读取项目规则"; }
  try {
    workspace.presets = listPresets(agentDir).map((name) => {
      try { return { name, preset: readPreset(readSnapshot(presetPath(agentDir, name))) }; }
      catch (error) { return { name, error: error instanceof Error ? error.message : "无法读取模板" }; }
    });
  } catch { workspace.presetsError = "无法读取个人模板目录，请检查读取权限。"; }
  return workspace;
}
export function rulesChanged(workspace: Workspace): boolean {
  return Boolean(workspace.rules && workspace.rules.value !== workspace.rules.initial);
}
export function projectRulesWrite(rules: ProjectRules): FileWrite | undefined {
  const preset = validatePreset({ version: 1, resources: [], agentsMd: rules.value });
  if (preset.agentsMd && rules.override.text !== undefined) throw new Error("存在 AGENTS.override.md，请先处理覆盖文件再保存规则。");
  return planAgents(rules.file, preset.agentsMd);
}
export function captureAgents(file: FileSnapshot): string {
  const text = file.text ?? "";
  return section(text)?.body ?? text;
}
function planAgents(file: FileSnapshot, agentsMd?: string): FileWrite | undefined {
  const current = file.text ?? "";
  const managed = section(current);
  const block = agentsMd ? `${START}\n${agentsMd}\n${END}` : "";
  let text = current;
  if (managed) text = current.slice(0, managed.start) + block + current.slice(managed.end);
  else if (block) text = `${current}${current ? (current.endsWith("\n") ? "\n" : "\n\n") : ""}${block}\n`;
  return text === current ? undefined : { file, text };
}
export function preparePreset(model: ProjectModel, input: Preset): PresetPlan {
  const preset = validatePreset(input);
  if (dirtyRows(model).length) throw new Error("请先保存或放弃待修改的能力开关，再初始化模板。");
  const draft = structuredClone(model);
  const selected = preset.resources.map((item) => {
    const matches = draft.rows.filter((row) => row.kind === item.kind && row.name === item.name);
    if (!matches.length) throw new Error(`缺少资源：${item.kind} ${item.name}。请先安装或配置，未应用任何修改。`);
    if (matches.length !== 1) throw new Error(`同名资源有歧义：${item.kind} ${item.name}。请先消除歧义。`);
    const row = matches[0];
    if (!row.editable) throw new Error(`${item.name} 是只读资源，请在来源扩展中管理。`);
    return { row, state: item.enabled ? "on" as const : "off" as const };
  });
  const agents = readSnapshot(join(model.cwd, "AGENTS.md"));
  const override = readSnapshot(join(model.cwd, "AGENTS.override.md"));
  const agentsWrite = planAgents(agents, preset.agentsMd);
  if (preset.agentsMd && override.text !== undefined) {
    throw new Error("项目存在 AGENTS.override.md，Pi 会优先读取它；请先处理该文件再应用 AGENTS.md 模板。");
  }
  for (const { row, state } of selected) {
    row.state = state;
    row.reason = row.state !== row.initial ? "来自已选择的初始化模板" : undefined;
  }
  return { model: draft, agents, override, agentsWrite };
}
export function applyPreset(plan: PresetPlan, source: FileSnapshot): boolean {
  assertUnchanged(source);
  assertUnchanged(plan.agents);
  assertUnchanged(plan.override);
  return saveProject(plan.model, undefined, plan.agentsWrite ? [plan.agentsWrite] : []);
}
