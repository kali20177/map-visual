/*
 * Fixture source for firmware_shellcmd.map — dot-less custom input sections.
 *
 * `__attribute__((section("shellCommand")))` produces contribution lines whose
 * section token carries no leading dot (` shellCommand  <vma> <size> <obj>`),
 * which the parser must accept like any other contribution. Collected by
 * shell_link.ld via `*(shellCommand)`.
 */
typedef int (*cmd_fn)(int, char **);

struct shell_cmd {
    const char *name;
    cmd_fn fn;
};

static int cmd_ping(int argc, char **argv) { (void)argv; return argc; }
static int cmd_echo(int argc, char **argv) { (void)argv; return argc * 2; }

const struct shell_cmd shell_commands[] __attribute__((used, section("shellCommand"))) = {
    { "ping", cmd_ping },
    { "echo", cmd_echo },
};

int main(void) { return shell_commands[0].fn(1, 0) + shell_commands[1].fn(2, 0); }
