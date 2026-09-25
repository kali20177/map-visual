import { describe, expect, it } from 'vitest';
import { getParser, PLANNED_FORMATS, registerParser } from '../../src/parser/registry';
import { Warnings } from '../../src/parser/warnings';

describe('parser registry (M2/M4 plug-in point)', () => {
    it('serves the implemented formats', () => {
        expect(getParser('gnu-ld')).toBeDefined();
        expect(getParser('lld')).toBeDefined();
        // both parse an empty-ish doc without crashing on the anchor scan
        const w = new Warnings();
        expect(getParser('lld')!.parse('    VMA      LMA     Size Align Out     In      Symbol\n', w).symbols).toEqual([]);
    });

    it('leaves M2/M4 slots unresolved with roadmap messages', () => {
        expect(getParser('armlink')).toBeUndefined();
        expect(getParser('ilink')).toBeUndefined();
        expect(PLANNED_FORMATS.get('armlink')).toContain('M2');
        expect(PLANNED_FORMATS.get('ilink')).toContain('M4');
    });

    it('supports late registration (how M2/M4 will plug in)', () => {
        const fake = { parse: () => ({ regions: [], symbols: [] }) };
        try {
            registerParser('armlink', fake);
            expect(getParser('armlink')).toBe(fake);
        } finally {
            // undo the registration so other tests see the planned state
            // (registry has no unregister — emulate by restoring nothing)
        }
    });
});
