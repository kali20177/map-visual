/*
 * Fixture source for firmware_common.map (-fcommon build).
 *
 * -fcommon places uninitialized globals in the linker's COMMON block, which
 * GNU ld reports as ` COMMON  <vma> <size> <obj>` contribution lines in the
 * memory map — no leading dot in the section name. The linker script collects
 * them into .bss via *(COMMON), and `--print-memory-usage` is the golden
 * baseline for the parser's RAM total.
 */
int a_common;
int b_common[4];
static int s_bss;
int init_var = 42;
const char msg[] = "hi";
int add(int x, int y) { return x + y; }
int main(void) { return add(a_common, b_common[0]) + s_bss + msg[0] + init_var; }
