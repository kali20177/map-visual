// Minimal runtime stubs so -nostdlib links succeed while keeping libgcc
// unwind tables (.ARM.exidx) in the map — mirrors what real firmware does.
#include <cstddef>

extern "C" void abort() {
    for (;;) {
    }
}

extern "C" void *memcpy(void *dst, const void *src, size_t n) {
    auto *d = static_cast<unsigned char *>(dst);
    const auto *s = static_cast<const unsigned char *>(src);
    while (n--) {
        *d++ = *s++;
    }
    return dst;
}

extern "C" void *memset(void *dst, int c, size_t n) {
    auto *d = static_cast<unsigned char *>(dst);
    while (n--) {
        *d++ = static_cast<unsigned char>(c);
    }
    return dst;
}
