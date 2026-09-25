# MapVisual 竞品调研报告

> 调研时间：2026-09-25。方法：本地源码分析（Map-View、imgui-gl3-glfw3-base）+ Web 检索（npm / GitHub / VSCode Marketplace）。
> 结论先行：**"快捷键秒开 + 可排序/过滤/分组的列表视图 + 开箱即用的 C++ demangle + 多工具链格式" 这个组合在现有工具中是空白**，MapVisual 以此为定位。

## 1. 工具总览

| 工具 | 形态 | 支持格式 | C++ demangle | 列表/排序 | 可视化 | 备注 |
|---|---|---|---|---|---|---|
| Map View Embedded ([charcoal141/Map-View](https://github.com/charcoal141/Map-View)) | VSCode 插件（纯 TS，零运行时依赖） | Keil AC5/AC6、EIDE 变体、GNU ld（ESP-IDF/通用） | **无** | 无排序，搜索只高亮可见节点 | Treemap 热力图 | 与 MapVisual 最直接的竞品，本地已克隆分析 |
| [linkermapviz](https://github.com/linkermapviz/linkermapviz) | 独立工具，生成 HTML | GNU ld | 无（透传 map 内文本） | 无 | Treemap | 单一格式，产出静态页面 |
| [Emma / pypiemma](https://github.com/holzkohlengrill/Emma) | Python CLI | 多种 map（号称 arbitrary） | 无 | CSV 导出后自行处理 | 无 UI（CSV 报表） | 思路好：map → 结构化数据 → 后处理 |
| [puncover](https://github.com/HBehrens/puncover) | Python/Flask Web | **不解析 map，解析 ELF+DWARF** | 有（基于符号表） | 有 | Web 表格 + 调用图 | 需要 ELF 带 debug info；与 map 解析互补 |
| [bloaty](https://github.com/google/bloaty) | C++ CLI | ELF/Mach-O/PE | 有 | 有（多维度） | 终端表格 | 业界标杆，但同样基于二进制而非 map |
| [jetperch/memviewer](https://github.com/jetperch/memviewer) | Python GUI | map + ELF | 部分 | 有限 | 树/表格 | 小众 |
| [map_file_analyzer](https://github.com/yahyatawil/map_file_analyzer) | Python 脚本 | GNU ld | 无 | 无 | 无 | grep 式脚本 |
| Keil/IAR/STM32CubeIDE 内置 | IDE 文本视图 | 自家格式 | 部分（IAR 显示原始名） | 无 | 无 | 只是让 map 可读，无分析 |

Marketplace 检索另见少量小众插件（如 Atari XEX Memory Analyzer），无以列表为核心的通用 map 分析器。

## 2. 重点样本分析

### 2.1 Map View Embedded（主要参照对象，本地源码分析）

**架构**：`extension.ts`（命令+读文件）→ `parser/`（格式分发 + Keil/GNU 两个解析器）→ `transformer/treeBuilder.ts`（建树 + ROM/RAM 汇总）→ WebviewPanel 注入 `window.__DATA__`，纯 DOM 渲染 treemap。一次性数据流，webview 只回传一条 `configMemory` 消息。

**值得借鉴**：
- 格式检测启发式（`src/parser/index.ts:270-284`）：首行含 `Arm Compiler`/`Component:` → Keil；头部含 `Archive member included` 或 `^LOAD ` 或同时含 `Memory Configuration` + `Linker script and memory map` → GNU ld。便宜可靠，可扩展。
- Keil 行状态机（`src/parser/index.ts:79-95`）：按小节标题（`Section Cross References` → `Removing Unused input sections` → `Image Symbol Table` → `Memory Map of the image` → `Image component sizes`）转移状态；"Removing" 小节进入无 case 的状态即整段跳过。
- AC5（段名 `i.main`）与 AC6（`.text.main`）的函数名提取差异处理。
- GNU `*fill*` 归为 PAD 灰色并排除出聚合；归档成员 `libheap.a(tlsf.c.obj)` 的提取正则；ESP-IDF 组件路径归类。
- Keil `Image component sizes` 小节提供权威的 per-object 聚合（code/RO/RW/ZI），比逐行累加更可靠。
- 数据模型（`src/parser/types.ts`）：`MemorySection{execAddr, loadAddr, size, type: Code|Data|Zero|PAD, attr: RO|RW, sectionName, objectName, functionName}` 与 `ComponentSize{code, codeIncData, roData, rwData, ziData, debug}`，可直接演化为我们 IR 的基础。
- 每工作区持久化 ROM/RAM 手工配置（`keilMapHeatmap.memoryConfig`）。

**确定的问题（也是 MapVisual 的机会）**：
1. **完全没有 C++ demangle** —— 全代码库无 demangle 相关代码，C++ 固件的 mangled 名直接上屏（如 `_ZN6MyClass4funcEv`）。这是用户明说的不满点。
2. 只有 treemap：面积图适合"占比感知"，但**无法精确排序、对比、查找**（例如"谁最占 RAM 的前 20 个变量"）。
3. 无排序、无按模块聚合列表、无导出；搜索只调 DOM 透明度，不查数据模型。
4. IAR ilink、LLVM lld 完全不支持；格式检测是 Keil/GNU 二选一。
5. Keil ROM/RAM 判断用硬编码地址（`>=0x08000000 && <0x20000000` 即 Flash），非 STM32 布局即出错；GNU 侧 `.data` 的 loadAddr 恒为 null（`esp32Parser.ts:313`），无法做 Flash/RAM 双重计入。
6. "Removing Unused input sections"（gc-sections 产出）直接丢弃而不是作为"已排除"桶展示。
7. GNU 总量靠重新累加而非读 Grand Totals；区域归属按首个命中地址，重叠区域会错分。
8. 测试覆盖：仅 1 个 41 行合成 Keil AC5 fixture 的冒烟测试；GNU 解析器无任何测试。

### 2.2 imgui-gl3-glfw3-base（前作，本地源码分析）

C++23 + Dear ImGui 桌面程序。价值在**解析知识沉淀**而非代码本身：
- GNU ld 行文法完整抽象为 6 种行类型（`inc/map_parser.hpp:18-27`），5 条 `std::regex` + `*fill*`/`[!provide]` 前缀检查（`src/map_parser.cpp:72-114`）。
- **贡献段（contribution）内尺寸分配算法**：GNU ld 只给"输入段"总大小，段内多个符号需按地址差分摊（组内排序，非末位 = 下址-本址，末位 = 段起点+段大小-本址）。文档化于 `docs/superpowers/specs/2026-03-16-map-parser-design.md` §2.4。
- 已验证的坑：`(size before relaxing)`、`. = ALIGN(...)` 脚本表达式伪装成符号行、纯十六进制名垃圾行、`address==0` 不能作为过滤条件（`.comment` 也为 0）、LTO 后 `.ltrans0.ltrans.o` 且被内联符号消失、多符号贡献（crt/TLS）。
- 已知缺陷（移植时修正）：尺寸分组键漏了贡献地址 → 同对象同段同大小的两个贡献会串组；`ALIGN`/`PROVIDE` 子串过滤误伤同名真实符号；`std::stoull` 无异常保护；`std::regex` 逐行匹配对 MB 级 map 太慢；Discarded 区域以 `Memory Configuration` 为终止符，缺失时吞掉整个文件。
- demangle 用 vendored LLVM（`3rd_party/llvm-demangle`），**但没有接进 UI**；17 组 Itanium 测试向量可直接移植。
- 13 个 GNU ld fixture（x86-64 g++-14 生成，含编译命令 README），覆盖：基础、`-ffunction-sections/-fdata-sections`、`--gc-sections`、`-flto`、组合、TLS（`.tdata/.tbss`）、`-mcmodel=large`（`.ldata/.lbss`）、ifunc（`.iplt`）、discarded。
- **用例库缺口**（嵌入式真实场景）：无归档成员 `libc.a(printf.o)`、无 `.ARM.exidx/.ARM.attributes`、无 Keil/IAR、无 vtable/typeinfo/guard variable/COMDAT 符号形态。已在移植时补齐计划（见 DESIGN.md §10）。

### 2.3 puncover / bloaty（ELF 路线的标杆）

两者都绕开 map 文件直接分析 ELF：puncover 靠 DWARF 还原函数/变量/栈用量并给出调用图；bloaty 提供多维度（section/symbol/compile unit/archive member）尺寸剖析和 **diff 模式**（对比两个版本的体积变化）。启示：
- ELF 路线信息更全但**依赖带调试信息的产物**，且 发布/ stripping 后的 map 仍是最轻量的交付物；map 路线解析快、无外部依赖，两者互补不冲突。
- bloaty 的 diff 模式是高频刚需，列入 MapVisual 路线图（M5）。

### 2.4 demangle 技术选型调研（JS/TS 生态）

| 候选 | 现状 | 评估 |
|---|---|---|
| [`demangle`](https://www.npmjs.com/package/demangle) | 2016 年，emscripten 编译 libc++abi | 太老，弃 |
| [`demangler-js`](https://github.com/arthurmco/demangler-js) | 2018，纯 JS，自称仅 GCC/Clang | 语法覆盖度存疑 |
| [`demangler`](https://github.com/SMJSGaming/Demangler) | 2022，20KB 纯 JS | 小众实现，依赖怪异（`std-node`），覆盖度存疑 |
| **[`gecko-profiler-demangle`](https://github.com/mstange/gecko-profiler-demangle)**（Mozilla/Firefox Profiler 在用） | **2025-09 仍在发版**，Rust→WASM，`demangle_any` 同时支持 C++ 与 Rust | **选它**：工程质量高、活跃、零依赖、约 541KB（unpacked），Node 扩展宿主可直接 `WebAssembly.instantiate` |
| 自行移植 LLVM `ItaniumDemangle.h` 到 TS | 无现成 JS 移植（调研未发现可用品） | 长期理想解（纯 TS、可测、无 wasm），作为路线图备选 |
| 外部 `arm-none-eabi-c++filt` / `llvm-cxxfilt` | 需本机工具链 | 作为可配置的"校验/兜底"通道，不做默认依赖 |

另注意：GNU ld 的 map 里**符号行通常已被 ld 自动 demangle**（如 `add(int, int)`），但段名（`.text._Z3addii`）与 Keil AC6 场景仍是 mangled —— 所以 demangle 的真正主战场是**段名中内嵌的符号**与 `--no-demangle` 场景，以及把两种形态统一成可搜索的 displayName。

## 3. 结论：MapVisual 的差异化定位

1. **列表优先**：精确到符号的表格 + 任意列排序 + 过滤/分组，补齐 treemap 类工具"看不精确"的短板（treemap 作为辅助视图保留在路线图中）。
2. **开箱即用的 C++ 支持**：内置 WASM demangler，段名/符号双形态归一，mangled 与 demangled 双向可搜索。
3. **多工具链**：GNU ld 首发（用例库现成），Keil 紧随（参照 Map-View 知识 + 自采样例），IAR/lld 规划中 —— 这是现有 VSCode 插件都不具备的广度。
4. **编译选项自动化**：`-ffunction-sections` 两行式条目、LTO `.ltrans`、`--gc-sections` 的 Discarded 桶、`*fill*` 填充、归档成员、load address 的 Flash/RAM 双计入，全部默认处理，用户零配置。
5. **工作流内置**：快捷键秒开、watch 重建自动刷新、区域占用条常驻 —— 对比"打开终端跑 python 脚本"或"切到浏览器看 HTML"是体验代差。

## Sources

- [Map View Embedded（Marketplace / charcoal141/Map-View）](https://github.com/charcoal141/Map-View)
- [linkermapviz](https://github.com/linkermapviz/linkermapviz)
- [Emma Memory and Mapfile Analyser（holzkohlengrill/Emma）](https://github.com/holzkohlengrill/Emma) / [PyPI: pypiemma](https://pypi.org/project/pypiemma/)
- [puncover（HBehrens/puncover）](https://github.com/HBehrens/puncover)
- [bloaty（google/bloaty）](https://github.com/google/bloaty)
- [jetperch/memviewer](https://github.com/jetperch/memviewer)
- [yahyatawil/map_file_analyzer](https://github.com/yahyatawil/map_file_analyzer)
- [gecko-profiler-demangle（mstange）](https://github.com/mstange/gecko-profiler-demangle)
- [demangle（npm）](https://www.npmjs.com/package/demangle) / [demangler-js](https://github.com/arthurmco/demangler-js) / [demangler](https://github.com/SMJSGaming/Demangler)
- [LLVM ItaniumDemangle 源码](https://llvm.org/doxygen/ItaniumDemangle_8cpp_source.html)
- [LLVM RFC: Improve map-files for effective analysis and debugging](https://discourse.llvm.org)（lld map 格式演进的背景）
