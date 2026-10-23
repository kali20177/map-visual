import { describe, expect, it } from 'vitest';
import { parseFixture } from './helpers';

/**
 * End-to-end goldens against real-world maps.
 *
 * stm32f103-rb-demo-boot: CubeMX-style script sections.
 * Truth: arm-none-eabi-size text 7600 + data 48 = 7648 flash;
 * ELF sections .data + .bss + ._user_heap_stack = 6360 ram.
 *
 * zephyr-nucleo-f103rb: Zephyr's generated linker script prints its output
 * sections WITHOUT a leading dot (`text`, `rodata`, `datas`, `bss`, ...).
 * Truth: arm-none-eabi-size text 76432 + data 824 = 77256 flash;
 * ELF ALLOC sections with VMA in RAM sum to 16054 ram.
 */
describe('real-world map golden (stm32f103-rb-demo Release/boot)', () => {
    it('matches the ELF segment truth exactly', async () => {
        const doc = await parseFixture('real/stm32f103-rb-demo-boot.map');
        expect(doc.format).toBe('gnu-ld');
        expect(doc.warnings).toEqual([]);
        expect(doc.totals.flash).toBe(7648);
        expect(doc.totals.ram).toBe(6360);
    });

    it('assigns region roles with the COPY region downgraded', async () => {
        const doc = await parseFixture('real/stm32f103-rb-demo-boot.map');
        const roles = Object.fromEntries(doc.regions.map((r) => [r.name, r.role]));
        expect(roles).toEqual({ FLASH: 'flash', RAM: 'ram', DEVNULL_ROM: 'other' });
        // .log_strings lives in DEVNULL_ROM ((COPY) output) — no storage claim
        const logRow = doc.symbols.find((s) => s.status === 'kept' && s.section === '.log_strings');
        expect(logRow).toBeDefined();
        expect(logRow!.storage).toEqual([]);
    });

    it('tiles kept non-meta rows with zero overlap and zero gaps', async () => {
        const doc = await parseFixture('real/stm32f103-rb-demo-boot.map');
        const rows = doc.symbols
            .filter((s) => s.status === 'kept' && s.kind !== 'meta' && s.size > 0)
            .map((s) => ({ a: s.addr, b: s.addr + s.size }))
            .sort((x, y) => x.a - y.a || x.b - y.b);
        let sum = 0;
        let union = 0;
        let overlap = 0;
        let curA: number | null = null;
        let curB: number | null = null;
        for (const v of rows) {
            sum += v.b - v.a;
            if (curA == null) {
                curA = v.a;
                curB = v.b;
            } else if (v.a >= curB!) {
                union += curB! - curA;
                curA = v.a;
                curB = v.b;
            } else {
                overlap += Math.min(curB!, v.b) - v.a;
                curB = Math.max(curB!, v.b);
            }
        }
        if (curA != null) {
            union += curB! - curA;
        }
        expect(overlap).toBe(0);
        expect(sum).toBe(union);
    });
});

describe('real-world map golden (zephyr nucleo_f103rb)', () => {
    it('matches the ELF segment truth exactly despite dot-less section names', async () => {
        const doc = await parseFixture('real/zephyr-nucleo-f103rb.map');
        expect(doc.format).toBe('gnu-ld');
        expect(doc.warnings).toEqual([]);
        expect(doc.totals.flash).toBe(77256);
        expect(doc.totals.ram).toBe(16054);
    });

    it('downgrades DEVNULL_ROM and keeps bss in ram', async () => {
        const doc = await parseFixture('real/zephyr-nucleo-f103rb.map');
        const roles = Object.fromEntries(doc.regions.map((r) => [r.name, r.role]));
        expect(roles).toEqual({ FLASH: 'flash', RAM: 'ram', DEVNULL_ROM: 'other', SRAM0: 'ram', IDT_LIST: 'other' });
        // RAM 与 SRAM0 是同址同角色的别名，但没有 IROM/DROM 命名可供分流：
        // 两处都必须保留原用量（折叠别名是 Memory layout 的视图语义，不能
        // 让 summary 的 region used 凭空归零）。
        const used = Object.fromEntries(doc.totals.regions.map((r) => [r.region.name, r.used]));
        expect(used).toEqual({ FLASH: 77256, RAM: 16054, DEVNULL_ROM: 0, SRAM0: 16054, IDT_LIST: 0 });
        // Zephyr parks log strings in DEVNULL_ROM — not part of the image
        const logRow = doc.symbols.find((s) => s.status === 'kept' && s.section.startsWith('._log_strings.'));
        expect(logRow).toBeDefined();
        expect(logRow!.storage).toEqual([]);
        // `bss` (dot-less header) contributions classify as bss
        const bssRow = doc.symbols.find((s) => s.status === 'kept' && s.kind === 'bss' && s.section.startsWith('.bss'));
        expect(bssRow).toBeDefined();
        // `._k_heap.*` struct data: RAM VMA + FLASH load image
        const kheap = doc.symbols.find((s) => s.status === 'kept' && s.section.startsWith('._k_heap.'));
        expect(kheap).toBeDefined();
        expect(kheap!.storage).toEqual(['flash', 'ram']);
    });
});

