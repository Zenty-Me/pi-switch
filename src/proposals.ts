import { createHash } from "node:crypto";
import { assertProjectUnchanged, dirtyRows, effectiveEnabled, resourceGroup, savedEnabled,
  type Override, type ProjectModel, type ResourceRow } from "./model.ts";

export interface ProposedChange {
  id: string;
  state: Override;
  reason: string;
}

export function resourceId(row: ResourceRow): string {
  return `${row.kind}:${createHash("sha256").update(row.id).digest("hex").slice(0, 16)}`;
}

export function resourceSummary(row: ResourceRow) {
  return {
    id: resourceId(row), kind: row.kind, name: row.name.slice(0, 128),
    description: row.description.slice(0, 1200), source: resourceGroup(row).slice(0, 200),
    editable: row.editable, savedSetting: row.initial, proposedSetting: row.state,
    savedEnabled: savedEnabled(row), proposedEnabled: effectiveEnabled(row),
    pending: row.state !== row.initial,
    ...(row.reason ? { reason: row.reason.slice(0, 500) } : {}),
    ...(row.kind === "mcp" ? { connection: "unknown", connectionHelp: "配置启用不代表已连接，请使用 /mcp 检查。" } : {}),
  };
}

export function stageChanges(model: ProjectModel, changes: ProposedChange[]): void {
  if (!changes.length || changes.length > 200) throw new Error("请提供 1–200 项明确的修改建议。");
  const byId = new Map(model.rows.map((row) => [resourceId(row), row]));
  const seen = new Set<string>();
  // Validate the entire proposal before changing any in-memory selection.
  const validated = changes.map((change) => {
    const row = byId.get(change.id);
    if (!row) throw new Error("存在未知资源 ID，请先 list 获取清单，不要猜测 ID。");
    if (seen.has(change.id)) throw new Error("同一资源出现重复建议，请合并后重试。");
    seen.add(change.id);
    if (!row.editable) throw new Error(`${row.name.slice(0, 128)} 为只读资源，不能在本面板修改。`);
    if (!["inherit", "on", "off"].includes(change.state)) throw new Error("无效的项目设置。");
    const reason = change.reason?.trim();
    if (!reason || reason.length > 500) throw new Error("每项建议需要 1–500 字的理由。");
    return { row, state: change.state, reason };
  });
  for (const { row, state, reason } of validated) {
    row.state = state;
    row.reason = row.state === row.initial ? undefined : reason;
  }
}

/** Drafts are session-local and never persisted by model-facing tools. */
export class ProposalStore {
  private model?: ProjectModel;
  private owner?: string;

  clear(): void { this.model = undefined; this.owner = undefined; }

  async get(owner: string, load: () => Promise<ProjectModel>): Promise<ProjectModel> {
    if (owner !== this.owner) this.clear();
    if (this.model) {
      try { assertProjectUnchanged(this.model); }
      catch {
        this.clear();
        throw new Error("配置文件已改变，旧建议已作废。请重新获取清单或打开面板，再生成建议。");
      }
      if (dirtyRows(this.model).length) return this.model;
    }
    this.model = await load();
    this.owner = owner;
    return this.model;
  }
}
