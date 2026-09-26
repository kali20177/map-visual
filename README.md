# MapVisual

嵌入式开发者的 VSCode map 文件阅读器：**快捷键一键打开链接器 map，以可排序、可过滤、可分组的列表精确查看每个符号的 Flash/RAM 占用，开箱即用的 C++ 名称还原**。

**状态：MVP 已实现**（GNU ld + LLVM lld 解析器、虚拟列表 UI、WASM demangle 全部可用并通过 134 项测试；lld 已用真实 ld.lld 23.1.2 产物验证）。CLI 命令行通道（M6）已交付。Keil armlink / IAR 按里程碑推进。

## 快速开始

```bash
npm install
npm run compile     # esbuild 打包 extension / worker / webview / cli
npm test            # vitest，134 项单测（含真实 map 黄金基准）
```

调试运行：VSCode 打开本目录按 `F5`（扩展开发宿主），在工程里放一个 `.map` 文件，`Alt+M` 或双击打开。

## CLI（AI / 脚本通道）

解析核心不依赖 VSCode，可直接命令行调用（`npm run compile` 后），供 AI 助手与脚本消费：

```bash
node dist/cli.js summary firmware.map                    # 区域占用 + Flash/RAM 总量（JSON）
node dist/cli.js symbols firmware.map --top 20 --kind code   # 符号清单，可过滤/排序
node dist/cli.js treemap firmware.map --depth 2          # section→object 层级占比
node dist/cli.js diff old.map new.map                    # 按符号对比增减 + 总量差值
```

默认输出 JSON（AI 可直接读/继续 jq），`--md` 输出 Markdown 表格；退出码与错误 kind 对齐。完整契约见 [docs/CLI.md](docs/CLI.md)。

## 功能规划（速览）

- **`Alt+M` 秒开**：QuickPick 选择或双击 `.map` 直接进入可视化视图，重建后自动刷新；**`Alt+Shift+D` 对比两份 map**
- **符号级列表**：Size / Symbol / Kind / Section / Object / Address 任意排序，虚拟滚动；右键菜单支持复制 mangled / demangled / 整行、按对象过滤、跳转源码
- **Treemap 视图**：列表 ⇄ 面积图一键切换，按分组着色、可钻取
- **Map Diff**：选两份 map 按符号对比增减（added / removed / changed），Flash/RAM 总量差值汇总，可导出 CSV
- **C++ 还原**：内置 WASM demangler（gecko-profiler-demangle，零配置），段名内嵌符号（`.text._ZN...`）一并还原，mangled 与 demangled 双向可搜索
- **编译选项自动化**：`-ffunction-sections` 两行式条目、LTO、`--gc-sections` 裁剪桶、`*fill*` 填充、静态库成员、relax 注释行、`.data` 的 Flash/RAM 双计入
- **多工具链**：GNU ld ✅ / LLVM lld ✅（真实产物验证）/ Keil armlink（接口预留，M2）/ IAR ilink（接口预留，M4）
- **汇总面板 + 状态栏**：区域占用条、分类占比、Top 符号；VSCode 状态栏速览当前 map 的 Flash/RAM
- **解析进度**：状态栏进度提示（读取 → 检测 → 解析 → demangle → 分析）

## 质量门禁

工具链参照 kart 项目：**ESLint（typescript-eslint recommended）+ dependency-cruiser 架构规则 + lint-staged 提交钩子**，刻意不引入格式化器（风格由统一约定与 tsc 严格选项保证，与 kart 一致）。

```bash
npm run lint            # ESLint：正确性规则 + 运行时边界
npm run check:coupling  # dependency-cruiser：模块分层
npm run typecheck       # tsc --noEmit（strict + noUnusedLocals）
npm test                # vitest
```

**运行时边界规则**（本项目最重要的一层防护，均经故意违规实测确认会触发）：
- `src/worker.ts / parser / demangle / analysis`（worker_threads 运行时）与 `src/cli.ts / cliApp.ts`（独立 CLI 进程）**禁止 import vscode** —— tsc 查不出这个错误（@types/vscode 使其可解析），但打包后 Worker 启动即崩，由 ESLint `no-restricted-imports` 拦截
- `src/webview/**`（沙箱 iframe 运行时）禁止 vscode 与 Node 内置模块；本地依赖白名单限定 `types/protocol/webview`（解析结果必须经宿主下发），由 dependency-cruiser 强制
- `extension / mapEditor / workerClient`（宿主）不得绕过 worker 直接引用解析器/分析器
- CLI（cli/cliApp）不得引用宿主与 webview（dependency-cruiser `cli-no-host` / `cli-no-webview`）

提交时 `simple-git-hooks` 的 pre-commit 会对暂存文件自动执行 `eslint --fix`。`package.json` 的 `allowScripts` 声明了 esbuild / simple-git-hooks 的安装脚本白名单（npm ≥11 的 install-scripts 机制）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 总体设计：架构、数据模型、解析管线、demangle 方案、UI 线框、里程碑 |
| [docs/CLI.md](docs/CLI.md) | CLI 设计方案（M6）：AI/脚本通道的命令契约、JSON 输出、边界规则与测试策略 |
| [docs/RESEARCH.md](docs/RESEARCH.md) | 竞品调研：Map View Embedded、linkermapviz、Emma、puncover、bloaty 的实现逻辑与差距分析 |
| [docs/FORMATS.md](docs/FORMATS.md) | map 文件格式规范：GNU ld 行文法与尺寸分摊算法、Keil armlink、IAR/lld 待采样项 |
| [test/fixtures/](test/fixtures/) | 用例库：13 个 x86 fixture（移植自前作）+ 3 个 arm-none-eabi 真实嵌入式 fixture（含归档成员、.ARM.exidx、load address、no-demangle）+ lld 生成脚本 |

## 用例库说明

`test/fixtures/gnuld-x86/` 移植自前作 imgui-gl3-glfw3-base（x86-64 g++-14 生成）；`gnuld-arm/` 由本机 Arm GNU Toolchain 13.3 实际构建生成（build.sh 可复现，含 C++ 类/模板、静态库归档、STM32 式链接脚本）；`lld/` 提供 ld.lld 生成脚本（待本机 lld 可用后执行）。每个子目录的 README/build.sh 记录了精确的编译命令。
