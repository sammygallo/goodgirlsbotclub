# Postgres 16 + pgvector, built on the SAME Alpine base as the stock
# image so the pgdata volume stays byte-compatible. See
# docs/pgvector-migration-plan.md for why we do not use the published
# Debian-based pgvector images.
ARG PG_VERSION=16

FROM postgres:${PG_VERSION}-alpine AS build

# Pin the extension version explicitly — an unpinned build means the
# extension can change under a routine image rebuild.
ARG PGVECTOR_VERSION=v0.8.0

# `with_llvm = yes` is baked into this base image's PGXS Makefile.global,
# and passing `with_llvm=no` to make does NOT suppress the bitcode targets
# — the build reaches them and dies on a missing clang. So we install the
# toolchain and ship the bitcode instead.
#
# The versions are NOT interchangeable: PGXS hardcodes `CLANG = clang-21`
# and `LLVM_BINPATH = /usr/lib/llvm21/bin`, while Alpine's unversioned
# `llvm-dev` is LLVM 22. Pin to 21 to match what PGXS will actually invoke.
RUN apk add --no-cache build-base git clang21 llvm21-dev

RUN git clone --branch "${PGVECTOR_VERSION}" --depth 1 \
        https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && cd /tmp/pgvector \
    # OPTFLAGS="" strips pgvector's default -march=native. Without it the
    # CI runner's CPU features get baked in and the binary can SIGILL on
    # the droplet's different CPU.
    && make OPTFLAGS="" \
    && make install

FROM postgres:${PG_VERSION}-alpine
COPY --from=build /usr/local/lib/postgresql/vector.so \
                  /usr/local/lib/postgresql/
COPY --from=build /usr/local/share/postgresql/extension/vector* \
                  /usr/local/share/postgresql/extension/
# JIT bitcode — the base image has with_llvm enabled, so Postgres expects
# to find it for any extension that ships it.
COPY --from=build /usr/local/lib/postgresql/bitcode/vector.index.bc \
                  /usr/local/lib/postgresql/bitcode/
COPY --from=build /usr/local/lib/postgresql/bitcode/vector \
                  /usr/local/lib/postgresql/bitcode/vector/
