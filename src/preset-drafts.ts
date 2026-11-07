import { createHash, randomUUID } from "node:crypto";
import { assertProjectUnchanged, assertUnchanged, commitFiles, dirtyRows, type FileSnapshot, type ProjectModel } from "./model.ts";
import { projectFingerprint, resourceSummary } from "./proposals.ts";
import { applyPreset, preparePreset, readSnapshot, validatePreset, validatePresetResources,
  type Preset, type PresetItem, type PresetPlan } from "./presets.ts";

export type PresetOperation = "save" | "apply";
export interface PresetDraft {
  id: string;
  userMessageId?: string;
  name: string;
  operation: PresetOperation;
  source: FileSnapshot;
  preset: Preset;
  plan?: PresetPlan;
  fingerprint: string;
}
const modelFingerprint = (model: ProjectModel) => createHash("sha256").update(JSON.stringify([
  projectFingerprint(model), model.rows.map((row) => [row.id, row.name, row.state, row.initial, row.editable, row.inheritedEnabled]),
])).digest("hex");

export class PresetDraftStore {
  private owner?: string;
  private draft?: PresetDraft;

  use(owner: string): void {
    if (owner !== this.owner) { this.clear(); this.owner = owner; }
  }
  clear(): void { this.draft = undefined; this.owner = undefined; }
  get current(): PresetDraft | undefined { return this.draft; }
  get item(): PresetItem | undefined {
    return this.draft ? { name: this.draft.name, preset: this.draft.preset, draft: this.draft.operation } : undefined;
  }
  stage(model: ProjectModel, source: FileSnapshot, name: string, input: Preset,
    operation: PresetOperation, userMessageId?: string): PresetDraft {
    const preset = validatePreset(input);
    validatePresetResources(model, preset);
    const plan = operation === "apply" ? preparePreset(model, preset) : undefined;
    const draft: PresetDraft = { id: randomUUID(), name, preset, source, operation, userMessageId,
      fingerprint: modelFingerprint(model), ...(plan ? { plan } : {}) };
    this.draft = draft;
    return draft;
  }
  checked(model: ProjectModel): PresetDraft {
    const draft = this.draft;
    if (!draft) throw new Error("没有模板草稿，请先生成或预览模板。");
    try {
      assertProjectUnchanged(model);
      if (modelFingerprint(model) !== draft.fingerprint) throw new Error("项目配置或草稿改变");
      for (const file of [draft.source, ...(draft.plan ? [draft.plan.agents, draft.plan.override] : [])]) {
        readSnapshot(file.path);
        assertUnchanged(file);
      }
    } catch {
      this.draft = undefined;
      throw new Error("模板或项目配置已改变，模板草稿已失效。请重新生成、展示并确认。");
    }
    return draft;
  }
  confirm(model: ProjectModel, operation: PresetOperation, id: string | null | undefined, userMessageId?: string): PresetDraft {
    const draft = this.checked(model);
    if (!id || id !== draft.id || operation !== draft.operation) throw new Error("模板方案版本或操作不匹配，请重新查看草稿并确认。");
    if (!userMessageId || !draft.userMessageId || userMessageId === draft.userMessageId) {
      throw new Error("请展示完整模板方案，等待用户在后续消息中确认；不能同一轮暂存并保存或应用。");
    }
    return draft;
  }
  commit(model: ProjectModel, draft: PresetDraft): boolean {
    if (this.checked(model) !== draft) throw new Error("模板方案已改变，请重新确认。");
    const changed = draft.operation === "save"
      ? draft.source.text !== `${JSON.stringify(draft.preset, null, 2)}\n`
      : Boolean(draft.plan && (dirtyRows(draft.plan.model).length || draft.plan.agentsWrite));
    if (draft.operation === "save") {
      if (changed) commitFiles([{ file: draft.source, text: `${JSON.stringify(draft.preset, null, 2)}\n` }]);
    } else applyPreset(draft.plan!, draft.source);
    this.draft = undefined;
    return changed;
  }
}

export function presetDraftSummary(draft: PresetDraft) {
  return {
    saved: false, proposalId: draft.id, operation: draft.operation, name: draft.name,
    overwrites: draft.operation === "save" && draft.source.text !== undefined,
    resourceCount: draft.preset.resources.length,
    changedCount: draft.plan ? dirtyRows(draft.plan.model).length : 0,
    rulesChanged: Boolean(draft.plan?.agentsWrite),
    nextStep: "请用 preset_show 分页查看全部资源与规则，展示方案并等待后续消息确认；保存用 preset_save，应用项目用 preset_apply。也可打开 /switch 复核。",
  };
}

export function presetResourceItems(preset: Preset, model: ProjectModel) {
  return preset.resources.map((entry) => {
    const matches = model.rows.filter((row) => row.kind === entry.kind && row.name === entry.name);
    const row = matches.length === 1 ? matches[0] : undefined;
    return { ...entry, availability: !matches.length ? "missing" : matches.length > 1 ? "ambiguous" : !row!.editable ? "readonly" : "available",
      ...(row ? { id: resourceSummary(row).id, savedEnabled: resourceSummary(row).savedEnabled,
        savedSetting: row.initial, proposedSetting: entry.enabled ? "on" : "off" } : {}) };
  });
}

export function pageItems<T>(items: T[], offset = 0, limit = 20) {
  const page: T[] = [];
  let size = 0;
  for (const item of items.slice(offset, offset + limit)) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (page.length && size + bytes > 18000) break;
    page.push(item); size += bytes;
  }
  return { total: items.length, offset, items: page, nextOffset: offset + page.length < items.length ? offset + page.length : null };
}

export function presetTextPage(text: string, offset = 0) {
  // Bound text by characters so multibyte rules and JSON escaping still fit a tool response.
  let end = Math.min(text.length, offset + 3000);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return { text: text.slice(offset, end), offset, total: text.length, nextOffset: end < text.length ? end : null };
}
