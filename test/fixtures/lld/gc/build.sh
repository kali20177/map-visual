#!/usr/bin/env bash
# gc-sections multi-object fixture: -ffunction-sections/-fdata-sections with
# --gc-sections (unused function/data silently absent from the map), COMMON
# symbols (`util.o:(COMMON)`, one In row per symbol), data-in-code mapping
# symbols ($d inside a function from inline asm), and align-8 padding after an
# align-1 input section in .data (7 bytes).
# Requires clang + ld.lld on PATH (or Homebrew llvm).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(mktemp -d /tmp/mapvisual-lld-gc-fixture.XXXXXX)"
CC="$(command -v clang || echo /opt/homebrew/opt/llvm/bin/clang)"
LD="$(command -v ld.lld || echo /opt/homebrew/opt/lld/bin/ld.lld)"

cd "$BUILD"
cat > util.c <<'EOF'
volatile char pad_probe = 'p';
volatile long long ll_probe = 0x1122334455667788LL;
int common_a;              /* -fcommon -> COMMON */
char common_b[8];
static const unsigned int unused_table[8] = {0};  /* gc'd */
void util_used(int *p) { *p += 1; }
void util_unused(void) {}  /* gc'd */
EOF
cat > main.c <<'EOF'
extern void util_used(int *);
extern volatile char pad_probe;
extern volatile long long ll_probe;
extern char common_b[8];
extern int poolkeeper(int);
int common_a;
static volatile char bss_tail[12];
int main(void) {
    int v = 0;
    util_used(&v);
    bss_tail[0] = v + pad_probe;
    common_a = bss_tail[0];
    common_b[0] = (char)(ll_probe >> 33) + poolkeeper(1);
    return common_a + common_b[0] + bss_tail[0];
}
EOF
cat > pool.c <<'EOF'
int poolkeeper(int x) {
    if (x > 1000) {
        __asm volatile(".word 0xdeadbeef");
    }
    return x + 1;
}
EOF

"$CC" --target=armv7m-none-eabi -mcpu=cortex-m3 -ffreestanding -nostdlib -O2 -ffunction-sections -fdata-sections -fcommon -c util.c main.c pool.c
"$LD" -Map "$DIR/gc_lld.map" -N --gc-sections -e main -o gc.elf util.o main.o pool.o
echo "gc_lld.map written to $DIR"
rm -rf "$BUILD"