/**
 * stm32f103-rb-demo 的 clang+lld 分支产物（Homebrew clang/ld.lld 23.1.2 +
 * ArmGNUToolchain 13.3 newlib/libstdc++/libgcc 静态库 + 自定义链接脚本 +
 * LLVM LTO；仓库同源 GCC 产线的黄金基准见上方 rb-demo 描述）。
 * 真值 = llvm-readelf -S：ALLOC 且非 W 的段之和为 flash（.fw_signature /
 * .init_array 带 W flag 但 VMA 在 FLASH，物理占 flash）；W 且 VMA 在 RAM
 * 的段（.data + .bss + ._user_heap_stack）为 ram。该语料驱动了 lld 解析器
 * 一整轮实战修复：脚本语句行、合并 .eh_frame 过期地址行、地址 0 的未放置
 * 段、弱别名簇、脚本生长段、乱序输入行（docs/DESIGN.md §13 条目 19）。
 */
describe('real-world map golden (stm32f103-rb-demo clang+lld, ReleaseClang)', () => {
    it('app (LTO + 静态库) matches the ELF section truth exactly', async () => {
        const doc = await parseFixture('real/stm32f103-rb-demo-lld-app.map');
        expect(doc.format).toBe('lld');
        expect(doc.warnings).toEqual([]);
        // flash = readelf -S 非 W 的 ALLOC 段（75480，.fw_signature/.init_array
        // 带 W 但 VMA 在 FLASH，原地占 flash）+ .data 的载像副本 656（段表里
        // 不是独立段，藏在 LOAD segment）= 76208，与 llvm-size text+data 一致；
        // ram = W 且 VMA 在 RAM（.data 656 + .bss 7328 + ._user_heap_stack
        // 1536）= 9520。Berkeley size 的 data+bss=9592 把 .fw_signature /
        // .init_array 误计入 RAM（size(1) 口径局限，见 real/README）。
        expect(doc.totals.flash).toBe(76208);
        expect(doc.totals.ram).toBe(9520);
    });

    it('app 标记 LTO 合成对象、拆分 archive 成员、.log_strings 不认领存储', async () => {
        const doc = await parseFixture('real/stm32f103-rb-demo-lld-app.map');
        expect(doc.symbols.some((s) => s.isLto && s.object === 'UART-Dbg.elf.lto.o')).toBe(true);
        // 合并 .eh_frame 贡献行（过期地址）被跳过，字节由 fill 吸收
        expect(doc.symbols.some((s) => s.section.startsWith('.eh_frame+'))).toBe(false);
        const u8g2 = doc.symbols.find((s) => s.archive?.endsWith('libu8g2.a'));
        expect(u8g2).toBeDefined();
        expect(u8g2!.member).toBeTruthy();
        const log = doc.symbols.find((s) => s.section === '.log_strings');
        expect(log).toBeDefined();
        expect(log!.kind).toBe('meta');
        expect(log!.storage).toEqual([]);
    });

    it('boot matches the ELF section truth exactly', async () => {
        const doc = await parseFixture('real/stm32f103-rb-demo-lld-boot.map');
        expect(doc.format).toBe('lld');
        expect(doc.warnings).toEqual([]);
        expect(doc.totals.flash).toBe(8164);
        expect(doc.totals.ram).toBe(4240);
    });
});

