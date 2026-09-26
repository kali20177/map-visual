# Map 文件格式规范（解析器知识库）

> 本文是 MapVisual 解析器的**格式圣经**：GNU ld 部分移植自 imgui-gl3-glfw3-base 的
> `docs/superpowers/specs/2026-03-16-map-parser-design.md`（384 行）并结合 13 个 fixture 实证修订；
> Keil 部分来自 Map-View 源码分析；IAR/lld 为待采样占位。
> 所有示例行均可在 `test/fixtures/` 中找到出处。

---

## 1. GNU ld / GCC（arm-none-eabi-gcc、x86_64-linux-gnu-gcc 等）

### 1.1 文件整体布局

`-Wl,-Map=out.map` 产出的文件按顺序包含以下区域（部分可选）：

```
[Merging program properties ...]        ← 可选头部
As-needed library libc.so.6 ...         ← 可选，动态库相关
Archive member included to satisfy references:   ← 有静态库时出现
  file            libc.a(printf.o)
Discarded input sections                ← 有 --gc-sections 时出现
  .note.GNU-stack  0x0000000000000000  0x0 xxx.o
Memory Configuration
  Name             Origin             Length             Attributes
  FLASH            0x08000000         0x00100000         xr
  RAM              0x20000000         0x00030000         xrw
  *default*        0x00000000         0xffffffff
Linker script and memory map            ← ★ 主区域起始锚点
  LOAD /path/to/elf                     ← LOAD 行（跳过）
  .text           0x0000000000001129    0x35
   *(.text .stub .text.* .gnu.linkonce.t.*)
   .text._Z3addii
   *fill*          0x0000000000001066   0xa
   .text           0x...   0x35  /tmp/ccJV5oYb.o    ← 贡献行
                  0x0000000000001129    add(int, int)     ← 符号行（已 demangle）
   .rodata._ZL13prime_numbers
   *(COMMON)
   .bss            0x...  (size before relaxing 0x...)  ← 带注释
   . = ALIGN(...) / PROVIDE(...)          ← 脚本表达式
  OUTPUT(elfname elf64-x86-64)          ← 文件结尾
```

### 1.2 行文法（6 种行类型）

| # | 类型 | 正则（锚定全行） | 示例 |
|---|---|---|---|
| L1 | 顶层输出段头 | `^(\.\S+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)(\s+load address 0x([0-9a-fA-F]+))?$` | `.text 0x0000000000001129 0x35`；`.data 0x20000000 0x48 load address 0x0800abc0` |
| L2 | 缩进裸段名（两行式条目的第一行） | `^\s+(\.\S+)$` | `   .text._Z3addii` |
| L3 | 贡献行（带段名） | `^\s+(\.\S+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S+)$` | ` .text 0x0000000000001129 0x35 /tmp/ccJV5oYb.o` |
| L4 | 贡献行（不带段名，跟随 L2） | `^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S+)$` | `   0x0000000000001129 0x18 /tmp/ccRXLECw.o` |
| L5 | 符号行 | `^\s+0x([0-9a-fA-F]+)\s+(.+)$`（名字用贪婪匹配，容忍空格） | `                0x0000000000001129    add(int, int)`；也匹配 `0x... _ZN3foo3barEv` |
| L6 | 其它 | 兜底 | 通配行 `*(.text.*)`、脚本表达式、注释 |

前缀特判（先于正则）：
- `*fill*`：`^\s+\*fill\*\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)` —— 对齐填充，记为 PAD 记录（不是丢弃，可汇总"浪费的空间"）。
- `[!provide]`：PROVIDE 语句，跳过。

**关键事实**：符号行的名字**通常已被 ld 自动 demangle**（Itanium ABI 默认行为），如 `add(int, int)`、`operator new(unsigned long)`（含空格！L5 必须贪婪匹配）。段名中则保留 mangled 形态（`.text._Z3addii`、`.rodata._ZL13prime_numbers`）。

### 1.3 状态机

```
SeekMain ──"Linker script and memory map"──► InMainMap
    │                                          │
    │"Discarded input sections"                │ 记录: 段头(L1/L2)、贡献(L3/L4)、
    ▼                                          │ 符号(L5)、*fill*、Memory Configuration 行
InDiscarded ──"Memory Configuration"──► InMemoryConfig ──"Linker script and memory map"──► InMainMap
```

