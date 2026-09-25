// ifunc 测试用例 - 间接函数
// 触发 .iplt 段

#include <cstdio>
#include <cstdint>

// CPU 特性检测 - 简单示例
#ifdef __x86_64__

// 基础实现
static int add_impl_basic(int a, int b) {
    return a + b;
}

// 模拟的优化实现（实际应用中可能使用 SSE/AVX）
static int add_impl_optimized(int a, int b) {
    // 这里可以是有 SIMD 优化的版本
    return a + b;
}

// 解析器函数 - 返回要使用的实际函数
// 必须是 extern "C" 以避免名称修饰
extern "C" void* resolve_add() {
    // 在实际应用中，这里会检测 CPU 特性
    // 例如检查是否支持 AVX2 等
    printf("Resolver called - selecting implementation\n");

    // 简单检测：总是返回优化版本
    return reinterpret_cast<void*>(add_impl_optimized);
}

// 声明 ifunc - 函数地址由 resolver 决定
extern "C" int add(int, int) __attribute__((ifunc("resolve_add")));

#else
// 非 x86_64 平台的替代实现
int add(int a, int b) { return a + b; }
#endif

// 另一个 ifunc 示例：字符串长度计算
static std::size_t strlen_impl_basic(const char* s) {
    std::size_t len = 0;
    while (*s++) ++len;
    return len;
}

extern "C" void* resolve_strlen() {
    return reinterpret_cast<void*>(strlen_impl_basic);
}

extern "C" std::size_t fast_strlen(const char*) __attribute__((ifunc("resolve_strlen")));

int main() {
    printf("Testing ifunc:\n");
    printf("add(1, 2) = %d\n", add(1, 2));
    printf("add(10, 20) = %d\n", add(10, 20));
    printf("fast_strlen(\"hello\") = %zu\n", fast_strlen("hello"));
    return 0;
}
