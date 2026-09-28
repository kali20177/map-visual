# AGENTS.md

VSCode 插件 **MapVisual**：嵌入式链接器 map 文件可视化（列表/ Treemap / Diff），支持 GNU ld 与 LLVM lld，内置 C++ demangle（WASM，零配置）。代码与文档注释用中文。

## 常用命令

```bash
npm run compile        # esbuild 五入口：dist/extension.js + worker.js + webview.js + diff.js + cli.js（并拷贝 wasm）
npm run typecheck      # tsc --noEmit（strict + noUnusedLocals）
npm run lint           # ESLint（flat config：eslint.config.mjs）
npm run check:coupling # dependency-cruiser 架构规则
npm test               # vitest（test/unit/）
npm run prepare        # 安装 simple-git-hooks pre-commit（lint-staged）
```

提交前四项全绿（typecheck / lint / coupling / test，当前基线 191 项测试）。pre-commit 会自动对暂存文件 `eslint --fix`。

调试：VSCode 打开本目录按 `F5`（扩展开发宿主），工作区放一个 `.map` 文件，`Alt+M` 或双击打开即可实测。

## CLI 速查（AI / 脚本通道）

`npm run compile` 后可直接调，解析核心不依赖 VSCode（完整契约见 docs/CLI.md）：

```bash
node dist/cli.js summary firmware.map                      # 区域占用 + Flash/RAM 总量（JSON）
node dist/cli.js symbols firmware.map --top 20 --kind code # 符号清单，可过滤/排序
node dist/cli.js treemap firmware.map --depth 2            # section→object 层级占比
node dist/cli.js diff old.map new.map                      # 符号级增减 + 总量差值
```

默认输出 JSON（`--md` 出 Markdown 表格），退出码与错误 kind 对齐。

## 目录

- `src/extension.ts` `mapEditor.ts` `diffPanel.ts` `workerClient.ts` — 扩展宿主层（唯一允许 import 'vscode' 的地方）
- `src/worker.ts` 与 `src/parser/`（gnuld / lld / detect / registry / pipeline）、`src/demangle/`、`src/analysis/` — worker 运行时，纯 Node，禁止 vscode
- `src/cli.ts` `src/cliApp.ts` — CLI 运行时（M6，第四入口，独立进程直接调 parser/analysis，不经 worker_threads）：逻辑在 cliApp 的 `runCli` 纯函数（可测、可被未来 MCP 复用），cli.ts 只做进程接线；同受禁 vscode 约束，且只准依赖 worker 树核心与 types/protocol（depcruise cli-allowlist 白名单）
- `src/webview/`（main / model / diff / treemap）— webview 运行时（浏览器沙箱），禁止 vscode 与 node 内置模块
- `src/protocol.ts` — 三层消息协议；`src/types.ts` — 跨层 IR 契约（新增共享类型放这里，不要放 analysis/，dependency-cruiser 会拦）
- `test/unit/` — vitest；`test/fixtures/` — 22 份 map fixture：gnuld-x86（移植自 imgui-gl3-glfw3-base）、gnuld-arm（build.sh 实际构建）、lld/、real/（外部真实工程黄金基准：rb-demo + zephyr，见该目录 README），fixture 的 .map 是黄金基准，改动解析器必须保持全部通过
- `docs/` — DESIGN（§13 实现偏差必读）与 CLI（M6 命令行通道的设计契约）入库；FORMATS（map 格式圣经）、RESEARCH（竞品调研：Map View Embedded、linkermapviz、Emma、puncover、bloaty）为本地 AI 参考文档，不入库（与 REVIEW-* 同策略，见 .gitignore）

## 架构边界（由 ESLint + dependency-cruiser 强制，勿绕过）

- 四个运行时物理隔离：**worker 树（worker/parser/demangle/analysis）与 CLI（cli/cliApp）禁止 import vscode**；**webview 禁止 vscode 与 node 内置模块**；**宿主（extension/mapEditor/diffPanel/workerClient）不得直接 import parser/analysis**——解析必须经 worker 消息协议；**CLI 只准依赖 worker 树核心与 types/protocol**（cli-allowlist 白名单，列表式规则曾漏 diffPanel）
- webview 本地依赖白名单：仅 `types.ts` / `protocol.ts` / `webview/` 内部
- 修改边界规则本身要同步 eslint.config.mjs 与 .dependency-cruiser.cjs 两处，并用"故意违规"验证规则真的会触发
- 禁 vscode 为什么归 ESLint 管：@types/vscode 使 'vscode' 可解析、tsc 查不出这类违规，但打包后 Worker 启动即崩——由 `no-restricted-imports` 拦截；`package.json` 的 `allowScripts` 是 npm≥11 安装脚本白名单（esbuild / simple-git-hooks）

## 关键坑（踩过的）

- **package.json 不能加 `"type": "module"`**：dist/worker.js 是 CJS bundle，加了会被 Node 当 ESM 加载直接崩（wasm glue 内部用 require）
- **esbuild 会把 `import.meta` 替换成空对象**（CJS 输出）：dist/cli.js 里解析包版本号只能由 cli.ts 用 `createRequire(__filename)` 注入 `CliEnv.version`；vitest 下是真 ESM 不受影响
- demangler：绕过 gecko-profiler-demangle 默认入口，`import 'gecko-profiler-demangle/index_bg.js'` + 自行 `WebAssembly.instantiate(bytes, { './index_bg.js': bg })` + `__wbg_set_wasm`；wasm 由 build.mjs 拷到 dist/，worker 用 `__dirname` 定位
- GNU ld map：relax 注释是独立无地址行；脚本赋值带地址会伪装符号行；`.bss` 段头也有 load address，区域占用必须按 storage 过滤；符号尺寸靠贡献段内地址差分摊（组键含地址，见 docs/FORMATS.md §1.4）；LTO 合并段会重打印 pre-merge 历史快照行（按"输出段内贡献+fill 铺满段 size"取舍）；无点自定义段名（`section("shellCommand")`）与两行式 NOLOAD 段头（col0 裸名 + load address 行）都要识别；**ld 不给本地符号打符号行**——`-ffunction-sections`/LTO 内化/libgcc 等预编译库里的 `static`、匿名命名空间函数只剩「裸子段头 `.text.foo` + 贡献行」，这类贡献成为 `fromSectionName` 段级行，其 `line` 必须锚在印着段名的那一行（贡献行只印地址/尺寸/目标文件，分栏点击靠名字校验）
- lld map：整表有前导缩进，行类型靠 Align 列后空格数判别（output=1、child≥2）；尺寸是无前缀十六进制（`12` = 18）
- 新格式（M2 Keil / M4 IAR）走 `src/parser/registry.ts` 的 `registerParser`，契约见该文件注释；不要改 detect/pipeline 的分发逻辑

## 其他约定

- 所有代码文件以 LF 结尾；不引入格式化器（Prettier/Biome），风格靠统一约定（与 kart 项目一致）
- UI 文案英文、颜色只用语义 kind 色板 + `--vscode-*` 主题变量（亮/暗/高对比都要正常）
- webview 视觉验证：`python3 -m http.server 8123` 后访问 `test/harness.html` 与 `test/diff-harness.html`（内置 --vscode-* 变量与 mock 数据，mock 文件已 gitignore）
- 提交信息用中文 Conventional Commits（`feat:` / `chore:` …），参照 git log 既有风格
