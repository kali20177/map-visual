#!/usr/bin/env bash
# Regenerates the GNU ld (arm-none-eabi) fixtures. Requires Arm GNU Toolchain on PATH.
# Artifacts (objects/ELF) stay in a temp dir; only sources, link script and .map files are kept here.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(mktemp -d /tmp/mapvisual-arm-fixture.XXXXXX)"

cd "$BUILD"
cat > isr.cpp <<'EOF'
extern "C" __attribute__((section(".isr_vector"))) const void *vectors[] = {
    (const void *)0x20005000, // initial stack pointer
    (const void *)1,          // Reset
    (const void *)2,          // NMI
};
EOF

CFLAGS="-mcpu=cortex-m3 -mthumb -std=c++17 -O2"
arm-none-eabi-g++ $CFLAGS -c "$DIR/main.cpp" -o main.o
arm-none-eabi-g++ $CFLAGS -c "$DIR/lib.cpp"  -o lib.o
arm-none-eabi-g++ $CFLAGS -c isr.cpp -o isr.o
arm-none-eabi-g++ $CFLAGS -c "$DIR/stubs.cpp" -o stubs.o
arm-none-eabi-ar rcs libutil.a lib.o

LDFLAGS="-mcpu=cortex-m3 -mthumb -nostdlib -T "$DIR/link.ld" -Wl,--print-memory-usage"
# 1) primary fixture: -ffunction-sections/-fdata-sections + --gc-sections + archive member
arm-none-eabi-g++ $CFLAGS -ffunction-sections -fdata-sections \
  -Wl,--gc-sections -Wl,-Map="$DIR/firmware_sections_gc.map" $LDFLAGS \
  main.o isr.o stubs.o libutil.a -lgcc -o firmware.elf

# 2) baseline: no -ffunction-sections (monolithic .text, multi-symbol contributions)
arm-none-eabi-g++ $CFLAGS \
  -Wl,-Map="$DIR/firmware_basic.map" $LDFLAGS \
  main.o isr.o stubs.o libutil.a -lgcc -o firmware_basic.elf

# 3) --no-demangle: symbol lines stay mangled
arm-none-eabi-g++ $CFLAGS -ffunction-sections -fdata-sections \
  -Wl,--gc-sections,--no-demangle -Wl,-Map="$DIR/firmware_no_demangle.map" $LDFLAGS \
  main.o isr.o stubs.o libutil.a -lgcc -o firmware_nm.elf

echo "fixtures written to $DIR"
rm -rf "$BUILD"
