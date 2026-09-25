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
    // data
    ['.data', 'data'],
    ['.got', 'data'],
    ['.igot', 'data'],
    ['.dynamic', 'data'],
    ['.tdata', 'data'],
    ['.ldata', 'data'],
    ['.sdata', 'data'],
    ['.dram', 'data'],
    // bss
    ['.bss', 'bss'],
    ['.tbss', 'bss'],
    ['.lbss', 'bss'],
    ['.sbss', 'bss'],
    ['.noinit', 'bss'],
];

export function classifySection(rawName: string): SymbolKind {
    const name = rawName.toLowerCase();
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