/**
 * 同一 Zephyr 工程的 clang+lld 产物（自建 clangemb 工具链：Homebrew
 * clang/ld.lld 23.1.2 + ArmGNUToolchain 13.3 binutils/libgcc + picolibc
 * 模块源码编译 + CONFIG_CPP/minimal libc++，与上方 gnuarmemb 构建同
 * Kconfig 结果；工具链与构建命令见 stm32f103-zephyr-demo 仓库的
 * clang-lld-toolchain/README.md）。
 * 真值 = arm-none-eabi-size -B 的 text 87552 + data 872 = 88424 flash；
 * RAM = ELF ALLOC 段中 VMA 落在 RAM 的 size 之和 16131（datas 582 +
 * bss 6559 + noinit 8704 + log_dynamic_area 124 + log_mpsc_pbuf_area 60 +
 * device_states 42 + k_sem_area 32 + k_heap_area 24 + log_msg_ptr_area 4）。
 * 该语料驱动了 SCRIPT_ROW_RE 的复合赋值扩展：Zephyr 生成脚本在 rom_start
 * 里打印 `. += 0x0 - (. - __rom_start_address)`，旧正则只认 ` = ` 而漏判。
 */
describe('real-world map golden (zephyr nucleo_f103rb clang+lld)', () => {
    it('matches the ELF section truth exactly', async () => {
        const doc = await parseFixture('real/zephyr-nucleo-f103rb-lld.map');
        expect(doc.format).toBe('lld');
        expect(doc.warnings).toEqual([]);
        expect(doc.totals.flash).toBe(88424);
        expect(doc.totals.ram).toBe(16131);
    });

    it('吸收复合赋值语句行、k_heap 领 flash+ram、libclang_rt 标记系统库', async () => {
        const doc = await parseFixture('real/zephyr-nucleo-f103rb-lld.map');
        // 语句行（`. +=`、`. =`）不落成符号——demangled 名不含带空格的赋值号
        expect(doc.symbols.some((s) => s.name.includes(' += ') || s.name.includes(' = '))).toBe(false);
        // `._k_heap.static.*`：VMA 在 RAM、LMA 在 FLASH 的载像（与 GNU 构建的
        // _k_heap 断言同款口径）
        const kheap = doc.symbols.find((s) => s.status === 'kept' && s.section.startsWith('._k_heap.'));
        expect(kheap).toBeDefined();
        expect(kheap!.storage).toEqual(['flash', 'ram']);
        // 无点输出段分类：bss/noinit 内的输入段（.bss.xxx/.noinit.xxx）→ bss，
        // datas 内的 .data.* → data
        expect(doc.symbols.some((s) => s.status === 'kept' && s.kind === 'bss' && s.outSection === 'bss')).toBe(true);
        expect(doc.symbols.some((s) => s.status === 'kept' && s.kind === 'bss' && s.outSection === 'noinit')).toBe(true);
        const datas = doc.symbols.find((s) => s.status === 'kept' && s.outSection === 'datas');
        expect(datas).toBeDefined();
        expect(datas!.kind).toBe('data');
        // compiler-rt 别名库（内容为 libgcc）成员按系统库过滤，与 GNU 构建
        // 的 libgcc 成员同待遇
        const rt = doc.symbols.find((s) => s.archive?.endsWith('libclang_rt.builtins.a'));
        expect(rt).toBeDefined();
        expect(rt!.isSystem).toBe(true);
    });
});

/**
 * arduino-esp32（arduino-cli 1.5.1 + esp32:esp32 3.3.12）与 PlatformIO
 * （espressif32 8.0.0，同为 Arduino core 3.3.12）的真实构建产物。
 *
 * 真值口径与 IDF 样本一致：
 *  - flash = 应用镜像 `.bin` 减去镜像头（24 B 头 + 6×8 B 段头 + 校验/对齐）；
 *    解析值略低于 `.bin` 的部分来自 `.rtc_reserved`（NOLOAD、不进镜像）与
 *    `.noinit`（只记 RAM），属于已知 ≤40 B 的口径差。
 *  - ram = DRAM（`.data`+`.bss`+`.noinit`）+ IRAM（`.iram0.text/.vectors`）
 *    + RTC（`.rtc.force_slow/.rtc_reserved`），与 `esp32-*-elf-readelf -S`
 *    的 ALLOC 段按 VMA 窗口求和一致。
 *
 * 这批语料驱动了两处分类修复（docs/DESIGN.md §13 条目 25）：
 *  ① `.DebugExceptionVector.text`（Xtensa vectors.S 的代码桩）被 `.debug`
 *    前缀误判成 meta，IRAM 少 6 B；
 *  ② `*fill*` 行用输出段名做分类，`.dram0.bss` 命中 `.dram` → data、把
 *    BSS 填充记成 flash+ram（S3 样本 238 B / C3 样本 206 B）。
 */
