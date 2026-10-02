#!/usr/bin/env bash
# Static library fixture: archive member In rows (`libnet.a(net.o):(.text...)`),
# an unreferenced member never pulled (audio.o), a pulled member whose unused
# function is gc'd, and align-4 padding between archive members' input
# sections (net_send ends mid-word, crc32 starts word-aligned).
# Requires clang + ld.lld + llvm-ar on PATH (or Homebrew llvm).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(mktemp -d /tmp/mapvisual-lld-archive-fixture.XXXXXX)"
CC="$(command -v clang || echo /opt/homebrew/opt/llvm/bin/clang)"
AR="$(command -v llvm-ar || echo /opt/homebrew/opt/llvm/bin/llvm-ar)"
LD="$(command -v ld.lld || echo /opt/homebrew/opt/lld/bin/ld.lld)"

cd "$BUILD"
cat > crc.c <<'EOF'
unsigned int crc32(const unsigned char *p, int n) {
    unsigned int c = 0xffffffffu;
    while (n--) { c ^= *p++; for (int i = 0; i < 8; i++) c = (c >> 1) ^ (0xedb88320u & -(c & 1)); }
    return ~c;
}
EOF
cat > net.c <<'EOF'
extern unsigned int crc32(const unsigned char *, int);
static unsigned char frame[64];
void net_send(const unsigned char *p, int n) {
    for (int i = 0; i < n && i < 60; i++) frame[i] = p[i];
    *(unsigned int *)(frame + 60) = crc32(frame, n);
}
void net_unused(void) {}   /* member pulled but this function gc'd */
EOF
cat > audio.c <<'EOF'
void audio_mix(short *dst, const short *src, int n) { while (n--) *dst++ = *src++; }
EOF
cat > main.c <<'EOF'
extern void net_send(const unsigned char *, int);
static const unsigned char payload[8] = {1,2,3,4,5,6,7,8};
int main(void) { net_send(payload, 8); return 0; }
EOF

"$CC" --target=armv7m-none-eabi -mcpu=cortex-m3 -ffreestanding -nostdlib -O2 -ffunction-sections -fdata-sections -c crc.c net.c audio.c main.c
"$AR" rcs libnet.a crc.o net.o audio.o
"$LD" -Map "$DIR/archive_lld.map" -N --gc-sections -e main -o archive.elf main.o libnet.a
echo "archive_lld.map written to $DIR"
rm -rf "$BUILD"
