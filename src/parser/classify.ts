import type { SymbolKind } from '../types';

/**
 * Section-name → kind classification (prefix match, first hit wins).
 * Order matters: more specific prefixes must come before their generic parents.
 * Grounded in the fixture corpus; see docs/FORMATS.md §1.6.
 */
const PREFIX_TABLE: ReadonlyArray<readonly [string, SymbolKind]> = [
    // meta — non-alloc, debug/annotation
    ['.debug', 'meta'],
    ['.stab', 'meta'],
    ['.symtab', 'meta'],
    ['.strtab', 'meta'],
    ['.shstrtab', 'meta'],
    ['.line', 'meta'],
    ['.comment', 'meta'],
    ['.gnu.build.attributes', 'meta'],
    ['.gnu.attributes', 'meta'],
    ['.arm.attributes', 'meta'],
    ['.jcr', 'meta'],
    ['.tm_clone_table', 'meta'],
    // Xtensa per-function properties / literal-annotation records: the ELF
    // marks them non-alloc (no A flag), so they hold no image bytes
    ['.xt.', 'meta'],
    ['.xtensa.', 'meta'],
    // RISC-V build attribute records (ESP32-C3/C6/H2), non-alloc like .xt.*
    ['.riscv.attributes', 'meta'],
    // init/fini arrays must match before .init/.fini
    ['.init_array', 'other'],
    ['.fini_array', 'other'],
    ['.preinit_array', 'other'],
    ['.ctors', 'other'],
    ['.dtors', 'other'],
    // unwind tables live in flash but are not code
    ['.arm.exidx', 'rodata'],
    ['.arm.extab', 'rodata'],
    // code
    ['.text', 'code'],
    ['.init', 'code'],
    ['.fini', 'code'],
    ['.plt', 'code'],
    ['.iplt', 'code'],
    ['.vectors', 'code'],
    ['.iram', 'code'],
    // ESP-IDF WiFi ROM-patch routines are emitted straight into IRAM under
    // these names; they are code despite not starting with `.text`
    ['.wifirxiram', 'code'],
    ['.wifi0iram', 'code'],
    ['.wifislprxiram', 'code'],
    // More of the same family: extra/sleep IRAM payloads (placed in
    // .flash.text or .iram0.text depending on the IDF build) and the Xtensa
    // register-window overflow vectors
    ['.wifiextrairam', 'code'],
    ['.wifislpiram', 'code'],
    ['.phyiram', 'code'],
    // Xtensa exception/interrupt vector stubs: IDF's vectors.S names them
    // without a `.text`/`.iram` prefix, but they live in .iram0.vectors.
    // classifySection lowercases first, so these tokens must be lowercase.
    ['.windowvectors', 'code'],
    ['.doubleexceptionvector', 'code'],
    ['.level', 'code'],
    // RISC-V exception vectors (ESP32-C3/C6/H2) live in .iram0.text
    ['.exception_vectors', 'code'],
    // ESP32-C2 BT controller IRAM payloads (BLE release-IRAM layout):
    // connection/ISR routines and coexistence glue
    ['.conn_iram1', 'code'],
    ['.isr_iram1', 'code'],
    ['.coexiram', 'code'],
    ['.nmiexceptionvector', 'code'],
    ['.kernelexceptionvector', 'code'],
    ['.userexceptionvector', 'code'],
    ['._invalid_pc_placeholder', 'code'],
    // ESP-IDF RTC segments: `.rtc.text` is code, the rest is initialized
    // data / zero-init (`.rtc.force_*` are the RTC_SLOW/RTC_FAST payloads)
    ['.rtc.text', 'code'],
    ['.glue_7', 'code'],
    ['.v4_bx', 'code'],
    ['.vfp11_veneer', 'code'],
    // rodata
    ['.rodata', 'rodata'],
    ['.eh_frame', 'rodata'],
    ['.gcc_except', 'rodata'],
    ['.gnu_extab', 'rodata'],
    ['.note', 'rodata'],
    ['.interp', 'rodata'],
    ['.gnu.hash', 'rodata'],
    ['.dynsym', 'rodata'],
    ['.dynstr', 'rodata'],
    ['.gnu.version', 'rodata'],
    ['.sframe', 'rodata'],
    ['.rel', 'rodata'], // .rel.* / .rela.*
    ['.hash', 'rodata'],
    ['.isr_vector', 'rodata'],
    // Xtensa literal pools (4-byte literals are both `.literal.*` and `.lit4`)
    ['.literal', 'rodata'],
    ['.lit4', 'rodata'],
    ['.srodata', 'rodata'],
    ['.rtc.rodata', 'rodata'],
    // data
    ['.data', 'data'],
    ['.got', 'data'],
    ['.igot', 'data'],
    ['.dynamic', 'data'],
    ['.tdata', 'data'],
    ['.ldata', 'data'],
    ['.sdata', 'data'],
    // BT LE release-IRAM layout: .dram0.bt.bss must be matched before the
    // generic `.dram` → data rule (it is a NOBITS section)
    ['.dram0.bt.bss', 'bss'],
    ['.dram', 'data'],
    ['.rtc.data', 'data'],
    ['.rtc.force_slow', 'data'],
    ['.rtc.force_fast', 'data'],
    ['.rtc_timer_data_in_rtc_mem', 'data'],
    // bss
    ['.bss', 'bss'],
    ['.ext_ram.bss', 'bss'],
    ['.ext_ram_noinit', 'bss'],
    ['.rtc.bss', 'bss'],
    ['.rtc_noinit', 'bss'],
    ['.tbss', 'bss'],
    ['.lbss', 'bss'],
    ['.sbss', 'bss'],
    ['.noinit', 'bss'],
];

/**
 * Dot-less output section names, matched exactly — Zephyr's generated linker
 * script prints `text` / `rodata` / `datas` / `bss` / `noinit` / ... without a
 * leading dot. Exact match (not prefix) so a hypothetical `database` section
 * stays `other`.
 */
const EXACT_TABLE: ReadonlyArray<readonly [string, SymbolKind]> = [
    ['text', 'code'],
    ['ramfunc', 'code'],
    ['rodata', 'rodata'],
    ['datas', 'data'],
    ['data', 'data'],
    ['sdata', 'data'],
    ['device_states', 'data'],
    ['bss', 'bss'],
    ['sbss', 'bss'],
    ['noinit', 'bss'],
    // CubeMX heap/stack NOLOAD section — its echoed load address is not part
    // of the image, same semantics as `.bss`
    ['._user_heap_stack', 'bss'],
];

export function classifySection(rawName: string): SymbolKind {
    const name = rawName.toLowerCase();
    const exact = EXACT_TABLE.find(([token]) => token === name);
    if (exact) {
        return exact[1];
    }
    if (name === 'common' || name === 'large_common') {
        return 'bss';
    }
    for (const [prefix, kind] of PREFIX_TABLE) {
        if (name.startsWith(prefix)) {
            return kind;
        }
    }
    return 'other';
}
