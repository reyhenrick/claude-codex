#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>

/* A kernel-held lock survives exec and is released on process exit, including crashes.
   There is no PID-file stale-lock recovery race and no token in process arguments. */
int main(int argc, char **argv) {
    if (argc < 4) return 64;
    struct stat directory;
    if (lstat(argv[1], &directory) != 0 || !S_ISDIR(directory.st_mode) || directory.st_uid != getuid()) return 73;
    if (chmod(argv[1], 0700) != 0) return 73;
    char path[PATH_MAX];
    int length = snprintf(path, sizeof(path), "%s/service.lock", argv[1]);
    if (length < 0 || (size_t)length >= sizeof(path)) return 73;
    int descriptor = open(path, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    struct stat info;
    if (descriptor < 0 || fstat(descriptor, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid()) return 73;
    if (fchmod(descriptor, 0600) != 0) return 73;
    if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) return errno == EWOULDBLOCK ? 75 : 73;
    int flags = fcntl(descriptor, F_GETFD);
    if (flags < 0 || fcntl(descriptor, F_SETFD, flags & ~FD_CLOEXEC) != 0) return 73;
    char lockDescriptor[24]; snprintf(lockDescriptor, sizeof(lockDescriptor), "%d", descriptor);
    setenv("CODEX_ACCOUNTS_LOCK_FD", lockDescriptor, 1);
    setenv("CODEX_ACCOUNTS_RUNTIME", argv[1], 1);
    execv(argv[2], &argv[2]);
    return 71;
}
