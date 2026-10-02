#!/usr/bin/env bash
# Full LTO fixture: the whole program becomes one synthetic object named
# `<output>.elf.lto.o` in the In column — lld's only LTO tell in map files
# (ThinLTO uses `<output>.elf.lto.<file>.o` per module). Volatile globals keep
# .data alive so cross-TU attribution stays observable after inlining.
# Requires clang + ld.lld on PATH (or Homebrew llvm).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(mktemp -d /tmp/mapvisual-lld-lto-fixture.XXXXXX)"
CC="$(command -v clang || echo /opt/homebrew/opt/llvm/bin/clang)"
LD="$(command -v ld.lld || echo /opt/homebrew/opt/lld/bin/ld.lld)"

cd "$BUILD"
cat > mathx.c <<'EOF'
volatile int gate = 5;
int add2(int a, int b) { return a + b + gate; }   /* volatile read blocks const-fold */
static int triple(int x) { return x * 3; }
int math_combo(int x) { return triple(x) + add2(x, 1); }
EOF
cat > main.c <<'EOF'
extern int math_combo(int);
extern volatile unsigned int lto_data;
volatile unsigned int lto_data = 0x2a;
static const unsigned int lto_table[8] = {1,2,3,4,5,6,7,8};
int main(void) { return math_combo(3) + (int)lto_data + lto_table[2]; }
EOF

"$CC" --target=armv7m-none-eabi -mcpu=cortex-m3 -ffreestanding -nostdlib -O2 -flto -ffunction-sections -fdata-sections -c mathx.c main.c
"$LD" -Map "$DIR/lto_lld.map" -N --gc-sections -e main -o lto.elf mathx.o main.o
echo "lto_lld.map written to $DIR"
rm -rf "$BUILD"
