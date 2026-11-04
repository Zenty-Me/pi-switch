import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { dirtyRows, effectiveEnabled, type ProjectModel, type ResourceRow } from "./model.ts";

export type PanelResult = "save" | "cancel";

export class CapabilitiesPanel implements Component, Focusable {
  readonly capturesViewportInput = true;
  private input = new Input({ prompt: "搜索：", placeholder: "名称、描述或来源" });
  private tab: "skill" | "mcp" = "skill";
  private selected = 0;
  private listHeight = 8;
  private discardPrompt = false;
  private mouseRows = new Map<number, () => void>();
  private saveRow = -1;
  private saveButtonWidth = 0;
  private _focused = false;
  private model: ProjectModel;
  private tui: TUI;
  private theme: Theme;
  private kb: Pick<KeybindingsManager, "matches">;
  private done: (result: PanelResult) => void;

  constructor(options: {
    model: ProjectModel; tui: TUI; theme: Theme; kb: Pick<KeybindingsManager, "matches">;
    done: (result: PanelResult) => void;
  }) {
    this.model = options.model;
    this.tui = options.tui;
    this.theme = options.theme;
    this.kb = options.kb;
    this.done = options.done;
  }
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }
  invalidate(): void { this.input.invalidate(); }

  private filtered(): ResourceRow[] {
    const query = this.input.getValue().trim().toLowerCase();
    return this.model.rows.filter((row) => row.kind === this.tab &&
      `${row.name} ${row.description} ${row.source}`.toLowerCase().includes(query));
  }
  handleInput(data: string): void {
    if (this.discardPrompt) {
      if (matchesKey(data, "ctrl+s")) this.done("save");
      else if (this.kb.matches(data, "tui.select.confirm")) this.done("cancel");
      else if (this.kb.matches(data, "tui.select.cancel")) this.discardPrompt = false;
      this.tui.requestRender();
      return;
    }
    if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
      if (dirtyRows(this.model).length) this.discardPrompt = true;
      else this.done("cancel");
    } else if (matchesKey(data, "ctrl+s")) {
      this.done("save");
    } else if (this.kb.matches(data, "tui.input.tab")) {
      this.tab = this.tab === "skill" ? "mcp" : "skill";
      this.selected = 0;
    } else if (this.kb.matches(data, "tui.select.up")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (this.kb.matches(data, "tui.select.down")) {
      this.selected = Math.min(Math.max(0, this.filtered().length - 1), this.selected + 1);
    } else if (this.kb.matches(data, "tui.select.pageUp")) {
      this.selected = Math.max(0, this.selected - this.listHeight);
    } else if (this.kb.matches(data, "tui.select.pageDown")) {
      this.selected = Math.min(Math.max(0, this.filtered().length - 1), this.selected + this.listHeight);
    } else if (data === " " || this.kb.matches(data, "tui.select.confirm") || matchesKey(data, "ctrl+r")) {
      const row = this.filtered()[this.selected];
      if (row?.editable) {
        row.state = matchesKey(data, "ctrl+r") ? "inherit" : effectiveEnabled(row) ? "off" : "on";
      }
    } else {
      this.input.handleInput(data);
      this.selected = 0;
    }
    this.tui.requestRender();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.discardPrompt) return { handled: true };
    if (event.type === "wheel") {
      const max = Math.max(0, this.filtered().length - 1);
      this.selected = Math.max(0, Math.min(max, this.selected + (event.wheelDelta ?? 0)));
      this.tui.requestRender();
      return { handled: true, focus: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    if (event.y === 4) {
      this.tab = event.x < 22 ? "skill" : "mcp";
      this.selected = 0;
    } else if (event.y === this.saveRow) {
      this.handleInput(event.x < this.saveButtonWidth ? "\u0013" : "\u0012");
    } else this.mouseRows.get(event.y)?.();
    this.tui.requestRender();
    return { handled: true, focus: true };
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    this.listHeight = Math.max(1, Math.min(14, this.tui.terminal.rows - 16));
    const rows = this.filtered();
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.listHeight / 2), rows.length - this.listHeight));
    const lines = [
      this.theme.bold(this.theme.fg("accent", "项目能力管理")),
      this.theme.fg("muted", this.model.cwd),
      this.theme.fg("muted", "仅影响当前项目 · 保存后重新加载"),
      ["skill", "mcp"].map((kind) => {
        const count = this.model.rows.filter((row) => row.kind === kind).length;
        const label = `${kind === "skill" ? "Skills" : "MCP"} (${count})`;
        return kind === this.tab ? this.theme.fg("accent", `[ ${label} ]`) : `  ${label}  `;
      }).join("    "),
      ...this.input.render(inner),
      this.theme.fg("dim", "开关  名称 · 项目设置"),
    ];
    this.mouseRows.clear();
    for (let i = start; i < Math.min(rows.length, start + this.listHeight); i++) {
      const index = i;
      this.mouseRows.set(lines.length + 1, () => {
        this.selected = index;
        this.handleInput(" ");
      });
      const row = rows[i];
      const enabled = effectiveEnabled(row);
      const checkbox = this.theme.fg(enabled ? "success" : "dim", enabled ? "[x]" : "[ ]");
      const state = !row.editable ? "只读" : row.state === "inherit" ? "继承" : row.state === "on" ? "项目启用" : "项目禁用";
      const dirty = row.state === row.initial ? "" : " *";
      const name = i === this.selected ? this.theme.bold(row.name) : row.name;
      lines.push(`${i === this.selected ? ">" : " "} ${checkbox} ${name} · ${state}${dirty}`);
    }
    if (!rows.length) lines.push(this.theme.fg("muted", this.tab === "mcp"
      ? "没有匹配的 MCP。可先用 pi mcp add 配置服务。" : "没有匹配的 Skills。"));
    const selected = rows[this.selected];
    lines.push(this.theme.fg("dim", `${rows.length ? this.selected + 1 : 0}/${rows.length} · ${selected?.source ?? ""}`));
    lines.push(this.theme.fg("muted", selected?.description || " "));
    this.saveRow = lines.length + 1;
    const saveButton = "[ 保存并重新加载 Ctrl+S ]";
    this.saveButtonWidth = visibleWidth(saveButton) + 3;
    lines.push(this.theme.fg("accent", `${saveButton} [ 恢复继承 Ctrl+R ] 待保存：${dirtyRows(this.model).length} 项`));
    lines.push(this.theme.fg("dim", "Tab 切换 · ↑↓ 选择 · 空格/Enter 开关"));
    lines.push(this.theme.fg("dim", "Ctrl+R 恢复继承 · Ctrl+S 保存 · Esc 关闭"));
    if (this.discardPrompt) lines.push(this.theme.fg("warning", "有未保存修改：Enter 放弃并关闭 · Esc 返回 · Ctrl+S 保存"));
    const border = this.theme.fg("border", "─".repeat(Math.max(0, width - 2)));
    const result = [`╭${border}╮`];
    for (const line of lines) {
      const text = truncateToWidth(line.replace(/[\r\n]/g, " "), inner, "…");
      result.push(`│ ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`);
    }
    result.push(`╰${border}╯`);
    return result.map((line) => truncateToWidth(line, width));
  }
}
