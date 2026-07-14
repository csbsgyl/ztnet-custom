#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ZTNET_INSTALLER_SOURCE_ONLY=1
source "${TEST_DIR}/../one-click-install.sh"

assert_eq() {
	local expected="$1"
	local actual="$2"
	local message="$3"

	if [ "$expected" != "$actual" ]; then
		printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$message" "$expected" "$actual" >&2
		exit 1
	fi
}

DOCKER_MIRROR_URL="https://docker.xiaohangyun.org/"
normalize_mirror_url
assert_eq "docker.xiaohangyun.org" "$MIRROR_REGISTRY" "normalizes the mirror registry"
assert_eq \
	"docker.xiaohangyun.org/library/postgres:15.2-alpine" \
	"$(mirror_image_for "postgres:15.2-alpine")" \
	"rewrites an official Docker Hub image"
assert_eq \
	"docker.xiaohangyun.org/zyclonite/zerotier:1.14.2" \
	"$(mirror_image_for "zyclonite/zerotier:1.14.2")" \
	"rewrites a namespaced Docker Hub image"
assert_eq \
	"docker.xiaohangyun.org/library/postgres:15.2-alpine" \
	"$(mirror_image_for "registry-1.docker.io/library/postgres:15.2-alpine")" \
	"rewrites an explicit Docker Hub registry"
if mirror_image_for "ghcr.io/csbsgyl/ztnet-custom:latest" >/dev/null; then
	printf 'FAIL: generated a mirror candidate for an unsupported explicit registry\n' >&2
	exit 1
fi
assert_eq \
	"https://registry-1.docker.io/v2/" \
	"$(image_registry_url "postgres:15.2-alpine")" \
	"detects Docker Hub"
assert_eq \
	"https://ghcr.io/v2/" \
	"$(image_registry_url "ghcr.io/csbsgyl/ztnet-custom:latest")" \
	"detects an explicit registry"

docker() {
	return 1
}

DOCKER_MIRROR_MODE="auto"
MIRROR_AVAILABLE=1
probe_url() {
	return 1
}
run_docker_pull() {
	[ "$1" = "docker.xiaohangyun.org/library/postgres:15.2-alpine" ]
}
POSTGRES_IMAGE="postgres:15.2-alpine"
select_image "POSTGRES_IMAGE" "$POSTGRES_IMAGE" "" "POSTGRES_MIRROR_IMAGE"
assert_eq \
	"docker.xiaohangyun.org/library/postgres:15.2-alpine" \
	"$POSTGRES_IMAGE" \
	"selects the mirror when the source registry probe fails"

probe_url() {
	return 0
}
run_docker_pull() {
	[ "$1" = "docker.xiaohangyun.org/library/postgres:15.2-alpine" ]
}
POSTGRES_IMAGE="postgres:15.2-alpine"
select_image "POSTGRES_IMAGE" "$POSTGRES_IMAGE" "" "POSTGRES_MIRROR_IMAGE"
assert_eq \
	"docker.xiaohangyun.org/library/postgres:15.2-alpine" \
	"$POSTGRES_IMAGE" \
	"falls back to the mirror after a direct pull failure"

probe_url() {
	return 0
}
run_docker_pull() {
	[ "$1" = "ghcr.io/csbsgyl/ztnet-custom:latest" ]
}
ZTNET_IMAGE="ghcr.io/csbsgyl/ztnet-custom:latest"
select_image "ZTNET_IMAGE" "$ZTNET_IMAGE" "registry.example.com/ztnet-custom:latest" "ZTNET_MIRROR_IMAGE"
assert_eq \
	"ghcr.io/csbsgyl/ztnet-custom:latest" \
	"$ZTNET_IMAGE" \
	"prefers a reachable source registry in auto mode"

DOCKER_MIRROR_MODE="always"
probe_url() {
	return 1
}
run_docker_pull() {
	[ "$1" = "registry.example.com/ztnet-custom:latest" ]
}
ZTNET_IMAGE="ghcr.io/csbsgyl/ztnet-custom:latest"
select_image "ZTNET_IMAGE" "$ZTNET_IMAGE" "registry.example.com/ztnet-custom:latest" "ZTNET_MIRROR_IMAGE"
assert_eq \
	"registry.example.com/ztnet-custom:latest" \
	"$ZTNET_IMAGE" \
	"prefers an explicit fallback image in always mode"

printf 'one-click installer tests passed\n'
