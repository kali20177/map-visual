# 真实工程基准 map

`stm32f103-rb-demo-boot.map` 来自本地工程 `stm32f103-rb-demo`（CMake + Arm GNU Toolchain
13.3.Rel1，`-flto -ffunction-sections -fdata-sections` + C++ + 自定义链接脚本）的
Release/boot 固件，是 4 份真实 map 中最小的一份（95 KB）。它**不由本仓库的 build.sh
生成**，是外部黄金基准：重新生成需回原工程构建。其余 fixture（`gnuld-arm/`、
`gnuld-x86/`、`lld/`）由各自 build.sh 构建。

覆盖的真实形态（golden 断言见 `test/unit/realmap.test.ts`）：

- LTO 合并/relax 历史快照行（`.comment` / `.debug_str` / `.rodata`）
- `(COPY)` 段落位的 `DEVNULL_ROM` 区域降级（`.log_strings` 不计入存储）
- 两行式段头（`._user_heap_stack` 纯 extent 形态）
- 无点自定义段名贡献行（`shellCommand`）

真值口径：FLASH 7648 B = `arm-none-eabi-size` 的 text(7600)+data(48)；
RAM 6360 B = ELF 段级 `.data`+`.bss`+`._user_heap_stack` 之和。