**Discarded 区域的正确处理**（修正 imgui 实现）：逐行解析为 `status: "discarded"` 的记录保留在 IR 中（用户可查看"被裁剪了什么"），而不是整段丢弃。终止条件不能用单一字面量兜底：`Memory Configuration` 缺失时会吞掉整个文件 —— 以"回到 L1 顶层段头"作为附加终止信号。

### 1.4 贡献内符号尺寸分配算法（核心）

GNU ld 只给**贡献**（输入段）的总大小，段内多个符号（crt、TLS、LTO 场景常见）需要分摊：

1. 以贡献为单位分组，**组键必须包含贡献地址**：`(object, section, contrib_addr, contrib_size)`。
   （imgui 实现漏了 `contrib_addr`，同对象同段同大小的两个贡献会串组、算出错误尺寸 —— 移植时修正。）
2. 组内只有一个符号 → 直接取贡献大小。
3. 多个符号 → 按地址升序：
   - 非末位符号：`size = next_addr - addr`
   - 末位符号：`size = contrib_start + contrib_size - addr`
4. 验证不变量：`sum(组内符号 size) == contrib_size`（作为解析器自检 + 单测断言）。

### 1.5 特殊条目处理矩阵

| 条目 | 处理 | 说明 |
|---|---|---|
| `*fill*  addr size` | PAD 记录，保留 | 对齐填充，汇总为"浪费空间"指标 |
| `0x10 (size before relaxing)`（独立行） | 跳过 | **ARM relax 场景实测**：注释单独成行、无地址列，其数值是 relax 前尺寸；不能当符号行吞掉 |
| `(size before relaxing 0x...)`（行尾） | 剥离注释 | 只取最终 size |
| `. = ALIGN(...)`、`PROVIDE(...)`、`_estack = ...` 等脚本表达式 | 跳过 | **实测它们带地址列**，会伪装成 L5 符号行；按名字含 ` = ` 识别 |
| 纯十六进制符号名（`deadbeef` 式） | **不过滤**（imgui 过滤了，属于误伤） | 改用 L5 匹配出的 size 列合法性判断 |
| `address == 0` | **不作为过滤条件** | `.comment`、`.debug*` 等非分配段地址也是 0 |
| `COMMON` / `LARGE_COMMON` / `*(COMMON)` | `COMMON` 通配行跳过；归入 Bss 类 | 未初始化全局 |
| 归档成员 `libc.a(printf.o)` | 解析出 `archive` + `member` 字段 | ARM fixture 已含 `libutil.a(lib.o)` 与长路径 `libgcc.a(unwind-arm.o)` |
| object 列为自由文本（`.glue_7 ... linker stubs`） | 按贡献解析，object="linker stubs"，标记系统对象 | 链接器生成段（glue/veneer/stub）没有真实对象文件 |
| `load address 0x...`（L1 可选列） | 记入 `lma` | `.data` 的 VMA 在 RAM、LMA 在 Flash —— Flash/RAM 双计入的依据。**注意 `.bss` 段头也会带 load address**，但 zero-init 无加载镜像，区域占用需按 storage 过滤 |
| `.ltrans0.ltrans.o` | 正常对象名；被内联符号天然缺席 | LTO 归因到 `.ltrans` 编号，UI 标注"LTO 产物" |
| 共享库 `libc.so.6` 条目 | 记录但默认折叠 | 宿主 Linux 场景才有；嵌入式通常无 |
| `OUTPUT(...)` | 文件结束锚点 | |
| `LOAD /path` | 跳过 | |
| 无点自定义段名贡献行（` shellCommand  <vma> <size> <obj>`） | 正常贡献组，kind=other | `__attribute__((section("shellCommand")))` 等脚本 `*(名字)` 收集的自定义段——段名 token 不以 `.` 开头 |
| **无点输出段头**（col0 `bss 0x… 0x… [load address]`，Zephyr 链接脚本） | 正常输出段头 | Zephyr 的生成脚本给输出段命名不带点（`text`/`rodata`/`datas`/`bss`/`noinit`/`k_heap_area`/…）——段头段名 token 同样放宽为 `[A-Za-z_.]` 开头；kind 由 §1.6 的无点精确表推断。**载像区分**：`datas`/`k_*_area` 等带 `load address` 的两行式无点段头是真实初始化数据（lma 生效）；`._user_heap_stack` 类 bss 语义段的 load address 是脚本残留，忽略（与单行 `.bss` 段头的 zeroInit 规则同构） |
| `ASSERT (…)`（缩进、带地址前缀） | 跳过 | 链接脚本断言回显（Zephyr `initlevel_error` 段后），与 ` = ` 赋值同类 |
| 合并/relax 历史快照行 | 剔除 | LTO+字符串合并下 ld 会重打印已合并输入段的 pre-merge 大小（同 VMA、旧尺寸，无占位）——解析器按"输出段内贡献+fill 恰好铺满 [vma, vma+size)"链式取舍，非链上行丢弃 |
| 两行式输出段头（col0 裸段名 + 次行 extent） | 段级 extent，不产生贡献 | NOLOAD/纯脚本段的两种次行形态：`load address 0x…`（`.tm_clone_table`，size 0）与纯 `0x<vma> 0x<size>` 两字段（`._user_heap_stack` 实际打印形态）；其次行的 load address 不是真实载像，段内 fill 只占 RAM |
| Memory Configuration 区域降级 | region role → `other`，区域内符号 `storage=[]` | 区域 kept 内容全为非 alloc 语义（kind `other`/`meta`，如 `(COPY)` 段落位的 `DEVNULL_ROM`、仅自定义段的区域）时不计入 flash/ram；**仅含 fill 的区域不降级**（NOLOAD 堆栈 pad 仍占 RAM——fill 的 kind 继承自所在段，不能证明区域的内容属性）。口径注意：位于 FLASH 的可写自定义段（如 `.fw_signature`）无法按内容与 `(COPY)` 段区分，同样不计入——RAM 真值取 ELF 段级（`.data`+`.bss`+`._user_heap_stack` 之和），`size`(1) 工具会把这类段计入 data 列（其 ram 估计虚高 64 B/段） |
| `FILL mask 0xff` | 跳过 | 脚本 FILL 回显，无 extent |
| `.bss` 类段（单行头也带 load address）的 `*fill*` | 只占 RAM | zero-init 无加载镜像；fill 的 lma 归零 |
| 有载像段（`.data`）内的 `*fill*` | 占 Flash（载像）+ RAM | fill 字节同样存在于 LMA 镜像——Berkeley `size`(1) 工具的 data 列含它（此处及上文的 `size` 均指该工具，非字段名） |

