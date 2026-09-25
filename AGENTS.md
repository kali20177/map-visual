# AGENTS.md

VSCode 插件 **MapVisual**：嵌入式链接器 map 文件可视化（列表/ Treemap / Diff），支持 GNU ld 与 LLVM lld，内置 C++ demangle（WASM，零配置）。代码与文档注释用中文。

## 常用命令

```bash
npm run compile        # esbuild 三入口：dist/extension.js + worker.js + webview.js + diff.js（并拷贝 wasm）
npm run typecheck      # tsc --noEmit（strict + noUnusedLocals）
npm run lint           # ESLint（flat config：eslint.config.mjs）
npm run check:coupling # dependency-cruiser 架构规则
npm test               # vitest（test/unit/）
npm run prepare        # 安装 simple-git-hooks pre-commit（lint-staged）
```

提交前四项全绿（typecheck / lint / coupling / test，当前基线 91 项测试）。pre-commit 会自动对暂存文件 `eslint --fix`。

## 目录

- `src/extension.ts` `mapEditor.ts` `diffPanel.ts` `workerClient.ts` — 扩展宿主层（唯一允许 import 'vscode' 的地方）
- `src/parser/`（gnuld / lld / detect / registry / pipeline）、`src/demangle/`、`src/analysis/`、`src/worker.ts` — worker 运行时，纯 Node，禁止 vscode
- `src/webview/`（main / model / diff / treemap）— webview 运行时（浏览器沙箱），禁止 vscode 与 node 内置模块
- `src/protocol.ts` — 三层消息协议；`src/types.ts` — 跨层 IR 契约（新增共享类型放这里，不要放 analysis/，dependency-cruiser 会拦）
- `test/unit/` — vitest；`test/fixtures/` — 19 个真实 map fixture（gnuld-x86 移植自 imgui-gl3-glfw3-base、gnuld-arm 由 build.sh 实际构建、lld/ 同理），fixture 的 .map 是黄金基准，改动解析器必须保持全部通过
- `docs/` — DESIGN（§13 实现偏差必读）、FORMATS（map 格式圣经）、RESEARCH

## 架构边界（由 ESLint + dependency-cruiser 强制，勿绕过）

- 三个运行时物理隔离：**worker 树（worker/parser/demangle/analysis）禁止 import vscode**；**webview 禁止 vscode 与 node 内置模块**；**宿主（extension/mapEditor/workerClient）不得直接 import parser/analysis**——解析必须经 worker 消息协议
- webview 本地依赖白名单：仅 `types.ts` / `protocol.ts` / `webview/` 内部
- 修改边界规则本身要同步 eslint.config.mjs 与 .dependency-cruiser.cjs 两处，并用"故意违规"验证规则真的会触发

## 关键坑（踩过的）

- **package.json 不能加 `"type": "module"`**：dist/worker.js 是 CJS bundle，加了会被 Node 当 ESM 加载直接崩（wasm glue 内部用 require）
- demangler：绕过 gecko-profiler-demangle 默认入口，`import 'gecko-profiler-demangle/index_bg.js'` + 自行 `WebAssembly.instantiate(bytes, { './index_bg.js': bg })` + `__wbg_set_wasm`；wasm 由 build.mjs 拷到 dist/，worker 用 `__dirname` 定位
- GNU ld map：relax 注释是独立无地址行；脚本赋值带地址会伪装符号行；`.bss` 段头也有 load address，区域占用必须按 storage 过滤；符号尺寸靠贡献段内地址差分摊（组键含地址，见 docs/FORMATS.md §1.4）
- lld map：整表有前导缩进，行类型靠 Align 列后空格数判别（output=1、child≥2）；尺寸是无前缀十六进制（`12` = 18）
- 新格式（M2 Keil / M4 IAR）走 `src/parser/registry.ts` 的 `registerParser`，契约见该文件注释；不要改 detect/pipeline 的分发逻辑

## 其他约定

- 所有代码文件以 LF 结尾；不引入格式化器（Prettier/Biome），风格靠统一约定（与 kart 项目一致）
- UI 文案英文、颜色只用语义 kind 色板 + `--vscode-*` 主题变量（亮/暗/高对比都要正常）
- webview 视觉验证：`python3 -m http.server 8123` 后访问 `test/harness.html` 与 `test/diff-harness.html`（内置 --vscode-* 变量与 mock 数据，mock 文件已 gitignore）
- 提交信息用中文 Conventional Commits（`feat:` / `chore:` …），参照 git log 既有风格
