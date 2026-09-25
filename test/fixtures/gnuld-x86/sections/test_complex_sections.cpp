// 复杂测试用例 - 开启 -ffunction-sections -fdata-sections
// 包含多种段类型

// text 段 - 代码段
int add(int a, int b) {
    return a + b;
}

int multiply(int a, int b) {
    return a * b;
}

void process_data() {
    for (int i = 0; i < 10; ++i) {
        add(i, i);
    }
}

// rodata 段 - 只读数据
const char* greeting = "Hello, World!";
const int prime_numbers[] = {2, 3, 5, 7, 11, 13};

// data 段 - 已初始化的可读写数据
int initialized_var = 100;
char buffer[64] = "initialized data";

// bss 段 - 未初始化的数据
int uninitialized_var;
char large_buffer[1024];

int main() {
    process_data();
    return add(initialized_var, uninitialized_var);
}
