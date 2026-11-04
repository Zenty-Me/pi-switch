# Pi 项目能力面板

在 Pi 中用 `/project-capabilities` 打开面板，按项目启用或禁用 Skills 和原生 MCP 服务。

需要 Pi **1.5.0 或更新的 1.x 版本**、Node.js **22.19.0+**；开发验证使用 Pi 1.5.0、Node.js 24。支持 Windows、macOS、Linux 的原生路径。

## 安装

尚未发布到 npm，可以直接通过 GitHub 安装：

```bash
pi install git:github.com/Zenty-Me/pi-project-capabilities
```

此命令将面板安装为全局插件，因此在各项目都能打开；面板里的选择始终只保存到当前项目。已经打开的 Pi 会话执行 `/reload`，然后输入：

```text
/project-capabilities
```

仅临时试用（不写入安装设置）：

```bash
pi -e git:github.com/Zenty-Me/pi-project-capabilities
```

也可以只在某个项目安装插件，在那个项目目录执行：

```bash
pi install --local git:github.com/Zenty-Me/pi-project-capabilities
```

项目需要通过 Pi 原生的信任流程，打开面板时 Pi 需要处于空闲状态。

## 操作

| 操作 | 按键 |
| --- | --- |
| 切换 Skills / MCP | Tab |
| 搜索名称、描述或来源 | 直接输入；Ctrl+U 清空 |
| 选择条目 | ↑ / ↓；PageUp / PageDown |
| 启用 / 禁用所选项 | 空格 / Enter |
| 恢复所选项的继承状态 | Ctrl+R |
| 保存全部修改并重新加载 | Ctrl+S |
| 关闭 | Esc |

全屏模式下还支持鼠标点击标签页、条目、保存和恢复继承按钮，以及滚轮选择。普通终端模式使用键盘。

`[x]` 表示启用，`[ ]` 表示禁用；“继承”表示没有单独设置该资源的项目开关。`*` 表示尚未保存。已有修改时，Esc 会进入退出确认：Enter 放弃，Esc 返回，Ctrl+S 保存。

## 配置与作用范围

- Skills 使用 Pi 原生 `.pi/settings.json` 的精确资源路径开关与包级覆盖，兼容全局、项目、`.agents/skills` 和已安装包中的 Skills。禁用条目会继续显示，可再次启用。
- MCP 使用项目 `.pi/mcp.json` 的 `enabled` 字段。禁用全局服务时仅写入 `{ "enabled": false }` 覆盖，不复制命令、URL、密钥或其他全局配置。
- 恢复 MCP 继承只去掉项目 `enabled`，保留服务定义、工具暴露设置及其他字段。
- 只在保存时写项目配置，不更改全局资源配置，不移动、删除 Skills，不修改 Pi 核心。
- 保存前检查项目和全局配置是否发生变化；有变化时要求重新打开面板。单文件使用临时文件替换；两文件保存若遇到普通 I/O 错误，会尝试恢复原文件。进程崩溃或断电不具备跨文件事务保证。
- 重新加载后影响后续请求；已进入对话历史的 Skill 内容或 MCP 返回内容仍可能保留。

面板只管理 **Pi 原生 `mcp.json` 服务**。由扩展临时注册的 MCP 会显示为只读；第三方 MCP 适配器的专用配置由其自身管理。浏览器、搜索、子代理等普通扩展工具不属于原生 MCP 服务。

没有配置原生 MCP 时，MCP 标签页为空，可先使用 `pi mcp add` 添加服务。面板显示的是配置启用状态；连接诊断、登录仍使用 Pi 的 `/mcp`。

“恢复继承”移除单项精确开关，保留已有的目录或通配符策略。不同路径但同名的 Skills 分别显示，实际生效的同名优先级由 Pi 决定。新增加的 Skills 或 MCP 沿用 Pi 的默认规则，不会自动加入禁用名单。

## 在另一台电脑使用

新电脑安装原生 Pi 后，执行相同的安装命令：

```bash
pi install git:github.com/Zenty-Me/pi-project-capabilities
```

如果通过复制目录安装，可执行 `pi install /path/to/pi-project-capabilities`。

只需复制 `package.json`、`src/`、`README.md`、`LICENSE`；运行插件不需要复制 `node_modules`，也不需要构建。

Skills、MCP 服务和登录信息在新电脑上分别安装或配置。本版本使用 Pi 原生本机路径保存 Skill 项目开关；如果用户目录或安装位置变了，需要在新电脑面板中重新选择。当前不提供跨机器预设导入。

卸载 GitHub 来源的插件：

```bash
pi remove git:github.com/Zenty-Me/pi-project-capabilities
```

如果当初使用本地路径安装，卸载时也使用相同的本地路径。

更新未固定版本的已安装插件：

```bash
pi update --extensions
```

卸载后项目开关仍有效，可用 `pi config --local` 和 `/mcp` 修改。

## 开发验证

克隆仓库后安装开发依赖，以及仅供开发验证的宿主模块，再运行检查：

```bash
git clone https://github.com/Zenty-Me/pi-project-capabilities.git
cd pi-project-capabilities
npm ci --ignore-scripts
npm install --no-save --package-lock=false @earendil-works/pi-coding-agent@1.5.0 @earendil-works/pi-tui@1.5.0
npm run check
```

本地开发试用：

```bash
pi -e .
```

运行时仅使用 Pi 提供的宿主模块，无额外运行依赖。测试覆盖资源开关、恢复继承、项目隔离、MCP 凭据保留、配置变更冲突、搜索、键盘／鼠标交互与中文宽度。
