#define _GNU_SOURCE
#include <linux/landlock.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
/* Write confinement for 7-Zip, inherited by its children. Fail closed on old kernels. */
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) { fputs("Landlock no disponible: se requiere Linux >= 5.13 con Landlock habilitado para extraer de forma segura.\n", stderr); return 1; }
  uint64_t writes = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
    LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
    LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) writes |= (1ULL << 13); /* REFER */
  if (abi >= 3) writes |= (1ULL << 14); /* TRUNCATE */
  struct landlock_ruleset_attr rules = { .handled_access_fs = writes };
  int fd = syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
  int dir = open(argv[1], O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct landlock_path_beneath_attr allow = { .allowed_access = writes, .parent_fd = dir };
  if (fd < 0 || dir < 0 || syscall(SYS_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, &allow, 0) ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || syscall(SYS_landlock_restrict_self, fd, 0)) { perror("No se pudo aislar la extracción"); return 1; }
  close(fd); close(dir); execvp(argv[2], argv + 2); perror("No se pudo iniciar el extractor"); return 1;
}