### 1.6 输出段分类表（kind 推断）

| kind | 前缀/名字 |
|---|---|
| code | `.text*`、`.init`、`.fini`、`.plt*`、`.iplt`、`.vectors`、`.iram*`（xtensa） |
| rodata | `.rodata*`、`.eh_frame*`、`.gcc_except*`、`.gnu_extab`、`.note*`、`.interp`、`.gnu.hash`、`.dynsym`、`.dynstr`、`.gnu.version*`、`.sframe`、`.ARM.exidx`、`.ARM.extab`、`.ARM.attributes`（非分配，标注 meta）、`.hash` |
| data | `.data*`（含 `.data.rel.ro`、`.data1`）、`.got*`、`.dynamic`、`.tdata`、`.ldata`、`.sdata*`（RISC-V/小数据） |
| bss | `.bss*`、`.tbss`、`.lbss`、`.sbss*`、`.noinit*`、`COMMON` |
| meta（非分配，默认折叠） | `.debug_*`、`.line`、`.stab*`、`.comment`、`.gnu.build.attributes`、`.jcr`、`.tm_clone_table` |
| other | `.init_array`/`.fini_array`/`.preinit_array`/`.ctors`/`.dtors`（初始化语义，默认归 code-adjacent）及未识别项 |

**无点段名精确表**（Zephyr 风格，精确匹配非前缀）：`text`→code、`ramfunc`→code、`rodata`→rodata、`datas`/`data`/`sdata`/`device_states`→data、`bss`/`sbss`/`noinit`/`._user_heap_stack`→bss。

