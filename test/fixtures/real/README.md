# 真实工程基准 map

外部黄金基准，**不由本仓库的 build.sh 生成**，重新生成需回各自源工程构建。
其余 fixture（`gnuld-arm/`、`gnuld-x86/`、`lld/`）由各自 build.sh 构建。

- `stm32f103-rb-demo-boot.map` — 本地工程 `stm32f103-rb-demo`（CMake +
  Arm GNU Toolchain 13.3.Rel1，`-flto -ffunction-sections -fdata-sections` +
  C++ + 自定义链接脚本）的 Release/boot 固件（95 KB，4 份真实 map 中最小）。
  覆盖：LTO 合并/relax 快照行、`(COPY)` 段落位的 `DEVNULL_ROM` 区域降级、
  两行式段头（`._user_heap_stack` 纯 extent 形态）、无点自定义段名贡献行。

- `zephyr-nucleo-f103rb.map` — 本地工程 `stm32f103-zephyr-demo`
  （Zephyr 4.x + gnuarmemb 13.3，NUCLEO-F103RB）的默认构建（620 KB）。
  覆盖：**Zephyr 生成脚本的无点输出段名**（`text`/`rodata`/`datas`/`bss`/
  `noinit`/`k_*_area`/`log_*_area`，含带 `load address` 的两行式形态）、
  `ASSERT` 脚本行、`DEVNULL_ROM` 降级、`._k_heap.*` 类带载像 other 贡献。

- `stm32f103-rb-demo-lld-{app,boot}.map` — 同一工程 `stm32f103-rb-demo`
  的 **clang + lld 分支**（`try-clang-lld`，2026-10-03 构建产物）：
  Homebrew clang/ld.lld 23.1.2 + ArmGNUToolchain 13.3 的
  newlib/libstdc++/libgcc 静态库 + 自定义链接脚本 + LLVM LTO（app），
  只保留 `.map`（boot 23 KB / app 242 KB）。覆盖：链接脚本语句行
  （赋值/`ALIGN`/`LONG`/`PROVIDE`，任意缩进）、合并 `.eh_frame` 的过期
  地址行（`+0x0` 后缀）、地址 0 的未放置段（`.log_strings`）、脚本生长段
  （`._user_heap_stack`/`.fw_signature`）、弱别名簇、Thumb bit0、
  `lib*.a(member.o)` archive 行与 `UART-Dbg.elf.lto.o` LTO 合成对象。
  这批语料驱动了 lld 解析器 2026-10-03 的实战修复轮
  （docs/DESIGN.md §13 条目 19）。

- `zephyr-nucleo-f103rb-lld.map` — 与 `zephyr-nucleo-f103rb.map` 同一工程
  的 **clang + lld 构建**（2026-10-03，470 KB）：自建 out-of-tree 工具链
  `clangemb`（Homebrew clang/ld.lld 23.1.2 + ArmGNUToolchain 13.3 的
  binutils/libgcc + picolibc 模块源码编译 + CONFIG_CPP/minimal libc++，
  Kconfig 结果与 gnuarmemb 构建一致；工具链与构建命令见
  stm32f103-zephyr-demo 仓库的 clang-lld-toolchain/README.md）。
  覆盖：**复合赋值脚本语句行**（`. += 0x0 - (. - __rom_start_address)`，
  驱动 SCRIPT_ROW_RE 扩展，docs/DESIGN.md §13 条目 20）、GNU 版全部
  无点段形态的 lld 版、`k_heap_area` 带 LMA 载像、picolibc 的 `libc.a`
  显式路径、`libclang_rt.builtins.a` 成员行（系统库过滤）。

真值口径（golden 断言见 `test/unit/realmap.test.ts`）：

- rb-demo boot：FLASH 7648 B = `arm-none-eabi-size` 的 text(7600)+data(48)；
  RAM 6360 B = ELF 段级 `.data`+`.bss`+`._user_heap_stack` 之和。
- zephyr：FLASH 77256 B = `arm-none-eabi-size` 的 text(76432)+data(824)；
  RAM 16054 B = ELF VMA 落在 RAM 的全部 ALLOC 段之和。
- rb-demo lld app：FLASH 76208 B = `llvm-size -B` 的 text(75480)+data(728)
  （.data 载像在 LOAD segment 里，段表无独立条目）；RAM 9520 B = readelf -S
  中 W flag 且 VMA 在 RAM 的段（.data 656 + .bss 7328 + ._user_heap_stack
  1536）。Berkeley 的 data+bss=9592 把 `.fw_signature`/`.init_array`（W flag
  但 VMA 在 FLASH，原地）误计入 RAM——size(1) 口径局限，同 GNU 产线注记。
- rb-demo lld boot：FLASH 8164 B / RAM 4240 B，同口径。
- zephyr lld：FLASH 88424 B = `arm-none-eabi-size` 的 text(87552)+data(872)；
  RAM 16131 B = ELF VMA 落在 RAM 的全部 ALLOC 段之和（datas 582 + bss 6559
  + noinit 8704 + log_dynamic_area 124 + log_mpsc_pbuf_area 60 +
  device_states 42 + k_sem_area 32 + k_heap_area 24 + log_msg_ptr_area 4）。
