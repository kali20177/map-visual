import type { MapDocument, MapTotals, MemoryRegion, SymbolRecord, Storage, SymbolKind } from '../types';
import { EMPTY_KIND_TOTALS } from '../types';

function regionOf(regions: MemoryRegion[], addr: number): MemoryRegion | undefined {
    return regions.find((r) => addr >= r.origin && addr < r.origin + r.length);
}

/**
 * Decide the flash/ram role of each Memory Configuration region.
 * Anchors beat names: the region holding the first .text (code) is flash,
 * the one holding the first .bss is ram; remaining regions fall back to
 * conventional naming (FLASH/ROM vs RAM/SRAM/DTCM/...).
 */
export function assignRegionRoles(regions: MemoryRegion[], symbols: SymbolRecord[]): void {
    for (const r of regions) {
        r.role = 'other';
    }
    if (regions.length === 0) {
        return;
    }
    const firstCode = symbols.find((s) => s.status === 'kept' && s.kind === 'code' && !s.isFill);
    const firstBss = symbols.find((s) => s.status === 'kept' && s.kind === 'bss' && !s.isFill);
    const anchor = (sym: SymbolRecord | undefined, role: 'flash' | 'ram'): void => {
        if (!sym) {
            return;
        }
        const region = regionOf(regions, sym.addr);
        if (region && region.role === 'other') {
            region.role = role;
        }
    };
    anchor(firstCode, 'flash');
    anchor(firstBss, 'ram');
    for (const r of regions) {
        if (r.role !== 'other') {
            continue;
        }
        if (/(flash|rom|itcm)/i.test(r.name)) {
            r.role = 'flash';
        } else if (/(ram|sram|dtcm|dram|aon|psram|sdram|ocram|data)/i.test(r.name)) {
            r.role = 'ram';
        }
    }
}

function computeStorage(sym: SymbolRecord, regions: MemoryRegion[]): Storage[] {
    if (sym.status === 'discarded') {
        return [];
    }
    // Non-alloc annotation/debug content occupies no storage.
    if (sym.kind === 'meta') {
        return [];
    }
    const vmaRegion = regionOf(regions, sym.addr);
    const lmaRegion = sym.lma != null ? regionOf(regions, sym.lma) : undefined;

    if (sym.kind === 'bss') {
        return ['ram'];
    }
    if (sym.kind === 'data') {
        const set = new Set<Storage>();
        // initializer bytes live in flash (lma), runtime image in ram (vma)
        if (lmaRegion ? lmaRegion.role === 'flash' : true) {
            set.add('flash');
        }
        if (vmaRegion ? vmaRegion.role === 'ram' : true) {
            set.add('ram');
        }
        return set.size > 0 ? [...set] : ['ram'];
    }
    // code / rodata / meta / other / pad — follow the VMA region, fall back to flash
    if (vmaRegion && vmaRegion.role !== 'other') {
        return [vmaRegion.role];
    }
    if (lmaRegion && lmaRegion.role === 'ram') {
        return ['ram'];
    }
    return ['flash'];
}

export function computeStorageAndTotals(doc: MapDocument): MapTotals {
    const { regions, symbols } = doc;
    const kindTotals = EMPTY_KIND_TOTALS();
    let flash = 0;
    let ram = 0;
    let keptCount = 0;
    let discardedCount = 0;
    let fillTotal = 0;

    for (const sym of symbols) {
        sym.storage = computeStorage(sym, regions);
        if (sym.status === 'discarded') {
            discardedCount++;
            continue;
        }
        keptCount++;
        kindTotals[sym.kind] += sym.size;
        if (sym.isFill) {
            fillTotal += sym.size;
        }
        if (sym.storage.includes('flash')) {
            flash += sym.size;
        }
        if (sym.storage.includes('ram')) {
            ram += sym.size;
        }
    }

    const regionUsage = regions.map((region) => {
        const roleStorage: Storage = region.role === 'ram' ? 'ram' : 'flash';
        let used = 0;
        for (const sym of symbols) {
            if (sym.status !== 'kept') {
                continue;
            }
            const vmaIn = sym.addr >= region.origin && sym.addr < region.origin + region.length;
            const lmaIn = sym.lma != null && sym.lma >= region.origin && sym.lma < region.origin + region.length;
            // zero-init sections echo a load address too — only count a symbol
            // into a region when its storage actually claims that kind
            if (vmaIn && sym.storage.includes(roleStorage)) {
                used += sym.size;
            } else if (!vmaIn && lmaIn && sym.storage.includes('flash')) {
                used += sym.size;
            }
        }
        return { region, used };
    });

    return { flash, ram, keptCount, discardedCount, fillTotal, kindTotals, regions: regionUsage };
}

/** Convenience for the pipeline: mutates doc with roles + storage + totals. */
export function finalize(doc: MapDocument): MapDocument {
    assignRegionRoles(doc.regions, doc.symbols);
    doc.totals = computeStorageAndTotals(doc);
    return doc;
}

export type { SymbolKind };
