#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>
#include <libproc.h>

static int acquire_lock(const char *directory, const char *name, int blocking) {
    char path[PATH_MAX];
    int length = snprintf(path, sizeof(path), "%s/%s", directory, name);
    if (length < 0 || (size_t)length >= sizeof(path)) { errno = EINVAL; return -1; }
    int descriptor = open(path, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    struct stat info;
    if (descriptor < 0) return -1;
    if (fstat(descriptor, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1 || fchmod(descriptor, 0600) != 0) {
        close(descriptor); errno = EACCES; return -1;
    }
    while (flock(descriptor, LOCK_EX | (blocking ? 0 : LOCK_NB)) != 0) {
        if (errno == EINTR) continue;
        int failure = errno; close(descriptor); errno = failure; return -1;
    }
    int flags = fcntl(descriptor, F_GETFD);
    if (flags < 0 || fcntl(descriptor, F_SETFD, flags & ~FD_CLOEXEC) != 0) { close(descriptor); return -1; }
    return descriptor;
}

static void export_descriptor(const char *name, int descriptor) {
    char value[24]; snprintf(value, sizeof(value), "%d", descriptor); setenv(name, value, 1);
}

/* A kernel-held lock survives exec and is released on process exit, including crashes.
   There is no PID-file stale-lock recovery race and no token in process arguments. */
int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "--process-identity") == 0) {
        char *end; errno = 0; long parsed = strtol(argv[2], &end, 10);
        if (errno || *end || parsed <= 1 || parsed > INT_MAX) return 64;
        struct proc_bsdinfo info;
        if (proc_pidinfo((int)parsed, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_uid != getuid()) return 69;
        printf("%ld:%llu:%llu\n", parsed, (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
        return 0;
    }
    int offset = 1, blocking = 0;
    int guard = argc > 1 && strcmp(argv[1], "--update-guard") == 0;
    const char *lock_name = "service.lock", *descriptor_name = "CODEX_ACCOUNTS_LOCK_FD";
    if (argc > 1 && strcmp(argv[1], "--initialize") == 0) {
        offset = 2; blocking = 1; lock_name = "initialization.lock";
        descriptor_name = "CODEX_ACCOUNTS_INIT_LOCK_FD";
    } else if (argc > 1 && strcmp(argv[1], "--maintain") == 0) {
        offset = 2; lock_name = "maintenance.lock";
        descriptor_name = "CODEX_ACCOUNTS_MAINTENANCE_LOCK_FD";
    } else if (guard) {
        offset = 2; lock_name = "update.lock";
    }
    if (argc < offset + (guard ? 1 : 3)) return 64;
    struct stat directory;
    if (lstat(argv[offset], &directory) != 0 || !S_ISDIR(directory.st_mode) || directory.st_uid != getuid()) return 73;
    if (chmod(argv[offset], 0700) != 0) return 73;
    int descriptor = acquire_lock(argv[offset], lock_name, blocking);
    if (descriptor < 0) return errno == EWOULDBLOCK ? 75 : 73;
    if (guard) {
        puts("ready"); fflush(stdout);
        char input[64];
        while (1) {
            ssize_t count = read(STDIN_FILENO, input, sizeof(input));
            if (count == 0) return 0;
            if (count < 0 && errno != EINTR) return 74;
        }
    }
    unsetenv("CODEX_ACCOUNTS_LOCK_FD");
    unsetenv("CODEX_ACCOUNTS_INIT_LOCK_FD");
    unsetenv("CODEX_ACCOUNTS_MAINTENANCE_LOCK_FD");
    unsetenv("CODEX_ACCOUNTS_UPDATE_LOCK_FD");
    if (strcmp(lock_name, "maintenance.lock") == 0) {
        int update = acquire_lock(argv[offset], "update.lock", 0);
        if (update < 0) return errno == EWOULDBLOCK ? 75 : 73;
        export_descriptor("CODEX_ACCOUNTS_UPDATE_LOCK_FD", update);
    }
    export_descriptor(descriptor_name, descriptor);
    setenv("CODEX_ACCOUNTS_RUNTIME", argv[offset], 1);
    execv(argv[offset + 1], &argv[offset + 1]);
    return 71;
}
