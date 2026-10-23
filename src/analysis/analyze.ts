import type { MapDocument, MapTotals, MemoryRegion, SymbolRecord, Storage, SymbolKind } from '../types';
import { EMPTY_KIND_TOTALS } from '../types';
import { classifySection } from '../parser/classify';
import type { Warnings } from '../parser/warnings';

function regionOf(regions: MemoryRegion[], addr: number): MemoryRegion | undefined {
    return regions.find((r) => addr >= r.origin && addr < r.origin + r.length);
}

/**
 * ESP-IDF's segment names are canonical across targets and are stronger
 * evidence than content mass: `iram0_2_seg` is the IROM window despite its
 * name, and a small app can legitimately carry more IRAM code than IROM
 * code (classic ESP32 hello_world: 51.7 KB IRAM vs 47.4 KB IROM), which
 * makes a pure code-mass vote call IRAM flash. Exact names only — other
 * vendors' regions still go through the content anchors.
 */
const IDF_REGION_ROLES: Readonly<Record<string, 'flash' | 'ram'>> = {
    iram0_0_seg: 'ram',
    iram0_2_seg: 'flash',
    irom0_0_seg: 'flash',
    dram0_0_seg: 'ram',
    drom0_0_seg: 'flash',
    rtc_iram_seg: 'ram',
    rtc_data_seg: 'ram',
    rtc_slow_seg: 'ram',
    rtc_reserved_seg: 'ram',
    rtc_fast_reserved_seg: 'ram',
    rtc_slow_reserved_seg: 'ram',
    extern_ram_seg: 'ram',
};

/** Region-name families used when the content anchors leave a region open. */
const FLASH_NAME_RE = /(flash|rom|itcm)/i;
// `rtc` is RAM too (RTC slow/fast memory); ESP-IDF names its segments
// `rtc_slow_seg` / `rtc_reserved_seg`, which no other family matches.
const RAM_NAME_RE = /(ram|sram|dtcm|dram|aon|psram|sdram|ocram|rtc|data)/i;

/** Sum of the kept, non-fill rows of one kind per region (VMA). */
function kindMass(regions: MemoryRegion[], symbols: SymbolRecord[], kind: SymbolKind): Map<MemoryRegion, number> {
    const mass = new Map<MemoryRegion, number>();
    for (const s of symbols) {
        if (s.status !== 'kept' || s.isFill || s.isReserve || s.kind !== kind || s.size <= 0) {
            continue;
        }
        const region = regionOf(regions, s.addr);
        if (region) {
            mass.set(region, (mass.get(region) ?? 0) + s.size);
        }
    }
    return mass;
}

/** Give `role` to the region carrying the most of `kind`, if still open. */
function anchorByMass(
    regions: MemoryRegion[],
    symbols: SymbolRecord[],
    kind: SymbolKind,
    role: 'flash' | 'ram',
): void {
    const mass = kindMass(regions, symbols, kind);
    let best: MemoryRegion | undefined;
    let bestSize = 0;
    let bestNameMatch = false;
    // Tie-break: a region whose name matches the role wins over an anonymous
    // one; otherwise regions order keeps the verdict stable. Regions already
    // settled (IDF names) are never candidates — an anchor may pick the
    // largest code region even when that region is the RAM alias holding
    // BT/IRAM code.
    for (const r of regions) {
        if (r.role !== 'other') {
            continue;
        }
        const size = mass.get(r) ?? 0;
        if (size <= 0) {
            continue;
        }
        const nameMatch = role === 'flash' ? FLASH_NAME_RE.test(r.name) : RAM_NAME_RE.test(r.name);
        if (size > bestSize || (size === bestSize && nameMatch && !bestNameMatch)) {
            best = r;
            bestSize = size;
            bestNameMatch = nameMatch;
        }
    }
    if (best && best.role === 'other') {
        best.role = role;
    }
}

/**
 * Decide the flash/ram role of each Memory Configuration region.
 * Anchors beat names: the region carrying the most .text (code) is flash,
 * the one carrying the most .bss is ram; remaining regions fall back to
 * conventional naming (FLASH/ROM vs RAM/SRAM/DTCM/...).
 *
 * Mass beats "first row" because maps print sections in script order, not
 * by importance: ESP-IDF prints `.iram0.vectors`/`.iram0.text` (real IRAM,
 * 100 KB) before `.flash.text` (IROM, >1 MB), so a first-code anchor pinned
 * IRAM as flash and let the name fallback call the `iram0_2_seg` IROM
 * window ram — both roles inverted.
 */
export function assignRegionRoles(regions: MemoryRegion[], symbols: SymbolRecord[]): void {
    for (const r of regions) {
        r.role = 'other';
    }
    if (regions.length === 0) {
        return;
    }
    for (const r of regions) {
        const role = IDF_REGION_ROLES[r.name];
        if (role) {
            r.role = role;
        }
    }
    anchorByMass(regions, symbols, 'code', 'flash');
    anchorByMass(regions, symbols, 'bss', 'ram');
    for (const r of regions) {
        if (r.role !== 'other') {
            continue;
        }
        if (FLASH_NAME_RE.test(r.name)) {
            r.role = 'flash';
        } else if (RAM_NAME_RE.test(r.name)) {
            r.role = 'ram';
        }
    }
}