describe('real-world map golden (arduino-esp32 / ESP32-S3, arduino-cli 3.3.12)', () => {
    it('matches the ELF/bin truth', async () => {
        const doc = await parseFixture('real/arduino-esp32-location-s3.map');
        expect(doc.format).toBe('gnu-ld');
        expect(doc.warnings).toEqual([]);
        // .bin 1,237,904 − 96（镜像头 116 − rtc_reserved 24 + 对齐 4）
        expect(doc.totals.flash).toBe(1237808);
        // DRAM 48,652（arduino-cli "Global variables use"）+ IRAM 95,387 + RTC 72
        expect(doc.totals.ram).toBe(144111);
        const roles = Object.fromEntries(doc.regions.map((r) => [r.name, r.role]));
        expect(roles).toMatchObject({
            iram0_0_seg: 'ram',
            iram0_2_seg: 'flash',
            dram0_0_seg: 'ram',
            drom0_0_seg: 'flash',
            rtc_reserved_seg: 'ram',
            rtc_slow_seg: 'ram',
            extern_ram_seg: 'ram',
        });
        const used = Object.fromEntries(doc.totals.regions.map((r) => [r.region.name, r.used]));
        expect(used).toMatchObject({
            iram0_0_seg: 95387,
            dram0_0_seg: 48652, // 与 arduino-cli 报的 "Global variables use" 逐字节相等
            rtc_reserved_seg: 40,
            rtc_slow_seg: 32,
        });
    });

    it('keeps the Xtensa DebugExceptionVector in IRAM code', async () => {
        const doc = await parseFixture('real/arduino-esp32-location-s3.map');
        const dbg = doc.symbols.find((s) => s.section === '.DebugExceptionVector.text');
        expect(dbg).toBeDefined();
        expect(dbg!.kind).toBe('code');
        expect(dbg!.storage).toEqual(['flash', 'ram']);
        expect(dbg!.size).toBe(6);
    });

    it('treats .dram0.bss fills as RAM-only', async () => {
        const doc = await parseFixture('real/arduino-esp32-location-s3.map');
        const fills = doc.symbols.filter((s) => s.isFill && s.outSection === '.dram0.bss');
        expect(fills.length).toBeGreaterThan(0);
        expect(fills.every((s) => s.storage.join() === 'ram')).toBe(true);
    });
});

describe('real-world map golden (PlatformIO espressif32 8.0.0 / ESP32-C3)', () => {
    it('matches the ELF/bin truth', async () => {
        const doc = await parseFixture('real/platformio-c3-adblock.map');
        expect(doc.format).toBe('gnu-ld');
        expect(doc.warnings).toEqual([]);
        // .bin 1,497,392 − 97（镜像头 116 − rtc_reserved 24 + 填充 5）
        expect(doc.totals.flash).toBe(1497295);
        // DRAM 78,176（PlatformIO "RAM used"）+ IRAM 65,284 + RTC 72
        expect(doc.totals.ram).toBe(143532);
        const used = Object.fromEntries(doc.totals.regions.map((r) => [r.region.name, r.used]));
        expect(used).toMatchObject({
            iram0_0_seg: 65284,
            dram0_0_seg: 78176,
            iram0_2_seg: 1144006, // IROM 段 0x1174c8 少 2 B 段间对齐
            drom0_0_seg: 273192,
        });
        const roles = Object.fromEntries(doc.regions.map((r) => [r.name, r.role]));
        expect(roles).toMatchObject({
            iram0_0_seg: 'ram',
            iram0_2_seg: 'flash',
            dram0_0_seg: 'ram',
            drom0_0_seg: 'flash',
            rtc_iram_seg: 'ram',
            rtc_reserved_seg: 'ram',
        });
    });

    it('keeps .dram0.bss fills out of flash', async () => {
        const doc = await parseFixture('real/platformio-c3-adblock.map');
        const fills = doc.symbols.filter((s) => s.isFill && s.outSection === '.dram0.bss');
        expect(fills.length).toBeGreaterThan(0);
        expect(fills.every((s) => s.storage.join() === 'ram')).toBe(true);
    });
});
