import { describe, expect, it } from 'vitest';
import { parseFixture } from './helpers';

/**
 * ESP32-C2 BLE release-IRAM 布局回归。
 *
 * `.dram0.bt.data` / `.dram0.bt.bss` 是 **ESP32-C2 专属**输出段：C2 的 BT
 * controller Kconfig 定义 `BT_LE_RELEASE_IRAM_SUPPORTED`（经典 ESP32 与 S3
 * 都没有，因此它们的 map 不会出现这两个段）。BT 库的普通 `.data.*` /
 * `.bss.*` 输入段被 `.lf` 映射进来，kind 仍由输入段决定——data 占
 * flash+ram，bss 只占 ram。
 *
 * `.conn_iram1.*` / `.isr_iram1.*` / `.coexiram.*` 是 C2 BT controller 的
 * IRAM 代码族（真实 `bleprph` ESP32-C2 map 里有 5.4 KB），必须算 code，
 * 否则这部分 IRAM 载像不会计入 flash。
 */
describe('ESP32-C2 BLE (release-IRAM) layout', () => {
    it('uses IDF region names and totals for the C2 layout', async () => {
        const doc = await parseFixture('gnuld-riscv/esp32c2-bt.map');
        expect(doc.format).toBe('gnu-ld');
        expect(doc.warnings).toEqual([]);
        const roles = Object.fromEntries(doc.regions.map((r) => [r.name, r.role]));
        expect(roles).toEqual({
            iram0_0_seg: 'ram',
            iram0_2_seg: 'flash',
            dram0_0_seg: 'ram',
            drom0_0_seg: 'flash',
        });
        // flash = .flash.text 0x40 + IRAM 代码 0x40 + BT/普通 data 0x20
        //       + appdesc 0x10 + rodata 0x20
        expect(doc.totals.flash).toBe(0xd0);
        // ram = IRAM 0x40 + BT/普通 data 0x20 + BT/普通 bss 0x30
        expect(doc.totals.ram).toBe(0x90);
        const used = Object.fromEntries(doc.totals.regions.map((r) => [r.region.name, r.used]));
        expect(used).toEqual({
            iram0_0_seg: 0x40,
            iram0_2_seg: 0x40,
            dram0_0_seg: 0x50,
            drom0_0_seg: 0x30,
        });
    });

    it('stores BT data in flash+ram, BT bss in ram, and BT IRAM as code', async () => {
        const doc = await parseFixture('gnuld-riscv/esp32c2-bt.map');
        const data = doc.symbols.find((s) => s.outSection === '.dram0.bt.data' && s.name === 'bt_data')!;
        expect(data.kind).toBe('data');
        expect(data.storage).toEqual(['flash', 'ram']);
        const bss = doc.symbols.find((s) => s.outSection === '.dram0.bt.bss' && s.name === 'bt_bss')!;
        expect(bss.kind).toBe('bss');
        expect(bss.storage).toEqual(['ram']);
        for (const section of ['.conn_iram1.25', '.isr_iram1.0', '.coexiram.3']) {
            expect(doc.symbols.find((s) => s.section === section)!.kind, section).toBe('code');
        }
        expect(doc.symbols.filter((s) => s.isReserve).map((s) => s.outSection)).not.toContain('.dram0.bt.data');
        expect(doc.symbols.filter((s) => s.isReserve).map((s) => s.outSection)).not.toContain('.dram0.bt.bss');
        // C2 NOLOAD end markers are address space, not storage
        expect(doc.symbols.filter((s) => s.isReserve).map((s) => s.outSection)).toEqual(
            expect.arrayContaining(['.iram0.text_end', '.iram0.end', '.dram0.heap_start']),
        );
    });
});
