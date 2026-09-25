# MapVisual 设计文档

> 状态：设计定稿（v1.0，2026-09-25）；**MVP 已实现**（见文末「实现偏差记录」）。前置阅读：[RESEARCH.md](RESEARCH.md)（竞品调研）、[FORMATS.md](FORMATS.md)（格式规范）。
> 前作 imgui-gl3-glfw3-base 已验证 GNU ld 解析逻辑并沉淀 13 个 fixture + 17 组 demangle 用例；本项目把它升级为 VSCode 插件形态。

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
| F14 | 跳转源码：object 路径 → 源文件启发式匹配 | Could（M5） |
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
               | { type: 'revealSource', objectFile }   // M5
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

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 脚手架 | 工程、esbuild、vitest、CI、fixtures 就位 | `npm test` 绿；F5 起调通 |
| M1 GNU ld MVP | 检测/解析/尺寸分摊/demangle/列表排序过滤/汇总面板/快捷键 | 13 fixtures 全绿；真实 STM32 map 手验 |
| M2 Keil armlink | AC5/AC6/EIDE、Grand Totals、Image component sizes 聚合 | 真实 AC5+AC6 样例手验 |
| M3 体验打磨 | 分组、导出、watch、系统库过滤、状态栏、进度条、降级提示页 | 全部 Should 项落地 |
| M4 第二梯队格式 | IAR ilink（需样例采集）、LLVM lld | 各 ≥1 真实样例通过 |
| M5 进阶 | Map Diff、跳转源码、Treemap 视图 | Diff 支持 GNU/Keil 各一对 |

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
