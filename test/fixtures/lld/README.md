# LLVM lld fixture（tabular `-Map` 格式）

由各自 `build.sh` 构建（clang[++] 23.1.2 + ld.lld 23.1.2，Homebrew llvm；
只保留 `.map`，产物与目标文件留在临时目录）。golden 断言见
`test/unit/lld.test.ts`，几何/行号全语料不变量见 `test/unit/geometry.test.ts`。

2026-10-03 补齐验证缺口时新增 cpp / archive / gc / lto 四份（此前仅一份纯 C
单 .o 的 `firmware_lld.map`）。实测定论：

- **符号名形态**：lld map 符号列默认打 **demangled** 名（`app::Led::render(int)`、
  `vtable for app::Widget`）；`--no-demangle` 才保留 mangled（pipeline 的
  isMangled 兜底覆盖）。mangled 名始终存在于 `-ffunction-sections` 段名
  （`.text._ZN...`）中，pipeline 从段名回提取。
- **archive 成员**：In 行形如 `libnet.a(net.o):(.text.net_send)`；未被引用的
  成员与成员内被 gc 的函数从不打印。
- **--gc-sections**：回收的符号静默缺席；COMMON 符号按 `util.o:(COMMON)`
  逐符号一行。
- **LTO**：full LTO 把输入名改成 `<输出名>.elf.lto.o`（thin 为
  `<输出名>.elf.lto.<文件>.o`），这是 map 里唯一的 LTO 标记。
- **padding**：lld 不打印 fill 行；输入行带绝对地址，解析器按相邻输入行的
  地址差合成 `*fill*` 行（无 line，同 `*unsym*` 策略），总量与 ELF 逐字节对齐。

| fixture | 覆盖 | 真值（flash = llvm-size text+data，ram = data+bss；除 cpp 外） |
| --- | --- | --- |
| `firmware_lld.map` | 单 .o 纯 C、$t 映射符号、非分配段归 meta | 50 / 4 |
| `cpp/cpp_lld.map` | C++ 双 TU：模板/内联去重、vtable（`.rodata._ZTV...`）、`.init_array`（VMA==LMA 原地，只占 flash）、`.0` 后缀本地符号、段间 padding（.text 2B + .data 3B） | 210 / 44 |
| `archive/archive_lld.map` | 静态库成员拆分、未拉入成员、成员内 gc、成员间 2B padding | 484 / 64 |
| `gc/gc_lld.map` | 多对象 + --gc-sections、COMMON 逐符号行、`$d` 数据映射符号、.data 7B padding | 150 / 40 |
| `lto/lto_lld.map` | full LTO 合成对象名、LTO 内联后归因 | 50 / 8 |

同一日（2026-10-03）晚些时候，真实工程 rb-demo 的 clang+lld 分支产物入库
`real/stm32f103-rb-demo-lld-{app,boot}.map`，暴露并修复了本目录合成 fixture
未覆盖的实战形态：链接脚本语句行（任意缩进）、合并 `.eh_frame` 过期地址行、
地址 0 的未放置段、脚本生长段、弱别名簇、`::(` 符号行误判、符号行自带 LMA
列——详见 `real/README.md` 与 docs/DESIGN.md §13 条目 19。

工具链版本变化会改变 `.comment`/`.ARM.attributes` 尺寸与地址布局——重生成后
同步更新测试里的 golden 数字与 README 真值列。
