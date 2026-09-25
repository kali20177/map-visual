namespace util {

int add3(int a, int b, int c) { return a + b + c; }

// kept in the archive but not referenced -> gc'd at link time
int helper(int v) { return v ^ 0x55; }

} // namespace util
