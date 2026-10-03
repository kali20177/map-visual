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
