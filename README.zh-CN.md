<div align="center">

<img src="https://github.com/kali20177/map-visual/raw/HEAD/media/icon-2x.png" width="96" alt="MapVisual 图标" />

# MapVisual

**在 VS Code 里可视化嵌入式链接器 map 文件。**

[![CI](https://github.com/kali20177/map-visual/actions/workflows/ci.yml/badge.svg)](https://github.com/kali20177/map-visual/actions/workflows/ci.yml)

[English](README.md) | 简体中文

</div>

链接器 map 记录的是：目标文件被映射到内存的哪里、公共符号如何分配、链接引入了哪些归档成员、各符号被赋予的地址，以及这些符号最终有没有进入映像。而真实的 map 动辄几 MB，全是密集文本。MapVisual 把 GNU ld 或 LLVM lld 生成的 `.map` 变成可排序、可过滤的符号列表，给出每个符号的 Flash/RAM 占用，并提供 Treemap、构建间 Diff 与内置的 C++ 名称还原。

## 功能

- **打开 map**：按 `Alt+M` 从列表选择，或直接双击任意 `.map` 文件，重建固件后已打开的视图会自动刷新
- **符号级列表**：按大小、名称、类型、段、目标文件、地址排序；按对象、库、输出段、段类型、目录分组；按文本、段类型、最小尺寸过滤；隐藏编译器与运行时对象；查看被 `--gc-sections` 裁剪的内容。虚拟滚动让多 MB 的 map 依然流畅
- **跟得上手的过滤**：空白分隔的词自动组合，`-词` 表示排除，`"一段短语"` 保整体（符号名与路径里有空格时用得上）；命中处高亮、工具栏给出计数，搜不到时会明说而不是看起来像坏了
- **内存占用**：侧栏显示内存区域占用条、段类型占比与最大的符号，状态栏显示当前 map 的总量
- **分栏定位**：点击任意符号行，在旁边打开原始 map 并高亮该行；`Alt+单击`改为复制，`mapvisual.clickAction` 把这两者对调；无论怎么设置，双击始终定位到原始行。复制操作在行右键菜单
- **Treemap**：把列表切换为面积占比图，可逐组钻取
- **Map Diff**：两份构建按符号对比增减（新增、移除、变化），给出 Flash/RAM 总量差值，可导出 CSV
- **内置 C++ 名称还原**：扩展自带 WASM demangler，无需工具链与配置；从段名还原的符号（`.text._ZN…`）同样处理，mangled 与 demangled 两种写法都能搜到
- **真实链接器输出**：处理 `-ffunction-sections` 条目、LTO 合并段、`--gc-sections` 裁剪、`*fill*` 填充、静态库成员与 relax 注释，`.data` 同时计入 Flash 和 RAM
- **CSV 导出**：过滤后的全部行，或仅你选中的行
- **跳转源码**：从符号跳到工作区内的源文件
- **附带 CLI**：同一解析引擎也能从命令行调用（见下文）

## 快速开始

1. 从 marketplace 安装扩展（或安装 `.vsix`）。
2. 打开包含工程的工作区，按 `Alt+M` 选择 map，或双击任意 `.map` 文件，默认由 MapVisual 打开。
3. 想用纯文本查看时，点编辑器标题栏的 **Open as Text** 按钮；想永久改变默认编辑器，右键文件 → *Open With…* → *Configure default editor*。

阅读 map 时：

- **工具栏**：`C++` 名称还原、`System`（隐藏 crt/libgcc/libc）、`Removed`（gc-section 裁剪符号）、`Treemap`、`Raw`（在旁边打开原始 map）、`CSV` 导出。过滤框支持 `-词` 排除与 `"一段短语"`（用于名字里带空格的对象或路径）
- **列宽**：拖动表头里的分隔线即可调宽窄——相邻两列互相让渡宽度，表格始终填满面板
- **行交互**：单击执行配置的动作（`locate` 定位，或 `mapvisual.clickAction: copy` 复制），`Alt+单击`执行另一个，双击始终定位到原始行；`Shift+单击` 与 `Shift+↑/↓` 选中一段，`Ctrl/Cmd+单击` 逐个切换，`Ctrl/Cmd+A` 全选当前可见行，选中内容可经行菜单导出。右键打开行菜单：复制 demangled / mangled / 整行，定位原始行，按对象或按段过滤，只看某一类型，排除某个对象，跳转源码
- **视图状态会按文件保留**：过滤、排序、分组、折叠状态、Treemap 钻取层级、列宽、滚动位置与行选中，切到别的标签页再切回来都还在；关掉文件之后再打开（包括新开的窗口）同样回到原样。切回标签页不会重新解析 map
- **状态栏**：当前 map 的 Flash/RAM 总量

## 命令

| 命令 | 快捷键 |
|---|---|
| MapVisual: Open Map File | `Alt+M` |
| MapVisual: Compare Two Maps | `Alt+Shift+D` |
| MapVisual: Open as Text | 编辑器标题栏（查看 map 时） |

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `mapvisual.demangle` | `true` | 还原 C++ 符号名（内置 WASM demangler）。 |
| `mapvisual.formatOverride` | `auto` | 强制指定 map 格式而非自动检测（`gnu-ld` / `lld`）。 |
| `mapvisual.clickAction` | `locate` | 单击符号行的动作：`locate` 在原始 map 中定位该行，`copy` 复制显示名。`Alt+单击`始终执行另一个动作，双击始终定位。 |

## 命令行

解析核心不依赖 VS Code。构建之后，同一套引擎也能作为 CLI 给脚本和 AI 助手调用，提供 `summary`、`symbols`、`treemap`、`diff` 四个命令，默认输出 JSON，`--md` 输出 Markdown：

```bash
node dist/cli.js summary firmware.map
node dist/cli.js symbols firmware.map --top 20 --kind code
node dist/cli.js treemap firmware.map --depth 2
node dist/cli.js diff old.map new.map
```

完整契约见 [docs/CLI.md](docs/CLI.md)。

## 支持的工具链

| 工具链 | 状态 |
|---|---|
| GNU ld（`gcc`、`arm-none-eabi-gcc`） | ✅ 真实固件构建验证 |
| LLVM lld（`ld.lld`） | ✅ 真实产物验证 |
| Keil armlink | 规划中 |
| IAR ilink | 规划中 |

## 隐私

解析全部在本机完成，运行在本地 worker 进程里。扩展不收集遥测，也不发起网络请求，固件符号始终留在本机。

## 许可证

[MIT](LICENSE)
