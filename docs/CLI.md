# MapVisual CLI 设计方案（M6：AI / 脚本通道）

> 把插件的核心能力（map 解析、区域统计、符号清单、Treemap 数据、Diff）以命令行形式暴露，
> 供 AI 编码助手与脚本管道调用。本文是 M6 的实现方案，遵循 `docs/DESIGN.md` 的架构与边界约定。
> 状态：**已实现**（2026-09-26，实现偏差见文末 §10）。

## 1. 背景与目标

AI 编码助手（ZCode / Claude Code / Cursor 等）都能执行 shell 命令。当前它们要看懂一份 linker map
只能肉眼扫几千行文本；CLI 化之后，一条命令就能拿到经过 22 份黄金基准 fixture 验证的精确数字
（区域占用与 `--print-memory-usage`、ELF 段级真值对齐），以及内置 WASM demangle 后的符号名——
AI 不必再外调 `c++filt`，也不必自己实现尺寸语义（bss 的 load address 陷阱、LTO 快照行、双计入等
`docs/FORMATS.md` 里的坑都已由解析器消化）。

**目标**

1. 四个子命令：`summary` / `symbols` / `treemap` / `diff`，默认输出 JSON（机器可读，可继续 jq/grep），可选 `--md`（Markdown 表格，供人阅读或贴 issue）。
2. 复用 worker 树全部核心，**零解析逻辑复制**——CLI 只是第四个运行时入口。
3. 边界规则同步收紧并验证（ESLint + dependency-cruiser）。
4. 仓库内 `npx mapvisual ...` 即用；`bin` 字段支持后续 npm 分发。

**非目标**

- 不做交互式 TUI、进度动画（`onProgress` 默认静默，`--progress` 可选输出到 stderr）。
- 不做 MCP server（§9 仅作演进预留——包同一 seam，不在本里程碑）。
- 不经 worker_threads：worker 的存在意义是避免阻塞扩展宿主 UI 线程；CLI 是独立进程，直接调用即可。
- 不支持 stdin（`-` 读管道）——列入开放问题，M6 不做。

## 2. 架构定位

```
                ┌───────────────────────────────┐
                │         VSCode 扩展宿主        │
                │  extension/mapEditor/diffPanel │
                └──────────────┬────────────────┘
                               │ worker_threads + protocol.ts 消息
        ┌──────────────────────┴───────────────────────┐
        │        worker 树（纯 Node，零 vscode 依赖）     │
        │  worker.ts（线程入口）                          │
        │  parser/   detect · registry · gnuld · lld · pipeline │
        │  demangle/ WASM（dist/index_bg.wasm，__dirname 定位）  │
        │  analysis/ analyze · diff                      │
        └──────────────────────┬───────────────────────┘
                               │ 同一棵树内的直接函数调用
                ┌──────────────┴───────────────┐
                │ cliApp.ts   命令实现（可单测） │
                │ cli.ts      进程入口          │
                └──────────────────────────────┘
```

复用点与现状完全对齐：

- 解析入口即 worker 所用：`parseMapFile` / `parseMapText`（`src/parser/pipeline.ts:32,54`），
  区域角色、storage、totals 由 `finalize`（`src/analysis/analyze.ts:143`）填充，CLI 拿到的就是
  webview 渲染的同一份 IR（`MapDocument`，纯 interface 无 Map/Set，`JSON.stringify` 直接可用）。
- Diff 复用 `diffDocuments`（`src/analysis/diff.ts`），产出 `DiffResult`。
- demangle WASM 由 build.mjs 拷到 dist/，worker 以 `__dirname` 定位（`src/worker.ts:31`）；
  CLI bundle 打进同一 dist/，定位逻辑零改动。
- 未来 armlink/ilink 经 registry 注册后 CLI 自动获得，无需改 CLI。

## 3. 命令面与契约

```bash
mapvisual summary <file>                          # 区域占用 + flash/ram 总量 + warnings
mapvisual symbols <file> [--kind K]... [--status kept|discarded]
                  [--section RE] [--object RE] [--filter SUBSTR] [--min-size N]
                  [--sort size|addr|name] [--top N]
mapvisual treemap  <file> [--by section|object|kind] [--depth 1|2|3]
mapvisual diff     <fileA> <fileB> [--status added|removed|changed] [--min-delta N] [--top N]

# 全局：--format auto|gnu-ld|lld   --no-demangle   --md   --progress   --help   --version
```

