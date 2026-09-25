import type { SymbolKind, SymbolRecord } from '../types';

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk).
 * Pure geometry: input items sorted internally by size desc, output rects
 * tile the given rectangle exactly. Unit-tested for area conservation and
 * aspect-ratio bounds.
 */

export interface TreemapItem {
    key: string;
    label: string;
    size: number;
    kind: SymbolKind;
}

export interface TreemapRect {
    key: string;
    label: string;
    size: number;
    kind: SymbolKind;
    x: number;
    y: number;
    w: number;
    h: number;
}

interface Placer {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface AreaItem {
    item: TreemapItem;
    area: number;
}

function worstRatio(row: AreaItem[], length: number, rowArea: number): number {
    if (rowArea <= 0 || length <= 0) {
        return Infinity;
    }
    const thickness = rowArea / length;
    let worst = 0;
    for (const it of row) {
        const other = it.area / thickness;
        if (other <= 0) {
            return Infinity;
        }
        const ratio = Math.max(thickness / other, other / thickness);
        if (ratio > worst) {
            worst = ratio;
        }
    }
    return worst;
}

/** Lay one "row" of items along the shorter side of the remaining area. */
function layoutRow(row: AreaItem[], area: Placer, rowArea: number, out: TreemapRect[]): void {
    const horizontal = area.w >= area.h;
    const thickness = horizontal ? rowArea / area.h : rowArea / area.w;
    let along = 0;
    for (const it of row) {
        const span = it.area / rowArea * (horizontal ? area.h : area.w);
        if (horizontal) {
            out.push({ ...it.item, x: area.x, y: area.y + along, w: thickness, h: span });
        } else {
            out.push({ ...it.item, x: area.x + along, y: area.y, w: span, h: thickness });
        }
        along += span;
    }
    if (horizontal) {
        area.x += thickness;
        area.w -= thickness;
    } else {
        area.y += thickness;
        area.h -= thickness;
    }
}

export function squarify(items: TreemapItem[], rect: { x: number; y: number; w: number; h: number }): TreemapRect[] {
    const out: TreemapRect[] = [];
    if (items.length === 0 || rect.w <= 0 || rect.h <= 0) {
        return out;
    }
    const total = items.reduce((a, b) => a + b.size, 0);
    if (total <= 0) {
        return out;
    }
    const containerArea = rect.w * rect.h;
    // work in area units so geometry and sizes share one dimension
    const queue = [...items]
        .sort((a, b) => b.size - a.size)
        .map((item) => ({ item, area: (item.size / total) * containerArea }));
    const area = { ...rect };
    let i = 0;
    while (i < queue.length) {
        const shortSide = Math.min(area.w, area.h);
        const row: AreaItem[] = [queue[i]];
        let rowArea = queue[i].area;
        let best = worstRatio(row, shortSide, rowArea);
        i++;
        // greedily add items while the worst aspect ratio improves
        while (i < queue.length) {
            const candidateRatio = worstRatio([...row, queue[i]], shortSide, rowArea + queue[i].area);
            if (candidateRatio <= best) {
                row.push(queue[i]);
                rowArea += queue[i].area;
                best = candidateRatio;
                i++;
            } else {
                break;
            }
        }
        layoutRow(row, area, rowArea, out);
    }
    return out;
}

/** Two-level treemap data: top-level groups with their aggregated children. */
export interface TreemapGroup {
    key: string;
    label: string;
    size: number;
    kind: SymbolKind;
    items: TreemapItem[];
}

export function buildGroups(rows: SymbolRecord[], groupKeyOf: (s: SymbolRecord) => string): TreemapGroup[] {
    const groups = new Map<string, TreemapGroup>();
    for (const sym of rows) {
        if (sym.status === 'discarded' || sym.size <= 0) {
            continue;
        }
        const key = groupKeyOf(sym);
        let g = groups.get(key);
        if (!g) {
            g = { key, label: key, size: 0, kind: sym.kind, items: [] };
            groups.set(key, g);
        }
        g.size += sym.size;
        g.items.push({ key: `${key}::${sym.name}`, label: sym.demangled ?? sym.name, size: sym.size, kind: sym.kind });
    }
    return [...groups.values()].sort((a, b) => b.size - a.size);
}
