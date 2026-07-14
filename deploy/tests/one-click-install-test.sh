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

assert_file_contains() {
	local file="$1"
	local expected="$2"
	local message="$3"

	if ! grep -Fq "$expected" "$file"; then
		printf 'FAIL: %s\nmissing: %s\n' "$message" "$expected" >&2
		exit 1
	fi
}

assert_file_not_contains() {
	local file="$1"
	local unexpected="$2"
	local message="$3"

	if grep -Fq "$unexpected" "$file"; then
		printf 'FAIL: %s\nunexpected: %s\n' "$message" "$unexpected" >&2
		exit 1
	fi
}

TEST_TMP="$(mktemp -d)"
cleanup_test() {
	rm -rf "$TEST_TMP"
}
trap cleanup_test EXIT

INSTALL_DIR="${TEST_TMP}/existing"
mkdir -p "$INSTALL_DIR"
cat > "${INSTALL_DIR}/.env" <<'EOF'
POSTGRES_USER=existing-user
POSTGRES_PASSWORD=existing-database-secret
POSTGRES_DB=existing-database
POSTGRES_PORT=5432
NEXTAUTH_URL=https://ztnet.example.com
NEXTAUTH_SECRET=existing-auth-secret
NEXTAUTH_URL_INTERNAL=http://ztnet:3000
AUTO_UPDATE=false
AUTO_UPDATE_INTERVAL=7200
AUTO_UPDATE_CLEANUP=true
EOF

POSTGRES_USER_PROVIDED=""
POSTGRES_DB_PROVIDED=""
POSTGRES_PASSWORD_PROVIDED=""
NEXTAUTH_SECRET_PROVIDED=""
NEXTAUTH_URL_PROVIDED=""
AUTO_UPDATE_PROVIDED=""
AUTO_UPDATE_INTERVAL_PROVIDED=""
AUTO_UPDATE_CLEANUP_PROVIDED=""
POSTGRES_USER="postgres"
POSTGRES_DB="ztnet"
POSTGRES_PASSWORD=""
NEXTAUTH_SECRET=""
NEXTAUTH_URL=""
AUTO_UPDATE="true"
AUTO_UPDATE_INTERVAL="3600"
AUTO_UPDATE_CLEANUP="false"
load_existing_environment
validate_auto_update
assert_eq "existing-user" "$POSTGRES_USER" "preserves the existing database user"
assert_eq "existing-database" "$POSTGRES_DB" "preserves the existing database name"
assert_eq "existing-database-secret" "$POSTGRES_PASSWORD" "preserves the existing database password"
assert_eq "existing-auth-secret" "$NEXTAUTH_SECRET" "preserves the existing auth secret"
assert_eq "https://ztnet.example.com" "$NEXTAUTH_URL" "preserves the existing public URL"
assert_eq "false" "$AUTO_UPDATE" "preserves the existing auto-update setting"
assert_eq "7200" "$AUTO_UPDATE_INTERVAL" "preserves the existing update interval"
assert_eq "true" "$AUTO_UPDATE_CLEANUP" "preserves the existing cleanup setting"
write_env_file
assert_file_contains "${INSTALL_DIR}/.env" "POSTGRES_PASSWORD=existing-database-secret" "does not rotate the database password"
assert_file_contains "${INSTALL_DIR}/.env" "NEXTAUTH_SECRET=existing-auth-secret" "does not rotate the auth secret"

AUTO_UPDATE_PROVIDED="x"
AUTO_UPDATE="true"
load_existing_environment
assert_eq "true" "$AUTO_UPDATE" "keeps an explicitly supplied update setting"
AUTO_UPDATE_PROVIDED=""

if (AUTO_UPDATE_INTERVAL=59; validate_auto_update) >/dev/null 2>&1; then
	printf 'FAIL: accepted an update interval shorter than 60 seconds\n' >&2
	exit 1
fi

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
	"docker.xiaohangyun.org/nickfedor/watchtower:1.19.0" \
	"$(mirror_image_for "nickfedor/watchtower:1.19.0")" \
	"rewrites the updater image"
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

INSTALL_DIR="${TEST_TMP}/updates-enabled"
mkdir -p "$INSTALL_DIR"
AUTO_UPDATE="true"
AUTO_UPDATE_INTERVAL="3600"
AUTO_UPDATE_CLEANUP="false"
UPDATER_IMAGE="docker.xiaohangyun.org/nickfedor/watchtower:1.19.0"
write_compose_file
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "com.centurylinklabs.watchtower.enable: \"true\"" "labels ZTNET for updates"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "image: docker.xiaohangyun.org/nickfedor/watchtower:1.19.0" "writes the selected updater image"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "WATCHTOWER_POLL_INTERVAL: \"3600\"" "writes the update interval"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "com.centurylinklabs.watchtower.scope: \"ztnet-custom\"" "scopes the application and updater"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "/var/run/docker.sock:/var/run/docker.sock" "mounts the Docker socket"
assert_eq \
	"1" \
	"$(grep -Fc 'com.centurylinklabs.watchtower.enable: "true"' "${INSTALL_DIR}/docker-compose.yml")" \
	"enables updates for exactly one container"

INSTALL_DIR="${TEST_TMP}/updates-disabled"
mkdir -p "$INSTALL_DIR"
AUTO_UPDATE="false"
write_compose_file
assert_file_not_contains "${INSTALL_DIR}/docker-compose.yml" "com.centurylinklabs.watchtower.enable" "omits update labels when disabled"
assert_file_not_contains "${INSTALL_DIR}/docker-compose.yml" "  updater:" "omits the updater service when disabled"

printf 'one-click installer tests passed\n'
