# gnuld-riscv — RISC-V / ESP32-C3/C2 map fixtures

`esp32c3.map` 与 `esp32c2-bt.map` 是合成 fixture，按 ESP-IDF 5.5.5 的
C3/C2 链接脚本（`components/esp_system/ld/{esp32c3,esp32c2}/memory.ld.in`
+ 公共 `ld.*.sections`）构造，用于钉住 Xtensa 之外的 RISC-V 形态。

## 与 S3 的布局差异

| 项目 | ESP32-S3（Xtensa） | ESP32-C3（RISC-V） |
|---|---|---|
| MMU 表项 | 512 × 64 KB（32 MB/总线） | 128 × 64 KB（8 MB/总线） |
| IROM/DROM 窗口 | 32 MB 硬件窗口 | 8 MB |
| PSRAM | `extern_ram_seg` + `.ext_ram.*` | **无 PSRAM、无 extern_ram_seg** |
| RTC | fast + slow + reserved | 只有一块 RTC slow（0x50000000） |
| 代码/数据段 | `.sdata/.sbss` 无；Xtensa `.literal` | `.sdata/.sbss/.srodata`（gp 相对）；无 `.literal` |
| 元数据 | `.xt.prop/.xt.lit/.xtensa.info` | `.riscv.attributes` |

## 真实 C3 实测（IDF 5.5.5）

| 样本 | 来源 | flash | `.bin` | ram | IDF 官方 DRAM + RTC |
|---|---|---|---|---|---|
| hello-c3 | IDF hello_world | 137,407 | 137,472 | 55,846 | 55,790 + 56 |
| st7789 | nopnop2002/esp-idf-st7789 @ 9c933f7 | 297,308 | 297,360 | 73,800 | 73,744 + 56 |

C3 的 IDF `DRAM` 行是 IRAM+DRAM 的共享 SRAM 用量（两个总线别名），所以
`ram = DRAM + RTC`。两份 map 的 `.riscv.attributes` 都表现为
**无 extent 的裸输出段头 + `/DISCARD/` 里的零地址贡献**，不是普通的
`name 0xaddr 0xsize` 段头；fixture 也按这个形态构造。

## ESP32-C2 BLE（BT release-IRAM）

C2 比 C3 更精简：Memory Configuration 只有 `iram0_0_seg` / `iram0_2_seg` /
`dram0_0_seg` / `drom0_0_seg` 四个 region，**没有 RTC / extern_ram**；
但它是唯一会产生 `.dram0.bt.data` / `.dram0.bt.bss` 的 target
（`BT_LE_RELEASE_IRAM_SUPPORTED` 只在 `components/bt/controller/esp32c2/
Kconfig.in` 定义，经典 ESP32 和 S3 都不产生）。

| 样本 | 来源 | flash | `.bin` | ram | IDF 官方 |
|---|---|---|---|---|---|
| bt-c2 | IDF bleprph（NimBLE） | 465,579 | 465,632 | 91,468 | 91,468（无 RTC） |

- `.dram0.bt.data` 0x160 / `.dram0.bt.bss` 0x19c：BT 库的普通 `.data.*`/
  `.bss.*` 输入段被 `.lf` 映射进来；data 占 flash+ram，bss 只占 ram。
- `.conn_iram1.*` / `.isr_iram1.*` / `.coexiram.*` 是 BT controller 的
  IRAM 代码（合计 5.4 KB）；漏分类会让 flash 比 `.bin` 少 5.3 KB。
- `.iram0.end`（10 B）与 `.iram0.text_end` / `.dram0.heap_start` 一样是
  NOLOAD 地址尾，不计存储——排除后 ram 与 IDF 官方逐字节相等。

`esp32c2-bt.map` fixture 钉住上述形态（flash `0xD0`、ram `0x90`、4 个
region、BT data/bss 的存储归属、`.conn_iram1/.isr_iram1/.coexiram` 为
code、`.iram0.end` 为 reserve）。

## 覆盖的形态

1. `IDF_REGION_ROLES` 对 C3 同样生效（`iram0_2_seg` 是 IROM 窗口）。
2. `.riscv.attributes` → meta（无 extent 的 meta 段走 keep-all，不发
   `outputExtentUnknown`）；`.srodata` → rodata；`.sdata/.sbss` → data/bss；
   `__global_pointer$ = ...` 赋值行不是符号行。
3. `.exception_vectors.text` / `.exception_vectors_table.text`（RISC-V 异常
   向量，落在 `.iram0.text`，算代码）。
4. `.iram0.text_end` / `.dram0.heap_start`（NOLOAD 尾）不占存储——
   与 IDF `idf.py size` 的 used 口径一致。

## 期望值

- `test/unit/esp32c3.test.ts`：flash `0xF0`、ram `0x80`、6 个 region
  （无 `extern_ram_seg`）、kind 汇总、`fillTotal = 0`、预留段 storage 为空。
- `test/unit/esp32c2-bt.test.ts`：flash `0xD0`、ram `0x90`、4 个 region、
  `.dram0.bt.data` = flash+ram、`.dram0.bt.bss` = ram、
  `.conn_iram1/.isr_iram1/.coexiram` = code、`.iram0.end` = reserve。
