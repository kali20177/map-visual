// TLS 测试用例 - thread_local 变量
// 触发 .tdata 和 .tbss 段

#include <cstdio>

// .tdata 段 - 已初始化的 thread_local 数据
thread_local int tls_initialized = 42;
thread_local char tls_buffer[64] = "thread local initialized";
thread_local const char* tls_ptr = "tls pointer data";

// .tbss 段 - 未初始化的 thread_local 数据
thread_local int tls_uninitialized;
thread_local char tls_large_buffer[1024];
thread_local double tls_values[16];

// text 段 - 普通函数
int get_tls_value() {
    return tls_initialized + tls_uninitialized;
}

void set_tls_value(int v) {
    tls_initialized = v;
}

// 每个线程独立的计数器
thread_local int thread_counter = 0;

int increment_counter() {
    return ++thread_counter;
}

int main() {
    printf("TLS initialized: %d\n", tls_initialized);
    printf("TLS buffer: %s\n", tls_buffer);
    printf("TLS pointer: %s\n", tls_ptr);

    tls_uninitialized = 100;
    printf("TLS uninitialized after set: %d\n", tls_uninitialized);

    printf("Thread counter: %d\n", increment_counter());
    printf("Thread counter again: %d\n", increment_counter());

    return get_tls_value();
}
