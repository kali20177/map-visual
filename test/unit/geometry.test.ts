import { describe, expect, it } from 'vitest';
import { fixtureMaps, parseFixture } from './helpers';
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
