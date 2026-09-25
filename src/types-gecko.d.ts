/**
 * wasm-bindgen "new layout" glue module: the bg module both exposes the API
 * and provides the wasm imports (passed as the imports object under its own
 * module name — see src/demangle/index.ts).
 */
declare module 'gecko-profiler-demangle/index_bg.js' {
    export function __wbg_set_wasm(exports: unknown): void;
    export const __wbindgen_start: (() => void) | undefined;
    export function demangle_any(name: string): string;
}
