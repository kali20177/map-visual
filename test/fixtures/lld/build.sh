#!/usr/bin/env bash
# Regenerates the LLVM lld fixture (tabular -Map format).
# Requires ld.lld on PATH: `brew install lld` or any llvm toolchain shippping lld.
# Only the .map file is kept; objects stay in a temp dir.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(mktemp -d /tmp/mapvisual-lld-fixture.XXXXXX)"
LD="$(command -v ld.lld || echo /opt/homebrew/opt/lld/bin/ld.lld)"

cd "$BUILD"
cat > main.c <<'EOF'
extern unsigned int shared_counter;
unsigned int shared_counter = 7;
static const unsigned int table[4] = {1, 2, 3, 4};
static unsigned int buffer[16];
int compute(int a) { return a + table[1]; }
int main(void) {
    buffer[0] = compute(1);
    shared_counter++;
    return buffer[0];
}
EOF

clang --target=armv7m-none-eabi -mcpu=cortex-m3 -ffreestanding -nostdlib -O2 -c main.c -o main.o
"$LD" -Map "$DIR/firmware_lld.map" -N --gc-sections -e main -o firmware.elf main.o
echo "fixture written to $DIR"
rm -rf "$BUILD"
