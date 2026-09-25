// 简单测试用例 - 少量函数和全局变量

int global_var = 42;

int add(int a, int b) {
    return a + b;
}

int main() {
    return add(global_var, 1);
}
