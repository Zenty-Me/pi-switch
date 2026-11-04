import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable,
  type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { dirtyRows, effectiveEnabled, resourceGroup, savedEnabled,
  type Override, type ProjectModel, type ResourceRow } from "./model.ts";

export type PanelResult = "save" | "cancel";
type Filter = "all" | "overrides" | "pending";
type Sheet = "batch" | "filter" | "help" | "discard" | "details";
interface Action { label: string; run: () => void; disabled?: boolean; active?: boolean; primary?: boolean; }
interface Hit { x: number; end: number; y: number; run: (x: number) => void; }
interface Block { lines: string[]; hits: Hit[]; }
interface Area { x: number; y: number; width: number; height: number; }
const STATE: Record<Override, string> = { inherit: "按默认", on: "开启", off: "关闭" };
const FILTER: Record<Filter, string> = { all: "全部", overrides: "项目单独设置", pending: "待保存" };
const text = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, " ");
const enabledText = (enabled: boolean) => enabled ? "开启" : "关闭";
const fit = (value: string, width: number) => {
  const line = truncateToWidth(value, Math.max(0, width), "…");
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
};

export class CapabilitiesPanel implements Component, Focusable {
  readonly capturesViewportInput = true;
  private input = new Input({ prompt: "搜索  ", placeholder: "名称、用途或来源" });
  private tab: "skill" | "mcp" = "skill";
  private filter: Filter = "all";
  private selected = 0;
  private listHeight = 8;
  private sheet?: Sheet;
  private menuIndex = 0;
  private detailOffset = 0;
  private detailMax = 0;
  private detailResource?: string;
  private detailArea?: Area;
  private searchArea?: Area;
  private hits: Hit[] = [];
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
    this.model = options.model; this.tui = options.tui; this.theme = options.theme;
    this.kb = options.kb; this.done = options.done;
    const pending = dirtyRows(this.model);
    if (pending.length) { this.filter = "pending"; this.tab = pending[0].kind; }
  }
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && !this.sheet; }
  invalidate(): void { this.input.invalidate(); }

  private filtered(): ResourceRow[] {
    const query = this.input.getValue().trim().toLowerCase();
    return this.model.rows.filter((row) => row.kind === this.tab
      && (this.filter !== "overrides" || row.state !== "inherit")
      && (this.filter !== "pending" || row.state !== row.initial)
      && `${row.name} ${row.description} ${row.source} ${resourceGroup(row)}`.toLowerCase().includes(query))
      .sort((a, b) => resourceGroup(a).localeCompare(resourceGroup(b)) || a.name.localeCompare(b.name));
  }
  private current(): ResourceRow | undefined {
    const rows = this.filtered();
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const row = rows[this.selected];
    if (row?.id !== this.detailResource) { this.detailOffset = 0; this.detailResource = row?.id; }
    return row;
  }
  private selectTab(tab: "skill" | "mcp"): void { this.tab = tab; this.selected = 0; }
  private selectFilter(filter: Filter): void { this.filter = filter; this.selected = 0; }
  private cycleFilter(): void {
    const filters: Filter[] = ["all", "overrides", "pending"];
    this.selectFilter(filters[(filters.indexOf(this.filter) + 1) % filters.length]);
  }
  private setRow(row: ResourceRow | undefined, state: Override): void {
    if (!row?.editable) return;
    row.state = state; row.reason = undefined;
  }
  private toggle(): void {
    const row = this.current();
    if (row) this.setRow(row, effectiveEnabled(row) ? "off" : "on");
  }
  private batch(state: Override): void {
    // Snapshot all matching rows before changing a setting that may remove rows from the filter.
    for (const row of this.filtered()) this.setRow(row, state);
    this.current();
  }
  private undo(): void {
    for (const row of this.model.rows) { row.state = row.initial; row.reason = undefined; }
    this.current();
  }
  private open(sheet: Sheet): void {
    this.sheet = sheet; this.menuIndex = 0;
    if (sheet === "details") this.detailOffset = 0;
    this.input.focused = false;
  }
  private closeSheet(): void { this.sheet = undefined; this.input.focused = this.focused; }
  private close(): void {
    if (dirtyRows(this.model).length) this.open("discard");
    else this.done("cancel");
  }
  private move(delta: number): void {
    this.selected = Math.max(0, Math.min(Math.max(0, this.filtered().length - 1), this.selected + delta));
  }
  private scroll(delta: number): void { this.detailOffset = Math.max(0, Math.min(this.detailMax, this.detailOffset + delta)); }
  private menuActions(): Action[] {
    if (this.sheet === "filter") return (["all", "overrides", "pending"] as Filter[]).map((filter) => ({
      label: FILTER[filter], active: this.filter === filter, run: () => this.selectFilter(filter),
    }));
    const count = this.filtered().filter((row) => row.editable).length;
    return [
      ...(["on", "off", "inherit"] as Override[]).map((state) => ({
        label: `全部${STATE[state]}（${count}）`, disabled: !count, run: () => this.batch(state),
      })),
      { label: `撤销全部待保存（${dirtyRows(this.model).length}）`, disabled: !dirtyRows(this.model).length, run: () => this.undo() },
    ];
  }
  private handleSheet(data: string): void {
    if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) { this.closeSheet(); return; }
    if (this.sheet === "discard") {
      if (matchesKey(data, "ctrl+s")) this.done("save");
      else if (this.kb.matches(data, "tui.select.confirm")) this.done("cancel");
    } else if (this.sheet === "details") {
      if (matchesKey(data, "f3")) this.closeSheet();
      else if (this.kb.matches(data, "tui.select.up")) this.scroll(-1);
      else if (this.kb.matches(data, "tui.select.down")) this.scroll(1);
      else if (this.kb.matches(data, "tui.select.pageUp")) this.scroll(-this.listHeight);
      else if (this.kb.matches(data, "tui.select.pageDown")) this.scroll(this.listHeight);
    } else if (this.sheet === "help") {
      if (matchesKey(data, "f1")) this.closeSheet();
    } else {
      const actions = this.menuActions();
      if (this.kb.matches(data, "tui.select.up")) this.menuIndex = Math.max(0, this.menuIndex - 1);
      else if (this.kb.matches(data, "tui.select.down")) this.menuIndex = Math.min(actions.length - 1, this.menuIndex + 1);
      else if (this.kb.matches(data, "tui.select.confirm")) {
        const action = actions[this.menuIndex];
        if (action && !action.disabled) { this.closeSheet(); action.run(); }
      }
    }
  }
  handleInput(data: string): void {
    if (this.sheet) this.handleSheet(data);
    else if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) this.close();
    else if (matchesKey(data, "ctrl+s")) this.done("save");
    else if (this.kb.matches(data, "tui.input.tab")) this.selectTab(this.tab === "skill" ? "mcp" : "skill");
    else if (matchesKey(data, "f1")) this.open("help");
    else if (matchesKey(data, "f2")) this.cycleFilter();
    else if (matchesKey(data, "f3")) { if (this.current()) this.open("details"); }
    else if (matchesKey(data, "f4")) this.open("batch");
    else if (matchesKey(data, "alt+e")) this.batch("on");
    else if (matchesKey(data, "alt+d")) this.batch("off");
    else if (matchesKey(data, "alt+r")) this.batch("inherit");
    else if (matchesKey(data, "ctrl+r")) this.setRow(this.current(), "inherit");
    else if (this.kb.matches(data, "tui.select.up")) this.move(-1);
    else if (this.kb.matches(data, "tui.select.down")) this.move(1);
    else if (this.kb.matches(data, "tui.select.pageUp")) this.move(-this.listHeight);
    else if (this.kb.matches(data, "tui.select.pageDown")) this.move(this.listHeight);
    else if (data === " " || this.kb.matches(data, "tui.select.confirm")) this.toggle();
    else { this.input.handleInput(data); this.selected = 0; }
    this.tui.requestRender();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Hit areas are in content coordinates, excluding the frame's one row and two columns.
    const x = event.x - 2; const y = event.y - 1;
    const search = this.searchArea;
    if (!this.sheet && search && event.button === "left" && (event.type === "press" || event.type === "click")
      && x >= search.x && x < search.x + search.width && y === search.y) {
      this.input.handleMouse({ ...event, x: x - search.x, y: 0, width: search.width, height: 1 });
      this.focused = true;
      this.tui.requestRender();
      return { handled: true, focus: true };
    }
    if (event.type === "wheel") {
      const area = this.detailArea;
      if (this.sheet === "details" || (!this.sheet && area && x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height)) this.scroll(event.wheelDelta ?? 0);
      else if (!this.sheet) this.move(Math.sign(event.wheelDelta ?? 0) * 3);
      else return undefined;
    } else if (event.type === "click" && event.button === "left") {
      const hit = this.hits.find((item) => item.y === y && x >= item.x && x < item.end);
      if (!hit) return undefined;
      hit.run(x);
    } else return undefined;
    this.tui.requestRender();
    return { handled: true, focus: true };
  }

  private buttons(actions: Action[], width: number): Block {
    const block: Block = { lines: [], hits: [] };
    let line = "";
    for (const action of actions) {
      const label = ` ${action.label} `;
      if (line && visibleWidth(line) + visibleWidth(label) + 1 > width) { block.lines.push(line); line = ""; }
      if (line) line += " ";
      const x = visibleWidth(line);
      if (!action.disabled) block.hits.push({ x, end: Math.min(width, x + visibleWidth(label)), y: block.lines.length, run: action.run });
      let styled = this.theme.fg(action.disabled ? "dim" : action.primary || action.active ? "accent" : "muted", label);
      if (action.active || action.primary) styled = this.theme.bold(styled);
      if ((action.primary || action.active) && !action.disabled) styled = this.theme.bg("selectedBg", styled);
      line += styled;
    }
    if (line) block.lines.push(line);
    return block;
  }
  private append(lines: string[], block: Block): void {
    for (const hit of block.hits) this.hits.push({ ...hit, y: hit.y + lines.length });
    lines.push(...block.lines);
  }
  private frame(lines: string[], width: number): string[] {
    const border = (value: string) => this.theme.fg("borderMuted", value);
    return [border(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
      ...lines.map((line) => border("│") + ` ${fit(line, width - 4)} ` + border("│")),
      border(`╰${"─".repeat(Math.max(0, width - 2))}╯`)].map((line) => truncateToWidth(line, width));
  }
  private heading(left: string, right: string, width: number): string {
    const remaining = Math.max(1, width - visibleWidth(right) - 2);
    return fit(left, remaining) + "  " + right;
  }
  private settings(row: ResourceRow, width: number): Block {
    return this.buttons((["on", "off", "inherit"] as Override[]).map((state) => ({
      label: STATE[state], active: row.state === state, disabled: !row.editable, run: () => this.setRow(row, state),
    })), width);
  }
  private difference(row: ResourceRow): string {
    return row.state === row.initial ? `当前${enabledText(savedEnabled(row))} · ${STATE[row.state]}`
      : `已保存 ${enabledText(savedEnabled(row))} → 待应用 ${enabledText(effectiveEnabled(row))}`;
  }
  private description(row: ResourceRow, width: number): string[] {
    const section = (title: string, value: string) => [this.theme.fg("muted", title),
      ...wrapTextWithAnsi(text(value), width), ""];
    return [
      ...(row.reason ? section("模型建议", row.reason) : []),
      ...section("用途", row.description || "暂无用途说明"),
      ...(!row.editable ? section("只读资源", "此服务由扩展注册或缺少原生配置，请在来源扩展中管理。") : []),
      ...(row.kind === "mcp" ? section("连接状态：未知", "开启配置不代表已连接，请使用 /mcp 检查。") : []),
      ...section("来源", row.source),
    ];
  }
  private detailBlock(row: ResourceRow | undefined, width: number, height: number): Block {
    if (!row) return { lines: [this.theme.fg("muted", "选择一项，查看用途和项目设置。")], hits: [] };
    const actions = this.settings(row, width);
    const lines = [this.theme.bold(text(row.name)), this.theme.fg("dim", text(resourceGroup(row))), "",
      this.theme.fg("muted", row.editable ? "本项目设置" : "本项目设置 · 只读"), ...actions.lines,
      this.theme.fg(row.state !== row.initial ? "warning" : "dim", this.difference(row)), ""];
    const hits = actions.hits.map((hit) => ({ ...hit, y: hit.y + 4 }));
    const content = this.description(row, width);
    const viewport = Math.max(1, height - lines.length - 1);
    this.detailMax = Math.max(0, content.length - viewport);
    this.detailOffset = Math.min(this.detailOffset, this.detailMax);
    this.detailArea = { x: 0, y: lines.length, width, height: viewport };
    lines.push(...content.slice(this.detailOffset, this.detailOffset + viewport));
    while (lines.length < height - 1) lines.push("");
    const link = this.buttons([{ label: this.detailMax ? "更多详情 › 可滚动" : "完整详情 ›", run: () => this.open("details") }], width);
    hits.push(...link.hits.map((hit) => ({ ...hit, y: height - 1 })));
    lines.push(...link.lines);
    return { lines, hits };
  }
  private listBlock(rows: ResourceRow[], width: number, height: number): Block {
    const entries: ({ group: string } | { row: ResourceRow; index: number })[] = [];
    let group = "";
    rows.forEach((row, index) => {
      const next = resourceGroup(row);
      if (next !== group) entries.push({ group: next });
      group = next; entries.push({ row, index });
    });
    const block: Block = { lines: [], hits: [] };
    const viewport = entries.length > height && height > 2 ? height - 1 : height;
    this.listHeight = Math.max(1, viewport);
    const selection = entries.findIndex((entry) => "row" in entry && entry.index === this.selected);
    const start = Math.max(0, Math.min(selection - Math.floor(viewport / 2), entries.length - viewport));
    for (const entry of entries.slice(start, start + viewport)) {
      if ("group" in entry) { block.lines.push(this.theme.fg("dim", text(entry.group))); continue; }
      const { row, index } = entry;
      const pending = row.state !== row.initial;
      const status = `${row.editable ? enabledText(effectiveEnabled(row)) : "只读"}${pending ? " · 待保存" : ""}`;
      const prefix = `${index === this.selected ? "›" : " "} [${effectiveEnabled(row) ? "x" : " "}] `;
      const name = fit(text(row.name), Math.max(1, width - visibleWidth(prefix) - visibleWidth(status) - 1));
      let line = `${prefix}${name} ${this.theme.fg(pending ? "warning" : "muted", status)}`;
      if (index === this.selected) line = this.theme.bg("selectedBg", fit(line, width));
      block.hits.push({ x: 0, end: width, y: block.lines.length, run: (x) => {
        this.selected = index;
        if (x >= 2 && x < 5) this.toggle();
      } });
      block.lines.push(line);
    }
    if (!entries.length) block.lines.push(...wrapTextWithAnsi(this.theme.fg("muted", this.filter === "pending"
      ? "没有待保存项。切换到“全部”可继续选择。" : this.tab === "mcp"
        ? "没有匹配的 MCP。可用 pi mcp add 添加服务。" : "没有匹配的 Skills，试试其他关键词。"), width).slice(0, height));
    if (entries.length > height && height > 2) {
      while (block.lines.length < height - 1) block.lines.push("");
      block.lines.push(this.theme.fg("dim", `${this.selected + 1} / ${rows.length} 项${start > 0 ? " · ↑" : ""}${start + viewport < entries.length ? " · ↓ 更多" : ""}`));
    }
    while (block.lines.length < height) block.lines.push("");
    return block;
  }
  private body(rows: ResourceRow[], width: number, height: number): Block {
    const row = this.current();
    if (width >= 100 && height >= 12) {
      const leftWidth = Math.floor((width - 3) * 0.53);
      const rightX = leftWidth + 3;
      const rightWidth = width - rightX;
      const left = this.listBlock(rows, leftWidth, height);
      const right = this.detailBlock(row, rightWidth, height);
      if (this.detailArea) { this.detailArea.x += rightX; }
      return { lines: left.lines.map((line, y) => fit(line, leftWidth) + this.theme.fg("borderMuted", " │ ") + fit(right.lines[y] ?? "", rightWidth)),
        hits: [...left.hits, ...right.hits.map((hit) => ({ ...hit, x: hit.x + rightX, end: hit.end + rightX }))] };
    }
    const summary = row ? this.buttons([
      ...(["on", "off", "inherit"] as Override[]).map((state) => ({ label: STATE[state], active: row.state === state, disabled: !row.editable, run: () => this.setRow(row, state) })),
      { label: "详情 ›", run: () => this.open("details") },
    ], width) : { lines: [], hits: [] };
    const summaryLines = row ? [this.theme.fg(row.state !== row.initial ? "warning" : "dim", this.difference(row)),
      ...summary.lines, this.theme.fg("muted", text(row.reason ? `建议：${row.reason}` : row.description))] : [];
    const list = this.listBlock(rows, width, Math.max(1, height - summaryLines.length));
    const offset = list.lines.length;
    return { lines: [...list.lines, ...summaryLines],
      hits: [...list.hits, ...summary.hits.map((hit) => ({ ...hit, y: hit.y + offset + 1 }))] };
  }
  private footer(width: number): Block {
    const count = dirtyRows(this.model).length;
    const left = this.buttons([
      { label: "批量操作 ▾", run: () => this.open("batch") },
      { label: "帮助", run: () => this.open("help") },
      { label: count ? "放弃修改" : "关闭", run: () => this.close() },
    ], width);
    const right = this.buttons([{ label: count ? `保存并应用（${count}）` : "保存并应用", primary: true, disabled: !count, run: () => this.done("save") }], width);
    const rightWidth = visibleWidth(right.lines[0]);
    if (left.lines.length === 1 && visibleWidth(left.lines[0]) + rightWidth + 2 <= width) {
      const x = width - rightWidth;
      return { lines: [fit(left.lines[0], x) + right.lines[0]],
        hits: [...left.hits, ...right.hits.map((hit) => ({ ...hit, x: hit.x + x, end: hit.end + x }))] };
    }
    const x = Math.max(0, width - rightWidth);
    return { lines: [...left.lines, " ".repeat(x) + right.lines[0]],
      hits: [...left.hits, ...right.hits.map((hit) => ({ ...hit, x: hit.x + x, end: hit.end + x, y: hit.y + left.lines.length }))] };
  }
  private renderSheet(width: number, height: number): string[] {
    const inner = Math.max(1, width - 4);
    const lines: string[] = [];
    if (this.sheet === "details") {
      const row = this.current();
      if (!row) { this.closeSheet(); return this.render(width); }
      const content = [this.theme.bold(text(row.name)), this.difference(row), `本项目设置：${STATE[row.state]}`, ""]
        .flatMap((line) => wrapTextWithAnsi(line, inner)).concat(this.description(row, inner));
      const viewport = Math.max(1, height - 5);
      this.detailMax = Math.max(0, content.length - viewport);
      this.detailOffset = Math.min(this.detailOffset, this.detailMax);
      lines.push(this.theme.fg("muted", "资源详情"), ...content.slice(this.detailOffset, this.detailOffset + viewport));
    } else if (this.sheet === "discard") {
      lines.push(this.theme.bold(`放弃这 ${dirtyRows(this.model).length} 项修改？`), "", ...wrapTextWithAnsi("这些修改尚未保存到项目。你也可以返回继续编辑，或保存并应用。", inner), "");
      this.append(lines, this.buttons([
        { label: "继续编辑", run: () => this.closeSheet() },
        { label: "放弃修改", run: () => this.done("cancel") },
        { label: "保存并应用", primary: true, run: () => this.done("save") },
      ], inner));
    } else if (this.sheet === "help") {
      lines.push(this.theme.bold("键盘与鼠标"), "", ...[
        "Tab               切换 Skills / MCP", "↑↓ / PageUp↓      选择资源 / 翻页",
        "空格 / Enter      切换所选项", "F2 / F3 / F4      筛选 / 详情 / 批量",
        "Ctrl+R            所选项按默认", "Alt+E / D / R     筛选结果开启 / 关闭 / 默认",
        "Ctrl+S            保存并应用", "Esc               返回或关闭", "",
        "点击条目只选中；点击复选框才切换。", "右侧详情支持鼠标滚动，长内容可按 F3 查看。",
      ].map((line) => truncateToWidth(line, inner)));
    } else {
      const batch = this.sheet === "batch";
      const rows = this.filtered();
      const count = rows.filter((row) => row.editable).length;
      lines.push(this.theme.bold(batch ? "批量操作" : "显示哪些资源"), "");
      if (batch) lines.push(...wrapTextWithAnsi(`仅当前 ${this.tab === "skill" ? "Skills" : "MCP"} 筛选结果：${count} 项可修改，${rows.length - count} 项只读。包含滚动区外的结果；不会立即保存。`, inner), "");
      this.menuActions().forEach((action, index) => {
        const line = `${index === this.menuIndex ? "›" : " "} ${action.active ? "● " : ""}${action.label}`;
        this.hits.push({ x: 0, end: inner, y: lines.length, run: () => {
          if (!action.disabled) { this.closeSheet(); action.run(); }
        } });
        lines.push(action.disabled ? this.theme.fg("dim", line) : index === this.menuIndex ? this.theme.bg("selectedBg", fit(line, inner)) : line);
      });
      if (batch) lines.push("", this.theme.fg("dim", "“撤销全部待保存”作用于两类资源的所有待修改项。"));
    }
    if (this.sheet !== "discard") {
      lines.push("");
      this.append(lines, this.buttons([{ label: this.sheet === "details" ? "返回列表" : "返回", run: () => this.closeSheet() }], inner));
    }
    return this.frame(lines.slice(0, Math.max(1, height - 2)), width);
  }
  private resetLayout(): void { this.hits = []; this.detailArea = undefined; this.searchArea = undefined; }
  render(width: number): string[] {
    this.resetLayout();
    const height = Math.max(4, Math.floor(this.tui.terminal.rows * 0.95));
    if (width < 40 || height < 18) return this.frame(["项目能力", "请扩大终端至至少 40 列、20 行。", "Ctrl+S 保存 · Esc 关闭"].slice(0, height - 2), width);
    if (this.sheet) return this.renderSheet(width, height);
    const inner = width - 4;
    const pending = dirtyRows(this.model).length;
    const all = this.model.rows.filter((row) => row.kind === this.tab);
    const title = this.theme.bold("项目能力") + this.theme.fg("muted", `  ${text(basename(this.model.cwd.replace(/\\/g, "/")))}`);
    const badge = this.theme.fg(pending ? "warning" : "dim", pending ? `${pending} 项待保存` : "未修改");
    const lines = [this.heading(title, badge, inner), this.theme.fg("dim", `仅影响本项目 · 开启 ${all.filter(effectiveEnabled).length} / ${all.length}`), ""];
    this.append(lines, this.buttons([
      { label: `Skills ${this.model.rows.filter((row) => row.kind === "skill").length}`, active: this.tab === "skill", run: () => this.selectTab("skill") },
      { label: `MCP ${this.model.rows.filter((row) => row.kind === "mcp").length}`, active: this.tab === "mcp", run: () => this.selectTab("mcp") },
      { label: `${FILTER[this.filter]} ▾`, run: () => this.open("filter") },
    ], inner));
    this.searchArea = { x: 0, y: lines.length, width: inner, height: 1 };
    lines.push(...this.input.render(inner), this.theme.fg("borderMuted", "─".repeat(inner)));
    const footer = this.footer(inner);
    const bodyHeight = Math.max(1, height - lines.length - footer.lines.length - 4);
    const body = this.body(this.filtered(), inner, bodyHeight);
    if (this.detailArea) this.detailArea.y += lines.length;
    this.append(lines, body);
    lines.push(this.theme.fg("borderMuted", "─".repeat(inner)));
    this.append(lines, footer);
    lines.push(this.theme.fg("dim", pending ? "修改尚未应用，确认后再保存。" : "模型建议与手动修改，都由你确认后应用。"));
    return this.frame(lines, width);
  }
}
