import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable,
  type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { dirtyRows, effectiveEnabled, resourceGroup, savedEnabled,
  type Override, type ProjectModel, type ResourceRow } from "./model.ts";
import { readSnapshot, rulesChanged, type PresetItem, type Workspace } from "./presets.ts";

export type PanelPage = "overview" | "resources" | "rules" | "presets";
export type PanelResult = "save" | "cancel" | {
  action: "edit-rules" | "save-preset" | "apply-preset" | "update-preset" | "review-draft";
  page: PanelPage;
  name?: string;
};
type Filter = "all" | "overrides" | "pending";
type Sheet = "batch" | "filter" | "help" | "discard" | "details" | "document";
interface Action { label: string; run: () => void; disabled?: boolean; active?: boolean; primary?: boolean; }
interface Hit { x: number; end: number; y: number; run: (x: number) => void; }
interface Block { lines: string[]; hits: Hit[]; }
interface Area { x: number; y: number; width: number; height: number; }
const PAGE_KEYS = ["alt+1", "alt+2", "alt+3", "alt+4"] as const;
const PAGES: { id: PanelPage; label: string; title: string; subtitle: string }[] = [
  { id: "overview", label: "当前项目", title: "项目概览", subtitle: "把常用能力与工作约定放在一起。" },
  { id: "resources", label: "Skills / MCP", title: "能力配置", subtitle: "选择当前项目需要的能力，查看用途与修改理由。" },
  { id: "rules", label: "项目规则", title: "通用规则", subtitle: "编辑可复用的工作约定，项目说明会保留。" },
  { id: "presets", label: "我的模板", title: "模板库", subtitle: "复用配置组合，在新项目中快速开始。" },
];
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
  private presetInput = new Input({ prompt: "搜索模板  ", placeholder: "模板名称" });
  private page: PanelPage;
  private workspace: Workspace;
  private presetIndex = 0;
  private overviewIndex = 0;
  private document?: { title: string; content: string };
  private skillBody?: string;
  private documentLayout?: { content: string; width: number; lines: string[] };
  private markdown?: { content: string; component: Markdown };
  private mainArea?: Area;
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
    workspace?: Workspace; page?: PanelPage;
    done: (result: PanelResult) => void;
  }) {
    this.model = options.model; this.tui = options.tui; this.theme = options.theme;
    this.kb = options.kb; this.done = options.done;
    this.workspace = options.workspace ?? { presets: [] };
    const pending = dirtyRows(this.model);
    this.page = options.page ?? (pending.length ? "resources" : "overview");
    if (pending.length) { this.filter = "pending"; this.tab = pending[0].kind; }
  }
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && !this.sheet && this.page === "resources";
    this.presetInput.focused = value && !this.sheet && this.page === "presets";
  }
  invalidate(): void {
    this.input.invalidate(); this.presetInput.invalidate(); this.documentLayout = undefined;
    this.markdown?.component.invalidate();
  }
  private pendingCount(): number { return dirtyRows(this.model).length + Number(rulesChanged(this.workspace)); }
  private selectPage(page: PanelPage): void {
    this.page = page; this.sheet = undefined; this.detailOffset = 0;
    this.focused = this.focused;
  }
  private nextPage(): void { this.selectPage(PAGES[(PAGES.findIndex((page) => page.id === this.page) + 1) % PAGES.length].id); }
  private request(action: Exclude<PanelResult, string>["action"], name?: string): void {
    this.done({ action, page: this.page, ...(name ? { name } : {}) });
  }

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
    if (this.workspace.rules) this.workspace.rules.value = this.workspace.rules.initial;
    this.current();
  }
  private open(sheet: Sheet): void {
    this.sheet = sheet; this.menuIndex = 0;
    if (sheet === "details" || sheet === "document") this.detailOffset = 0;
    if (sheet === "details") {
      this.skillBody = undefined;
      const row = this.current();
      if (row?.kind === "skill" && row.path) {
        try { this.skillBody = readSnapshot(row.path).text ?? "Skill 文件已不存在。"; }
        catch { this.skillBody = "无法读取 Skill 全文，请检查文件路径、权限和大小（上限 1 MiB）。"; }
      }
    }
    this.focused = this.focused;
  }
  private closeSheet(): void { this.sheet = undefined; this.focused = this.focused; }
  private close(): void {
    if (this.pendingCount()) this.open("discard");
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
      { label: `撤销全部待保存（${this.pendingCount()}）`, disabled: !this.pendingCount(), run: () => this.undo() },
    ];
  }
  private handleSheet(data: string): void {
    if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) { this.closeSheet(); return; }
    if (this.sheet === "discard") {
      if (matchesKey(data, "ctrl+s")) this.done("save");
      else if (this.kb.matches(data, "tui.select.confirm")) this.done("cancel");
    } else if (this.sheet === "details" || this.sheet === "document") {
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
    else if (matchesKey(data, "ctrl+s")) { if (this.pendingCount()) this.done("save"); }
    else if (matchesKey(data, "f5")) this.nextPage();
    else if (matchesKey(data, "f6")) { if (this.workspace.rules) this.request("save-preset"); }
    else if (matchesKey(data, "f7") && this.page === "presets") {
      const item = this.currentPreset();
      if (item && this.workspace.rules) this.request(item.draft ? "review-draft" : "update-preset", item.name);
    }
    else if (PAGE_KEYS.some((key) => matchesKey(data, key))) {
      this.selectPage(PAGES[PAGE_KEYS.findIndex((key) => matchesKey(data, key))].id);
    }
    else if (matchesKey(data, "f1")) this.open("help");
    else if (this.page !== "resources") this.handleWorkspaceInput(data);
    else if (this.kb.matches(data, "tui.input.tab")) this.selectTab(this.tab === "skill" ? "mcp" : "skill");
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
      (this.page === "presets" ? this.presetInput : this.input).handleMouse({ ...event, x: x - search.x, y: 0, width: search.width, height: 1 });
      this.focused = true;
      this.tui.requestRender();
      return { handled: true, focus: true };
    }
    if (event.type === "wheel") {
      const main = this.mainArea;
      if (!this.sheet && main && (x < main.x || x >= main.x + main.width || y < main.y || y >= main.y + main.height)) return undefined;
      const area = this.detailArea;
      if (this.sheet === "details" || this.sheet === "document" || (!this.sheet && area && x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height)) this.scroll(event.wheelDelta ?? 0);
      else if (!this.sheet && this.page === "resources") this.move(Math.sign(event.wheelDelta ?? 0) * 3);
      else if (!this.sheet && this.page === "presets") this.movePreset(Math.sign(event.wheelDelta ?? 0) * 3);
      else return undefined;
    } else if (event.type === "click" && event.button === "left") {
      const hit = this.hits.find((item) => item.y === y && x >= item.x && x < item.end);
      if (!hit) return undefined;
      hit.run(x);
    } else return undefined;
    this.tui.requestRender();
    return { handled: true, focus: true };
  }

  private presets(): PresetItem[] {
    const query = this.presetInput.getValue().toLowerCase();
    return this.workspace.presets.filter((item) => item.name.toLowerCase().includes(query));
  }
  private currentPreset(): PresetItem | undefined {
    const items = this.presets();
    this.presetIndex = Math.max(0, Math.min(items.length - 1, this.presetIndex));
    return items[this.presetIndex];
  }
  private movePreset(delta: number): void {
    this.presetIndex = Math.max(0, Math.min(this.presets().length - 1, this.presetIndex + delta));
    this.detailOffset = 0;
  }
  private presetIssues(item: PresetItem): string[] {
    if (item.error) return [item.error];
    return item.preset?.resources.flatMap((resource) => {
      const matches = this.model.rows.filter((row) => row.kind === resource.kind && row.name === resource.name);
      return !matches.length ? [`缺少 ${resource.kind}：${resource.name}`]
        : matches.length > 1 ? [`同名资源有歧义：${resource.name}`]
          : !matches[0].editable ? [`资源只读：${resource.name}`] : [];
    }) ?? [];
  }
  private overviewActions(): Action[] {
    return [
      { label: "选择 Skills / MCP", run: () => this.selectPage("resources") },
      { label: "编辑项目规则", run: () => this.selectPage("rules") },
      { label: "从模板初始化", run: () => this.selectPage("presets") },
    ];
  }
  private handleWorkspaceInput(data: string): void {
    if (this.kb.matches(data, "tui.input.tab")) { this.nextPage(); return; }
    if (this.page === "overview") {
      const actions = this.overviewActions();
      if (this.kb.matches(data, "tui.select.up")) this.overviewIndex = Math.max(0, this.overviewIndex - 1);
      else if (this.kb.matches(data, "tui.select.down")) this.overviewIndex = Math.min(actions.length - 1, this.overviewIndex + 1);
      else if (this.kb.matches(data, "tui.select.confirm")) actions[this.overviewIndex].run();
    } else if (this.page === "presets") {
      if (matchesKey(data, "f3")) {
        const item = this.currentPreset();
        if (item) {
          this.document = { title: `模板 ${item.name} · 只读`, content: this.presetContent(item) };
          this.open("document");
        }
      }
      else if (this.kb.matches(data, "tui.select.up")) this.movePreset(-1);
      else if (this.kb.matches(data, "tui.select.down")) this.movePreset(1);
      else if (this.kb.matches(data, "tui.select.pageUp")) this.movePreset(-this.listHeight);
      else if (this.kb.matches(data, "tui.select.pageDown")) this.movePreset(this.listHeight);
      else if (this.kb.matches(data, "tui.select.confirm")) {
        const item = this.currentPreset();
        if (item?.draft) this.request("review-draft", item.name);
        else if (item?.preset && !this.pendingCount() && !this.presetIssues(item).length) this.request("apply-preset", item.name);
      } else { this.presetInput.handleInput(data); this.presetIndex = 0; this.detailOffset = 0; }
    } else {
      if (matchesKey(data, "f3")) this.showProjectDocument();
      else if (matchesKey(data, "ctrl+e") || this.kb.matches(data, "tui.select.confirm")) {
        if (this.workspace.rules && this.workspace.rules.override.text === undefined) this.request("edit-rules");
      } else if (this.kb.matches(data, "tui.select.up")) this.scroll(-1);
      else if (this.kb.matches(data, "tui.select.down")) this.scroll(1);
      else if (this.kb.matches(data, "tui.select.pageUp")) this.scroll(-this.listHeight);
      else if (this.kb.matches(data, "tui.select.pageDown")) this.scroll(this.listHeight);
    }
  }
  private documentLines(content: string, width: number): string[] {
    if (this.documentLayout?.content === content && this.documentLayout.width === width) return this.documentLayout.lines;
    const lines = content.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(text(line), width));
    this.documentLayout = { content, width, lines };
    return lines;
  }
  private markdownLines(content: string, width: number): string[] {
    if (this.markdown?.content !== content) {
      const clean = stripVTControlCharacters(content).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
      const theme = this.theme;
      const component = new Markdown(clean, 0, 0, {
        heading: (s) => theme.bold(theme.fg("mdHeading", s)),
        link: (s) => theme.fg("mdLink", s), linkUrl: (s) => theme.fg("mdLinkUrl", s),
        code: (s) => theme.fg("mdCode", s), codeBlock: (s) => theme.fg("mdCodeBlock", s),
        codeBlockBorder: (s) => theme.fg("mdCodeBlockBorder", s), quote: (s) => theme.fg("mdQuote", s),
        quoteBorder: (s) => theme.fg("mdQuoteBorder", s), hr: (s) => theme.fg("mdHr", s),
        listBullet: (s) => theme.fg("mdListBullet", s), bold: (s) => theme.bold(s),
        italic: (s) => theme.italic(s), underline: (s) => theme.underline(s), strikethrough: (s) => theme.strikethrough(s),
      });
      this.markdown = { content, component };
    }
    return this.markdown.component.render(width);
  }
  private scrollContent(content: string[], width: number, height: number): Block {
    const viewport = Math.max(1, height - 1);
    this.listHeight = viewport;
    this.detailMax = Math.max(0, content.length - viewport);
    this.detailOffset = Math.min(this.detailOffset, this.detailMax);
    this.detailArea = { x: 0, y: 0, width, height: viewport };
    const lines = content.slice(this.detailOffset, this.detailOffset + viewport);
    while (lines.length < height - 1) lines.push("");
    lines.push(this.theme.fg("dim", this.detailMax ? `${this.detailOffset + 1} / ${content.length} 行 · 滚动查看` : ""));
    return { lines: lines.slice(0, height), hits: [] };
  }
  private overviewBody(width: number, height: number): Block {
    const skills = this.model.rows.filter((row) => row.kind === "skill");
    const mcps = this.model.rows.filter((row) => row.kind === "mcp");
    const ruleStatus = this.workspace.rulesError ? "项目规则读取异常，可在“项目规则”中查看原因。"
      : `通用规则：${this.workspace.rules?.value ? "已配置" : "尚未添加"} · 个人模板 ${this.workspace.presets.length} 份`;
    if (width < 76 || height < 15) {
      const lines = [this.theme.bold(`Skills  ${skills.filter(effectiveEnabled).length} / ${skills.length} 开启`),
        `MCP     ${mcps.filter(effectiveEnabled).length} / ${mcps.length} 配置开启 · 连接状态未知`, ruleStatus, ""];
      const actions = this.buttons(this.overviewActions().map((action, index) => ({ ...action, active: index === this.overviewIndex })), width);
      return { lines: [...lines, ...actions.lines].slice(0, height),
        hits: actions.hits.map((hit) => ({ ...hit, y: hit.y + lines.length })).filter((hit) => hit.y < height) };
    }
    const cardWidth = Math.floor((width - 4) / 3);
    const metrics = [
      ["Skills", `${skills.filter(effectiveEnabled).length} / ${skills.length}`, "已选择的能力"],
      ["MCP", `${mcps.filter(effectiveEnabled).length} / ${mcps.length}`, "配置开启 · 连接未知"],
      ["个人模板", `${this.workspace.presets.length} 份`, "可用于其他项目"],
    ];
    const cards = metrics.map(([label, value, hint]) => ["", this.theme.fg("muted", label), this.theme.bold(value), this.theme.fg("dim", hint), ""]
      .map((line) => this.theme.bg("toolPendingBg", ` ${fit(line, cardWidth - 2)} `)));
    const lines = cards[0].map((_, y) => cards.map((card) => card[y]).join("  "));
    lines.push("", this.theme.fg("muted", "开始配置"));
    const hints = ["筛选能力，阅读说明与完整 Skill", "管理可复用规则，保留项目专属说明", "查看模板内容，预览后应用到项目"];
    const hits: Hit[] = [];
    this.overviewActions().forEach((action, index) => {
      const selected = index === this.overviewIndex;
      const top = `${selected ? "›" : " "} ${action.label} `;
      hits.push({ x: 0, end: width, y: lines.length, run: action.run }, { x: 0, end: width, y: lines.length + 1, run: action.run });
      lines.push(this.theme.bg(selected ? "selectedBg" : "toolPendingBg", fit(this.theme.fg(selected ? "accent" : "text", top), width)),
        this.theme.bg(selected ? "selectedBg" : "toolPendingBg", fit(this.theme.fg("muted", `  ${hints[index]}`), width)), "");
    });
    if (lines.length < height) {
      const pending = dirtyRows(this.model);
      lines.push(this.theme.fg(this.pendingCount() ? "warning" : "muted", this.pendingCount() ? "待保存变更" : "配置状态"));
      if (pending.length || rulesChanged(this.workspace)) {
        for (const row of pending) lines.push(`  ${text(row.name)}   ${enabledText(savedEnabled(row))} → ${enabledText(effectiveEnabled(row))}`);
        if (rulesChanged(this.workspace)) lines.push("  通用规则   已编辑，等待应用");
      } else lines.push(ruleStatus);
    }
    return { lines: lines.slice(0, height), hits: hits.filter((hit) => hit.y < height) };
  }
  private showProjectDocument(): void {
    const rules = this.workspace.rules;
    if (!rules) return;
    this.document = { title: "AGENTS.md · 只读", content: rules.file.text ?? "项目还没有 AGENTS.md。保存通用规则后会自动创建。" };
    this.open("document");
  }
  private rulesBody(width: number, height: number): Block {
    const rules = this.workspace.rules;
    if (!rules) return this.scrollContent(this.documentLines(this.workspace.rulesError ?? "无法读取项目规则。请关闭面板后重试。", width), width, height);
    const actions = this.buttons([
      { label: "编辑规则", disabled: rules.override.text !== undefined, run: () => this.request("edit-rules") },
      { label: "查看 AGENTS.md", run: () => this.showProjectDocument() },
    ], width);
    const lines = [...actions.lines, this.theme.fg("dim", "仅编辑通用规则区块，保留已有项目说明。")];
    const content = [
      ...(rules.override.text !== undefined ? [this.theme.fg("warning", "存在 AGENTS.override.md，请先处理覆盖文件再编辑规则。"), ""] : []),
      ...(rulesChanged(this.workspace) ? [this.theme.fg("warning", "规则已修改，尚未应用到项目。"), ""] : []),
      ...this.markdownLines(rules.value || "尚未添加通用规则。点击“编辑规则”填写可复用的工作约定。", width),
    ];
    const body = this.scrollContent(content, width, Math.max(1, height - lines.length));
    if (this.detailArea) this.detailArea.y += lines.length;
    return { lines: [...lines, ...body.lines].slice(0, height), hits: actions.hits.filter((hit) => hit.y < height) };
  }
  private presetContent(item: PresetItem): string {
    const issues = this.presetIssues(item);
    const preset = item.preset;
    return [item.name,
      ...(item.draft ? [`模型草稿 · 待${item.draft === "save" ? "保存模板（不会修改项目）" : "应用到项目"}`, ""] : []),
      ...(issues.length ? ["暂时无法初始化：", ...issues, ""] : ["本机资源齐全，可预览后初始化。", ""]),
      ...(preset ? ["能力组合", ...preset.resources.map((row) => `${row.kind === "skill" ? "Skill" : "MCP"} · ${row.name}：${enabledText(row.enabled)}`),
        "", "通用规则", preset.agentsMd || "（不包含规则）"] : []),
    ].join("\n");
  }
  private presetsBody(width: number, height: number): Block {
    const items = this.presets();
    const item = this.currentPreset();
    if (!item) return this.scrollContent(this.documentLines(this.workspace.presetsError
      ?? (this.workspace.presets.length ? "没有匹配的模板，试试其他关键词。" : "还没有个人模板。先选择能力并编辑规则，再点击“保存为模板”。"), width), width, height);
    const actions = this.buttons([
      ...(item.draft ? [{ label: item.draft === "save" ? "复核并保存模板" : "复核并应用", primary: true,
        disabled: item.draft === "apply" && Boolean(this.pendingCount()), run: () => this.request("review-draft", item.name) }] : [
        { label: "应用到项目", primary: true, disabled: Boolean(this.pendingCount() || this.presetIssues(item).length || !item.preset), run: () => this.request("apply-preset", item.name) },
        { label: "更新此模板", disabled: !this.workspace.rules, run: () => this.request("update-preset", item.name) },
      ]),
      { label: "查看全文", run: () => { this.document = { title: `模板 ${item.name} · 只读`, content: this.presetContent(item) }; this.open("document"); } },
    ], width);
    const lines = [...actions.lines, this.theme.fg("dim", item.draft ? "模型模板草稿尚未保存，可在此完整复核。" : this.pendingCount()
      ? "请先保存或放弃待修改项，再初始化模板。" : "选择模板查看内容，应用前会展示完整预览。")];
    const available = Math.max(1, height - lines.length);
    const wide = width >= 86 && available >= 9;
    const listWidth = wide ? Math.max(27, Math.floor(width * 0.32)) : width;
    const listHeight = wide ? available : Math.max(1, Math.floor(available * 0.45));
    const rowHeight = wide ? 3 : 1;
    const visibleItems = Math.max(1, Math.floor(listHeight / rowHeight));
    this.listHeight = visibleItems;
    const start = Math.max(0, Math.min(this.presetIndex - Math.floor(visibleItems / 2), items.length - visibleItems));
    const list: Block = { lines: [], hits: [] };
    for (const [offset, value] of items.slice(start, start + visibleItems).entries()) {
      const selected = start + offset === this.presetIndex;
      const issues = this.presetIssues(value);
      const status = value.draft ? "草稿" : value.error ? "异常" : issues.length ? "缺失" : "就绪";
      const name = `${selected ? "›" : " "} ${text(value.name)}`;
      const label = wide ? this.heading(name, this.theme.fg(issues.length ? "warning" : "success", status), listWidth)
        : `${name}${issues.length ? ` · ${status}` : ""}`;
      const shade = (line: string) => this.theme.bg(selected ? "selectedBg" : "toolPendingBg", fit(line, listWidth));
      const y = list.lines.length;
      list.lines.push(shade(label));
      if (wide) {
        const resources = value.preset?.resources ?? [];
        list.lines.push(shade(this.theme.fg("muted", `  ${resources.filter((row) => row.kind === "skill").length} Skills · ${resources.filter((row) => row.kind === "mcp").length} MCP`)), "");
      }
      for (let dy = 0; dy < (wide ? 2 : 1); dy++) list.hits.push({ x: 0, end: listWidth, y: y + dy,
        run: () => { this.presetIndex = start + offset; this.detailOffset = 0; } });
    }
    while (list.lines.length < listHeight) list.lines.push("");
    const detailWidth = wide ? width - listWidth - 3 : width;
    const issues = this.presetIssues(item);
    const detailLines = [this.theme.bold(text(item.name)),
      ...(item.draft ? [this.theme.fg("warning", `模型草稿 · 待${item.draft === "save" ? "保存模板" : "应用项目"}`), ""] : []),
      this.theme.fg(issues.length ? "warning" : "success", issues.length ? "暂时无法初始化" : "● 本机资源齐全，可预览后初始化。"),
      ...issues.flatMap((issue) => wrapTextWithAnsi(text(issue), detailWidth)), "",
      this.theme.fg("muted", "能力组合"),
      ...(item.preset?.resources ?? []).flatMap((row) => wrapTextWithAnsi(
        `${this.theme.fg(row.enabled ? "success" : "dim", row.enabled ? "+" : "−")} ${text(row.name)} · ${enabledText(row.enabled)}`, detailWidth)),
      "", this.theme.fg("muted", "通用规则"), ...this.markdownLines(item.preset?.agentsMd || "（不包含规则）", detailWidth)];
    const details = this.scrollContent(detailLines, detailWidth, wide ? available : Math.max(1, available - listHeight));
    this.listHeight = visibleItems;
    if (this.detailArea) {
      this.detailArea.x = wide ? listWidth + 3 : 0;
      this.detailArea.y += lines.length + (wide ? 0 : listHeight);
    }
    const body = wide ? list.lines.map((line, y) => fit(line, listWidth) + this.theme.fg("borderMuted", " │ ") + fit(details.lines[y] ?? "", detailWidth))
      : [...list.lines, ...details.lines];
    return { lines: [...lines, ...body].slice(0, height), hits: [...actions.hits,
      ...list.hits.map((hit) => ({ ...hit, y: hit.y + lines.length }))].filter((hit) => hit.y < height) };
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
      let styled = this.theme.fg(action.disabled ? "dim" : action.primary || action.active ? "accent" : "text", label);
      if (action.active || action.primary) styled = this.theme.bold(styled);
      if (!action.disabled) styled = this.theme.bg(action.primary ? "customMessageBg" : action.active ? "selectedBg" : "toolPendingBg", styled);
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
    const link = this.buttons([{ label: row.kind === "skill" && row.path ? "Skill 全文 ›" : this.detailMax ? "更多详情 › 可滚动" : "完整详情 ›", run: () => this.open("details") }], width);
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
    if (width >= 86 && height >= 12) {
      const leftWidth = Math.floor((width - 3) * (width < 100 ? 0.44 : 0.50));
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
    const count = this.pendingCount();
    const left = this.buttons([
      ...(this.page === "resources" ? [{ label: "批量操作 ▾", run: () => this.open("batch") }] : []),
      ...(this.page !== "resources" || width >= 80
        ? [{ label: "保存为模板", disabled: !this.workspace.rules, run: () => this.request("save-preset") }] : []),
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
        .flatMap((line) => wrapTextWithAnsi(line, inner)).concat(this.description(row, inner),
          this.skillBody === undefined ? [] : [this.theme.bold("Skill 全文 · 只读"), ...this.documentLines(this.skillBody, inner)]);
      const viewport = Math.max(1, height - 5);
      this.detailMax = Math.max(0, content.length - viewport);
      this.detailOffset = Math.min(this.detailOffset, this.detailMax);
      lines.push(this.theme.fg("muted", "资源详情"), ...content.slice(this.detailOffset, this.detailOffset + viewport));
    } else if (this.sheet === "document") {
      const content = this.documentLines(this.document?.content ?? "", inner);
      const viewport = Math.max(1, height - 5);
      this.detailMax = Math.max(0, content.length - viewport);
      this.detailOffset = Math.min(this.detailOffset, this.detailMax);
      lines.push(this.theme.bold(this.document?.title ?? "全文"), ...content.slice(this.detailOffset, this.detailOffset + viewport));
    } else if (this.sheet === "discard") {
      lines.push(this.theme.bold(`放弃这 ${this.pendingCount()} 项修改？`), "", ...wrapTextWithAnsi("能力开关和通用规则的修改尚未保存到项目。可以继续编辑，或保存并应用。", inner), "");
      this.append(lines, this.buttons([
        { label: "继续编辑", run: () => this.closeSheet() },
        { label: "放弃修改", run: () => this.done("cancel") },
        { label: "保存并应用", primary: true, run: () => this.done("save") },
      ], inner));
    } else if (this.sheet === "help") {
      lines.push(this.theme.bold("键盘与鼠标"), "", ...[
        "F5 / Alt+1…4      切换四个区域", "F6 / F7           保存模板 / 更新所选模板",
        "Tab               切换 Skills / MCP", "↑↓ / PageUp↓      选择或翻页", "空格 / Enter      切换资源开关",
        "F2 / F3 / F4      筛选 / 全文 / 批量", "Ctrl+E            编辑通用规则",
        "Ctrl+R            所选资源按默认", "Alt+E / D / R     批量开 / 关 / 默认",
        "Ctrl+S            保存并应用项目", "Esc               返回或关闭", "",
        "点击条目只选中，点击复选框切换。", "鼠标滚轮可独立滚动右侧内容。",
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
      if (batch) lines.push("", this.theme.fg("dim", "“撤销全部待保存”同时恢复资源开关和通用规则。"));
    }
    if (this.sheet !== "discard") {
      lines.push("");
      this.append(lines, this.buttons([{ label: this.sheet === "details" ? "返回列表" : "返回", run: () => this.closeSheet() }], inner));
    }
    return this.frame(lines.slice(0, Math.max(1, height - 2)), width);
  }
  private sidebar(width: number, height: number): Block {
    const block: Block = { lines: [this.theme.fg("dim", "  工作区"), ""], hits: [] };
    PAGES.forEach((page, index) => {
      const active = this.page === page.id;
      const label = this.heading(` ${active ? "›" : " "} ${page.label} `, this.theme.fg("dim", `${index + 1} `), width);
      block.hits.push({ x: 0, end: width, y: block.lines.length, run: () => this.selectPage(page.id) });
      block.lines.push(active ? this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(label))) : this.theme.fg("muted", label), "");
    });
    if (height >= 16) block.lines.push(this.theme.fg("borderMuted", "─".repeat(width)), "",
      this.theme.fg("dim", "  作用范围"), "  当前项目", "", this.theme.fg("dim", "  Alt+1…4 导航"));
    while (block.lines.length < height) block.lines.push("");
    block.lines = block.lines.slice(0, height).map((line) => this.theme.bg("toolPendingBg", fit(line, width)));
    block.hits = block.hits.filter((hit) => hit.y < height);
    return block;
  }
  private resetLayout(): void { this.hits = []; this.detailArea = undefined; this.searchArea = undefined; this.mainArea = undefined; }
  render(width: number): string[] {
    this.resetLayout();
    const height = Math.max(4, Math.floor(this.tui.terminal.rows * 0.95));
    if (width < 40 || height < 18) return this.frame(["能力开关", "请扩大终端至至少 40 列、20 行。", "Ctrl+S 保存 · Esc 关闭"].slice(0, height - 2), width);
    if (this.sheet) return this.renderSheet(width, height);
    const inner = width - 4;
    const pending = this.pendingCount();
    const wide = width >= 120 && height >= 24;
    const mainX = wide ? 23 : 0;
    const contentWidth = inner - mainX;
    const title = this.theme.bg("customMessageBg", this.theme.bold(this.theme.fg("accent", " Pi Switch ")))
      + this.theme.bold(`  ${text(basename(this.model.cwd.replace(/\\/g, "/")))}`);
    const badge = this.theme.fg(pending ? "warning" : "success", pending ? `● ${pending} 项待保存 ` : "● 配置已保存 ");
    const header = [this.heading(title, badge, inner), this.theme.fg("dim", `项目目录 · ${text(this.model.cwd)}`), ""];
    const lines: string[] = [];
    if (wide) {
      const page = PAGES.find((entry) => entry.id === this.page)!;
      lines.push(this.theme.bold(page.title), this.theme.fg("muted", page.subtitle), "");
    } else this.append(lines, this.buttons(PAGES.map((page) => ({
      label: page.label, active: this.page === page.id, run: () => this.selectPage(page.id),
    })), contentWidth));
    if (this.page === "resources") {
      this.append(lines, this.buttons([
        { label: `Skills ${this.model.rows.filter((row) => row.kind === "skill").length}`, active: this.tab === "skill", run: () => this.selectTab("skill") },
        { label: `MCP ${this.model.rows.filter((row) => row.kind === "mcp").length}`, active: this.tab === "mcp", run: () => this.selectTab("mcp") },
        { label: `${FILTER[this.filter]} ▾`, run: () => this.open("filter") },
      ], contentWidth));
      this.searchArea = { x: 0, y: lines.length, width: contentWidth, height: 1 };
      lines.push(...this.input.render(contentWidth).map((line) => this.theme.bg("toolPendingBg", fit(line, contentWidth))));
    } else if (this.page === "presets") {
      this.searchArea = { x: 0, y: lines.length, width: contentWidth, height: 1 };
      lines.push(...this.presetInput.render(contentWidth).map((line) => this.theme.bg("toolPendingBg", fit(line, contentWidth))));
    }
    lines.push(this.theme.fg("borderMuted", "─".repeat(contentWidth)));
    const footer = this.footer(contentWidth);
    const bodyHeight = Math.max(1, height - header.length - lines.length - footer.lines.length - 4);
    const body = this.page === "resources" ? this.body(this.filtered(), contentWidth, bodyHeight)
      : this.page === "overview" ? this.overviewBody(contentWidth, bodyHeight)
        : this.page === "rules" ? this.rulesBody(contentWidth, bodyHeight) : this.presetsBody(contentWidth, bodyHeight);
    if (this.detailArea) this.detailArea.y += lines.length;
    this.mainArea = { x: mainX, y: header.length + lines.length, width: contentWidth, height: bodyHeight };
    this.append(lines, body);
    if (wide) while (lines.length < height - header.length - footer.lines.length - 4) lines.push("");
    lines.push(this.theme.fg("borderMuted", "─".repeat(contentWidth)));
    this.append(lines, footer);
    lines.push(this.theme.fg("dim", pending ? "项目修改未应用 · F6 保存模板" : "F5 切换 · F6 存模板 · F1 帮助"));
    this.hits = this.hits.map((hit) => ({ ...hit, x: hit.x + mainX, end: hit.end + mainX, y: hit.y + header.length,
      run: (x) => hit.run(x - mainX) }));
    for (const area of [this.searchArea, this.detailArea]) {
      if (area) { area.x += mainX; area.y += header.length; }
    }
    if (wide) {
      const sidebar = this.sidebar(mainX - 3, lines.length);
      this.hits.push(...sidebar.hits.map((hit) => ({ ...hit, y: hit.y + header.length })));
      return this.frame([...header, ...lines.map((line, y) => sidebar.lines[y] + this.theme.fg("borderMuted", " │ ") + fit(line, contentWidth))], width);
    }
    return this.frame([...header, ...lines], width);
  }
}
