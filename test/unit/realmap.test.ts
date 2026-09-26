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
