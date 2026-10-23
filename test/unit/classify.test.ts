import { describe, expect, it } from 'vitest';
import { classifySection } from '../../src/parser/classify';

/**
 * 段名词表回归（2026-10-22 多 target 实测补齐）。
 *
 * 这些名字来自真实的 ESP32（Xtensa）、ESP32-S3、ESP32-C3（RISC-V）map：
 * 编译器/厂商库给输入段起的名字不总以 `.text`/`.rodata` 开头，而 IDF 的
 * 输出段骨架是固定的（kind 只影响分桶，不影响 flash/ram 归属）。
 */
describe('section kind vocabulary', () => {
    it('classifies vendor IRAM code families', () => {
        for (const name of [
            '.wifiextrairam.4',
            '.wifislpiram.38',
            '.wifirxiram.55',
            '.wifi0iram.20',
            '.wifislprxiram.23',
            '.phyiram.19',
            '.WindowVectors.text',
            '.Level2InterruptVector.text',
            '.Level3InterruptVector.text',
            '.Level6InterruptVector.text',
            '.DoubleExceptionVector.text',
            '.DebugExceptionVector.text',
            '.NMIExceptionVector.text',
            '.KernelExceptionVector.text',
            '.UserExceptionVector.text',
            '._invalid_pc_placeholder',
            '.exception_vectors.text',
            '.exception_vectors_table.text',
            '.conn_iram1.25',
            '.isr_iram1.0',
            '.coexiram.3',
        ]) {
            expect(classifySection(name), name).toBe('code');
        }
    });

    it('does not mistake other .level* names for vectors', () => {
        // `.level2interrupt` 起的前缀替代了原先宽泛的 `.level`
        expect(classifySection('.leveldb.data')).toBe('other');
    });

    it('classifies Xtensa/RISC-V metadata and small data', () => {
        expect(classifySection('.xt.prop')).toBe('meta');
        expect(classifySection('.xtensa.info')).toBe('meta');
        expect(classifySection('.riscv.attributes')).toBe('meta');
        expect(classifySection('.srodata.const')).toBe('rodata');
        expect(classifySection('.sdata.gp')).toBe('data');
        expect(classifySection('.sbss.small')).toBe('bss');
    });

    it('classifies ESP-IDF BT/SPIRAM sections by their real storage class', () => {
        expect(classifySection('.dram0.bt.data')).toBe('data');
        // `.dram0.bt.bss` must win over the generic `.dram` → data rule
        expect(classifySection('.dram0.bt.bss')).toBe('bss');
        expect(classifySection('.ext_ram.bss.0')).toBe('bss');
        expect(classifySection('.ext_ram_noinit.foo')).toBe('bss');
    });

    it('resolves the plain IDF output-section names, not their prefixes', () => {
        // arduino-esp32 maps print `*fill*` rows whose section is the output
        // section name; `.dram` → data and `.iram` → code would misplace them.
        expect(classifySection('.dram0.bss')).toBe('bss');
        expect(classifySection('.dram0.noinit')).toBe('bss');
        expect(classifySection('.iram0.bss')).toBe('bss');
        expect(classifySection('.iram0.data')).toBe('data');
        expect(classifySection('.iram0.text')).toBe('code');
    });
});