- `<file>` 均为必选位置参数；`--kind`/`--status` 可重复（OR 语义）；`--section`/`--object`/`--filter` 为正则/子串匹配。
- `symbols` 默认按 size 降序（AI 的第一问永远是"谁最大"），且默认折叠 `meta`、隐藏 `discarded`（对齐 webview 默认视图），`--kind meta` / `--status discarded` 显式放开。
- `summary`/`symbols`/`treemap`/`diff` 成功输出 JSON 到 stdout；**MapParseError.kind 类错误**（退出码 3–7）在 stderr 输出单行 JSON `{"error":{"kind":"notfound","message":"..."}}`；**usage 错误**（退出码 2）stderr 为人类可读消息 + Usage 帮助（见 §10 偏差 4）。

**退出码**（与 `MapParseError.kind` 对齐，`src/parser/pipeline.ts:17`）：

| code | 含义 | 来源 |
|---|---|---|
| 0 | 成功 | |
| 1 | 未预期异常 | catch-all |
| 2 | 用法错误（未知命令/参数） | parseArgs |
| 3 | 文件不存在 | `notfound` |
| 4 | 已识别但未支持（armlink / ilink） | `unsupported`（透出 `PLANNED_FORMATS` 提示） |
| 5 | 无法识别格式 | `unknown` |
| 6 | JSON（JS sourcemap）误入 | `json` |
| 7 | 读写失败 | `io` |

## 4. 输出契约（JSON）

顶层公共字段：`tool` / `version` / `command` / `file`；`summary`、`diff` 额外带 `warnings`。
以下示例中 `flash/ram` 取自 rb-demo 真实黄金基准，其余字段值为示意结构（实现以 IR 为准）。

```jsonc
// summary —— totals 即 MapTotals（src/types.ts:60），regions 附 usage 百分比
{
  "tool": "mapvisual", "version": "0.1.0", "command": "summary",
  "file": "firmware.map", "format": "gnu-ld",
  "totals": {
    "flash": 7648, "ram": 6360,
    "keptCount": 0, "discardedCount": 0, "fillTotal": 0,
    "kindTotals": { "code": 0, "rodata": 0, "data": 0, "bss": 0, "meta": 0, "pad": 0, "other": 0 },
    "regions": [
      { "name": "FLASH", "role": "flash", "origin": 134217728, "length": 65536, "used": 7648, "usage": 0.117 }
    ]
  },
  "warnings": []
}

// symbols —— { ..., "count": N, "totals": {...}, "symbols": [SymbolRecord...] }（行结构与 webview 完全一致）
// treemap —— { ..., "tree": [ { "name": ".text", "size": 5980, "count": 42, "children": [
//                { "name": "main.o", "size": 812, "count": 3, "children": [ { "name": "main", "size": 100, "count": 1 } ] } ] } ] }
//            顶层数组按 size 降序；depth 由 --depth 截断；Σ 同级 size == 父 size（§7 属性测试）

// diff —— DiffResult（src/types.ts:109）外加聚合：
{
  "fileA": "old.map", "fileB": "new.map",
  "summary": { "added": 3, "removed": 1, "changed": 5, "deltaFlash": 452, "deltaRam": -16 },
  "rows": [ { "key": "...", "name": "app_init", "kind": "code", "status": "changed",
               "sizeA": 200, "sizeB": 460, "delta": 260, "objectA": "app.o", "objectB": "app.o" } ],
  "totalsA": { "...": "MapTotals" }, "totalsB": { "...": "MapTotals" }
}
```

`--md` 输出对应 Markdown 表格（summary 两张表：总量 + 区域；diff 一张变更表），实现为各命令
JSON 到 Markdown 的投影，不引入第三方依赖。

## 5. 实现设计

**双文件分层**（为了可测性与未来 MCP 复用）：

