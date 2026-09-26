import type { MapDocument, MapTotals, MemoryRegion, SymbolRecord, Storage, SymbolKind } from '../types';
import { EMPTY_KIND_TOTALS } from '../types';
import { classifySection } from '../parser/classify';
import type { Warnings } from '../parser/warnings';

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
    // data — and other-kind contributions with a load image (Zephyr's struct
    // sections print under dot-less script names like `._k_heap.static.*`,
    // classified other), and fills inside an initialized section: the bytes
    // live in the flash load image and at the runtime address
    if (sym.kind === 'data' || (sym.kind === 'other' && sym.lma != null) || (sym.isFill && sym.lma != null)) {
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
    // code / rodata / other / pad — follow the VMA region
    if (vmaRegion) {
        // a downgraded region (see finalize) holds no allocatable content —
        // e.g. (COPY) sections parked in a scratch address space
        if (vmaRegion.role === 'other') {
            return [];
        }
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
export function finalize(doc: MapDocument, warnings?: Warnings): MapDocument {
    assignRegionRoles(doc.regions, doc.symbols);
    downgradeContentlessRegions(doc.regions, doc.symbols);
    if (warnings) {
        warnRegionRoleConflicts(doc.regions, warnings);
    }
    doc.totals = computeStorageAndTotals(doc);
    return doc;
}

// Same name families the name fallback uses — a strong mismatch between what
// the content anchors decided and what the region is called means the single
// anchor misfired (e.g. code linked to run from RAM lands first). `itcm` is
// deliberately not in the flash set here: anchoring it to ram is physically
// right, so neither direction should warn.
const FLASH_CONFLICT_RE = /(flash|rom)/i;
const RAM_CONFLICT_RE = /(ram|sram|dtcm|dram|aon|psram|sdram|ocram|data)/i;

/**
 * Cross-check the content anchors against region names. The anchor logic is
 * deliberately name-blind, but it only has single-sided evidence — when its
 * verdict contradicts a strong RAM/flash name the roles are probably swapped
 * wholesale (i.MX RT style code-in-RAM layouts) and the user gets no signal.
 * Names carrying both word families (FLASH_DATA, ROM_DATA, ...) are
 * ambiguous by themselves — trust the anchor there.
 */
function warnRegionRoleConflicts(regions: MemoryRegion[], warnings: Warnings): void {
    for (const r of regions) {
        if (r.role === 'flash' && RAM_CONFLICT_RE.test(r.name) && !FLASH_CONFLICT_RE.test(r.name)) {
            warnings.add(`region "${r.name}" holds executable content but its name suggests RAM — flash/ram roles may be swapped`);
        } else if (r.role === 'ram' && FLASH_CONFLICT_RE.test(r.name) && !RAM_CONFLICT_RE.test(r.name)) {
            warnings.add(`region "${r.name}" holds zero-init content but its name suggests flash — flash/ram roles may be swapped`);
        }
    }
}

/**
 * Regions whose kept contents are entirely non-alloc kinds ("other"/"meta" —
 * e.g. a (COPY) output section parked in a scratch address space behind a
 * ROM-ish name) occupy no storage; downgrade them so their symbols claim none.
 * A region counts as holding storage content when storage-kind symbols live at
 * its VMA, when their load image (lma) lands in it, or when fills belonging to
 * a storage-kind section sit in it. A region holding no rows but fills is
 * never downgraded: pad-only NOLOAD heap/stack sections still occupy storage,
 * and a fill's kind is inherited from its section, so it proves nothing about
 * the region's own alloc semantics.
 */
function downgradeContentlessRegions(regions: MemoryRegion[], symbols: SymbolRecord[]): void {
    const storageKinds = new Set<SymbolKind>(['code', 'rodata', 'data', 'bss']);
    const inRegion = (addr: number, r: MemoryRegion): boolean => addr >= r.origin && addr < r.origin + r.length;
    const reaches = (s: SymbolRecord, r: MemoryRegion): boolean =>
        s.status === 'kept' && (inRegion(s.addr, r) || (s.lma != null && inRegion(s.lma, r)));
    const holdsStorage = (s: SymbolRecord, r: MemoryRegion): boolean => {
        const kind = s.isFill ? classifySection(s.section) : s.kind;
        return storageKinds.has(kind) && reaches(s, r);
    };
    for (const r of regions) {
        if (r.role === 'other') {
            continue;
        }
        if (!symbols.some((s) => reaches(s, r) && !s.isFill)) {
            continue;
        }
        if (!symbols.some((s) => holdsStorage(s, r))) {
            r.role = 'other';
        }
    }
}

export type { SymbolKind };
