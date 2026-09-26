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

真值口径（golden 断言见 `test/unit/realmap.test.ts`）：

- rb-demo boot：FLASH 7648 B = `arm-none-eabi-size` 的 text(7600)+data(48)；
  RAM 6360 B = ELF 段级 `.data`+`.bss`+`._user_heap_stack` 之和。
- zephyr：FLASH 77256 B = `arm-none-eabi-size` 的 text(76432)+data(824)；
  RAM 16054 B = ELF VMA 落在 RAM 的全部 ALLOC 段之和。