```ts
// src/cliApp.ts —— 纯命令实现：不触碰 process，vitest 直测，MCP 可直接 import
export interface CliRunResult { code: number; out?: string; err?: string }
export async function runCli(argv: string[]): Promise<CliRunResult>;  // 契约：永不 reject

// src/cli.ts —— esbuild 入口（dist/cli.js，构建时注入 shebang banner）
import { runCli } from './cliApp';
void runCli(process.argv.slice(2)).then((r) => {
    if (r.out) process.stdout.write(r.out);
    if (r.err) process.stderr.write(r.err);
    process.exitCode = r.code;  // 不用 process.exit：大 JSON 可能截断在 pipe 缓冲中
});
```

实现要点与已知坑：

1. **CJS 禁止 top-level await**——esbuild 对 cjs 输出不支持 TLA（worker 同为 cjs），入口用 IIFE/`.then` 包裹。
2. **版本号注入**：`createRequire(import.meta.url)('../package.json').version`——esbuild 的 cjs 输出支持
   `import.meta.url`（指向 dist/cli.js），vitest 下指向源文件，两条路径都解析到仓库根 package.json，
   免去 esbuild `define` 在 vitest 下未定义的问题。
3. **wasmDir**：传 `__dirname`，与 worker 相同（`src/worker.ts:31`）；`--no-demangle` 时跳过初始化。
4. `parseMapFile` 复用后，`--format`、`--no-demangle` 直接映射到 `ParseOptions`。
5. treemap 聚合：kept 符号按 `--by` 键分组求和（section → object → symbol 三层），不引入 webview 的
   渲染语义；分组键语义与 webview 分组（M3）保持一致，实现时对照 `src/webview/model.ts` 校准。

**构建与分发**：

- `build.mjs` 增加第五个 entry：`src/cli.ts → dist/cli.js`，`format: 'cjs'`、`platform: 'node'`、
  `target: 'node18'`，加 `banner: { js: '#!/usr/bin/env node' }`（shebang 必须物理在文件头，npm bin 才能执行）。
- `package.json` 增加 `"bin": { "mapvisual": "./dist/cli.js" }`。仓库内 `node dist/cli.js ...` 直接可用；
  npm install -g / npx 分发留待发布时决定包名（见 §9）。
- vsce 打包自动把 dist/cli.js 带进 vsix（约 +50KB，无害；扩展本身不调用它）。

## 6. 边界规则改动（两处同步 + 故意违规验证）

CLI 属于 worker 树的消费者，必须与 worker 同等约束。按 AGENTS.md 约定，规则改动同步两个文件并用
"故意违规"验证真的会触发：

1. **eslint.config.mjs**：worker 树 vscode 禁令的 `files` 列表（当前为
   `['src/worker.ts', 'src/parser/**', 'src/demangle/**', 'src/analysis/**']`）增加 `'src/cli.ts'` 与 `'src/cliApp.ts'`。
2. **.dependency-cruiser.cjs** 三处：
   - `no-orphans` 的豁免列表增加 `src/cli.ts`（运行时入口，与 extension/worker/webview main 同列）；
   - 新增规则 `cli-no-webview`：`from ^src/(cli\.ts|cliApp\.ts)` → `to ^src/webview/` 禁止（CLI 不拖浏览器代码）；
   - 新增规则 `cli-no-host`：`to ^src/(extension\.ts|mapEditor\.ts|workerClient\.ts)` 禁止（宿主文件引入 vscode，
     间接污染 CLI）。
3. **验证**：临时在 cliApp.ts 写 `import 'vscode'` 跑 `npm run lint`（应红）、`import { } from './webview/model'`
   跑 `npm run check:coupling`（应红），确认后移除并重跑四项全绿。

## 7. 测试策略

`test/unit/cli.test.ts`（vitest，直测 `runCli`，不 spawn 进程）：

