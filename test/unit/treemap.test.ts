import { describe, expect, it } from 'vitest';
import { buildGroups, squarify, type TreemapItem } from '../../src/webview/treemap';
import type { SymbolRecord } from '../../src/types';

const W = 1000;
const H = 500;

function items(sizes: number[]): TreemapItem[] {
    return sizes.map((size, i) => ({ key: `k${i}`, label: `item${i}`, size, kind: 'code' as const }));
}

describe('squarify', () => {
    it('tiles the rectangle exactly (area conservation)', () => {
        const rects = squarify(items([500, 300, 120, 80]), { x: 0, y: 0, w: W, h: H });
        const area = rects.reduce((a, r) => a + r.w * r.h, 0);
        expect(area).toBeCloseTo(W * H, 0);
    });

    it('keeps every rect inside the container (fp tolerance)', () => {
        const rects = squarify(items([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]), { x: 5, y: 5, w: W, h: H });
        const eps = 1e-6;
        for (const r of rects) {
            expect(r.x).toBeGreaterThanOrEqual(5 - eps);
            expect(r.y).toBeGreaterThanOrEqual(5 - eps);
            expect(r.x + r.w).toBeLessThanOrEqual(5 + W + eps);
            expect(r.y + r.h).toBeLessThanOrEqual(5 + H + eps);
        }
    });

    it('bounds aspect ratios for varied input', () => {
        const rects = squarify(items([4000, 2000, 900, 500, 300, 200, 100, 50, 20, 10]), { x: 0, y: 0, w: W, h: H });
        const worst = Math.max(...rects.map((r) => Math.max(r.w / r.h, r.h / r.w)));
        // squarified layout keeps ratios ≈ ≤ 2 for this kind of distribution
        expect(worst).toBeLessThan(4);
    });

    it('handles degenerate inputs', () => {
        expect(squarify([], { x: 0, y: 0, w: W, h: H })).toEqual([]);
        expect(squarify(items([0, 0]), { x: 0, y: 0, w: W, h: H })).toEqual([]);
        expect(squarify(items([100]), { x: 0, y: 0, w: 0, h: 0 })).toEqual([]);
    });

    it('places the largest item first', () => {
        const rects = squarify(items([900, 100]), { x: 0, y: 0, w: W, h: H });
        expect(rects[0].label).toBe('item0');
        expect(rects[0].w).toBeGreaterThan(rects[1].w);
    });
});

describe('buildGroups', () => {
    const sym = (over: Partial<SymbolRecord>): SymbolRecord => ({
        name: 's',
        mangled: null,
        demangled: null,
        addr: 0,
        size: 1,
        kind: 'code',
        section: '.text',
        object: 'a.o',
        archive: null,
        member: null,
        lma: null,
        storage: ['flash'],
        status: 'kept',
        isFill: false,
        fromSectionName: false,
        isSystem: false,
        isLto: false,
        ...over,
    });

    it('groups by object, aggregates sizes and sorts groups desc', () => {
        const groups = buildGroups(
            [
                sym({ name: 'a', size: 10, object: 'x.o' }),
                sym({ name: 'b', size: 5, object: 'x.o' }),
                sym({ name: 'c', size: 30, object: 'y.o' }),
            ],
            (s) => s.object,
        );
        expect(groups.map((g) => g.label)).toEqual(['y.o', 'x.o']);
        expect(groups[0].size).toBe(30);
        expect(groups[1].size).toBe(15);
        expect(groups[1].items.length).toBe(2);
    });

    it('skips discarded rows and zero sizes', () => {
        const groups = buildGroups(
            [
                sym({ name: 'a', size: 0 }),
                sym({ name: 'b', size: 5, status: 'discarded' }),
                sym({ name: 'c', size: 30 }),
            ],
            () => 'all',
        );
        expect(groups.length).toBe(1);
        expect(groups[0].items.length).toBe(1);
    });
});
