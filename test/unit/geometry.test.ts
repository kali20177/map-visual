import { describe, expect, it } from 'vitest';
import { fixtureMaps, parseFixture, readFixture } from './helpers';
import type { SymbolRecord } from '../../src/types';

/**
 * 几何不变量（复审三轮 P3，docs/REVIEW-26a5b23.md）：
 * "总量正确"对行级几何错位完全免疫——符号区间越过贡献末尾时前缀空洞与
 * 尾部越界互相抵消，totals 分毫不差。本文件把"按输出段分组的零重叠零
 * 空隙"提升为全语料断言（此前只覆盖 real/stm32f103-rb-demo-boot 一份），
 * 任何 allocateSizes / tiling 回归都会在这里红。
 *
 * 审计口径与 dist/cli.js 导出一致：kept、非 meta、size>0 的行，按
 * outSection 分组后做区间合并。组间不合并——(COPY) 段的 scratch 地址空间
 * （DEVNULL_ROM）与真实段 VMA 本就允许重叠。
 */

interface Span {
    a: number;
    b: number;
}

function spans(rows: SymbolRecord[]): Span[] {
    return rows
        .map((s) => ({ a: s.addr, b: s.addr + s.size }))
        .sort((x, y) => x.a - y.a || x.b - y.b);
}

function audit(sp: Span[]): { overlap: number; gap: number } {
    let overlap = 0;
    let gap = 0;
    let curB: number | null = null;
    for (const { a, b } of sp) {
        if (curB == null) {
            curB = b;
            continue;
        }
        if (a >= curB) {
            gap += a - curB;
            curB = b;
        } else {
            overlap += Math.min(curB, b) - a;
            curB = Math.max(curB, b);
        }
    }
    return { overlap, gap };
}

describe('geometric invariant — per-output-section zero overlap, zero gaps (whole corpus)', () => {
    for (const rel of fixtureMaps()) {
        it(rel, async () => {
            const doc = await parseFixture(rel);
            const by = new Map<string, SymbolRecord[]>();
            for (const s of doc.symbols) {
                if (s.status !== 'kept' || s.kind === 'meta' || s.size <= 0) {
                    continue;
                }
                const key = s.outSection ?? `(none:${s.section})`;
                if (!by.has(key)) {
                    by.set(key, []);
                }
                by.get(key)!.push(s);
            }
            const problems: string[] = [];
            for (const [key, rows] of by) {
                const { overlap, gap } = audit(spans(rows));
                if (overlap > 0 || gap > 0) {
                    problems.push(`${key}: overlap=${overlap} gap=${gap}`);
                }
            }
            expect(problems).toEqual([]);
        });
    }
});

describe('warning invariants — no tiling/extent/role-conflict noise on the corpus', () => {
    // 复审四轮建议动作 5：这三类告警在现有语料上的基线是 0，靠人工扫容易漏
    it('every fixture stays clean of fallback and role-swap warnings', async () => {
        for (const rel of fixtureMaps()) {
            const doc = await parseFixture(rel);
            const noise = doc.warnings.filter(
                (w) =>
                    w.message.includes('tiling search failed') ||
                    w.message.includes('extent unknown') ||
                    w.message.includes('may be swapped'),
            );
            expect(noise).toEqual([]);
        }
    });
});

describe('raw map line invariant — every row points at a real raw line (split-mode locate)', () => {
    // 分栏定位的根基：行内点击要落回原始 map 文件。除解析器合成的
    // *unsym* 前缀垫行外，每行都必须有 1-based 行号，且命中的原始行要真的
    // 包含该行的名字——宿主的 G4 守卫就是这么判的（行内找不到名字即回
    // rawLineMissing），所以这里不给任何行留豁免：段级行（无符号行的
    // 贡献，`-ffunction-sections`/LTO/libgcc 里大量存在）也必须指向印着
    // 段名的段头行，而不是只印地址/尺寸/目标文件的贡献行。
    it('records a line for every row, and every line names its row', async () => {
        for (const rel of fixtureMaps()) {
            const lines = readFixture(rel).split('\n');
            const doc = await parseFixture(rel);
            for (const s of doc.symbols) {
                if (s.line == null) {
                    // 解析器合成的行没有原始行可指：*unsym* 是 GNU ld 贡献内
                    // 首符号前的垫行，*fill* 是 lld 段间对齐 padding（lld map
                    // 根本不打印 fill 行，无从借行）
                    expect(['*unsym*', '*fill*'], `${rel}: row without a raw line`).toContain(s.name);
                    continue;
                }
                const raw = lines[s.line - 1];
                expect(raw, `${rel}:${s.line} (${s.name}) out of range`).toBeDefined();
                expect(raw!.length, `${rel}:${s.line} (${s.name}) blank line`).toBeGreaterThan(0);
                expect(raw!.includes(s.name), `${rel}:${s.line} should name "${s.name}", got: ${raw!.trim().slice(0, 80)}`).toBe(true);
            }
        }
    });

    // 同一原始行被两个不同名字的记录共享会让"点击定位"产生歧义——解析器
    // 的行消费是一行一类的，这个不变量钉住该结构性质（REVIEW-8f2c358 §3）
    it('no raw line is claimed by two different rows', async () => {
        for (const rel of fixtureMaps()) {
            const doc = await parseFixture(rel);
            const byLine = new Map<number, string>();
            for (const s of doc.symbols) {
                if (s.line == null) {
                    continue;
                }
                const prev = byLine.get(s.line);
                expect(prev, `${rel}:${s.line} claimed by "${prev}" and "${s.name}"`).toBeUndefined();
                byLine.set(s.line, s.name);
            }
        }
    });
});