**带载像的 other 贡献**：kind=other 但 lma≠null 的行（Zephyr 结构段 `._k_heap.static.*`、`._log_msg_ptr.*` 等打印在 RAM、载像在 FLASH）按 data 口径双计 flash+ram；lma=null 的 other 行仍只按 VMA 区域（DEVNULL_ROM 降级语义不受影响）。

`.ARM.exidx/.ARM.extab` 位于 Flash（LMA），计入 Flash 但 kind 单独标 `unwind`，避免和真实代码混淆 —— 这是 imgui 完全没处理的 ARM 场景。

### 1.7 Fixture 语料清单

**x86（`test/fixtures/gnuld-x86/`，移植自 imgui-gl3-glfw3-base，x86-64 g++-14 生成）：**

| 目录 | 覆盖 | 关键形态 |
|---|---|---|
| basic/ | 基线格式 | L1+L3+L5、`*fill*`、crt 对象、`(size before relaxing)`、`COMMON` 通配 |
| sections/ | `-ffunction-sections -fdata-sections --gc-sections` | 两行式条目（L2+L4）、mangled 段名 `.text._Z3addii` |
| lto/ | `-flto` | `.ltrans0.ltrans.o`、内联后 `add` 消失 |
| sections_lto/ | 组合 | LTO 对象 + mangled 段名并存 |
| tls/ | `thread_local` | `.tdata`/`.tbss` 多符号贡献（3-4 个符号/贡献） |
| large/ | `-mcmodel=large`、大数组 | `.ldata 0x20000`、`.lbss 0x40000` 尺寸计算 |
| ifunc/ | `ifunc` | `.iplt`、`.rela.ifunc` |
| discarded/ | `--gc-sections` 裁剪 | Discarded 区域内容、crt 保留断言 |

**ARM 嵌入式（`test/fixtures/gnuld-arm/`，arm-none-eabi-gcc 13.3 (Arm GNU Toolchain) 实际构建，build.sh 可复现）：**

| 文件 | 编译选项 | 覆盖 |
|---|---|---|
| firmware_sections_gc.map | `-ffunction-sections -fdata-sections -Wl,--gc-sections` + 静态库 libutil.a + STM32 式链接脚本（FLASH@0x08000000/RAM@0x20000000） | 归档成员、`.ARM.exidx/extab`、C++ 类/模板 mangled 段名、`load address` 列、cortex-m3 relax 注释行、`linker stubs`；**区域占用与 `--print-memory-usage` 精确一致（FLASH 4152 / RAM 260）** |
| firmware_basic.map | 无 -ffunction-sections | 单体 `.text` 多符号贡献的地址差分摊 |
| firmware_no_demangle.map | 追加 `-Wl,--no-demangle` | mangled 符号行（demangle 引擎主战场） |
| firmware_common.map | `-fcommon` | ` COMMON <vma> <size> <obj>` 贡献行（无点段名、归 bss）；**golden FLASH 44 / RAM 24** |
| firmware_cpp_sections.map | `-O0 -ffunction-sections -fdata-sections`（C++） | 符号行位于 mangled 段内（`.text._ZN...`）——mangled 从段名回收；**golden FLASH 120 / RAM 4** |
| firmware_shellcmd.map | `__attribute__((section("shellCommand")))` + `*(shellCommand)` 收集 | 无点自定义段名贡献行；**golden FLASH 44 / RAM 0** |

**真实工程基准（`test/fixtures/real/`，非 build.sh 产物，重新生成需回源工程构建）：**

