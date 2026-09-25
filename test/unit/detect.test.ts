import { describe, expect, it } from 'vitest';
import { detectFormat } from '../../src/parser/detect';

describe('format detection', () => {
    it('detects GNU ld maps', () => {
        const sample = 'Memory Configuration\n\nName  Origin  Length\n\nLinker script and memory map\n\n.text 0x1000 0x10\nOUTPUT(a.elf elf32-littlearm)';
        expect(detectFormat(sample).format).toBe('gnu-ld');
    });

    it('detects GNU ld maps starting with LOAD lines', () => {
        expect(detectFormat('LOAD /tmp/a.elf\n.start 0x0 0x0').format).toBe('gnu-ld');
    });

    it('detects lld tabular maps', () => {
        const sample = '    VMA      LMA     Size Align Out     In      Symbol\n000101c0 000101c0      21c     4 .text\n';
        const d = detectFormat(sample);
        expect(d.format).toBe('lld');
        expect(d.confidence).toBeGreaterThan(0.9);
    });

    it('flags JSON content as a likely sourcemap', () => {
        const d = detectFormat('{"version":3,"sources":[]}');
        expect(d.jsonSourcemap).toBe(true);
        expect(d.format).toBe('unknown');
    });

    it('recognizes (not yet supported) armlink maps', () => {
        const sample = 'Component: Arm Compiler 6.21\n\nImage Symbol Table\n\nMemory Map of the image\n\nImage component sizes\n';
        expect(detectFormat(sample).format).toBe('armlink');
    });

    it('returns unknown for random text', () => {
        expect(detectFormat('hello world\nnothing here\n').format).toBe('unknown');
    });
});
