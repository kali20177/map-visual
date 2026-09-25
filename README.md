# MapVisual

嵌入式开发者的 VSCode map 文件阅读器：**快捷键一键打开链接器 map，以可排序、可过滤、可分组的列表精确查看每个符号的 Flash/RAM 占用，开箱即用的 C++ 名称还原**。

**状态：MVP 已实现**（GNU ld + LLVM lld 解析器、虚拟列表 UI、WASM demangle 全部可用并通过 65 项测试；lld 已用真实 ld.lld 23.1.2 产物验证）。Keil armlink / IAR 按里程碑推进。

## 快速开始

```bash
npm install
npm run compile     # esbuild 打包 extension / worker / webview
npm test            # vitest，65 项单测（含 17 个真实 map fixture）
```

调试运行：VSCode 打开本目录按 `F5`（扩展开发宿主），在工程里放一个 `.map` 文件，`Alt+M` 或双击打开。

## 功能规划（速览）

- **`Alt+M` 秒开**：QuickPick 选择或双击 `.map` 直接进入可视化视图，重建后自动刷新
- **符号级列表**：Size / Symbol / Kind / Section / Object / Address 任意排序，虚拟滚动
- **C++ 还原**：内置 WASM demangler（gecko-profiler-demangle，零配置），段名内嵌符号（`.text._ZN...`）一并还原，mangled 与 demangled 双向可搜索
- **编译选项自动化**：`-ffunction-sections` 两行式条目、LTO、`--gc-sections` 裁剪桶、`*fill*` 填充、静态库成员、relax 注释行、`.data` 的 Flash/RAM 双计入
- **多工具链**：GNU ld ✅ / LLVM lld ✅ / Keil armlink（M2）/ IAR ilink（M4）
- **汇总面板**：区域占用条（Memory Configuration）、分类占比、Top 符号、填充浪费统计；CSV 导出

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 总体设计：架构、数据模型、解析管线、demangle 方案、UI 线框、里程碑 |
| [docs/RESEARCH.md](docs/RESEARCH.md) | 竞品调研：Map View Embedded、linkermapviz、Emma、puncover、bloaty 的实现逻辑与差距分析 |
| [docs/FORMATS.md](docs/FORMATS.md) | map 文件格式规范：GNU ld 行文法与尺寸分摊算法、Keil armlink、IAR/lld 待采样项 |
| [test/fixtures/](test/fixtures/) | 用例库：13 个 x86 fixture（移植自前作）+ 3 个 arm-none-eabi 真实嵌入式 fixture（含归档成员、.ARM.exidx、load address、no-demangle）+ lld 生成脚本 |

## 用例库说明

`test/fixtures/gnuld-x86/` 移植自前作 imgui-gl3-glfw3-base（x86-64 g++-14 生成）；`gnuld-arm/` 由本机 Arm GNU Toolchain 13.3 实际构建生成（build.sh 可复现，含 C++ 类/模板、静态库归档、STM32 式链接脚本）；`lld/` 提供 ld.lld 生成脚本（待本机 lld 可用后执行）。每个子目录的 README/build.sh 记录了精确的编译命令。