| 文件 | 来源 | 覆盖 |
|---|---|---|
| stm32f103-rb-demo-boot.map | stm32f103-rb-demo（CMake + Arm GNU Toolchain 13.3）Release/boot，LTO + C++ + 自定义脚本段 | 端到端黄金基准（`test/unit/realmap.test.ts`）：**FLASH 7648 / RAM 6360 与 ELF 段级真值一致**；LTO 合并/relax 快照行、`DEVNULL_ROM`（COPY）区域降级、两行式段头纯 extent 形态、无点 `shellCommand` 贡献行；kept 非 meta 行 VMA 零重叠零空隙 |
| zephyr-nucleo-f103rb.map | stm32f103-zephyr-demo（Zephyr 4.x + gnuarmemb 13.3）nucleo_f103rb | **无点输出段头**语料（`text`/`rodata`/`datas`/`bss`/`noinit`/`k_*_area`/`log_*_area`，含带 `load address` 的两行式）；端到端黄金基准：**FLASH 77256 / RAM 16054 与 ELF 段级真值一致**；`DEVNULL_ROM` 降级、`ASSERT` 脚本行、`._k_heap.*` 类带载像 other 贡献双计 |

**lld（`test/fixtures/lld/`）：** build.sh 提供 `ld.lld -Map` 生成脚本（armv7m freestanding）；本机 lld 就绪后执行回填，解析器先以官方表格格式合成基准验证。

---

## 2. Keil MDK / armlink（AC5 与 AC6）

### 2.1 文件布局与状态机

armlink map 按固定顺序分节，每节有标题行（状态机转移锚点）：

```
Section Cross References                        ← 状态 1（跳过）
    xxx.o(i.main) refers to yyy.o(...) for ...
Removing Unused input sections from the image   ← 状态 2（解析为 discarded 桶，Map-View 直接丢了）
    Removing main.o(.arm_projtext), (4 bytes).
Image Symbol Table                              ← 状态 3（Map-View 跳过；本地/全局符号明细）
Memory Map of the image                         ← ★ 状态 4（逐行明细）
Image Entry point : 0x080001c1
Load Region LR_1 (Base: 0x08000000, Size: 0x00001234, Max: 0xffffffff, ABSOLUTE)
    Execution Region ER_IROM1 (Exec base: 0x08000000, Load base: 0x08000000, Size: 0x1234, Max: 0xffffffff, ABSOLUTE)
    0x080001c1   0x000000b8   Data   RO         1234    .text                    startup_stm32f10x_hd.o
    0x08000279   0x00000004   PAD                            ← 纯填充行
Image component sizes                           ← ★ 状态 5（per-object 权威聚合）
    1234      56       0        0        0   1290   main.o
    ... Object Totals / Grand Totals / Total RO Size ... Total ROM Size ...
```

### 2.2 行文法（Memory Map 明细行）

标准 armlink（AC5/AC6）：`MEMORY_LINE_RE`

```
^\s*(0x[\da-f]+)\s+(0x[\da-f]+|-|COMPRESSED)\s+(0x[\da-f]+)\s+(Code|Data|Zero|PAD)\s+(RO|RW)\s+(\d+)\s+(\*?)\s*(.+?)\s{2,}(\S+)\s*$
 列: Exec Addr | Load Addr(可为'-'或COMPRESSED) | Size | Type | Attr | Idx | Section 名 | Object
```

EIDE 派生变体：少 load-addr/COMPRESSED 列、少 Idx 列（`EIDE_MEMORY_LINE_RE` 作为 fallback）。

要点：
- **AC5 vs AC6 检测**：首行 `Arm Compiler for Embedded`/`Compiler ... 6.x` → AC6；否则 AC5。影响函数名提取：AC5 段名 `i.main` → 剥 `i.`；AC6 段名 `.text.main` → 剥 `.text.`，且排除 `OUTLINED_FUNCTION_*`（编译器生成的外联函数）。
- `PAD` 行（可能无 section/object 列）：`objectName: "[PAD]"`。
- 归档成员：object 列形如 `libc.a(printf.o)` → 用 `^(.+?)\((.+?)\)$` 拆 `archive`/`member`。
- Keil 符号名 **通常是 demangle 过的**（`Image Symbol Table` 与 Memory Map 中显示如 `MyClass::func`），但 `.text` 段名带 mangled 的情况需验证 —— 采集真实 AC6 C++ 样例后确认（fixture 待补，Map-View 只有 41 行合成 AC5 样例）。
- `Image component sizes` 的 per-object 行（code/RO/RW/ZI/Debug 五列）与 `Grand Totals`、`Total RO  Size`/`Total ROM Size`（RAM/Flash 权威总量）——直接读取，不要重算（Map-View 的 GNU 侧就吃了重算的亏）。

