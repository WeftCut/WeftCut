#if defined(__linux__)

/*
 * Copyright (c) 2026 Naman Harshwal <namanharshwal@gmail.com>
 *
 * Fallback definitions for ISO C23 symbols introduced in GLIBC 2.38.
 * When compiling on GLIBC >= 2.38 (e.g. GitHub Actions ubuntu-latest / Ubuntu 24.04),
 * standard functions in statically linked C dependencies may be redirected by headers
 * to __isoc23_sscanf and __isoc23_strtol.
 * Providing these symbols internally ensures the compiled native addon resolves them
 * without requiring GLIBC 2.38+ at runtime, restoring compatibility with Ubuntu 22.04 LTS
 * (GLIBC 2.35) and Debian 12.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>

int __isoc23_sscanf(const char *s, const char *format, ...) {
    va_list args;
    va_start(args, format);
    int ret = vsscanf(s, format, args);
    va_end(args);
    return ret;
}

long int __isoc23_strtol(const char *nptr, char **endptr, int base) {
    return strtol(nptr, endptr, base);
}

#endif
