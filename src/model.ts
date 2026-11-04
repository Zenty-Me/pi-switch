import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CONFIG_DIR_NAME, DefaultPackageManager, SettingsManager, parseFrontmatter,
  type PackageSource, type RegisteredMcpServer, type ResolvedResource,
} from "@earendil-works/pi-coding-agent";

export type Override = "inherit" | "on" | "off";
type JsonObject = Record<string, unknown>;
export interface ResourceRow {
  id: string;
  kind: "skill" | "mcp";
  name: string;
  description: string;
  source: string;
  state: Override;
  initial: Override;
  inheritedEnabled: boolean;
  editable: boolean;
  path?: string;
  retainDiscovery?: boolean;
  packageSource?: string;
  packageRoot?: string;
}
interface ConfigFile {
  path: string;
  text: string | undefined;
  data: JsonObject;
}
export interface ProjectModel {
  cwd: string;
  rows: ResourceRow[];
  settings: ConfigFile;
  mcp: ConfigFile;
  globalSettings: ConfigFile;
  globalMcp: ConfigFile;
}

function record(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readConfig(path: string): ConfigFile {
  const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const data: unknown = text === undefined ? {} : JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!record(data)) throw new Error(`${path}: 配置必须是 JSON 对象`);
  return { path, text, data };
}
function skillPaths(data: JsonObject): string[] {
  const values = data.skills ?? [];
  if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
    throw new Error("settings.json 中的 skills 必须是字符串数组");
  }
  return values;
}
function servers(data: JsonObject): Record<string, JsonObject> {
  const values = data.mcpServers ?? {};
  if (!record(values) || Object.values(values).some((v) => !record(v))) {
    throw new Error("mcp.json 中的 mcpServers 必须是服务配置对象");
  }
  return values as Record<string, JsonObject>;
}
function key(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function entryPath(entry: string, base: string): string {
  let path = /^[+!-]/.test(entry) ? entry.slice(1) : entry;
  if (path.startsWith("~/") || path.startsWith("~\\")) path = join(homedir(), path.slice(2));
  return key(resolve(base, path));
}
function matchingEntries(entries: string[], path: string, base: string): string[] {
  return entries.filter((entry) => entryPath(entry, base) === key(path));
}
function exactState(entries: string[]): Override {
  // Native +path and -path are exact overrides; -path wins over +path.
  if (entries.some((entry) => entry.startsWith("-"))) return "off";
  if (entries.some((entry) => entry.startsWith("+"))) return "on";
  if (entries.some((entry) => entry.startsWith("!"))) return "off";
  return "inherit";
}
function packageIdentity(source: string, base: string): string {
  return /^(npm:|git:|https?:|git@)/.test(source) ? source : entryPath(source, base);
}
function packageEntries(data: JsonObject): PackageSource[] {
  return (data.packages ?? []) as PackageSource[];
}
function packageIndex(data: JsonObject, source: string, base: string): number {
  return packageEntries(data).findIndex((pkg) => packageIdentity(typeof pkg === "string" ? pkg : pkg.source, base)
    === packageIdentity(source, base));
}
function setPackageSkillOverride(data: JsonObject, row: ResourceRow, configPath: string): void {
  const packages = packageEntries(data);
  const index = packageIndex(data, row.packageSource!, dirname(configPath));
  if (index < 0 && row.state === "inherit") return;
  const existing = packages[index];
  const pkg = typeof existing === "object" ? { ...existing }
    : existing ? { source: existing } : { source: row.packageSource!, autoload: false };
  const wasEmpty = pkg.skills?.length === 0 && pkg.autoload !== false;
  const entries = (pkg.skills ?? []).filter((entry) => entryPath(entry, row.packageRoot!) !== key(row.path!));
  if (wasEmpty) entries.push("!**/*");
  if (row.state !== "inherit") entries.push(`${row.state === "on" ? "+" : "-"}${relative(row.packageRoot!, row.path!)}`);
  if (entries.length) pkg.skills = entries;
  else delete pkg.skills;
  const hasFilters = Object.keys(pkg).some((field) => field !== "source" && field !== "autoload");
  if (index < 0) packages.push(pkg);
  else if (!hasFilters && pkg.autoload === false) packages.splice(index, 1);
  else packages[index] = hasFilters ? pkg : pkg.source;
  if (packages.length) data.packages = packages;
  else delete data.packages;
}
async function resolveSkills(cwd: string, agentDir: string, global: JsonObject, project: JsonObject) {
  const texts = { global: JSON.stringify(global), project: JSON.stringify(project) };
  const settingsManager = SettingsManager.fromStorage({
    withLock(scope, fn) { fn(texts[scope]); },
  }, { projectTrusted: true });
  const errors = settingsManager.drainErrors();
  if (errors.length) throw new Error("Pi 无法解析资源配置，请先修复 settings.json");
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const result = await manager.resolve(async () => "skip");
  return result.skills;
}
function skillInfo(resource: ResolvedResource) {
  const fallback = basename(resource.path) === "SKILL.md"
    ? basename(dirname(resource.path)) : basename(resource.path, ".md");
  try {
    const { frontmatter } = parseFrontmatter<{ name?: string; description?: string }>(
      readFileSync(resource.path, "utf8"),
    );
    return {
      name: typeof frontmatter.name === "string" ? frontmatter.name : fallback,
      description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    };
  } catch { return { name: fallback, description: "无法读取 Skill 文件" }; }
}
function skillRow(resource: ResolvedResource, model: ProjectModel): ResourceRow {
  const projectBase = dirname(model.settings.path);
  let packageSource: string | undefined;
  let packageRoot: string | undefined;
  let entries = matchingEntries(skillPaths(model.settings.data), resource.path, projectBase);
  if (resource.metadata.origin === "package") {
    packageRoot = resource.metadata.packageRoot ?? resource.metadata.baseDir ?? dirname(resource.path);
    const source = resource.metadata.source;
    const sourceBase = resource.metadata.scope === "project" ? projectBase : dirname(model.globalSettings.path);
    packageSource = /^(npm:|git:|https?:|git@)/.test(source) ? source
      : relative(projectBase, resolve(sourceBase, source)) || ".";
    const pkg = packageEntries(model.settings.data)[packageIndex(model.settings.data, packageSource, projectBase)];
    entries = matchingEntries(typeof pkg === "object" ? pkg.skills ?? [] : [], resource.path, packageRoot);
  }
  const state = exactState(entries);
  const info = skillInfo(resource);
  return {
    id: `skill:${key(resource.path)}`, kind: "skill", ...info,
    source: `${resource.metadata.scope === "project" ? "项目" : "全局"} · ${resource.metadata.source}`,
    state, initial: state, inheritedEnabled: resource.enabled, editable: true,
    path: resource.path, packageSource, packageRoot,
  };
}
function isDefinition(config: JsonObject): boolean {
  return config.command !== undefined || config.url !== undefined || config.type !== undefined;
}
function mcpRows(model: ProjectModel, registered: RegisteredMcpServer[]): ResourceRow[] {
  const global = servers(model.globalMcp.data);
  const project = servers(model.mcp.data);
  const registry = new Map(registered.map((server) => [server.name, server]));
  return [...new Set([...Object.keys(global), ...Object.keys(project), ...registry.keys()])].map((name) => {
    const local = project[name];
    const base = local && isDefinition(local) ? local : global[name];
    const config = base ?? registry.get(name)?.config;
    const editable = base !== undefined;
    const state = typeof local?.enabled === "boolean" ? (local.enabled ? "on" : "off") : "inherit";
    const description = typeof config?.description === "string" ? config.description : "";
    return {
      id: `mcp:${name}`, kind: "mcp", name, description,
      source: editable ? (local && isDefinition(local) ? "项目 mcp.json" : "全局 mcp.json")
        : "扩展注册或缺失全局定义 · 请在来源扩展中管理",
      state, initial: state,
      inheritedEnabled: local && isDefinition(local) ? true : config?.enabled !== false,
      editable,
    };
  });
}

export async function loadProject(cwd: string, agentDir: string, registered: RegisteredMcpServer[] = []): Promise<ProjectModel> {
  const model: ProjectModel = {
    cwd, rows: [], settings: readConfig(join(cwd, CONFIG_DIR_NAME, "settings.json")),
    mcp: readConfig(join(cwd, CONFIG_DIR_NAME, "mcp.json")),
    globalSettings: readConfig(join(agentDir, "settings.json")),
    globalMcp: readConfig(join(agentDir, "mcp.json")),
  };
  const resources = await resolveSkills(cwd, agentDir, model.globalSettings.data, model.settings.data);
  model.rows = resources.map((resource) => skillRow(resource, model));
  const inherited = structuredClone(model.settings.data);
  const overridden = model.rows.filter((row) => row.state !== "inherit");
  for (const row of overridden) setSkillOverride(inherited, { ...row, state: "inherit" }, model.settings.path);
  const baseline = await resolveSkills(cwd, agentDir, model.globalSettings.data, inherited);
  const enabled = new Map(baseline.map((resource) => [key(resource.path), resource.enabled]));
  for (const row of model.rows) {
    row.retainDiscovery = !enabled.has(key(row.path!));
    row.inheritedEnabled = enabled.get(key(row.path!)) ?? true;
  }
  model.rows.push(...mcpRows(model, registered));
  model.rows.sort((a, b) => a.name.localeCompare(b.name));
  return model;
}

export function effectiveEnabled(row: ResourceRow): boolean {
  return row.state === "inherit" ? row.inheritedEnabled : row.state === "on";
}
export function dirtyRows(model: ProjectModel): ResourceRow[] {
  return model.rows.filter((row) => row.state !== row.initial);
}
export function setSkillOverride(data: JsonObject, row: ResourceRow, configPath: string): void {
  if (row.packageSource) {
    setPackageSkillOverride(data, row, configPath);
    return;
  }
  const base = dirname(configPath);
  const entries = skillPaths(data).filter((entry) => entryPath(entry, base) !== key(row.path!));
  const rel = relative(base, row.path!);
  const target = rel.startsWith("..") || isAbsolute(rel) ? row.path! : rel;
  // Inherited loose files need an explicit project discovery entry to receive project filters.
  if (row.state !== "inherit" || row.retainDiscovery) entries.push(target);
  if (row.state !== "inherit") entries.push(`${row.state === "on" ? "+" : "-"}${target}`);
  if (entries.length) data.skills = entries;
  else delete data.skills;
}
export function setMcpOverride(data: JsonObject, row: ResourceRow): void {
  const entries = servers(data);
  const entry = { ...entries[row.name] };
  if (row.state === "inherit") delete entry.enabled;
  else entry.enabled = row.state === "on";
  if (Object.keys(entry).length) {
    Object.defineProperty(entries, row.name, { value: entry, enumerable: true, writable: true, configurable: true });
  } else delete entries[row.name];
  if (Object.keys(entries).length) data.mcpServers = entries;
  else delete data.mcpServers;
}
function assertUnchanged(file: ConfigFile): void {
  const current = existsSync(file.path) ? readFileSync(file.path, "utf8") : undefined;
  if (current !== file.text) throw new Error(`${file.path} 已被修改，请关闭并重新打开面板`);
}
function serializeConfig(file: ConfigFile, data: JsonObject): string {
  const indent = file.text?.match(/^([ \t]+)\S/m)?.[1] ?? "  ";
  return `${JSON.stringify(data, null, indent)}\n`;
}
function commitConfigs(writes: { file: ConfigFile; data: JsonObject }[]): void {
  const staged: { file: ConfigFile; temporary: string }[] = [];
  const committed: ConfigFile[] = [];
  try {
    for (const { file, data } of writes) {
      mkdirSync(dirname(file.path), { recursive: true });
      const temporary = `${file.path}.${randomUUID()}.tmp`;
      staged.push({ file, temporary });
      const mode = file.text === undefined ? 0o600 : statSync(file.path).mode;
      writeFileSync(temporary, serializeConfig(file, data), { mode, flag: "wx" });
    }
    for (const { file, temporary } of staged) {
      assertUnchanged(file);
      renameSync(temporary, file.path);
      committed.push(file);
    }
  } catch {
    let restored = true;
    for (const file of committed.reverse()) {
      try {
        if (file.text === undefined) unlinkSync(file.path);
        else writeFileSync(file.path, file.text);
      } catch { restored = false; }
    }
    throw new Error(restored ? "保存失败，已恢复原配置。请检查文件权限或重新打开面板。"
      : "保存失败且部分配置未能恢复，请检查项目 settings.json 和 mcp.json 后执行 /reload。");
  } finally {
    for (const { temporary } of staged) {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* A leftover temp file is inactive. */ }
    }
  }
}
export function saveProject(model: ProjectModel): boolean {
  const changes = dirtyRows(model);
  if (!changes.length) return false;
  const settings = structuredClone(model.settings.data);
  const mcp = structuredClone(model.mcp.data);
  for (const row of changes) {
    if (!row.editable) throw new Error(`${row.name} 无法在此面板中修改`);
    if (row.kind === "skill") setSkillOverride(settings, row, model.settings.path);
    else setMcpOverride(mcp, row);
  }
  // Check all inputs before either write. Global files are never written.
  for (const file of [model.settings, model.mcp, model.globalSettings, model.globalMcp]) assertUnchanged(file);
  const writes = [];
  if (changes.some((row) => row.kind === "skill")) writes.push({ file: model.settings, data: settings });
  if (changes.some((row) => row.kind === "mcp")) writes.push({ file: model.mcp, data: mcp });
  commitConfigs(writes);
  return true;
}
