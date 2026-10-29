#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <linux/fs.h>
#include <errno.h>
/* Resolve every parent without following symlinks, then rename using pinned dirfds. */
static int parent(char *p, char **leaf) {
  if (p[0] != '/') { errno = EINVAL; return -1; }
  char *last = strrchr(p, '/'); *leaf = last + 1;
  if (!**leaf || !strcmp(*leaf, ".") || !strcmp(*leaf, "..")) { errno = EINVAL; return -1; }
  *last = 0;
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  char *save = NULL;
  for (char *s = strtok_r(p, "/", &save); s; s = strtok_r(NULL, "/", &save)) {
    if (!strcmp(s, ".") || !strcmp(s, "..")) { close(fd); errno = EINVAL; return -1; }
    int next = openat(fd, s, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(fd); if (next < 0) return -1; fd = next;
  }
  return fd;
}
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  char *a = strdup(argv[1]), *b = strdup(argv[2]), *from, *to;
  int src = parent(a, &from), dst = parent(b, &to);
  if (src < 0 || dst < 0 || syscall(SYS_renameat2, src, from, dst, to, RENAME_NOREPLACE)) {
    perror("No se pudo mover sin sobrescribir"); return 1;
  }
  fsync(dst); fsync(src); close(src); close(dst); free(a); free(b); return 0;
}
