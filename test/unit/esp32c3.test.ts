import { describe, expect, it } from 'vitest';
import { parseFixture } from './helpers';

/**
 * ESP32-C3（RISC-V ESP-IDF）布局回归。
 *
 * 与 S3（Xtensa）共享同一套 memory.ld/sections.ld 骨架，但键差异是：
 *  - MMU 只有 128 项（8 MB 窗口），DROM/IROM 都是 8 MB；
 *  - 没有 PSRAM → 没有 `extern_ram_seg` / `.ext_ram.*`；
 *  - RTC 只有一块 slow memory（0x50000000），`rtc_iram_seg` 与
 *    `rtc_slow_seg` 是同一个 region 的别名，map 里只有 `rtc_iram_seg`
 *    和 `rtc_reserved_seg`；
 *  - RISC-V 专有段：`.riscv.attributes`（非分配元数据）、`.sdata`/`.sbss`
 *    （gp 相对小数据）、`.srodata`，以及 `__global_pointer$` 赋值行。
 */
describe('ESP32-C3 (RISC-V IDF) layout', () => {
    it('has no PSRAM window and a single RTC memory', async () => {
        const doc = await parseFixture('gnuld-riscv/esp32c3.map');
        expect(doc.format).toBe('gnu-ld');
        expect(doc.warnings).toEqual([]);
        const roles = Object.fromEntries(doc.regions.map((r) => [r.name, r.role]));
        expect(roles).toEqual({
            iram0_0_seg: 'ram',
            iram0_2_seg: 'flash',
            dram0_0_seg: 'ram',
            drom0_0_seg: 'flash',
            rtc_iram_seg: 'ram',
            rtc_reserved_seg: 'ram',
        });
        // flash = .flash.text 0x60 + IRAM 代码/vectors 0x40
        //       + .dram0.data 载像 0x10 + appdesc 0x10 + rodata 0x20 + RTC 0x10
        expect(doc.totals.flash).toBe(0xf0);
        // ram = iram0_0 0x40 + .dram0.data 0x10 + bss 0x20 + RTC 0x10
        expect(doc.totals.ram).toBe(0x80);
        const used = Object.fromEntries(doc.totals.regions.map((r) => [r.region.name, r.used]));
        expect(used).toEqual({
            iram0_0_seg: 0x40,
            iram0_2_seg: 0x60,
            dram0_0_seg: 0x30,
            drom0_0_seg: 0x30,
            rtc_iram_seg: 0x8,
            rtc_reserved_seg: 0x8,
        });
    });

    it('classifies RISC-V small-data, srodata and build attributes', async () => {
        const doc = await parseFixture('gnuld-riscv/esp32c3.map');
        const attrs = doc.symbols.find((s) => s.section === '.riscv.attributes')!;
        expect(attrs.kind).toBe('meta');
        expect(attrs.storage).toEqual([]);
        expect(doc.symbols.find((s) => s.section === '.sdata.gp')!.kind).toBe('data');
        expect(doc.symbols.find((s) => s.section === '.sbss.small')!.kind).toBe('bss');
        expect(doc.symbols.find((s) => s.section === '.srodata.const')!.kind).toBe('rodata');
        expect(doc.symbols.find((s) => s.section === '.exception_vectors.text')!.kind).toBe('code');
        // gp 赋值行不是符号行
        expect(doc.symbols.some((s) => s.name.includes('__global_pointer$'))).toBe(false);
        // kind 汇总：vectors+text 代码、srodata+rodata 只读、sdata 数据、sbss 清零
        expect(doc.totals.kindTotals).toMatchObject({
            code: 0xa0,
            rodata: 0x30,
            data: 0x20,
            bss: 0x20,
            pad: 0,
            other: 0,
            meta: 0x10,
        });
    });

    it('still treats dummy/noload windows as address space only', async () => {
        const doc = await parseFixture('gnuld-riscv/esp32c3.map');
        const reserve = doc.symbols.filter((s) => s.isReserve);
        expect(reserve.map((s) => s.outSection)).toEqual(
            expect.arrayContaining([
                '.dram0.dummy',
                '.flash_rodata_dummy',
                '.flash.rodata_noload',
                // NOLOAD end markers are address space, not storage — IDF's
                // own `idf.py size` excludes them from used RAM
                '.iram0.text_end',
                '.dram0.heap_start',
            ]),
        );
        expect(reserve.every((s) => s.storage.length === 0)).toBe(true);
        expect(doc.totals.fillTotal).toBe(0);
    });
});
