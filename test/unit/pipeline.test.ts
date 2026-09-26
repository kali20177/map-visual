import { describe, expect, it } from 'vitest';
import { parseMapText } from '../../src/parser/pipeline';

/**
 * 零行结果永不静默（复审三轮 P4，docs/REVIEW-26a5b23.md）：
 * auto 检测只凭头部锚点（如 "Memory Configuration"）即可判格式——文件被
 * 截断 / 内容被裁剪时会得到 "0 B 固件 + 零告警 + exit 0" 的静默错答。
 */
describe('zero-row results are never silent', () => {
    it('warns on auto-detected but row-less maps (truncated file)', async () => {
        const text = ['Memory Configuration', '', 'FLASH            0x08000000 0x00100000 xr'].join('\n');
        const doc = await parseMapText(text, 'truncated.map', { demangle: false, formatOverride: 'auto' }, undefined);
        expect(doc.format).toBe('gnu-ld');
        expect(doc.symbols).toHaveLength(0);
        expect(doc.totals.flash).toBe(0);
        expect(doc.warnings.some((w) => w.message.includes('no rows parsed'))).toBe(true);
    });

    it('warns when a forced format yields no rows', async () => {
        const text = ['Linker script and memory map', '', '.text 0x1000 0x10 a.o'].join('\n');
        const doc = await parseMapText(text, 'forced.map', { demangle: false, formatOverride: 'lld' }, undefined);
        expect(doc.symbols).toHaveLength(0);
        expect(doc.warnings.some((w) => w.message.includes('format override'))).toBe(true);
    });
});