### 2.3 内存区域模型

- `Load Region ... (Base:, Size:, Max:)` / `Execution Region ... (Exec base:, Load base:, Size:, Max:)` 直接给出区域边界 —— 归属判断**用这些边界做区间匹配**，不要硬编码 `0x08000000/0x20000000`（Map-View 的缺陷，非 STM32 即错）。
- `.data` 双计入：Execution Region 的 Exec base（RAM）与 Load base（Flash）分离时，RO 数据的 Flash 占用与 RW 的 RAM 占用分开汇总（`Code + RO + RW-data` 计 Flash、`RW + ZI` 计 RAM，Keil 官方 Grand Totals 亦如此）。

---

## 3. IAR EWARM / ilink（M4，待采样）

调研未发现任何现成的 ilink map 解析器（绝大多数工具走 ELF 路线）—— 这是空白也是风险：**需要用户提供 2-3 份真实 .map 样例**后再定稿文法。已知线索：

- 文件头部含 IAR 版本信息（`IAR ... Linker` 字样）→ 可作为格式签名。
- 已知小节名（采集时验证）：`ENTRY LIST`、`SECTION SUMMARY`、`MODULE SUMMARY`、`FILE SUMMARY`？（不同版本有差异）。
- 地址/尺寸为十六进制**无 0x 前缀**（IAR 惯例），需按列宽或 token 位置判断。

## 4. LLVM lld（已支持，真实基准已回填）

`ld.lld -Map=`（Homebrew LLD 23.1.2 实测，fixture：`test/fixtures/lld/firmware_lld.map`，生成脚本 `build.sh`）：

```
     VMA      LMA     Size Align Out     In      Symbol
   10094    10094       18     4 .ARM.exidx
   10094    10094       18     4         <internal>:(.ARM.exidx)
   100ac    100ac       16     4         main.o:(.text)
   100ac    100ac        0     1                 $t
   100ad    100ad        4     1                 compute
```

**实测要点**（与早期假设的差异）：
- **整个表格有前导缩进**（VMA 列从第 3 列开始）——行正则必须容忍行首空白。
- 地址/尺寸为十六进制**无 0x 前缀**；解析时全部按 16 进制读取（`12` = 18）。
- **行类型判别 = Align 列与描述之间的空格数**：output 行恰好 1 格，input/symbol 行 ≥2 格（与整行前导缩进无关）。
- 符号名**保持 mangled**（C 符号原样）；ARM mapping symbol（`$t`/`$d`）会以 0 尺寸出现，保留为 code 行。
- Thumb 代码符号的地址带低位 bit（`compute` 显示 `100ad`）——是 st_value 原值，照实展示。
- input 行无符号子行时（`.ARM.exidx`、`.got`），段级行必须使用 input 行的真实尺寸（曾硬编码 0 导致漏计）。
- `.symtab/.strtab/.shstrtab` 等非分配 ELF 元数据段位于地址 0，必须归 meta（无 storage），否则虚增 Flash。
- symbol 尺寸直接取自符号表（比 GNU ld 的差分摊更精确）；lld map 不报告 fill/对齐填充，Σsymbol 可能略小于 section size。
- `--gc-sections` 的裁剪结果不出现在 lld map 中（无 discarded 桶）。

## 5. 格式检测决策表

| 信号（按优先级） | 判定 |
|---|---|
| 首行含 `Arm Compiler` / `Component:` / `ARM Compiler`；全文含 `Image component sizes` | Keil armlink |
| 含 `Memory Configuration` **且** `Linker script and memory map`；或头部含 `Archive member included` / `^LOAD ` | GNU ld |
| 含 IAR 头部签名（待定稿） | IAR ilink |
| lld 签名（待定稿）；否则 GNU ld 解析失败率异常时提示疑似 lld | lld |
| 内容以 `{` 开头且为合法 JSON | 不是链接 map —— 提示"这像 JS sourcemap"，引导用文本编辑器打开 |

检测前先做 `first-line veto`（Map-Verify 模式），两段式启发 + 用户可手动指定格式（设置项 `mapvisual.formatOverride`）。