/**
 * Output-section names whose whole extent is a placeholder address window,
 * not image content. ESP-IDF's linker script parks them at the start of the
 * MMU windows: `.flash_rodata_dummy` / `.ext_ram.dummy` even overlap at
 * 0x3c000020 (they alias the same window for different mappings) and the
 * ELF marks all of them NOBITS. The names are conventional and terminal
 * (`...dummy`, `...noload`, `...text_end`, `...heap_start`, `.iram0.end`)
 * — matching a mere token keeps real input sections like
 * `.text.z_dummy_thread_init` out.
 */
const RESERVE_SECTION_RE = /(?:^|[._-])(?:dummy|noload|text_end|heap_start|(?:dram0|iram0)\.end)$/i;

/** Flag rows whose output section only reserves address space. */
export function markReserveRows(symbols: SymbolRecord[]): void {
    for (const sym of symbols) {
        sym.isReserve =
            sym.status === 'kept' && sym.outSection != null && RESERVE_SECTION_RE.test(sym.outSection);
    }
}

function computeStorage(sym: SymbolRecord, regions: MemoryRegion[]): Storage[] {
    if (sym.status === 'discarded' || sym.isReserve) {
        return [];
    }
    // Fills parse as kind 'pad' but their bytes belong to the enclosing
    // section — storage follows the section's class (the region-role pass
    // applies the same rule): a .data fill occupies flash+ram, a .text fill
    // only flash, a .bss fill only ram, a fill inside non-alloc metadata
    // nothing. Without this, regionless parsers (lld) would claim ram for
    // every fill via the load-image rule below.
    const kind = sym.isFill ? classifySection(sym.section) : sym.kind;
    // Non-alloc annotation/debug content occupies no storage.
    if (kind === 'meta') {
        return [];
    }
    const vmaRegion = regionOf(regions, sym.addr);
    const lmaRegion = sym.lma != null ? regionOf(regions, sym.lma) : undefined;

    if (kind === 'bss') {
        return ['ram'];
    }
    // data — and other-kind contributions with a load image at a DIFFERENT
    // address (Zephyr's struct sections print under dot-less script names
    // like `._k_heap.static.*`, classified other): the bytes live in the
    // flash load image and at the runtime address. An other-kind section
    // with VMA == LMA is in-place (.init_array walked in flash, script-
    // emitted signature words) — the load image IS the runtime image, no
    // RAM claim; region-ful parsers reach the same verdict via region
    // roles, regionless ones (lld) only have the address equality.
    if (kind === 'data' || (kind === 'other' && sym.lma != null && sym.lma !== sym.addr)) {
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
    // Initialized code/rodata living in a RAM region still has a load image:
    // ESP-IDF's IRAM code and DRAM-resident rodata are copied out of flash,
    // and its map prints no LMA for them (the ELF carries it in PT_LOAD).
    // This mirrors the `.data` branch above — following the VMA alone would
    // report the 1 MB IROM sibling correctly but leave 100 KB+ of IRAM code
    // out of flash while still claiming it as ram.
    if ((kind === 'code' || kind === 'rodata') && vmaRegion?.role === 'ram') {
        const set = new Set<Storage>();
        if (lmaRegion ? lmaRegion.role === 'flash' : true) {
            set.add('flash');
        }
        set.add('ram');
        return [...set];
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
    // Self-contained for direct callers (tests, future MCP): reserve marking
    // only needs the row's own output section, never a prior pass.
    markReserveRows(symbols);
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
        // Placeholder windows tile an address range but hold no bytes of
        // their own; counting them would report 2.6 MB of ESP-IDF dummy
        // fills as pad and swamp the composition bar.
        if (sym.isReserve) {
            continue;
        }
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
    // Mark placeholder windows before the role/downgrade passes so their
    // rows never look like evidence that a region holds storage content.
    markReserveRows(doc.symbols);
    assignRegionRoles(doc.regions, doc.symbols);
    downgradeContentlessRegions(doc.regions, doc.symbols);
    if (warnings) {
        warnRegionRoleConflicts(doc.regions, warnings);
    }
    doc.totals = computeStorageAndTotals(doc);
    return doc;
}

// Same name families the name fallback uses — a strong mismatch between what
// the content anchors decided and what the region is called means the mass
// anchor misfired (e.g. the largest code region is RAM that executes in
// place). `itcm` is deliberately not in the flash set here: anchoring it to
// ram is physically right, so neither direction should warn.
const FLASH_CONFLICT_RE = /(flash|rom)/i;
// `(?<![i])ram` keeps Xtensa's `iram0_2_seg` out: ESP-IDF historically names
// the IROM (flash instruction window, 0x42000000) `iram0_2_seg`, so a flash
// verdict there is the documented layout, not a swapped pair. Plain `iram`
// regions still classify as ram via RAM_NAME_RE.
const RAM_CONFLICT_RE = /(sram|dtcm|dram|aon|psram|sdram|ocram|rtc|data|(?<![i])ram)/i;

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
            warnings.add('regionRoleSwappedRam', { params: [r.name] });
        } else if (r.role === 'ram' && FLASH_CONFLICT_RE.test(r.name) && !RAM_CONFLICT_RE.test(r.name)) {
            warnings.add('regionRoleSwappedFlash', { params: [r.name] });
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
        s.status === 'kept' &&
        !s.isReserve &&
        (inRegion(s.addr, r) || (s.lma != null && inRegion(s.lma, r)));
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
