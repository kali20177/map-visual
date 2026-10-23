# gnuld-xtensa — Xtensa / ESP-IDF map fixtures

`esp32s3.map` 是从真实 ESP-IDF 工程 `esp32-s3-demo`（xtensa-esp32s3-elf ld，
12.5 MB / 144,476 行）中抽取形态的**合成** fixture：地址、段名与行结构逐字
取自真实 map，尺寸缩小到几十字节，便于逐项断言。

## 多 target / 多配置实测（2026-10-22，IDF 5.5.5）

真实 map 由本机 IDF 5.5.5 编译，2–23 MB，未入库（体积）；下表是全部样本的
对账结果，用来避免单一 `esp32-s3-demo` 造成的样本偏差。C2 的 BLE 样本见
`gnuld-riscv/README.md`。

| 样本 | target / 配置 | 来源 | flash | `.bin` | 差 | ram | IDF 官方 used + RTC | 差 |
|---|---|---|---|---|---|---|---|---|
| hello-c3 | C3 / 最小 | IDF 示例 | 137,407 | 137,472 | −65 | 55,846 | 55,790 + 56 | 0 |
| st7789 | C3 / 显示 + spiffs | nopnop2002/esp-idf-st7789 @ 9c933f7 | 297,308 | 297,360 | −52 | 73,800 | 73,744 + 56 | 0 |
| hello-esp32 | ESP32 / 最小 | IDF 示例 | 136,731 | 136,800 | −69 | 63,665 | 51,707 + 11,908 + 56 | −6 |
| wifi-esp32 | ESP32 / WiFi | IDF 示例 | 697,948 | 697,936 | +12 | 132,293 | 97,979 + 34,264 + 56 | −6 |
| bt-discovery | ESP32 / 经典 BT（BLE 关） | IDF 示例 | 591,210 | 591,296 | −86 | 130,357 | 94,883 + 35,424 + 56 | −6 |
| s3-bt | S3 / NimBLE | IDF 示例（bleprph） | 541,245 | 541,248 | −3 | 114,913 | 98,479 + 16,384 + 56 | −6 |
| s3-wifi | S3 / WiFi | IDF 示例 | 697,553 | 697,504 | +49 | 126,585 | 110,151 + 16,384 + 56 | −6 |
| s3-spiram | S3 / PSRAM BSS | IDF hello + SPIRAM 配置 | 172,048 | 172,112 | −64 | 142,513 | 60,543 + 16,384 + 65,536 + 56 | −6 |
| camera | S3 / esp32-camera | espressif/esp32-camera @ f37e656 | 285,402 | 285,440 | −38 | 89,921 | 73,487 + 16,384 + 56 | −6 |
| xiaozhi | S3 / AI 助手 | 78/xiaozhi-esp32 v2.0.5 @860d12a（bread-compact-wifi） | 2,543,138 | 2,543,008 | +130 | 157,205 | 157,139 + 72 | −6 |
| watch-lvgl | S3 / AMOLED 手表 + PSRAM | Waveshare ESP32-S3-Touch-AMOLED-1.8 `14_lvgl_demo_v9` | 782,431 | 782,448 | −17 | 166,425 | 149,991 + 16,384 + 56 | −6 |

- flash 与 `.bin` 的差是镜像头/段头/对齐；ram 的 6 B 差来自 `.iram0.text_end`
  这类 NOBITS 尾（map 无符号行），已从 used 中排除，与 IDF 官方口径一致。
- C3 的 IDF `DRAM` 行本身包含 IRAM+DRAM（同一 SRAM 的两个别名），所以
  `ram = DRAM + RTC`；S3 是 `DIRAM + IRAM (+ PSRAM BSS) + RTC`。
- S3 SPIRAM 的 `.ext_ram.bss`（65,536 B）与 DROM 同址；角色表把
  `drom0_0_seg` 固定为 flash、`extern_ram_seg` 固定为 ram，因此
  `drom0_0_seg` 只计 `.flash.rodata`（32,044 B），PSRAM BSS 只计一次，
  也不再触发角色冲突告警。

