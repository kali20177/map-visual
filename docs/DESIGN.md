# MapVisual 设计文档

## 1. 背景与定位

前作用 Dear ImGui 做桌面版 map 分析器，三个硬伤：UI 难看且交互差、C++ demangle 没接入界面、只支持 GNU ld 且部分实现有缺陷。竞品（Map View Embedded 等）同样缺 C++ 支持、只有 treemap 没有精确列表。

**MapVisual = 嵌入式开发者的 VSCode 内置 map 阅读器**：快捷键一键打开 `.map`，以可排序/过滤/分组的虚拟列表呈现每个符号的占用，开箱即用地还原 C++ 名称，自动消化编译选项（`-ffunction-sections`、LTO、`--gc-sections`、静态库）带来的所有格式变体，Flash/RAM 双口径汇总。

## 2. 目标与非目标

**目标**
- G1 快捷键（默认 `Alt+M`）秒开当前工程 map 文件；`.map` 双击直接以可视化视图打开
- G2 符号级列表：大小、符号名、所在段、来源对象/库、地址、类型；任意列排序
- G3 C++ 名称还原：内置 demangler 零配置可用；mangled 与 demangled 双向可搜索
- G4 编译选项自动化：两行式条目、LTO、gc-sections 桶、`*fill*`、归档成员、load address 双计入，用户零配置
- G5 多工具链：GNU ld（M1）→ Keil armlink（M2）→ IAR ilink / LLVM lld（M4）
- G6 汇总视图：Memory Configuration 区域占用条 + 分类占比 + Top 符号
- G7 顺眼快：跟随 VSCode 主题（亮/暗/高对比）、10 万行级符号流畅滚动

**非目标**
- 不做 ELF/DWARF 分析（puncover/bloaty 的领域，可与本插件互补）
- 不做链接脚本编辑、不做 map 生成（构建系统集成）
- 不脱离 VSCode（不做独立 app；核心解析器保持无 UI 依赖，未来可复用）

## 3. 用户旅程

```
编译固件 → 按 Alt+M
  ├─ 当前编辑器是 .map → 直接在当前 tab 以 MapVisual 视图打开
  └─ 否则 → QuickPick 列出工作区全部 .map（按修改时间倒序，最近常用置顶）→ 回车打开
map 重新编译（文件变更）→ 已打开的视图自动重新解析、保留当前排序/过滤/滚动位置
```

辅助入口：命令面板 `MapVisual: Open Map File`、Explorer 中 `.map` 右键、编辑器标题按钮。首次使用无 `.map` 时展示"如何在 GCC/Keil/IAR 中生成 map"的引导页。

## 4. 功能需求（MoSCoW）

| # | 需求 | 优先级 |
|---|---|---|
| F1 | 快捷键 + QuickPick + `.map` 自定义编辑器（readonly） | Must |
| F2 | 虚拟滚动符号列表（10 万行级），列见 §8.2 | Must |
| F3 | 表头点击排序（size ↓ 默认、size ↑、name、address、section、object），单列即可 | Must |
| F4 | demangle：默认开启；开关切换；tooltip 显示完整双形态；段名内嵌符号还原 | Must |
| F5 | 汇总面板：区域占用条（Flash/RAM/自定义 region）、kind 占比、Top 10 符号 | Must |
| F6 | 文本过滤：大小写不敏感子串，同时匹配 mangled 与 demangled；kind/section 过滤；大小阈值 | Must |
| F7 | 分组视图：按 Object / 按库 / 按源码目录 / 按 kind / 平铺；分组行可折叠并显示小计 | Should |
| F8 | watch 重建自动刷新；解析进度条（大文件 >100ms 时显示） | Should |
| F9 | "隐藏系统运行库"开关（crt*.o、libgcc、newlib/libc 路径特征，可配置） | Should |
| F10 | 导出 CSV / JSON；复制 mangled / demangled / 全行 | Should |
| F11 | `*fill*` 与 Discarded（gc-sections 裁剪项）单独桶可查看 | Should |
| F12 | 状态栏：当前打开 map 的 Flash/RAM 总量速览 | Could |
| F13 | Map Diff：两份 map 按符号对比增减（bloaty 式） | Could（M5） |
| F15 | Treemap 辅助视图 | Could |

## 5. 系统架构

### 5.1 组件图

```
┌─ VSCode Extension Host (Node.js, TypeScript, esbuild 打包) ──────────────────┐
│                                                                              │
│  extension.ts                                                                │
│    ├ MapEditorProvider (CustomReadonlyEditorProvider, *.map)                 │
│    ├ MapCommandService  (Alt+M / QuickPick / watch)                          │
│    └ MapDocumentService ──► ParseWorker (worker_threads)                     │
│          │                     │  FormatDetector → GnuLd/Armlink/Iar/Lld     │
│          │                     │  DemanglerService (WASM + 缓存)              │
│          │                     └  AnalysisEngine (分组聚合/区域归属/总量)      │
│          └ parseResult(JSON IR) ════ postMessage ════╗                       │
└──────────────────────────────────────────────────────╫───────────────────────┘
                                                       ▼
┌─ Webview (React + TanStack Virtual，跟随 VSCode 主题) ────────────────────────┐
│  SummaryPanel │ FilterBar │ VirtualTable(排序/分组/折叠) │ StatusFooter       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 关键决策（ADR 摘要）

| 决策 | 选择 | 理由 |
|---|---|---|
| 打开方式 | CustomReadonlyEditorProvider + 命令双轨 | 双击即开符合直觉；命令走 QuickPick 解决"工程里有多个 map"的场景。注意 `.map` 与 JS sourcemap 同名：自定义编辑器检测到内容为 JSON 对象时展示降级提示页（"这像 sourcemap，点此用文本打开"） |
| 解析位置 | 扩展宿主的 `worker_threads` | MB 级 map 逐行解析不能卡宿主；worker 只做纯计算，便于 vitest 直测 |
| 数据传输 | 解析完成后一次性 `postMessage` 精简 IR | 10 万符号 × ~120B ≈ 15MB，structured clone 一次到位；排序/过滤/分组留在 webview 本地做（10 万行 JS 排序 <100ms），避免每次交互跨进程往返 |
| demangle 位置 | 宿主 worker 内、解析时批量做（先去重再 demangle） | WASM 实例常驻宿主可复用；结果缓存 Map，重复解析同一文件零开销 |
| UI 栈 | React + TanStack Virtual，自研表格行 | 虚拟滚动是硬需求；不引重型表格库，行渲染自绘以保证主题一致与性能 |
| demangle 实现 | 内置 `gecko-profiler-demangle`（WASM）+ 可选外部 `c++filt` 系工具 | 见 §7 |

### 5.3 中间表示（IR，TypeScript）

```ts
interface MapDocument {
  format: 'gnu-ld' | 'armlink' | 'ilink' | 'lld';
  formatConfidence: number;
  regions: MemoryRegion[];          // Memory Configuration / Load+Execution Region
  contributions: Contribution[];    // 保真层：链接器原始输入段
  symbols: SymbolRecord[];          // 列表层：符号（由贡献+符号行推导）
  fillEntries: FillRecord[];        // *fill* / PAD
  discarded: SymbolRecord[];        // gc-sections 裁剪桶
  totals: RegionTotals;             // Flash/RAM/kind 汇总（GNU 读 L1 累计，Keil 读 Grand Totals）
  warnings: ParseWarning[];         // 无法识别的行采样、格式置信度低的提示
}

interface MemoryRegion { name: string; origin: bigint; length: bigint; attrs: string; }

