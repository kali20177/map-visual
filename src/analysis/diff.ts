import type { DiffRow, DiffResult, MapDocument, SymbolKind } from '../types';

/**
 * Map Diff (M5): compare two parsed maps symbol-by-symbol.
 * Matching key = mangled name when known, else the raw name — stable across
 * builds of the same project. Rows are aggregated per key first (the same
 * symbol name can come from several objects/sections, e.g. static functions),
 * so the diff answers "how much did this symbol grow/shrink" in one line.
 * Discarded rows and fill padding are excluded; they surface via the totals.
 * Row/status types live in types.ts (shared with host + webview).
 */

interface Aggregated {
    key: string;
    name: string;
    kind: SymbolKind;
    size: number;
    objects: Set<string>;
}

function aggregate(doc: MapDocument): Map<string, Aggregated> {
    const map = new Map<string, Aggregated>();
    for (const sym of doc.symbols) {
        if (sym.status === 'discarded' || sym.isFill) {
            continue;
        }
        const key = sym.mangled ?? sym.name;
        let entry = map.get(key);
        if (!entry) {
            entry = { key, name: sym.demangled ?? sym.name, kind: sym.kind, size: 0, objects: new Set() };
            map.set(key, entry);
        }
        entry.size += sym.size;
        if (sym.demangled) {
            entry.name = sym.demangled;
        }
        if (sym.object && sym.object !== '[pad]') {
            entry.objects.add(sym.object);
        }
    }
    return map;
}

export function diffDocuments(a: MapDocument, b: MapDocument): DiffResult {
    const aggA = aggregate(a);
    const aggB = aggregate(b);

    const rows: DiffRow[] = [];
    const keys = new Set<string>([...aggA.keys(), ...aggB.keys()]);
    for (const key of keys) {
        const ea = aggA.get(key);
        const eb = aggB.get(key);
        const sizeA = ea?.size ?? 0;
        const sizeB = eb?.size ?? 0;
        const delta = sizeB - sizeA;
        const status = !ea ? 'added' : !eb ? 'removed' : delta !== 0 ? 'changed' : 'same';
        const name = eb?.name ?? ea!.name;
        const kind = eb?.kind ?? ea!.kind;
        rows.push({
            key,
            name,
            kind,
            status,
            sizeA,
            sizeB,
            delta,
            objectA: ea ? [...ea.objects].sort().join(', ') || null : null,
            objectB: eb ? [...eb.objects].sort().join(', ') || null : null,
        });
    }

    rows.sort((x, y) => {
        // biggest impact first: |delta| desc, then status, then name
        if (Math.abs(x.delta) !== Math.abs(y.delta)) {
            return Math.abs(y.delta) - Math.abs(x.delta);
        }
        const rank = (s: string): number => (s === 'added' ? 0 : s === 'removed' ? 1 : s === 'changed' ? 2 : 3);
        if (rank(x.status) !== rank(y.status)) {
            return rank(x.status) - rank(y.status);
        }
        return x.name.toLowerCase().localeCompare(y.name.toLowerCase());
    });

    return { fileA: a.file, fileB: b.file, rows, totalsA: a.totals, totalsB: b.totals };
}
