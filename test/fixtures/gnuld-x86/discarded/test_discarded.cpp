// 丢弃符号测试用例 - 包含会被链接器丢弃的符号

// 这些函数和变量会被链接器丢弃（未使用）
__attribute__((unused)) int unused_function() {
    return 123;
}

__attribute__((unused)) int unused_variable = 999;

static int static_unused() {
    return 456;
}

static int static_unused_var = 888;

// 实际使用的符号
int used_var = 42;

int used_function() {
    return used_var;
}

int main() {
    return used_function();
}
