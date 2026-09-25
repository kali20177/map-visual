// 大静态数组测试用例
// 触发 .ldata 和 .lbss 段（当数据超过特定大小时）

#include <cstdio>
#include <cstdint>

// 注意：.ldata 和 .lbss 通常在以下情况下出现：
// 1. 使用大地址模型 (-mcmodel=large)
// 2. 数据量超过特定阈值（通常 > 8KB）

// 大型已初始化数据 - 可能触发 .ldata
// 128KB 的已初始化数组
static char large_initialized_data[128 * 1024] = {
    'A', 'B', 'C', 'D'  // 部分初始化，其余为零
};

// 大型未初始化数据 - 可能触发 .lbss
// 256KB 的未初始化数组
static char large_uninitialized_data[256 * 1024];

// 另一个大数组 - 64KB
static int large_int_array[16 * 1024];

// 普通大小的数据作为对比
static char normal_data[1024] = "normal sized data";

// 初始化大数组的函数
void init_large_data() {
    for (int i = 0; i < 4; ++i) {
        large_initialized_data[i] = static_cast<char>('A' + i);
    }

    // 访问未初始化数据以确保它被分配
    large_uninitialized_data[0] = 'X';
    large_uninitialized_data[128 * 1024 - 1] = 'Y';

    // 初始化 int 数组
    for (int i = 0; i < 16 * 1024; ++i) {
        large_int_array[i] = i;
    }
}

// 验证数据
int verify_data() {
    if (large_initialized_data[0] != 'A') return -1;
    if (large_uninitialized_data[0] != 'X') return -2;
    if (large_int_array[100] != 100) return -3;
    return 0;
}

int main() {
    printf("Large data test\n");
    printf("Initialized data size: %zu bytes\n", sizeof(large_initialized_data));
    printf("Uninitialized data size: %zu bytes\n", sizeof(large_uninitialized_data));
    printf("Int array size: %zu bytes\n", sizeof(large_int_array));

    init_large_data();

    int result = verify_data();
    if (result == 0) {
        printf("Data verification passed\n");
    } else {
        printf("Data verification failed: %d\n", result);
    }

    return result;
}
