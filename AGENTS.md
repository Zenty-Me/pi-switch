# 项目约定

## 栈

Pi 1.5.x 扩展包，TypeScript，Node.js 22.19+。运行时依赖由 Pi 提供；`src/index.ts` 是插件入口。

## 目录

- `src/model.ts`：原生资源发现、项目覆盖和配置持久化。
- `src/panel.ts`：Skills / MCP 交互面板。
- `src/proposals.ts`：内存建议、资源元数据白名单和会话隔离。
- `src/tool.ts`：当前模型使用的 list / stage 工具，不得提供保存能力。
- `test/`：宿主加载、对话建议到人工保存、配置隔离和终端交互验证。

## 起前后端

没有前后端服务。用 `pi -e /absolute/path/to/pi-project-capabilities` 加载，然后执行 `/project-capabilities`。

## 测试

`npm run check` 执行 TypeScript 检查和 Node 测试（建议 Node.js 24）。开发环境需要可解析 Pi 宿主包及其提供的 typebox；发布包不得捆绑宿主模块。修改包内 Skill 开关后，必须验证 Pi 原生加载结果，不能仅断言面板状态。模型建议测试必须覆盖：暂存不落盘、仅面板保存落盘、认证配置不出现在工具结果、会话与项目间不泄漏。

## env

不需要 API Key。使用 Pi 的 `getAgentDir()` 和 `CONFIG_DIR_NAME`，不要硬编码用户目录。MCP 密钥保持在原有位置，项目覆盖只能修改启用状态。