### 原始 `esp32-s3-demo`

| 指标 | MapVisual | 真值 |
|---|---|---|
| flash | 1,497,083 B | 1,496,976 B（`esp32-s3-demo.bin`，差 +107） |
| ram | 215,253 B | 215,259 B（DIRAM 198,819 + IRAM 16,384 + RTC 56，差 −6） |
| `.flash.text` | 1,100,116 B | ELF segment 05（IROM） |
| `drom0_0_seg` used | 273,912 B | appdesc 256 + rodata 273,656 |
| `dram0_0_seg` used | 113,212 B | data 20,812 + bss 92,400 |
| warnings | 0 | — |

## 覆盖的形态

1. **IRAM/IROM 角色**：`iram0_0_seg`（0x40374000）是真 IRAM → ram；
   `iram0_2_seg`（0x42000020）是 IROM 的 flash 指令窗口 → flash。
   注意经典 ESP32 的 `hello_world` 里 IRAM 51.7 KB > IROM 47.4 KB，纯
   code 质量投票会投反——因此 IDF 段名（`IDF_REGION_ROLES`）优先于质量锚点。
2. **预留窗口**：`.ext_ram.dummy` / `.flash_rodata_dummy`（二者同址重叠）/
   `.dram0.dummy` / `.flash.rodata_noload`，以及 NOLOAD 尾
   `.iram0.text_end` / `.dram0.heap_start`；只占地址窗口，不进 flash/ram、
   kind 汇总、fill 汇总与 treemap。
3. **Xtensa 输入段族**：`.wifirxiram/.wifi0iram/.wifislprxiram`、
   `.wifiextrairam/.wifislpiram`、`.phyiram`（WiFi/PHY 代码）；
   `.literal/.lit4`（字面量池）；`.xt./.xtensa.`（非分配元数据）；
   `.WindowVectors/.LevelNInterruptVector/...`（异常/中断向量）。C2 的 BT
   IRAM 族（`.conn_iram1/.isr_iram1/.coexiram`）见 RISC-V README。
4. **RAM 代码载像**：IRAM 代码与 DRAM 内 rodata 在 map 里没有 LMA，存储按
   "flash + ram"记（与 `.data` 同口径）。
5. **BT / SPIRAM**：`.dram0.bt.data/.dram0.bt.bss` **只出现在 ESP32-C2**
   （`BT_LE_RELEASE_IRAM_SUPPORTED` 仅在 C2 controller Kconfig 定义）：
   经典 ESP32 的 bt_discovery（BLE 关闭）和 S3 的 NimBLE bleprph 实测都
   不产生这两个段。C2 的真实样本与 fixture 见 `gnuld-riscv/README.md`。
   `.ext_ram.bss/.ext_ram_noinit`（S3 PSRAM）的分类/存储规则见
   `classify.test.ts`；watch-lvgl 样本只产生 `.ext_ram.dummy`（未开外部 BSS）。
6. **RTC**：`rtc_iram_seg/rtc_slow_seg/rtc_reserved_seg` 都是 RAM（深睡保持）。
7. **`--cref` 表尾**：xiaozhi 的 map 末尾有 `Cross Reference Table`（symbol→file，
   长路径会换行成纯缩进行）；解析器遇到表头即停止，不再把换行路径报成
   `unrecognizedLine`。xiaozhi 的 PSRAM 只产生 `.ext_ram.dummy`（运行期堆），
   唤醒词模型（289,638 + 1,200 B）由 `build_default_assets_bin` 打进
   `generated_assets.bin`（563,463 B）烧到独立 assets 分区，**不在 app map
   里**——所以 2,543,138 只是 app 镜像，整片 flash 还要加 bootloader /
   partition table / assets。

## 期望值

`test/unit/esp32.test.ts` 钉住：flash `0xE8`、ram `0x90`、各 region 角色与
used、`pad`/`fillTotal` 只剩真实的 `0x4` 对齐填充、treemap 不含预留段。
