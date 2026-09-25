import * as fs from 'node:fs';

/**
 * C++ symbol demangling built on gecko-profiler-demangle (the Rust/WASM
 * demangler shipped with the Firefox Profiler — Itanium + Rust coverage).
 *
 * The package's default entry (index.js) does `import * as wasm from
 * './index_bg.wasm'`, which needs a bundler-aware wasm pipeline. We bypass it:
 * instantiate the .wasm ourselves and hand the exports to the glue via
 * `__wbg_set_wasm`, passing the glue module itself as the imports object
 * (new wasm-bindgen layout: the wasm imports its shims from './index_bg.js').
 */

type BgModule = {
    __wbg_set_wasm: (exports: unknown) => void;
    __wbindgen_start?: () => void;
    demangle_any: (name: string) => string;
};

let rawDemangle: ((name: string) => string) | null = null;
let initPromise: Promise<boolean> | null = null;

export function initDemangler(wasmPath: string): Promise<boolean> {
    if (initPromise) {
        return initPromise;
    }
    initPromise = (async () => {
        try {
            const bg: BgModule = await import('gecko-profiler-demangle/index_bg.js');
            const bytes = fs.readFileSync(wasmPath);
            const { instance } = await WebAssembly.instantiate(bytes, { './index_bg.js': bg });
            bg.__wbg_set_wasm(instance.exports);
            (instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();
            rawDemangle = (name) => bg.demangle_any(name);
            return true;
        } catch {
            rawDemangle = null;
            return false;
        }
    })();
    return initPromise;
}

export function demanglerAvailable(): boolean {
    return rawDemangle !== null;
}

/** A name that plausibly Itanium-mangles. `_Z` + at least one more char. */
export function isMangled(name: string): boolean {
    return name.length > 2 && (name.startsWith('_Z') || name.startsWith('__Z'));
}

/**
 * Pull the mangled symbol embedded in a linker section name:
 * `.text._ZN3app4mainEv` → `_ZN3app4mainEv`,
 * `.ARM.exidx.text._ZN...constprop.0` → `_ZN...` (mangled names never contain '.',
 * so anything after the first dot is a linker annotation).
 * Returns null when the section does not embed one.
 */
export function extractSectionSymbol(section: string): string | null {
    const idx = section.lastIndexOf('._Z');
    if (idx < 0) {
        return null;
    }
    let sym = section.slice(idx + 1);
    const dot = sym.indexOf('.');
    if (dot > 0) {
        sym = sym.slice(0, dot);
    }
    return /^[A-Za-z0-9_]+$/.test(sym) ? sym : null;
}

/**
 * Cached demangler. demangle() returns null for non-mangled input or when the
 * engine is unavailable — callers fall back to the raw name.
 */
export class Demangler {
    private cache = new Map<string, string | null>();

    /** Known libiberty-style special prefixes the WASM engine skips (e.g. `_ZGV` guard variables). */
    private static readonly PREFIX_FALLBACKS: ReadonlyArray<readonly [string, string]> = [
        ['_ZGV', 'guard variable for '],
    ];

    demangle(name: string): string | null {
        if (this.cache.has(name)) {
            return this.cache.get(name)!;
        }
        let result: string | null = null;
        if (rawDemangle && isMangled(name)) {
            try {
                // special prefixes get the prefix map first — the engine
                // degrades on them (e.g. `_ZGV...` → `ZGV...`)
                const needsFallback = Demangler.PREFIX_FALLBACKS.some(([p]) => name.startsWith(p));
                if (needsFallback) {
                    result = Demangler.prefixFallback(name);
                } else {
                    const direct = rawDemangle(name);
                    result = direct !== name ? direct : null;
                }
            } catch {
                result = null;
            }
        }
        this.cache.set(name, result);
        return result;
    }

    private static prefixFallback(name: string): string | null {
        for (const [prefix, label] of Demangler.PREFIX_FALLBACKS) {
            if (name.startsWith(prefix)) {
                const rest = '_Z' + name.slice(prefix.length);
                try {
                    const demangled = rawDemangle?.(rest);
                    if (demangled && demangled !== rest) {
                        return label + demangled;
                    }
                } catch {
                    // fall through
                }
            }
        }
        return null;
    }
}