interface Contribution {
  section: string;                  // ".text._Z3addii" / "i.main"
  vma: bigint; lma: bigint | null;  // lma 用于 .data 的 Flash 计入
  size: number; object: string;
  archive: string | null; member: string | null;   // libc.a(printf.o) 拆分
  kind: 'code' | 'rodata' | 'data' | 'bss' | 'meta' | 'pad' | 'other';
  status: 'kept' | 'discarded';
}

interface SymbolRecord {
  name: string;                     // 原文（可能已由 ld demangle）
  mangled: string | null;           // 从段名 `.text._Z3addii` 提取或原文为 mangled 时记录
  demangled: string | null;         // WASM demangle 结果（缓存后引用）
  displayName: string;              // 列表展示名（demangled 优先，回退 name）
  isDemangledFromSection: boolean;  // 名字来自段名还原（非符号行）
  addr: bigint; size: number;       // size 由 §FORMATS 1.4 算法分摊
  contribution: number;             // 指向 contributions 的下标
  storage: ('flash' | 'ram')[];     // 由 vma/lma 落在哪些 region 推导，.data 两处都占
}
```

`storage` 的推导规则：有 Memory Configuration / Execution Region 时按地址区间匹配（可配 region 角色：flash/ram/other）；无区域表时回退启发式（kind=data 且有 lma → flash+ram；kind=bss → ram；其余 → flash）。

### 5.4 消息协议（host ⇄ webview）

```
host → webview : { type: 'parseResult', doc } | { type: 'parseProgress', pct, stage }
               | { type: 'parseError', message, warnings } | { type: 'fileChanged' }
webview → host : { type: 'ready' } | { type: 'exportCsv', rows } | { type: 'copy', text }
               | { type: 'openExternal', url }          // 帮助页
