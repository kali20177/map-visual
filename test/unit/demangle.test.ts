import { describe, expect, it, beforeAll } from 'vitest';
import { Demangler, extractSectionSymbol, initDemangler, isMangled } from '../../src/demangle';
import { WASM_DIR } from './helpers';

/**
 * Expected values are the gecko-profiler-demangle (WASM) outputs verified
 * against the vectors ported from the imgui-gl3-glfw3-base corpus.
 * Style notes vs libiberty/c++filt: return types are omitted for templates
 * and vtables render compactly as {vtable(T)} — both fine for display.
 */
const VECTORS: Array<[string, string]> = [
    ['_ZN3foo3barERKNS_7MyClassE', 'foo::bar(foo::MyClass const&)'],
    ['_Z3fooIdET_S0_', 'foo<double>(double)'],
    ['_ZNSt6vectorIiSaIiEE9push_backEOi', 'std::vector<int, std::allocator<int> >::push_back(int&&)'],
    ['_ZNSt5dequeIiSaIiEE10push_frontEOi', 'std::deque<int, std::allocator<int> >::push_front(int&&)'],
    ['_ZplRK7MyClassS1_', 'operator+(MyClass const&, MyClass const&)'],
    ['_ZN7MyClassC1Ev', 'MyClass::MyClass()'],
    ['_ZN7MyClassD1Ev', 'MyClass::~MyClass()'],
    ['_ZNK7MyClass3getEv', 'MyClass::get() const'],
    ['_Z4funcRKiS0_PKc', 'func(int const&, int const&, char const*)'],
    ['_ZN3foo3bar3baz3quxE', 'foo::bar::baz::qux'],
    ['_ZTI7MyClass', 'typeinfo for MyClass'],
    ['_ZTS7MyClass', 'typeinfo name for MyClass'],
    ['_ZZ4mainE1x', 'main::x'],
];

describe('demangler (WASM)', () => {
    let demangler: Demangler;

    beforeAll(async () => {
        const ok = await initDemangler(WASM_DIR + '/index_bg.wasm');
        expect(ok).toBe(true);
        demangler = new Demangler();
    });

    it.each(VECTORS)('demangles %s', (input, expected) => {
        expect(demangler.demangle(input)).toBe(expected);
    });

    it('handles vtables in the engine compact style', () => {
        expect(demangler.demangle('_ZTV7MyClass')).toBe('{vtable(MyClass)}');
    });

    it('falls back to a prefix map for guard variables', () => {
        // real-world shape: guard for static local `s` in MyClass::get()
        expect(demangler.demangle('_ZGVZN7MyClass3getEvE1s')).toBe('guard variable for MyClass::get()::s');
        expect(demangler.demangle('_ZGVZ4mainE3buf')).toBe('guard variable for main::buf');
    });

    it('returns null for non-mangled names', () => {
        expect(demangler.demangle('main')).toBeNull();
        expect(demangler.demangle('plain_text')).toBeNull();
        expect(demangler.demangle('not_a_mangled_name')).toBeNull();
    });

    it('caches repeated calls', () => {
        expect(demangler.demangle('_ZN3foo3barERKNS_7MyClassE')).toBe('foo::bar(foo::MyClass const&)');
        expect(demangler.demangle('_ZN3foo3barERKNS_7MyClassE')).toBe('foo::bar(foo::MyClass const&)');
    });
});

describe('isMangled / extractSectionSymbol', () => {
    it('detects Itanium mangled names', () => {
        expect(isMangled('_ZN3app4mainEv')).toBe(true);
        expect(isMangled('_Z3fooi')).toBe(true);
        expect(isMangled('main')).toBe(false);
        expect(isMangled('_Z')).toBe(false);
        expect(isMangled('operator new')).toBe(false);
    });

    it('extracts symbols embedded in section names', () => {
        expect(extractSectionSymbol('.text._ZN3app4mainEv')).toBe('_ZN3app4mainEv');
        expect(extractSectionSymbol('.rodata._ZL13prime_numbers')).toBe('_ZL13prime_numbers');
        expect(extractSectionSymbol('.ARM.exidx.text._ZN3app11clamp_valueIiEET_S1_S1_S1_')).toBe('_ZN3app11clamp_valueIiEET_S1_S1_S1_');
        // linker annotations after the mangled name are stripped
        expect(extractSectionSymbol('.text._ZN3app1fEv.constprop.0')).toBe('_ZN3app1fEv');
        expect(extractSectionSymbol('.text')).toBeNull();
        expect(extractSectionSymbol('.comment')).toBeNull();
    });
});
