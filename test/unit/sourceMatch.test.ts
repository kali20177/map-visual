import { describe, expect, it } from 'vitest';
import { objectStem, rankCandidates, sourceGlobPatterns } from '../../src/sourceMatch';

describe('objectStem', () => {
    it('strips object suffixes', () => {
        expect(objectStem('main.o', null)).toBe('main');
        expect(objectStem('main.cpp.o', null)).toBe('main.cpp');
        expect(objectStem('startup_stm32f103.s.obj', null)).toBe('startup_stm32f103.s');
    });

    it('prefers the archive member', () => {
        expect(objectStem('libutil.a(lib.o)', 'lib.o')).toBe('lib');
        expect(objectStem('/p/libutil.a(lib.o)', null)).toBe('lib');
    });

    it('returns null for compiler temporaries and non-objects', () => {
        expect(objectStem('/tmp/ccAbCdEf.o', null)).toBeNull();
        expect(objectStem('main.ltrans0.ltrans.o', null)).toBeNull();
        expect(objectStem('linker stubs', null)).toBeNull();
        expect(objectStem('[pad]', null)).toBeNull();
        expect(objectStem('', null)).toBeNull();
    });
});

describe('sourceGlobPatterns', () => {
    it('tries the exact file first, then extensions', () => {
        expect(sourceGlobPatterns('main.cpp.o', null)).toEqual(['**/main.cpp', '**/main.cpp.{c,cc,cpp,cxx,c++,m,mm,s,S}']);
    });

    it('generates the extension alternation for bare stems', () => {
        expect(sourceGlobPatterns('main.o', null)).toEqual(['**/main.{c,cc,cpp,cxx,c++,m,mm,s,S}']);
    });

    it('returns nothing for unresolvable objects', () => {
        expect(sourceGlobPatterns('/tmp/ccXyZ12.o', null)).toEqual([]);
        expect(sourceGlobPatterns('linker stubs', null)).toEqual([]);
    });
});

describe('rankCandidates', () => {
    it('prefers shallow, short paths', () => {
        expect(
            rankCandidates([
                '/a/b/c/d/main.cpp',
                '/w/main.cpp',
                '/a/bb/main.cpp',
            ]),
        ).toEqual(['/w/main.cpp', '/a/bb/main.cpp', '/a/b/c/d/main.cpp']);
    });
});