```

一次性 `parseResult` 之后，排序/过滤/分组全部在 webview 内存完成，无往返。

## 6. 解析管线

1. **读取**：流式按行读（`readline`/大缓冲），不整文件入内存（修正 imgui 的 `raw_content` 双份内存问题）。
2. **检测**：首行 veto + 内容签名（FORMATS §5），置信度 <0.8 时在 `warnings` 中标注并允许 `mapvisual.formatOverride` 强制。
3. **逐行解析**：热点路径**不用正则逐行跑** —— 用手写字符扫描（找 `\t`/空格列边界 + `0x` 前缀判断）走 90% 的常规行，仅低频行回退到锚定正则；目标 10MB map ≤2s。
4. **demangle**：收集全部候选名（符号行原文 + 段名内嵌 `_Z...` 前缀提取），去重后批量调用 WASM，失败回退原文。
5. **尺寸分摊**：按 FORMATS §1.4（组键含贡献地址）；自检 `Σ symbols == contribution.size`，不等时记 warning 并保留贡献级尺寸兜底。
6. **聚合**：区域归属、kind 小计、Top 符号、`fill` 总量（"浪费空间"指标）、系统运行库标记。
7. **产出 IR** → postMessage。

错误恢复：单行解析失败只丢弃该行并记入 warnings（附行号与原文采样），绝不整体失败 —— map 文件来自十几种链接器版本，健壮性优先于严格性。

## 7. C++ demangle 设计

- **内置引擎**：`gecko-profiler-demangle`（Mozilla Firefox Profiler 同款，Rust→WASM，活跃维护，`demangle_any` 覆盖 C++ Itanium + Rust）。Node 侧 `WebAssembly.instantiate`，初始化失败（<0.1% 场景）优雅降级为"显示原文"。
- **外部引擎（可选）**：设置 `mapvisual.toolchain.cppfilt` 指向 `arm-none-eabi-c++filt`/`llvm-cxxfilt`，用于 WASM 未覆盖名字的兜底与"对照校验"（开发期用）；无工具链时完全不影响使用。
- **调用策略**：批量 + LRU 缓存（按文件维度）；`isMangled(name)` 快速判定（`_Z` 前缀 / `?` MSVC 前缀 / `__Z`），已 demangle 的符号行不再二次处理。
- **段名还原**（C++ 支持的主战场）：`(.text|\.rodata|\.data)\._Z([A-Za-z0-9_]+)` 提取内嵌符号 demangle；Keil AC5 `i.` / AC6 `.text.` 剥离后同样处理。
- **搜索归一**：过滤时对"mangled、demangled、displayName"三字段做大小写不敏感子串匹配，输入 `MyClass` 能命中 `_ZN7MyClass3getEv`。
- **测试向量**：直接移植前作 `test/mangling_test.cpp` 的 17 组用例（`_Z10addNumbersii`、`_ZN3foo3barERKNS_7MyClassE`、`_Z3fooIdET_S0_`、`_ZNK7MyClass3getEv`、`_ZplRK7MyClassS1_`、C1/D1 构造析构、`NS_`/`S0_`/`S1_` 替换、STL 模板、非法输入报错路径），另补前作缺失的形态：`_ZTV`（vtable）、`_ZTI/_ZTS`（typeinfo）、`_ZGV`（guard variable）、`_ZTh/_ZTv`（thunk）、lambda（`_ZZ...ENK...`）、右值引用/`noexcept`、变参模板、`operator new/delete`、COMDAT/weak 组符号 —— 这些在嵌入式 C++ 固件的 map 里高频出现。

## 8. UI 设计

### 8.1 布局线框

```
┌────────────────────────────────────────────────────────────────────────────┐
│ firmware.map  [GNU ld]  ↻   🔍 [ 过滤：输入即搜，双向匹配 ]   [C++] [☐系统库] │
├──────────────┬─────────────────────────────────────────────────────────────┤
│ 汇总面板      │  Size ▼ │ Symbol            │ Section      │ Object  │ Addr │
│              ├─────────────────────────────────────────────────────────────┤
│ FLASH  ▓▓▓░  │  0x1a4  │ MainWindow::onTick│ .text._ZN... │ main.o       │
│  42.1% 78.5K │  0x120  │ std::vector<...>  │ .text._ZNSt6 │ libstdc++.a  │
│ RAM    ▓░░░  │  0xf0   │ g_config          │ .bss.g_config│ config.o     │
│  18.9% 23.0K │  0xa0   │ *fill*(对齐填充)   │ —            │ [PAD]        │
│ ──────────   │  …（虚拟滚动，10 万行无压力）                                 │
│ code    45%  │                                                             │
│ rodata  25%  │  ▸ 按分组折叠行：main.o (12 symbols, 0x2f0)                  │
│ data    18%  │                                                             │
│ bss     10%  │                                                             │
│ pad      2%  │                                                             │
│ ──────────   │                                                             │
│ Top 符号跳转  │                                                             │
├──────────────┴─────────────────────────────────────────────────────────────┤
│ 3,412 symbols · Flash 178.3K/512K · RAM 23.0K/128K · 排序: Size ↓          │
└────────────────────────────────────────────────────────────────────────────┘
```

### 8.2 列定义

| 列 | 内容 | 排序 | 说明 |
|---|---|---|---|
| Size | 人类可读（`0x1a4`/`420 B`/`1.2 K`，悬浮显十六进制） | ✓ | 默认降序；PAD 行灰色 |
| Symbol | displayName；demangle 开启时显示还原名，mangled 作为次要灰字 | ✓ | 左侧 4px 色条 = kind 颜色 |
| Kind | code/rodata/data/bss/pad/meta 图标+色块 | ✓ | 主题色取自 VSCode token 色 |
| Section | 段名（monospace） | ✓ | 长名省略中间 |
| Object/Library | `main.o` 或 `libc.a › printf.o`；LTO 标注 | ✓ | 悬浮显完整路径 |
| Addr | VMA（`0x08001234`）；有 lma 差异时第二行显示 LMA | ✓ | |

### 8.3 交互与主题

- **主题**：全部颜色走 `--vscode-*` CSS 变量（编辑器背景/前景、列表 hover、badge），kind 色板为少量固定语义色并做亮暗两套校准；高对比模式只用色块+图标不用颜色传义。
- **tooltip**：完整 demangled、mangled、VMA/LMA、贡献原始大小、对象路径。
- **点击行为**：单击复制符号名（双形态切换由修饰键决定，可在设置改）；行右键菜单：复制 mangled / demangled / 导出选中 / 按此对象过滤。
- **分组**：分组行显示"名称 (N symbols, Σsize)"，可折叠；分组选择器：None / Object / Library / Directory / Kind。
- **性能预算**：首次渲染 ≤300ms；滚动 60fps（固定行高 24px + TanStack Virtual）；任意排序/过滤 ≤150ms @10 万行；demangle 5 万唯一名 ≤1s（WASM，批量）。
- 状态栏项：map 打开期间显示 `Flash 178.3K · RAM 23.0K`，点击跳回该视图。

## 9. 工程结构与打包

```
MapVisual/
├─ package.json          # engines: vscode ^1.85; main: dist/extension.js; 打包 esbuild
├─ src/
│  ├ extension.ts        # 激活、命令、keybinding、CustomReadonlyEditorProvider、watch
│  ├ document/           # MapDocumentService、QuickPick、降级提示页
│  ├ parser/
│  │  ├ detect.ts        # 格式检测（FORMATS §5）
│  │  ├ gnuld.ts armlink.ts iar.ts lld.ts   # 各格式状态机（纯函数，无 vscode 依赖）
│  │  └ types.ts         # IR 定义（§5.3）
│  ├ demangle/           # wasm 加载、缓存、外部 c++filt 通道
│  ├ analysis/           # 尺寸分摊、区域归属、聚合、系统库标记
│  └ webview/            # React app（Summary/Filter/Table/Status）+ 消息协议
├─ media/                # 样式、图标
├─ test/
│  ├ fixtures/gnuld-x86/ # ★ 已移植前作用例库（13 map + 编译命令 README）
│  ├ fixtures/embedded/  # M1 内补齐：arm-none-eabi 归档/ARM.exidx/load-address/no-demangle
│  ├ fixtures/armlink/   # M2：AC5/AC6/EIDE 真实样例（征集 + 合成）
│  └ unit/               # vitest：parser 纯函数、demangle 向量、尺寸算法属性测试
└─ docs/                 # 本文档群
```

打包：esbuild 单文件 bundle（`external: ['vscode']`，wasm 作为 asset 引入）；发布 `vsce package`。所有源码文件 LF 结尾。

## 10. 测试策略

1. **移植前作资产**（已完成 fixtures 复制）：
   - 13 个 GNU ld fixture → `test/fixtures/gnuld-x86/`，逐个 golden 断言（符号数、总尺寸、关键符号的 kind/size/addr、`.ltrans` 对象存在、TLS 多符号贡献分摊值）——对标前作 `map_parser_test.cpp` 的 21 个用例与 `export_map_json` 批量导出模式（改为 vitest snapshot）。
   - 17 组 demangle 向量 → `test/unit/demangle.test.ts`（§7 补充形态另加 ~15 组）。
2. **尺寸算法属性测试**：随机生成贡献/符号组合，断言 `Σ symbol.size == contribution.size` 且单符号组直接相等（针对前作分组键缺陷的回归防线）。
3. **健壮性 fuzz**：截断文件、随机删行、二进制注入、超长行 —— 解析不抛异常，warnings 可解释。
4. **新增 fixture（M1/M2 内完成）**：arm-none-eabi 归档成员、`.ARM.exidx`、`load address` 双计入、`--no-demangle`；Keil AC6 C++ 真实样例（含模板/命名空间/虚表符号）。
5. **解析器纯函数化**：`parser/*` 不 import vscode，vitest 直测；webview 的排序/过滤/分组逻辑同样纯函数化测试。

## 11. 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 脚手架 | 工程、esbuild、vitest、CI、fixtures 就位 | ✅ 2026-09-25 |
| M1 GNU ld MVP | 检测/解析/尺寸分摊/demangle/列表排序过滤/汇总面板/快捷键 | ✅ 2026-09-25（19 fixtures 全绿：x86 13 + arm 5 + lld 1，区域占用与 --print-memory-usage 一致） |
| M2 Keil armlink | AC5/AC6/EIDE、Grand Totals、Image component sizes 聚合 | 🔌 **接口已预留**（parser registry），待真实样例 |
| M3 体验打磨 | 分组、导出、watch、系统库过滤、状态栏、进度条、降级提示页、右键菜单 | ✅ 2026-09-25 |
| M4 第二梯队格式 | IAR ilink（需样例采集）、LLVM lld | ✅ lld（真实 23.1.2 产物验证）；🔌 IAR 接口已预留，待样例 |
| M5 进阶 | Map Diff、跳转源码、Treemap 视图 | ✅ 2026-09-25 |
| M6 CLI（AI / 脚本通道） | `mapvisual` 命令行：summary / symbols / treemap / diff 四命令、JSON/--md 输出、退出码对齐错误 kind、npm bin、CI smoke | ✅ 2026-09-26（设计契约见 docs/CLI.md；22 份 fixture 经 CLI 全量解析、3 份真实 map 断言 ELF 段级真值；IR 补 `outSection` 输出段名，经审核轮修复 treemap 口径/EPIPE/边界规则漏洞） |

**M2/M4 接口预留**：`src/parser/registry.ts` 暴露 `FormatParser` 接口（纯函数、无 vscode 依赖、未知行走 warnings、产出统一 IR）与 `registerParser(format, impl)`；`PLANNED_FORMATS` 为 armlink/ilink 保留用户可读的"已识别但未支持"提示。M2/M4 实现时只需新增解析器文件 + 一行注册 + 把格式移出 PLANNED_FORMATS，检测/管线/UI 全部无需改动。

## 12. 风险与开放问题

| 风险 | 对策 |
|---|---|
| IAR/lld 无样例、无现成解析器可参考 | M4 前向社区/用户征集样例；先交付"检测到疑似 lld/IAR"的明确提示而非误解析 |
| WASM demangler 覆盖不全（如极新 Itanium 扩展） | 外部 c++filt 兜底通道 + 失败回退原文；收集未命中样本迭代 |
| `.map` 与 JS sourcemap 的 custom editor 冲突 | JSON 嗅探降级页；keybinding/命令入口不受影响 |
| 超大 map（>50MB，LTO 大工程）性能 | worker 流式解析 + 手写字符扫描；超出预算时降级为"仅聚合视图"并提示 |
| Keil 格式版本差异（AC4/老版本 map） | 只承诺 AC5/AC6；未知行走 warnings 而非崩溃，鼓励用户提样例 |
| demangled 名含空格/特殊字符对排序与导出的影响 | displayName 单列存储，CSV 导出加引号转义 |

**开放问题**（实现期决定）：region 角色判定的默认表（flash/ram 地址段配置的用户体验）；分组目录层级取 object 路径的哪几级；QuickPick 是否常驻 MRU 列表上限。

## 13. 实现偏差记录（2026-09-25，MVP 交付时）

实现过程中基于实测做出的与上文不同的决策，均已验证：

1. **Webview 用 vanilla TypeScript + 自研虚拟列表**（原定 React + TanStack Virtual）：单一视图的应用引 React 收益有限，零运行时依赖让 bundle 缩到 21KB 且省去版本管理；纯逻辑（排序/过滤/分组/CSV）仍独立于 DOM 可单测。
2. **IR 扁平化**：`contributions + symbols` 两层结构简化为扁平 `SymbolRecord[]`，贡献级信息（section/object/lma）保留在行上；无符号行的贡献生成 `fromSectionName` 段级行，保证总量精确。webview 无需二次关联。
3. **lld 优先级提前**（用户要求 gcc/llvm 系优先）：lld 表格格式解析器与 GNU ld 同批交付，用合成 fixture + 官方格式验证；真实 lld fixture 生成脚本已备好（`test/fixtures/lld/build.sh`），待工具链安装后回填。
4. **实测新增的格式形态**（均已进解析器与用例库）：binutils relax 注释独立成行（`0x10 (size before relaxing)`，无地址列）；链接器生成内容的 object 列是自由文本（`.glue_7 ... linker stubs`）；`.bss` 输出段头也带 `load address`（区域占用计算必须按 storage 过滤，否则 bss 双计入 Flash）。
5. **demangle 引擎风格差异**：gecko-profiler-demangle 对模板省略返回类型、vtable 输出 `{vtable(T)}`（libiberty 为 `vtable for T`）、`_ZGV` 前缀未覆盖（已加前缀映射兜底 `guard variable for ...`）。测试向量以该引擎实际输出为准。
6. **真实 ARM fixture 落地**：`test/fixtures/gnuld-arm/` 由 arm-none-eabi-gcc 13.3 实际构建，区域占用与 ld `--print-memory-usage` 输出精确一致（FLASH 4152 B / RAM 260 B），作为区域归属算法的验收基准。
7. **审核轮（2026-09-25）新增格式形态与 fixtures**：`-fcommon` 构建的 COMMON 贡献行（` COMMON <vma> <size> <obj>`，段名无前导点，`*(COMMON)` 通配回显需跳过）已进 `CONTRIBUTION_RE` 并归 bss；新增 `firmware_common.map`（FLASH 44 / RAM 24）与 `firmware_cpp_sections.map`（FLASH 120 / RAM 4，`-ffunction-sections` C++，用于段名 mangled 回收）两个真实构建 fixture，黄金基准均为 `--print-memory-usage`。
8. **复审三轮几何修复（2026-09-26，REVIEW-26a5b23）**：① 贡献内无符号前缀字节（编译器 glue / literal pool，ld 不打印符号）输出 `*unsym*` 行（kind 同贡献段，`.data` 前缀因此保持 flash+RAM 双占），单符号 clamp 到贡献末尾，不变量改为 `Σ符号 size + prefixPad == contrib_size` 全分支成立（FORMATS §1.4）；② tiling 只对 alloc 段生效——`.ARM.attributes` 等非分配 meta 段的 VMA 列是文件内偏移累加，与段头 size 不构成地址空间，keep-all 静默是正确行为；alloc 段 tiling 失败一律告警并区分预算耗尽子集；③ 几何不变量（按 outSection 分组零重叠零空隙）进全语料测试 `test/unit/geometry.test.ts`（此前仅 rb-demo 一份有此断言）；④ auto 检测零行结果一律告警（截断 map 曾得 "0 B + 零告警 + exit 0"）；⑤ 区域角色锚点与命名冲突告警——firstCode 落在 RAM 名 region（或 firstBss 落在 FLASH 名 region）时提示 flash/ram 可能整体互换，`itcm` 双向不告警；⑥ 无 MEMORY 块的 map（Linux 用户态默认脚本，busybox 实测）`regions: []`：区域容量/占用率消失，退化口径为 code/rodata/pad 归 flash、bss 归 ram、data 双占，总量仍可用。**meta 段的已知口径（复审四轮 N4 登记）**：meta 豁免 tiling 后，"汇总贡献行 + 各分块贡献行"同时保留（ld 对 `.debug_str` 等 merge 段会先印一条整段汇总再逐对象印分块），二者描述同一批字节，`kindTotals.meta` 因此比 ELF 对应段真值偏高约 51%（rb-demo 132207→189325 vs ELF 124974；旧数字更接近真值但那是 tiling 误删 31 行真实贡献的巧合，不是去重）。meta 行 `storage==[]`，不进 flash/ram、不参与区域占用，影响面仅限列表行数与 meta 统计；若需收敛，先确认"汇总行 == 段 extent"的识别规则。
9. **分栏定位模式（2026-09-27）**：列表行点击从"复制符号名"改为"在原始 map 文本中定位该行"（复制全部移入行右键菜单，treemap 点击仍为复制）。支撑数据：`SymbolRecord` 新增可选 `line`（1-based 原始行号，gnuld/lld 解析器在消费行时记录；`*unsym*` 前缀垫行为解析器合成、无行号；discarded 两行式锚定符号名行）。host 侧 `showTextDocument`（异常关联回退 `openWith 'default'`）在 webview 侧栏按需打开纯文本分栏并 `preserveFocus`，`revealRange` + decoration 高亮行内符号名 span（行内找不到名字时退化为整行）；行号越界（文件重排后）回发 `rawLineMissing` 提示而非静默错位。工具栏 Raw 开关与 webview 重载（ready 重发）状态同步：手动关掉文本分栏由 tabGroups 监听回写 `splitChanged`。不变量进全语料测试：除 `*unsym*` 外所有行必有 `line`，且符号行命中的原始行真实包含该符号名；测试基线 184→189。复审收口（REVIEW-8f2c358，2026-09-27）：关闭分栏只关本功能绑定列的文本 tab（用户转移则跟随，自开的同文件 tab 不动）且尊重 `close()` 的取消返回，dirty 确认取消时按钮回显 on（N1）；打开文本栏成功即置位 splitOn 再做越界/内容校验（N2）；openRawEditor 兜底改为 openWith 后以 visibleTextEditors 复核，彻底失败弹错误提示不再静默（N3）；行内容不含该符号名时同样回 `rawLineMissing`（G4，语料审计 0 误报；顺带使 `rawLineMissing` 两个高频分支的 toast 文案都贴切，G1 无需再改）；decoration 与 tabs 监听纳入 subscriptions（G2）；"一行不被两个不同名字共享"补进语料不变量，测试基线 189→190。
10. **段级行的定位目标修正（2026-09-28，用户实测报告）**：在开启 `-ffunction-sections`/`-fdata-sections` 的真实工程里点击部分行回 `rawLineMissing`（"the map file may have changed since parsing"）。根因是 GNU ld **不给本地符号打符号行**：`static` 函数、匿名命名空间、LTO 内化后的函数，以及 libgcc 等预编译库的内部函数，在 map 里只剩「裸子段头 `.text.foo` + 贡献行」两行；这类贡献无符号行，解析器按设计输出 `fromSectionName` 段级行（见本条 §13.2），而 `line` 记的是贡献行——只印地址/尺寸/目标文件，不含段名。宿主 G4 守卫按"行内必须含该行的名字"判定，于是必然拒绝并提示文件已变。修法：`Contribution` 用 `sectionLine` 取代原 `line`（裸子段头行优先，无子段头时退回输出段头/`/DISCARD/` 头行），段级行改锚在印着段名的那一行；`pendingSection` 与 `pendingSectionLine` 经单一 setter 成对维护，避免行号脱离名字残留。**审计漏报的原因**：G4 当初的"语料审计 0 误报"与不变量测试都带 `!s.fromSectionName && !s.isFill` 豁免，而宿主判据并无此豁免——豁免即盲区。本次同步去掉该豁免（`*unsym*` 合成垫行仍无行号，由 webview 侧拦下），全语料 22 份 fixture 一行不落地校验通过；修前语料实测失败面：zephyr-nucleo 1531 行（占总行 31%）、stm32f103-rb-demo 84 行、gnuld-arm/firmware_basic 48 行。另加 pin 用例（`firmware_basic.map` 的 `.text.selfrel_offset31` → 行 57，且同段全局符号 `__aeabi_unwind_cpp_pr1` 仍指向自己的符号行 118），测试基线 190→191。
11. **交互补课（2026-09-29）**：行点击语义不再是"唯一答案"。`mapvisual.clickAction`（默认 `locate`）决定单击执行什么，**Alt+click 恒执行另一个动作**，**双击恒定位**——三者互不遮蔽，避免"改了默认值就有人的习惯动作失效"。实现要点：双击由独立的 `dblclick` 监听处理，单击监听用 `ev.detail > 1` 提前返回，从而不引入任何点击迟滞（分栏定位的"连续快速点行"是旗舰交互，250ms 迟滞判定会毁掉它）；`Enter` 走 `rowEl.click()`（合成 click 的 detail 为 0），因此跟随配置的动作而非强制定位。copy 动作复制**显示名**（与右键"Copy demangled"一致）。**搜索语法**：`model.parseFilterTerms` 把查询切成 include（AND）/exclude 两组，`-term` 排除、`"a b"` 引号保住带空格的短语（`linker stubs`、`My Project/build/x.o` 这类对象名/路径在语料里真实存在，不引号化会被拆成两个词而误判），未闭合引号吃到查询末尾；terms 每轮 `filterAndSort` 只解析一次后下传，避免 10 万符号 × 每符号分词。**列宽**用 fr 单位而非百分比：百分比轨道与 `gap: 12px` 相加会超出容器宽度（grid 的百分比按内容盒解析、gap 另计），fr 分配的是扣除 gap 后的自由空间，因此表格永远填满面板不出现横向溢出；拖动让相邻两列互相让渡（总和不变），`--mv-cols` 由表头与行共用，拖动时零重渲染。**持久化**用 `setState/getState`：webview 在面板隐藏时会被销毁、重新可见时重建（这正是 8f2c358 需要"ready 重发"的原因），因此过滤/排序/分组/kind 开关/折叠集合/视图/列宽一律存进宿主侧 webview state；`restoreUi`/`restoreCols` 对每个字段做白名单与类型校验，旧版本的 state 不会污染新代码。**`settings` 消息**与解析解耦：视图类偏好单独一条消息，`onDidChangeConfiguration` 只在 `demangle`/`formatOverride` 变化时才重解析（此前任何 `mapvisual.*` 变化都会白跑一次 MB 级解析）。**`Show only kind`** 走 kind facets 隔离而非文本过滤（文本 haystack 不含 kind 字段，且 facets 才是可见状态的真相）。其余为交互补课：命中高亮（`<mark>`，仅对 include 词）、匹配计数 chip（0 命中转警示色）、清除按钮、Escape 分级（先清查询再清选择）、Shift 范围选择（鼠标 + 键盘）、Ctrl/Cmd+A 全选可见、右键补"定位/按段过滤/只看某类型/排除对象"、分组维度补 `outSection`（CLI §10.7 早已登记该缺口）；`test/harness.html` 的 mock 补 `getState/setState` 与 `window.__mvMessages`（供自动化断言 webview 出站消息）。测试基线 191→199。
12. **视图状态持久化：两层存储与"回来即原样"（2026-09-29）**：webview 在面板隐藏时被销毁、重新可见时重建，因此**过滤/排序/分组/折叠集合/kind 开关/视图/treemap 钻取层级/列宽/滚动位置/多选**全部要落盘才算不丢。① **两层存储**：`setState`（webview 自身，同会话、随重建回放）与宿主 `workspaceState` 按文件一份（跨关闭文件与重启 VS Code）；两者共用同一个 blob，宿主副本在 `ready` 时先于文档回放，缺失（该文件没存过）则保留 webview 自身那份。blob 带 `v` 版本号，版本不符只丢 `ui/collapsed/...` 而保留 `splitOn`（宿主自有字段，与 webview schema 无关）。② **存储模块** `src/viewState.ts` 属宿主层但**刻意不 import vscode**（结构化 `KeyValueStore` 接口 + 注入 `flushDelayMs`）→ vitest 直测；写入节流 600ms（webview 每次重渲染都推新状态，而 `Memento.update` 会落盘），面板关闭与扩展停用时强制 flush；每文件一条、超 50 条按 LRU 淘汰；读回时逐字段校验，坏数据整条丢弃。③ **类型搬迁**：`SortKey`/`GroupBy`/`UiState` 从 `webview/model.ts` 移到 `types.ts`——宿主也要 round-trip 这个 blob，而 depcruise 禁止宿主 import `src/webview/`；model.ts 保留 re-export 供既有 import 点使用。④ **恢复语义**：滚动位置与多选带指纹（`symbolCount`），文档符号数不符时不恢复选中（重建后的行号会指到别的行，宁可清空）；treemap 钻取层级一并恢复；`splitOn` 单独存，重新打开该文件时**静默**重开文本分栏（失败不弹错——用户当下并未要求它，此路径 `openRawEditor(uri, quiet)`）。列表滚动位置单独记，切到 treemap 再切回不被清零。⑤ **切 tab 不再重解析**：`ready` 时若面板已持有文档就直接回放（此前每次 webview 重建都会重解析一份 MB 级 map，这是切走再切回最贵的一步）；为此给解析加了在途守卫，但**区分两类请求**——重复的首解析请求直接丢弃，而 watch 触发的重建改为"尾随重跑"（`trailingParse`，当前这轮结束后再跑一次），否则发布构建的刷新会被静默吞掉。⑥ 刻意**未开** `retainContextWhenHidden`：虚拟列表 DOM 很小，但保留 webview 会额外常驻一份 MapDocument（10 万符号 ≈ 15MB），而宿主 `PanelState` 本就持有一份；"缓存文档 + 状态恢复"达到同样效果且不吃这份内存。⑦ **验证边界**：webview 侧全部经 harness 实测（清掉 `setState` 只留宿主副本 = 模拟新会话，过滤/排序/分组/列宽/滚动 300px/两行多选/treemap 钻取层级全部回填）；`splitOn` 恢复与文档复用属宿主路径，harness 覆盖不到，仅代码审查 + 真实宿主手工验证。`host-must-use-worker` 规则的 from 名单补 `viewState.ts` 并做了故意违规复测。测试基线 199→207（新增 `test/unit/viewState.test.ts`）。**复审收口（REVIEW-f3f2b94，2026-09-29）**：① **N1 切 treemap 会冲掉列表滚动位置**——`renderTreemap` 把 spacer 压到视口高，浏览器随即把 `scrollTop` 夹到 0 并**为此派发 scroll 事件**，而监听无条件当成用户滚动（既回写 `listScrollTop`/`persist()`，又按 `visible` 把列表行画进 treemap 一帧）。修法：scroll 监听在 `state.view !== 'list'` 时直接返回；切回列表时用 `pendingScroll` 把记得的位置写回（`renderRows` 尾部已有该机制）。实测：treemap 期间 page 被夹到 0 而持久化保持 500、`.mv-datarow` 为 0，切回还原 500。② **N2 选中集合会悄悄挪到别的符号**——`selected` 存的是 `visible` 下标，此前靠"每个控件记得 `clearSelection()`"，摘要栏 kind 开关、分组折叠、C++ 开关三条路径就漏掉了（kind 与折叠甚至未被上一版触碰，属既有缺陷）。改为**结构性保证**：`model.rowSetSignature(ui, collapsed, docEpoch)` 在每轮 `renderRows` 比对，凡改变行集/行序的变更一律作废选中；签名**从对象自身取键并递归排序后序列化**，因此新增 `UiState` 字段自动纳入（不会重演"漏一条路径"），单测逐字段遍历断言其敏感性。随之删掉 9 处冗余 `clearSelection()`，只保留"行集本身不变"语义的三处（Escape / Ctrl+A / 回放 blob）。实测三条路径均清零，且切 treemap 往返**不会**误清（行集未变）。③ **N3 文档到达前的早写覆盖宿主副本**——`renderAll()` 无条件 `persist()`，而 `ResizeObserver` 首次回调会在 parseResult 之前渲染一轮，实测有 2 条 `symbolCount:0`、`selected:[]` 的 `persistView` 先覆盖宿主条目；正常路径自愈，但 webview 若在文档到达前消失（解析失败、大 map 解析途中切走 tab）就永久丢失多选。修法：`state.doc` 为空时 `persist()` 直接返回（此时屏幕上没有值得记住的内容）。实测首个 blob `symbolCount` 即为 172、零个零符号 blob。④ **N4 计数 chip 口径**——列表视图数的是"画出来的行"（折叠掉的组不算）而 treemap 数的是过滤命中数，同一查询两个视图给出不同数字，且全折叠时显示橙字 "no matches"（语义反了）。改为对 `buildView` 的 items 摊平计数（含被折叠组），与 treemap 同口径；实测全折叠时仍显示命中数且无警示色。⑤ **G1**：`SORT_KEYS`/`GROUP_KEYS` 上收 `types.ts` 作唯一真源、类型由 `as const` 派生（原先是手抄副本，加维度漏改会静默回退默认值）。**G2**：`setSplit` 同值/无条目时提前返回且不再 `touch`（此前已建条目、已改 `ts` 却不 `scheduleFlush`，留下永不落盘的内存条目）。**G4**（防御性，语料 6788 行零命中）：`section` 为空的行不再提供 "Filter by section" 菜单项，否则退化为清空过滤。**G3（固有取舍，登记备查）**：同一文件在两个编辑组各开一个面板时共用一份 blob，后写者赢、"按文件持久化"不区分面板——够用且简单，若日后要按面板区分需把 key 扩成 `uri#column`。测试基线 207→210。**复审二轮（REVIEW-3bf3a13，2026-09-29）**：① **R1 `docEpoch` 从不自增**——字段只有声明、初始化、读取三处，签名第三项恒为常量 `0`，等于没起作用；而上一版 `parseResult` 分支里兜底的 `clearSelection()` 已被本次删除，于是"文档被替换"这条行集变化路径**不再作废选中**（watch 重建、改 `demangle`/`formatOverride` 触发 reparse 都会命中，后者尤其致命：带回 demangled 名字后按名称排序行序整体变化，下标必然移位，高亮与 CSV 导出落到别的符号上）。这正是"结构性保证"自身漏掉的输入——签名里唯一不在 `UiState` 里的那一项。修法：新增 `setDocument(doc)` 把"赋文档 + 纪元自增"绑成**单一操作**（`state.doc` 全仓只有这一个赋值点），`parseResult` 改走它，今后再加赋值路径也走同门。实测：投递"少 3 个最大符号"的新文档 → 选中 4 行→0、持久化清空。**教训（写进来因为它是可复用的判据）：门禁全绿不等于路径被覆盖**——`docEpoch` 是接口字段，`noUnusedLocals`/ESLint 都不会对"声明未自增"出声，只有对照实验（投递新文档看选中是否作废）能抓到。② **R2 anchor 未纳入校验**——签名检查以 `state.selected.size > 0` 短路，`anchor` 不在其中：Ctrl 点掉唯一选中行后 anchor 残留，行集变化后 Shift 选择从陈旧 anchor 起算（实测本该 1 行却选中 8 行）。修法：条件放宽为 `selected.size > 0 || anchor !== null`，重置时一并清 anchor。③ G4 的对称性补齐：`Filter by object` 同样加空值守卫（`object`/`section` 在 22 份语料 6788 行里均零空值，两条都属防御性）。④ G3（顺序依赖）：在 `renderRows` 注明"签名赋值发生在 `pendingSelection` 应用之后"——恢复的多选正是靠这个先后关系才不被守护它的那次检查误清。**复审三轮（REVIEW-e082cb8，2026-10-01，第一次在区间合入 main 后收口）**：① **N1 treemap 下页脚符号数失真**——`renderFooter` 数的是 `visible.filter((v) => v.row).length`，而 `visible` 只有列表视图的 `renderRows` 会填（treemap 走 `renderTreemap`，只画瓦片、完全不碰 `visible`）。于是页脚在 treemap 里冻结在"最后一次列表渲染"的数字（实测：treemap 里过滤 `.text`，chip 已变 `69 matches` 而页脚仍是 `73 / 87`）；本版起 `view` 进 blob 后更明显——**"上次停在 treemap"的文件重开时直接以 treemap 渲染，`visible` 还是空数组，页脚显示 `0 / 87`**，切回列表才自愈。修法：新增模块级 `shownRows`，由两个视图各自维护"当前屏上的行数"（列表 = 未被折叠的行，treemap = 全部命中行，该视图没有折叠），`renderFooter` 只读它；口径与上一轮 N4 的 chip 同源（treemap 下两者必然相等，列表下前者少掉被折叠组，仍是"shown / total"的原意）。实测：treemap + `.text` → 页脚 `69 / 87`；恢复进 treemap → 页脚 `69 / 87`、7 个块、chip `69 matches` 三者一致。② **N2 键盘范围选择不落盘**——Shift+↑/↓ 走 `extendSelectionTo` + `focusRow`，而 `focusRow` 内部只有 `renderWindow()`，选中因此进了内存却没进宿主副本（鼠标的 Shift+单击与 Ctrl+单击都经 `renderSelection()` 立刻落盘）。修法：在 `focusRow` 之后补一次裸 `persist()`——不能用 `renderSelection()`，它会在 `focusRow` 已把焦点移到新行**之后**重绘 `rowsEl`，等于把刚设好的焦点丢掉。实测：连按两次 Shift+↓ → DOM 两行高亮且 `persistView` 由 10 条增至 12 条（末条 `selected [0,1]`；修前计数不变）。③ **G2 harness 补 `--vscode-list-inactiveSelectionBackground`**：harness 的 mock 变量表此前缺这一项，`.mv-row.mv-selected` 的底色在 harness 里恒为空 → **"选中行高亮"在 harness 截图里永远看不见**（本轮视觉验证据此报了一条假阳性，与本条 ② 的验证手段正好相关）。补暗色值 `#37373d` 后实测选中行 `background-color: rgb(55, 55, 61)`。④ **G3 补 `Exclude object` 的空值守卫**（与 `Filter by object` / `Filter by section` 对称）：空值时它只会在查询里留一个被分词器丢弃的裸 `-`，无实害，属一致性收口。测试基线维持 210（四处改动全在 DOM 层与静态 harness，无单测可挂）。
13. **界面本地化：四条通道，英文原文即 key（2026-10-02，用户实测报告）**：显示语言为中文（已装中文语言包）时，插件的命令面板、编辑器标题栏按钮、设置页、webview 工具条/侧栏/表头/行右键菜单/toast 仍全是英文。根因不是"漏翻了几条"，而是四条文案通道**都没接** VS Code 的本地化机制——语言包只翻译 VS Code 自身 UI，不碰扩展文案：① 清单 `contributes` 是字面量（未用 `%key%`）；② 宿主 `show*Message` / 进度标题是模板串（未用 `vscode.l10n.t`）；③ webview 文案内联（沙箱拿不到 vscode API）；④ 解析器把警告与进度阶段当**英文数据**流过 protocol（worker 树禁 import vscode，且 CLI 的英文输出是脚本契约）。约 127 条 key，逐条如下分通道处理。
  ① **清单**：`package.nls.json` + `package.nls.zh-cn.json`，清单里写 `%key%`，并声明 `"l10n": "./l10n"`——缺这个字段时 `vscode.l10n.bundle` 恒为 `undefined`，webview 会整片回落英文，症状很像"改动没生效"。`%key%` 的可覆盖范围以本机已装扩展实证而非文档：`customEditors.displayName`（hexeditor 用 `"%name%"`）、`configuration.description` 与 `enumDescriptions[]`（remote-containers）均支持；`menus` 只写 command id，不含文案，无需处理。
  ② **宿主**：调用点直接 `vscode.l10n.t('英文原文', args)`，英文原文既是 key 也是默认文案。
  ③ **webview**：bundle 由宿主在 `getHtml` 时**内联**为 `<script type="application/json" id="mv-l10n">`，而不是走 `postMessage` 握手——webview 的骨架 DOM 在模块顶层就写好了，消息到达只会更晚，握手会先画一帧英文。读取端 `src/webview/i18n.ts` 只导出 `makeT(bundle)` 纯函数（含 `{0}` 插值）与 `tr` 单例；`document` 不存在（vitest 的 node 环境）或元素缺失都返回空 bundle，正好使 `model.ts` 这类纯逻辑模块可以被单测直接引用。CSP（`default-src 'none'; script-src 'nonce-…'`）是否拦这类数据块是本方案唯一的未知项，先做了探针页（同款 CSP + 同款标签 + 一个带 nonce 的脚本读它）实测得 `CSP-OK` 才落地。
  ④ **"英文原文即 key"是支点**：`tr` 的回落、key 的抽取、译文的校对全由它免费得到。代价是 key 必须逐字节一致（破折号、省略号、尾随空格差一个字符就静默失效）——VS Code 对缺失 key 一律静默回落英文，漏翻只有人肉用中文界面才发现，因此**覆盖测试是必需品而非锦上添花**（见验证部分）。
  ⑤ **warnings 结构化**：`region "OCRAM" holds executable content…` 这类含动态内容的告警无法整串匹配翻译。`ParseWarning` 增加 `code` + `params`，英文 `message` 仍由 `WARNING_TEMPLATES[code]` 现算——**模板表放 `types.ts`**，worker 树与 webview 都能 import，中英两侧同一真源、不会各自漂移。英文 `message` 逐字保持原样：它是 CLI 的 JSON/Markdown 契约，现有测试里有 6 处直接断言它。`tiling search failed…` 原先靠 `msg += '; visit budget exhausted…'` 拼接，改为 `tilingSearchFailed` / `tilingSearchFailedWithBudget` 两个 code（各自是完整句子），中文才能自由重排语序。
  ⑥ **进度阶段收紧**：`PROGRESS_STAGES` 从 `string` 收紧为字面量 union，宿主 `STAGE_LABELS: Record<ProgressStage, string>` 因此漏一个阶段就 typecheck 失败。收紧当场暴露了 diff 作业里的自由串拼接（`reading ${path}`、`A: ${stage}`）——改为结构化 `side` / `detail` 字段，`stage` 保持固定标识符（CLI 打印的就是它），显示文案由 `hostI18n.progressText` 组合，中文下得到 `A: 检测格式…`。CLI 输出与其断言不变。
  ⑦ **不翻的**：`MapVisual`/`C++`/`CSV`/`LTO`、`Flash`/`RAM`、单位 `B/K/M`、kind 值（`code`/`data`/`bss`… 它们是 CSS class 与筛选语法的语义代号）、mangled/demangled（中文语境里直接说原词），以及符号名/段名/目标文件名等数据本体。命令 `category` 保持品牌名：命令面板默认显示 `title` 原文，实测 workbench bundle 里 `category` 前缀只在 `commandPalette.showCommandGroups` 打开时才拼，因此现在的 `MapVisual: 打开 Map 文件` 不会与 category 重复。
  ⑧ **不做**：CLI 保持英文（脚本通道，英文 warnings 是契约的一部分，`--progress` 原样打印 stage 标识符）；Marketplace 网页端详情页（`package.nls` 不作用于网页端，需另一套机制）；其它语言（目录结构留好，本次只出 `zh-cn`）。
  **验证**（四项门禁之外）：① `test/unit/i18n.test.ts` 用 TS AST 扫 `src/**` 的 `tr('…')` 与 `vscode.l10n.t('…')` 字面量，加上 `WARNING_TEMPLATES`/`COLUMN_LABELS`/`STATUS_LABELS`/`STAGE_LABELS` 四个间接表的值，与 bundle 做**双向**比对（缺译文、僵尸 key 都失败），另断言占位符集合一致、译文不引入源串没有的 HTML 敏感字符（译文会插进 HTML 模板，配 `escapeHtml`/`escapeAttr` 双保险）。② harness 加 `?zh`：同步 XHR 读语言包后按宿主同样的形态注入 JSON 块（同步是必须的——异步 fetch 会晚于首帧），Chrome headless 截图 + 视觉复核：工具条（`C++`/`系统`/`已移除`/`树图`/`原文`/`CSV`）、侧栏（`内存`/`构成`/`最大的符号`）、表头（`大小`/`符号`/`类型`/`段`/`目标文件 / 库`/`地址`）、页脚（`73 / 87 个符号 · Flash 4.05 K · gc 移除 85 · 填充 2 B · 排序：大小降序`）、diff 页（`变更`/`新增`/`移除`/`相同`）全部中文且无截断/重叠；英文版逐条对照确认行为未变——唯一差异是页脚排序读出从 `sort: size desc` 变成 `sort: Size descending`（复用列头文案，与表头同源）。③ CSP 探针实测。④ `vsce package` 实测 `l10n/` 与 `package.nls*.json` 进包（`.vscodeignore` 是排除制，测试里另加一条断言防止将来被 ignore 掉——漏打包就是"本地好用、装上失效"）。测试基线 210→222。
14. **行选择语义改为"单击选中 + 拖拽多选"，clickAction 设置下线（2026-10-02，用户实测反馈）**：第 11 条引入的 `mapvisual.clickAction`（默认 `locate`）让"单击"这个最基础的手势带副作用，而用户实测的习惯是点着看——单击即定位会不停开分栏，改成 `copy` 又会快速占满剪贴板。改按文件列表的方式：① **单击 = 选中该行**：`mousedown` 时清空旧选择并选中按下的行，`mouseup` 落盘一次；② **按住拖过多行 = 选中这一段**：拖到视口上下边缘外自动滚动继续扩展（每帧 14px，距边缘 24px 内触发）；拖拽期间只重绘不落盘，松手写一次（实测三个手势共 3 条 `persistView`）；③ 拖拽范围**重算而非累加**（`selectRangeBetween`）——往回拖要能收缩，而 Shift 用的 `extendSelectionTo` 只增不减，两者语义不同故并存；④ 边缘外的指针位置**夹到当前可见的首/末行**再映射行号，否则指针一出框选择就瞬间跳到列表末尾，而不是随滚动逐步推进（实测：按住拖到框外再滚到 `scrollTop=500`，存储的选择是 5..50 共 46 行，而 DOM 里只有窗口内的 10..50——虚拟列表下断言必须读持久化载荷，不能读 `.mv-selected`）；⑤ 键盘补一条：焦点在行上按 `Enter`（合成 click 的 `detail === 0`）等同双击定位；⑥ `Alt+单击` 仍是定位，选择只在无修饰键的按下时发生。**`mapvisual.clickAction` 设置连同 `settings` 消息一并删除**（宿主的 `readClickAction`、`onDidChangeConfiguration` 分支、webview 的 clickAction 状态、`ClickAction` 类型、package.nls 三条译文）：单击语义不再可配。复制仍走行右键菜单（三个复制项原样）——"点着看"因此不再有任何副作用。`.mv-row` 补 `user-select: none`，否则拖拽会先选中文本。验证：合成鼠标事件的 harness 自测（单击 1 行；拖 5..12 得 8 行；回拖收缩为 8..12；Ctrl+单击追加一行；Alt+单击不改选择且发 `revealRawLine`；普通单击零额外消息）+ headless 真实渲染；测试基线维持 222（DOM 交互无单测可挂）。**随之修掉的回归（用户实测）**：行右键菜单原先靠 `document` 的 `click` 关闭，而新的按下处理会在 mousedown 里重绘行列表——被替换掉的那个 mousedown 目标不再产生 click，`closeMenu` 于是从不执行，菜单一直悬浮。改为**按任何 mousedown 关闭**（菜单自身 `stopPropagation`，否则菜单项点不中），这本来也更贴合"按下即收起"的直觉；顺带在列表滚动时关闭（菜单锚在屏幕坐标上，滚动后指向错误的行）。自测覆盖六态：右键开、按行关、按列表外关、按菜单内存活、点菜单项执行动作并关闭、滚动关闭（最后一项 headless 不派发真实 scroll 事件，用合成事件验证处理器）。**多选菜单与单选菜单分开（用户实测反馈）**：原先无论选中几行，菜单都按"右键那一行"生成（只有导出一条用了选中数），选中 5 行时弹出来的仍是一整屏单行操作，读起来像是覆盖整个选择、实际只作用于指针下的那一行。改为：① 右键的行**不在**选中集合内时，先把选择重设为该行（文件列表惯例——菜单因此永远描述它将要作用的对象）；② 选中 > 1 行时改用选择菜单：复制 N 个 demangled/mangled 名、复制 N 整行（换行分隔）、导出 N 行为 CSV、取消选择；单行专属的定位 / 按此对象过滤 / 只看此类型 / 跳转源码**一律不出现**（它们只描述一个符号，留着就是同一个歧义）。多选复制用独立的 `Copied {0} rows` 回报行数，而不是回显被截断的文本。自测实测：拖选 3 行后右键得 5 项选择菜单、复制载荷 3 行、导出 3 行、取消选择归零；右键选择外的行则重设为单选并弹回 10 项单行菜单。

15. **列布局：地址列提前 + minmax 像素地板 + 表头右键恢复默认（2026-10-02，用户两轮实测反馈）**：用户反馈 Size 列"过宽"，且要把最后一列地址提到第一列。① **列序**调整为 地址｜大小｜符号｜类型｜段｜目标文件（`COLUMN_ORDER`、行模板、`DEFAULT_COLS` 三处同序）。地址是定宽十六进制（`0x` + 8/16 hex），作首列若保留右对齐，行首会留约 50px 空洞——正是用户抱怨的形态——因此 `.mv-td-addr` 改左对齐，定宽内容贴行首、纵向对齐不受影响（等宽）。② 纯 fr 的固有矛盾：比例列在宽窗口放大定宽内容、在窄窗口截断它（旧默认 6.8fr 在 1880px 下给 Size 105px，内容上限 `formatBytes` 7 字符 ≈ 50px；而地址列 7.7fr 早在 1206px 视口以下就开始截 "0x08000cac"）。改 `applyCols` 输出 **`minmax(地板px, Nfr)` 轨道**（`COL_MIN_PX`：地址 78 / 大小 52 / 类型 44 / 弹性列 40），窄面板先压符号/段/目标文件，定宽数据不再截断——Size 才敢收到 3.8fr（1880px 下 59px，旧 105px）。拖拽守卫同步改逐列地板（原统一 `MIN_COL_PX=40`），并给表头 mousedown 补 `button !== 0` 守卫（右键留给菜单，不再误启动拖拽）。新默认 `[7.2, 3.8, 37, 4.6, 23.5, 23.4]`（fr 只取相对比例、和 99.5，1880px 下 地址 111 / 大小 59 / 符号 574 / 类型 71）。③ **v1→v2**：列序变化使旧 blob 的 `cols` 数组按新序误读（拖过的布局错位而非崩溃），新旧序无法按形状区分，升版本整体丢弃（该文件的过滤/滚动/多选一次性重置，符合 `v` 字段"宁丢不误读"的注释语义）；曾在同日早间用过"落盘值等于旧默认数组即视为未定制"的宽度迁移（未提交），列序重排让它失去意义，已删——恢复默认的职责交给 ④。④ **表头右键 → "Reset column widths"（恢复默认列宽）**：复用行菜单的 `openMenu`，动作 `resetCols`（重置 + applyCols + persist）；范围刻意只含列宽——排序/分组/过滤是分析偏好，"布局"入口清掉它们会出乎意料。CSV 列序是 model.ts 的数据契约，不随表列序变；分组行是 flex，不依赖列位。验证：harness 实测新列序渲染、右键菜单重置回默认（拖宽地址列 → 菜单 → 回 7.2fr）、拖过的 v2 blob 重载原样保留、v1 blob 整体丢弃回新默认；四项门禁外 headless 截图（1880 中英 + 1300 中文窄窗）视觉复核。测试基线维持 224。

16. **「跳转到源码」整体下线（2026-10-02，用户实测反馈）**：行右键菜单的 Go to source 自 M5 起"实际用下来是坏的"，根因是能力边界而非缺陷：map 只记录目标文件（.o/.obj），从不记录源文件路径，宿主侧只能把 basename 生成 `**/main.cpp.{c,cpp,…}` glob 在**当前打开的工作区**里 `findFiles`（sourceMatch.ts 头注释自认 "searched in the workspace only"）。单开一份 .map（本插件的主场景）没有工作区，搜索范围恒为空，永远弹 "no source file found"；工作区开着但没有对应源码树同样失败；即便命中也只是按文件名猜（多目录同名还可能开错）；段级行 / linker stub 没有对象文件，菜单项却照常出现，点了只弹 "nothing to look for"。这与产品「零配置、map 自足」的定位相悖——右键菜单其余动作（复制 / 筛选 / 回原 map 定位）全部不依赖 map 之外的信息，唯独它是常驻却几乎永不命中的空承诺。按用户拍板整体下线：webview 菜单项、`revealSource` 协议消息、宿主 `revealSource()`、`src/sourceMatch.ts` 及其 7 项单测、l10n 三条译文（i18n 双向比对守卫同步通过）一并删除；DESIGN 特性表删 F14，M5 里程碑行保留（记录当时的交付事实）。曾评估过"不依赖工作区"的改进版（绝对对象路径剥后缀直接打开、相对路径从 map 所在目录逐级向上试探），仍是启发式且命中率取决于构建系统留下的对象路径形式，不值得为其保留一条常驻菜单项。测试基线 224 → 217。