| 用例 | 断言 |
|---|---|
| summary 黄金基准 | rb-demo `flash===7648 && ram===6360`；zephyr `77256/16054`；gnuld-arm `4152/260`（fixture 路径以 `test/fixtures/real/README` 为准） |
| 其余 22 份 fixture | summary 全部不抛错、`format` 识别正确 |
| symbols 过滤/排序 | `--kind code --top 5` 返回 5 行且 size 降序；`--no-demangle` 时 `demangled===null` |
| treemap 属性 | 任意 fixture：Σ 同级 children size == 父 size == 对应 totals |
| diff | 现有 fixtures 两两组合：added/removed/changed 计数、`deltaFlash === totalsB.flash - totalsA.flash` |
| 错误路径 | notfound → code 3；构造 armlink 头部 → code 4 且消息含"未支持"；JS sourcemap → code 6；stderr 为合法 JSON |
| `--md` | 输出含表格行且与 JSON 数值一致（抽查） |

CI（`.github/workflows/ci.yml`）在 Unit tests 后增加一步 CLI smoke：

```yaml
- name: CLI smoke
  run: |
    node dist/cli.js --version
    node dist/cli.js summary test/fixtures/real/stm32f103-rb-demo-boot.map | node -e "
      let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        const j=JSON.parse(s); if(j.totals.flash!==7648||j.totals.ram!==6360)process.exit(1);});"
```

## 8. 落地清单

| 项 | 动作 |
|---|---|
| `src/cliApp.ts` | 新增：`runCli` + 四命令实现（~200 行） |
| `src/cli.ts` | 新增：进程入口（~15 行） |
| `build.mjs` | +第五 entry（shebang banner） |
| `package.json` | +`bin` 字段 |
| `eslint.config.mjs` / `.dependency-cruiser.cjs` | §6 规则 |
| `test/unit/cli.test.ts` | §7 用例 |
| `.github/workflows/ci.yml` | CLI smoke 步骤 |
| `docs/DESIGN.md` §11 | 加 M6 行（实现完成后） |
| `README.md` 文档表 / `AGENTS.md` 目录段 | 加 `docs/CLI.md` 条目（实现完成后） |

实现顺序：边界规则先行（红→绿验证）→ cliApp/cli → build/bin → 测试 → CI → 文档同步。四项门槛
（typecheck/lint/coupling/test）保持全绿后提交。

## 9. 开放问题

1. **npm 包名**：`mapvisual` 在 npm registry 可能已被占用；发布时再定（备选 `mapvisual-cli` 或 scoped 包），
   bin 名可保持 `mapvisual` 不变。
2. **stdin 支持**（`mapvisual summary -`）：构建系统直接管道喂 map 文本的场景有价值，M7 评估。
3. **MCP server**：`cliApp.runCli` 即工具面，届时用官方 SDK 包 stdio server，把四个命令映射为四个 tool；
   CLI 先行不为 MCP 增加任何返工。
4. **跨格式 diff**（gnu-ld vs lld 同工程）：`diffDocuments` 的分组键跨格式是否稳定待验证，验证前不承诺。

## 10. 实现偏差记录（2026-09-26 交付时）

1. **`tree` 顶层数组**（§4 原示例为单节点对象）：treemap 有多个顶层 section/kind，数组更贴合 jq 消费（`.tree[0]`）；内层节点附加 `count`（叶子符号数）。
2. **symbols 额外携带 `totals`**：AI 拿清单时通常同时需要上下文总量，附赠不影响行契约。
3. **symbols 默认折叠 `meta`**（§3 已注明）：rb-demo 有 125KB meta vs 7.6KB 实际内容，不折叠会淹没 AI 的上下文。
4. **usage 错误（退出码 2）stderr 为人类可读 + Usage 帮助**，非 JSON——JSON 仅限 MapParseError.kind（退出码 3–7）：用法错误的受众是人，且 Usage 文本本身就是 AI 最需要的纠错信息。
5. **版本号注入**：esbuild 会把 `import.meta` 替换成空对象（CJS 输出），`dist/cli.js` 里由 cli.ts 用 `createRequire(__filename)` 解析后经 `CliEnv.version` 注入；vitest（真 ESM）走 `import.meta.url` 回退。
6. **treemap 计入 fill/pad 行**（kept 非 meta 全量，与 realmap 的"kept 非 meta 平铺不变量"一致）——pad 真实占用空间，排除会让树与 totals 对不上。
