#!/usr/bin/env bash
# C++ fixture: two TUs, templates/inline (comdat dedup), vtables in
# -fdata-sections section names (`.rodata._ZTV...`), .init_array, align-1
# before align-8 input sections (inter-input padding), local symbol suffix
# ` (.0)`. Symbol rows are DEMANGLED — lld demangles map symbol names by
# default; mangled names survive only in section names (recovered there).
# Requires clang++ + ld.lld on PATH (or Homebrew llvm).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(mktemp -d /tmp/mapvisual-lld-cpp-fixture.XXXXXX)"
CC="$(command -v clang++ || echo /opt/homebrew/opt/llvm/bin/clang++)"
LD="$(command -v ld.lld || echo /opt/homebrew/opt/lld/bin/ld.lld)"

cd "$BUILD"
cat > hw.hpp <<'EOF'
#pragma once
namespace app {
class Widget {
public:
    virtual int render(int pass);
    static int instance_count;
};
class Led : public Widget {
public:
    int render(int pass) override;
};
template <typename T>
T clamp(T v, T lo, T hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}
inline int scale(int x) { return x * 3; }
extern "C" int c_entry(int a, int b);
int run(int a, int b);
}
EOF

cat > widget.cpp <<'EOF'
#include "hw.hpp"
namespace app {
volatile int seed = 7;
int Widget::instance_count = 0;
int Widget::render(int pass) { return pass; }
int Led::render(int pass) { return clamp(pass, 0, 100) + scale(instance_count); }
struct Gadget {
    Gadget() : v(seed) {}   /* dynamic init -> .init_array (volatile read, not foldable) */
    int v;
};
Gadget gadget;
}
EOF

cat > main.cpp <<'EOF'
#include "hw.hpp"
namespace app {
Widget w;
Led led;
Widget* widgets[] = { &w, &led };
static unsigned int pool[4] = {10, 20, 30, 40};
static unsigned int scratch[8];
char lead_in = 'x';                 /* align-1 data section before align-8 one */
long long wide_probe = 0x1122334455667788LL;
int run(int a, int b) {
    scratch[0] = clamp(a, 1, 99) + scale(b) + (int)wide_probe + lead_in;
    return widgets[0]->render(pool[0]) + widgets[1]->render(pool[1]) + scratch[0];
}
}
extern "C" int c_entry(int a, int b) { return app::run(a, b); }
extern "C" int _start() { return c_entry(2, 3); }
EOF

"$CC" --target=armv7m-none-eabi -mcpu=cortex-m3 -mfloat-abi=soft -ffreestanding -nostdlib -fno-exceptions -fno-rtti -O2 -ffunction-sections -fdata-sections -c widget.cpp main.cpp
"$LD" -Map "$DIR/cpp_lld.map" -N --gc-sections -e _start -o cpp.elf widget.o main.o
echo "cpp_lld.map written to $DIR"
rm -rf "$BUILD"
