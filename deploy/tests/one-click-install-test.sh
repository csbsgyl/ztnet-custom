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
	local status=$?
	rm -rf "$TEST_TMP"
	exit "$status"
}
trap cleanup_test EXIT

assert_eq "127.0.0.1" "$PUBLIC_BIND" "binds new installations to loopback by default"
assert_eq "never" "$DOCKER_MIRROR_MODE" "disables third-party registry mirrors by default"
assert_eq "0" "$INSTALL_DOCKER" "does not run a remote Docker installer by default"
assert_eq "false" "$RATE_LIMIT_TRUST_PROXY" "does not trust forwarded client IP headers by default"
if ! image_reference_is_digest_pinned "$DEFAULT_RESTART_HELPER_IMAGE"; then
	printf 'FAIL: default restart helper image is not digest-pinned\n' >&2
	exit 1
fi
if ! image_reference_is_digest_pinned "$DEFAULT_UPDATER_IMAGE"; then
	printf 'FAIL: default updater image is not digest-pinned\n' >&2
	exit 1
fi
validate_restart_helper_config
validate_updater_config
validate_runtime_security
assert_eq \
	"$(sha256_file "${TEST_DIR}/../../container-ops.mjs")" \
	"$DEFAULT_RESTART_HELPER_SOURCE_SHA256" \
	"pins the helper source digest to the reviewed repository file"

if (UPDATER_IMAGE=nickfedor/watchtower:latest; validate_updater_config) >/dev/null 2>&1; then
	printf 'FAIL: accepted a mutable updater image override\n' >&2
	exit 1
fi

if (UPDATER_MIRROR_IMAGE=mirror.example.com/nickfedor/watchtower:latest; validate_updater_config) >/dev/null 2>&1; then
	printf 'FAIL: accepted a mutable updater mirror image\n' >&2
	exit 1
fi

(UPDATER_MIRROR_IMAGE=mirror.example.com/nickfedor/watchtower@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; validate_updater_config)

NO_PULL_MARKER="${TEST_TMP}/invalid-ops-image-pulled"
RUN_DOCKER_PULL_DEFINITION="$(declare -f run_docker_pull)"
run_docker_pull() {
	touch "$NO_PULL_MARKER"
}
if (
	RESTART_HELPER_IMAGE=ghcr.io/csbsgyl/ztnet-custom:ops-latest
	validate_restart_helper_config
	run_docker_pull "$RESTART_HELPER_IMAGE"
) >/dev/null 2>&1; then
	printf 'FAIL: accepted a mutable restart helper image before pull\n' >&2
	exit 1
fi
if [ -e "$NO_PULL_MARKER" ]; then
	printf 'FAIL: pulled a mutable restart helper image before rejecting it\n' >&2
	exit 1
fi

if (
	RESTART_HELPER_MIRROR_IMAGES=mirror.example.com/ztnet-custom:ops-latest
	validate_restart_helper_config
	run_docker_pull "$RESTART_HELPER_MIRROR_IMAGES"
) >/dev/null 2>&1; then
	printf 'FAIL: accepted a mutable restart helper mirror before pull\n' >&2
	exit 1
fi
if [ -e "$NO_PULL_MARKER" ]; then
	printf 'FAIL: pulled a mutable restart helper mirror before rejecting it\n' >&2
	exit 1
fi

if (
	UPDATER_IMAGE=nickfedor/watchtower:latest
	validate_updater_config
	run_docker_pull "$UPDATER_IMAGE"
) >/dev/null 2>&1; then
	printf 'FAIL: accepted a mutable updater image before pull\n' >&2
	exit 1
fi
if [ -e "$NO_PULL_MARKER" ]; then
	printf 'FAIL: pulled a mutable updater image before rejecting it\n' >&2
	exit 1
fi
eval "$RUN_DOCKER_PULL_DEFINITION"

INSTALL_DIR="${TEST_TMP}/existing"
mkdir -p "$INSTALL_DIR"
cat > "${INSTALL_DIR}/.env" <<'EOF'
POSTGRES_USER=existing-user
POSTGRES_PASSWORD=existing-database-secret
POSTGRES_DB=existing-database
POSTGRES_PORT=5432
PUBLIC_BIND=127.0.0.1
NEXTAUTH_URL=https://ztnet.example.com
NEXTAUTH_SECRET=existing-auth-secret
NEXTAUTH_URL_INTERNAL=http://ztnet:3000
INITIAL_ADMIN_EMAIL=owner@example.com
RATE_LIMIT_TRUST_PROXY=true
AUTO_UPDATE=false
AUTO_UPDATE_INTERVAL=7200
AUTO_UPDATE_CLEANUP=true
ZTNET_IMAGE=registry.example.com/owner/ztnet-custom:latest
UPDATE_API_URL=http://existing-updater:8080
UPDATE_API_TOKEN=existing-update-token
RESTART_API_URL=http://existing-restart-helper:8081
RESTART_API_TOKEN=existing-restart-token-0123456789abcdef
RESTART_HELPER_IMAGE=registry.example.com/ztnet-restart-helper@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RESTART_HELPER_SOURCE_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
EOF

POSTGRES_USER_PROVIDED=""
POSTGRES_DB_PROVIDED=""
POSTGRES_PASSWORD_PROVIDED=""
NEXTAUTH_SECRET_PROVIDED=""
NEXTAUTH_URL_PROVIDED=""
INITIAL_ADMIN_EMAIL_PROVIDED=""
RATE_LIMIT_TRUST_PROXY_PROVIDED=""
PUBLIC_BIND_EXTERNAL_PROVIDED=""
PUBLIC_BIND_PROVIDED=""
AUTO_UPDATE_PROVIDED=""
AUTO_UPDATE_INTERVAL_PROVIDED=""
AUTO_UPDATE_CLEANUP_PROVIDED=""
ZTNET_IMAGE_PROVIDED=""
UPDATE_API_URL_PROVIDED=""
UPDATE_API_TOKEN_PROVIDED=""
RESTART_API_URL_PROVIDED=""
RESTART_API_TOKEN_PROVIDED=""
RESTART_HELPER_IMAGE_PROVIDED=""
RESTART_HELPER_SOURCE_SHA256_PROVIDED=""
POSTGRES_USER="postgres"
POSTGRES_DB="ztnet"
POSTGRES_PASSWORD=""
NEXTAUTH_SECRET=""
NEXTAUTH_URL=""
INITIAL_ADMIN_EMAIL=""
RATE_LIMIT_TRUST_PROXY="false"
PUBLIC_BIND="127.0.0.1"
AUTO_UPDATE="true"
AUTO_UPDATE_INTERVAL="3600"
AUTO_UPDATE_CLEANUP="false"
ZTNET_IMAGE="$DEFAULT_ZTNET_IMAGE"
UPDATE_API_URL="http://updater:8080"
UPDATE_API_TOKEN=""
RESTART_API_URL="http://restart-helper:8081"
RESTART_API_TOKEN=""
RESTART_HELPER_IMAGE="$DEFAULT_RESTART_HELPER_IMAGE"
RESTART_HELPER_SOURCE_SHA256="$DEFAULT_RESTART_HELPER_SOURCE_SHA256"
load_existing_environment
validate_auto_update
assert_eq "existing-user" "$POSTGRES_USER" "preserves the existing database user"
assert_eq "existing-database" "$POSTGRES_DB" "preserves the existing database name"
assert_eq "existing-database-secret" "$POSTGRES_PASSWORD" "preserves the existing database password"
assert_eq "existing-auth-secret" "$NEXTAUTH_SECRET" "preserves the existing auth secret"
assert_eq "https://ztnet.example.com" "$NEXTAUTH_URL" "preserves the existing public URL"
assert_eq "owner@example.com" "$INITIAL_ADMIN_EMAIL" "preserves the initial administrator email"
assert_eq "true" "$RATE_LIMIT_TRUST_PROXY" "preserves the trusted-proxy rate-limit setting"
assert_eq "127.0.0.1" "$PUBLIC_BIND" "preserves the host bind address"
assert_eq "false" "$AUTO_UPDATE" "preserves the existing auto-update setting"
assert_eq "7200" "$AUTO_UPDATE_INTERVAL" "preserves the existing update interval"
assert_eq "true" "$AUTO_UPDATE_CLEANUP" "preserves the existing cleanup setting"
assert_eq "registry.example.com/owner/ztnet-custom:latest" "$ZTNET_IMAGE" "preserves the application image used by in-app updates"
assert_eq "http://existing-updater:8080" "$UPDATE_API_URL" "preserves the update API URL"
assert_eq "existing-update-token" "$UPDATE_API_TOKEN" "preserves the update API token"
assert_eq "http://existing-restart-helper:8081" "$RESTART_API_URL" "preserves the restart API URL"
assert_eq "existing-restart-token-0123456789abcdef" "$RESTART_API_TOKEN" "preserves the restart API token"
assert_eq "registry.example.com/ztnet-restart-helper@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$RESTART_HELPER_IMAGE" "preserves a custom digest-pinned restart helper image"
assert_eq "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "$RESTART_HELPER_SOURCE_SHA256" "preserves the custom restart helper source digest"
RESTART_HELPER_SOURCE_IMAGE="$RESTART_HELPER_IMAGE"
write_env_file
assert_file_contains "${INSTALL_DIR}/.env" "POSTGRES_PASSWORD=existing-database-secret" "does not rotate the database password"
assert_file_contains "${INSTALL_DIR}/.env" "NEXTAUTH_SECRET=existing-auth-secret" "does not rotate the auth secret"
assert_file_contains "${INSTALL_DIR}/.env" "UPDATE_API_TOKEN=existing-update-token" "does not rotate the update API token"
assert_file_contains "${INSTALL_DIR}/.env" "RESTART_API_TOKEN=existing-restart-token-0123456789abcdef" "does not rotate the restart API token"
assert_file_contains "${INSTALL_DIR}/.env" "PUBLIC_BIND=127.0.0.1" "keeps new deployments bound to loopback"
assert_file_contains "${INSTALL_DIR}/.env" "INITIAL_ADMIN_EMAIL=owner@example.com" "writes the initial administrator email"
assert_file_contains "${INSTALL_DIR}/.env" "RATE_LIMIT_TRUST_PROXY=true" "writes the trusted-proxy rate-limit setting"
assert_file_contains "${INSTALL_DIR}/.env" "ZTNET_IMAGE=registry.example.com/owner/ztnet-custom:latest" "keeps the existing application image in the environment"
assert_file_contains "${INSTALL_DIR}/.env" "RESTART_HELPER_IMAGE=registry.example.com/ztnet-restart-helper@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "preserves the restart helper image in the environment"
assert_file_contains "${INSTALL_DIR}/.env" "RESTART_HELPER_SOURCE_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "persists the restart helper source digest"

if [ "$(stat -f '%Lp' "${INSTALL_DIR}/.env" 2>/dev/null || stat -c '%a' "${INSTALL_DIR}/.env")" != "600" ]; then
	printf 'FAIL: generated .env is not mode 600\n' >&2
	exit 1
fi

if (RESTART_API_TOKEN=short; write_env_file) >/dev/null 2>&1; then
	printf 'FAIL: accepted a restart API token shorter than 32 characters\n' >&2
	exit 1
fi

if (
	UPDATE_API_TOKEN=shared-operation-token-0123456789abcdef
	RESTART_API_TOKEN="$UPDATE_API_TOKEN"
	write_env_file
) >/dev/null 2>&1; then
	printf 'FAIL: accepted identical update and restart API tokens\n' >&2
	exit 1
fi

INSTALL_DIR="${TEST_TMP}/fresh-token"
mkdir -p "$INSTALL_DIR"
RESTART_API_TOKEN=""
write_env_file
assert_eq "64" "${#RESTART_API_TOKEN}" "generates a 32-byte restart API token"
case "$RESTART_API_TOKEN" in
	*[!0-9a-f]*)
		printf 'FAIL: generated restart API token is not lowercase hexadecimal\n' >&2
		exit 1
		;;
esac

PUBLIC_BIND="127.0.0.1"
PUBLIC_BIND_PROVIDED=""
NEXTAUTH_URL=""
validate_public_access

if (PUBLIC_BIND=0.0.0.0; PUBLIC_BIND_PROVIDED=""; NEXTAUTH_URL=https://ztnet.example.com; validate_public_access) >/dev/null 2>&1; then
	printf 'FAIL: accepted a non-loopback bind that was not explicitly configured\n' >&2
	exit 1
fi

if (PUBLIC_BIND=0.0.0.0; PUBLIC_BIND_PROVIDED=x; NEXTAUTH_URL=http://ztnet.example.com; validate_public_access) >/dev/null 2>&1; then
	printf 'FAIL: accepted a public bind without an HTTPS public URL\n' >&2
	exit 1
fi

(PUBLIC_BIND=0.0.0.0; PUBLIC_BIND_PROVIDED=x; NEXTAUTH_URL=https://ztnet.example.com; validate_public_access) >/dev/null

if (RATE_LIMIT_TRUST_PROXY=invalid; validate_runtime_security) >/dev/null 2>&1; then
	printf 'FAIL: accepted an invalid RATE_LIMIT_TRUST_PROXY value\n' >&2
	exit 1
fi

INSTALL_DIR="${TEST_TMP}/legacy-bind"
mkdir -p "$INSTALL_DIR"
cat > "${INSTALL_DIR}/.env" <<'EOF'
NEXTAUTH_URL=http://legacy.example.com:3000
EOF
PUBLIC_BIND="127.0.0.1"
PUBLIC_BIND_EXTERNAL_PROVIDED=""
PUBLIC_BIND_PROVIDED=""
PUBLIC_BIND_LEGACY=0
load_existing_environment
assert_eq "0.0.0.0" "$PUBLIC_BIND" "preserves the public bind for an old deployment without PUBLIC_BIND"
assert_eq "1" "$PUBLIC_BIND_LEGACY" "marks an old deployment for explicit bind migration"
validate_public_access >/dev/null

PUBLIC_BIND="127.0.0.1"
PUBLIC_BIND_PROVIDED=""
PUBLIC_BIND_LEGACY=0

INSTALL_DIR="${TEST_TMP}/legacy-helper"
mkdir -p "$INSTALL_DIR"
cat > "${INSTALL_DIR}/.env" <<EOF
RESTART_HELPER_IMAGE=${LEGACY_RESTART_HELPER_IMAGE}
EOF
RESTART_HELPER_IMAGE_PROVIDED=""
RESTART_HELPER_SOURCE_SHA256_PROVIDED=""
RESTART_HELPER_IMAGE="$LEGACY_RESTART_HELPER_IMAGE"
RESTART_HELPER_SOURCE_SHA256="$DEFAULT_RESTART_HELPER_SOURCE_SHA256"
load_existing_environment
assert_eq "$DEFAULT_RESTART_HELPER_IMAGE" "$RESTART_HELPER_IMAGE" "migrates the legacy mutable helper tag to the official digest"
assert_eq "$DEFAULT_RESTART_HELPER_SOURCE_SHA256" "$RESTART_HELPER_SOURCE_SHA256" "uses the official source digest during legacy migration"

INSTALL_DIR="${TEST_TMP}/legacy-helper-mirror"
mkdir -p "$INSTALL_DIR"
cat > "${INSTALL_DIR}/.env" <<'EOF'
RESTART_HELPER_IMAGE=ghcr.nju.edu.cn/csbsgyl/ztnet-custom:ops-latest
EOF
RESTART_HELPER_IMAGE_PROVIDED=""
RESTART_HELPER_SOURCE_SHA256_PROVIDED=""
RESTART_HELPER_IMAGE="$LEGACY_RESTART_HELPER_IMAGE"
RESTART_HELPER_SOURCE_SHA256="$DEFAULT_RESTART_HELPER_SOURCE_SHA256"
load_existing_environment
assert_eq \
	"ghcr.nju.edu.cn/csbsgyl/ztnet-custom@sha256:${DEFAULT_RESTART_HELPER_DIGEST}" \
	"$RESTART_HELPER_IMAGE" \
	"migrates a known legacy helper mirror to the same registry digest"
assert_eq "$DEFAULT_RESTART_HELPER_SOURCE_SHA256" "$RESTART_HELPER_SOURCE_SHA256" "keeps source verification enabled for a migrated helper mirror"

INSTALL_DIR="${TEST_TMP}/unrelated-legacy-helper"
mkdir -p "$INSTALL_DIR"
cat > "${INSTALL_DIR}/.env" <<'EOF'
RESTART_HELPER_IMAGE=registry.example.com/another-project/ztnet-custom:ops-latest
EOF
RESTART_HELPER_IMAGE="$DEFAULT_RESTART_HELPER_IMAGE"
load_existing_environment
assert_eq \
	"registry.example.com/another-project/ztnet-custom:ops-latest" \
	"$RESTART_HELPER_IMAGE" \
	"does not migrate an unrelated mutable helper tag"
if image_reference_is_digest_pinned "$RESTART_HELPER_IMAGE"; then
	printf 'FAIL: unrelated mutable helper tag unexpectedly became trusted\n' >&2
	exit 1
fi

RESTART_HELPER_IMAGE="$DEFAULT_RESTART_HELPER_IMAGE"
RESTART_HELPER_SOURCE_SHA256="$DEFAULT_RESTART_HELPER_SOURCE_SHA256"

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
	"docker.xiaohangyun.org/nickfedor/watchtower@sha256:c1dfdf27fe805dcfefe1cf048cee6960a511c097a99aa355b0bc4be6e6bb3bdf" \
	"$(mirror_image_for "$DEFAULT_UPDATER_IMAGE")" \
	"rewrites the updater image without dropping its digest"
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

ZTNET_IMAGE="$DEFAULT_ZTNET_IMAGE"
ZTNET_MIRROR_IMAGE=""
ZTNET_MIRROR_IMAGES=""
ZTNET_MIRROR_IMAGES_PROVIDED=""
configure_ztnet_mirror_images
assert_eq "" "$ZTNET_MIRROR_IMAGES" "does not inject third-party GHCR mirrors by default"

ZTNET_IMAGE="sinamics/ztnet:latest"
ZTNET_MIRROR_IMAGES=""
configure_ztnet_mirror_images
assert_eq "" "$ZTNET_MIRROR_IMAGES" "does not apply fork mirrors to an overridden image"

ZTNET_IMAGE="$DEFAULT_ZTNET_IMAGE"
ZTNET_MIRROR_IMAGE="registry-user.example.com/ztnet-custom:latest"
ZTNET_MIRROR_IMAGES="registry-a.example.com/ztnet-custom:latest,registry-b.example.com/ztnet-custom:latest"
ZTNET_MIRROR_IMAGES_PROVIDED="x"
configure_ztnet_mirror_images
assert_eq \
	"registry-user.example.com/ztnet-custom:latest,registry-a.example.com/ztnet-custom:latest,registry-b.example.com/ztnet-custom:latest" \
	"$ZTNET_MIRROR_IMAGES" \
	"prepends the legacy single mirror override"

docker() {
	return 1
}

timeout() {
	return 124
}
DOCKER_PULL_TIMEOUT="5"
if run_docker_pull "example.invalid/slow:latest" >/dev/null 2>&1; then
	printf 'FAIL: accepted a timed-out image pull\n' >&2
	exit 1
else
	assert_eq "124" "$?" "returns the timeout exit status"
fi

timeout() {
	return 99
}
docker() {
	[ "$1" = "pull" ] && [ "$2" = "example.invalid/slow:latest" ]
}
DOCKER_PULL_TIMEOUT="0"
run_docker_pull "example.invalid/slow:latest" >/dev/null

docker() {
	return 1
}

DOCKER_MIRROR_MODE="never"
MIRROR_AVAILABLE=1
PULL_ATTEMPTS=""
probe_url() {
	return 0
}
run_docker_pull() {
	PULL_ATTEMPTS="${PULL_ATTEMPTS:+${PULL_ATTEMPTS},}$1"
	[ "$1" = "ghcr.io/csbsgyl/ztnet-custom:latest" ]
}
ZTNET_IMAGE="$DEFAULT_ZTNET_IMAGE"
select_image "ZTNET_IMAGE" "$ZTNET_IMAGE" "mirror.example.com/ztnet-custom:latest" "ZTNET_MIRROR_IMAGES"
assert_eq "$DEFAULT_ZTNET_IMAGE" "$ZTNET_IMAGE" "uses the official image when mirrors are disabled"
assert_eq "$DEFAULT_ZTNET_IMAGE" "$PULL_ATTEMPTS" "does not attempt explicitly listed mirrors in never mode"

DOCKER_MIRROR_MODE="auto"
MIRROR_AVAILABLE=1
probe_url() {
	return 1
}
PULL_ATTEMPTS=""
run_docker_pull() {
	PULL_ATTEMPTS="${PULL_ATTEMPTS:+${PULL_ATTEMPTS},}$1"
	[ "$1" = "docker.xiaohangyun.org/library/postgres:15.2-alpine" ]
}
POSTGRES_IMAGE="postgres:15.2-alpine"
select_image "POSTGRES_IMAGE" "$POSTGRES_IMAGE" "" "POSTGRES_MIRROR_IMAGE"
assert_eq \
	"docker.xiaohangyun.org/library/postgres:15.2-alpine" \
	"$POSTGRES_IMAGE" \
	"falls back to the mirror when the official pull fails"
assert_eq \
	"postgres:15.2-alpine,docker.xiaohangyun.org/library/postgres:15.2-alpine" \
	"$PULL_ATTEMPTS" \
	"tries the official registry before a configured mirror even when its probe fails"

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

PULL_ATTEMPTS=""
run_docker_pull() {
	PULL_ATTEMPTS="${PULL_ATTEMPTS:+${PULL_ATTEMPTS},}$1"
	[ "$1" = "mirror-b.example.com/ztnet-custom:latest" ]
}
ZTNET_IMAGE="ghcr.io/csbsgyl/ztnet-custom:latest"
select_image \
	"ZTNET_IMAGE" \
	"$ZTNET_IMAGE" \
	"mirror-a.example.com/ztnet-custom:latest, mirror-b.example.com/ztnet-custom:latest" \
	"ZTNET_MIRROR_IMAGES"
assert_eq \
	"mirror-b.example.com/ztnet-custom:latest" \
	"$ZTNET_IMAGE" \
	"selects the next ZTNET mirror after a failed candidate"
assert_eq \
	"ghcr.io/csbsgyl/ztnet-custom:latest,mirror-a.example.com/ztnet-custom:latest,mirror-b.example.com/ztnet-custom:latest" \
	"$PULL_ATTEMPTS" \
	"tries the official ZTNET image before explicitly configured mirrors"

PULL_ATTEMPTS=""
run_docker_pull() {
	PULL_ATTEMPTS="${PULL_ATTEMPTS:+${PULL_ATTEMPTS},}$1"
	[ "$1" = "mirror-a.example.com/ztnet-custom:latest" ]
}
ZTNET_IMAGE="ghcr.io/csbsgyl/ztnet-custom:latest"
select_image \
	"ZTNET_IMAGE" \
	"$ZTNET_IMAGE" \
	"mirror-a.example.com/ztnet-custom:latest,mirror-a.example.com/ztnet-custom:latest" \
	"ZTNET_MIRROR_IMAGES"
assert_eq \
	"mirror-a.example.com/ztnet-custom:latest" \
	"$ZTNET_IMAGE" \
	"uses an explicitly configured mirror after the source pull fails"
assert_eq \
	"ghcr.io/csbsgyl/ztnet-custom:latest,mirror-a.example.com/ztnet-custom:latest" \
	"$PULL_ATTEMPTS" \
	"deduplicates mirror candidates after the source attempt"

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

HELPER_FIXTURE="${TEST_TMP}/container-ops.mjs"
printf '%s\n' "export function createContainerOpsServer() {}" > "$HELPER_FIXTURE"
RESTART_HELPER_SOURCE_SHA256="$(sha256_file "$HELPER_FIXTURE")"
PINNED_HELPER_IMAGE="ghcr.io/csbsgyl/ztnet-custom@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

docker() {
	case "$1" in
		create) printf '%s\n' "restart-helper-check" ;;
		cp) cp "$HELPER_FIXTURE" "$3" ;;
		rm) return 0 ;;
		*) return 1 ;;
	esac
}
image_has_restart_helper "$PINNED_HELPER_IMAGE"

if image_has_restart_helper "ghcr.io/csbsgyl/ztnet-custom:ops-latest"; then
	printf 'FAIL: accepted a mutable restart helper image tag\n' >&2
	exit 1
fi

RESTART_HELPER_SOURCE_SHA256="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
if image_has_restart_helper "$PINNED_HELPER_IMAGE"; then
	printf 'FAIL: accepted a restart helper with the wrong source digest\n' >&2
	exit 1
fi
RESTART_HELPER_SOURCE_SHA256="$(sha256_file "$HELPER_FIXTURE")"

docker() {
	case "$1" in
		create) printf '%s\n' "restart-helper-check" ;;
		cp) return 1 ;;
		rm) return 0 ;;
		*) return 1 ;;
	esac
}
if image_has_restart_helper "sinamics/ztnet@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"; then
	printf 'FAIL: accepted an image without container-ops.mjs as the restart helper\n' >&2
	exit 1
fi

PULL_ATTEMPTS=""
run_docker_pull() {
	PULL_ATTEMPTS="${PULL_ATTEMPTS:+${PULL_ATTEMPTS},}$1"
	return 0
}
image_has_restart_helper() {
	[ "$1" = "$DEFAULT_RESTART_HELPER_IMAGE" ]
}
DOCKER_MIRROR_MODE="always"
RESTART_HELPER_IMAGE="$DEFAULT_RESTART_HELPER_IMAGE"
EXPLICIT_HELPER_MIRROR="mirror.example.com/csbsgyl/ztnet-custom@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
select_image \
	"RESTART_HELPER_IMAGE" \
	"$RESTART_HELPER_IMAGE" \
	"$EXPLICIT_HELPER_MIRROR" \
	"RESTART_HELPER_MIRROR_IMAGES" \
	"image_has_restart_helper"
assert_eq \
	"${EXPLICIT_HELPER_MIRROR},${DEFAULT_RESTART_HELPER_IMAGE}" \
	"$PULL_ATTEMPTS" \
	"validates an explicitly configured helper mirror before falling back"
assert_eq \
	"$DEFAULT_RESTART_HELPER_IMAGE" \
	"$RESTART_HELPER_IMAGE" \
	"selects the verified official helper digest"

INSTALL_DIR="${TEST_TMP}/updates-enabled"
mkdir -p "$INSTALL_DIR"
AUTO_UPDATE="true"
AUTO_UPDATE_INTERVAL="3600"
AUTO_UPDATE_CLEANUP="false"
PUBLIC_BIND="127.0.0.1"
INITIAL_ADMIN_EMAIL="owner@example.com"
RATE_LIMIT_TRUST_PROXY="false"
UPDATE_API_URL="http://updater:8080"
UPDATE_API_TOKEN="existing-update-token"
RESTART_API_URL="http://restart-helper:8081"
RESTART_API_TOKEN="existing-restart-token-0123456789abcdef"
RESTART_HELPER_IMAGE="$DEFAULT_RESTART_HELPER_IMAGE"
RESTART_HELPER_SOURCE_IMAGE="$RESTART_HELPER_IMAGE"
UPDATER_IMAGE="$DEFAULT_UPDATER_IMAGE"
write_compose_file
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "com.centurylinklabs.watchtower.enable: \"true\"" "labels the ZTNET application for updates"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "image: ${DEFAULT_UPDATER_IMAGE}" "pins the updater image digest"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "WATCHTOWER_POLL_INTERVAL: \"3600\"" "writes the update interval"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "WATCHTOWER_HTTP_API_UPDATE: \"true\"" "enables manual update requests"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "WATCHTOWER_HTTP_API_PERIODIC_POLLS: \"true\"" "keeps periodic updates enabled"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "WATCHTOWER_HTTP_API_METRICS: \"true\"" "enables updater health checks"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "WATCHTOWER_HTTP_API_TOKEN: \${UPDATE_API_TOKEN}" "uses the private update API token"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "com.centurylinklabs.watchtower.scope: \"ztnet-custom\"" "scopes the application and updater"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "/var/run/docker.sock:/var/run/docker.sock" "mounts the Docker socket"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "      - app-network" "connects the updater to the private application network"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "      - \"127.0.0.1:3000:3000\"" "binds the web application to loopback"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "INITIAL_ADMIN_EMAIL: \${INITIAL_ADMIN_EMAIL}" "passes the optional first-admin identity restriction"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "RATE_LIMIT_TRUST_PROXY: \${RATE_LIMIT_TRUST_PROXY}" "passes the trusted-proxy rate-limit setting"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "  restart-helper:" "adds the scoped restart helper"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "image: ${DEFAULT_RESTART_HELPER_IMAGE}" "pins the dedicated restart helper image"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "entrypoint: [\"node\", \"/app/container-ops.mjs\"]" "starts the fixed container operations service"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "    command: []" "clears the application image command for the restart helper"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "io.ztnet.instance: \"ztnet-custom\"" "labels the managed ZeroTier instance"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "io.ztnet.role: zerotier" "labels only ZeroTier as the restart target"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "io.ztnet.restart-enabled: \"true\"" "explicitly enables the ZeroTier restart target"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "RESTART_API_URL: \${RESTART_API_URL}" "passes the private restart URL to ZTNET"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "RESTART_API_TOKEN: \${RESTART_API_TOKEN}" "shares the restart token without embedding its value"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "    read_only: true" "uses a read-only helper root filesystem"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "      - no-new-privileges:true" "prevents helper privilege escalation"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "/var/run/docker.sock:/var/run/docker.sock:ro" "mounts the helper Docker socket read-only"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "  ops-network:" "adds an isolated operations network"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "    internal: true" "keeps the operations network internal"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "      - ./backups:/app/backups" "persists application backups on the host"
assert_eq \
	"1" \
	"$(grep -Fc './backups:/app/backups' "${INSTALL_DIR}/docker-compose.yml")" \
	"mounts the backup directory in exactly one service"
assert_eq \
	"1" \
	"$(grep -Fc 'com.centurylinklabs.watchtower.enable: "true"' "${INSTALL_DIR}/docker-compose.yml")" \
	"enables updates for the application but not the privileged helper"
assert_eq \
	"1" \
	"$(grep -Fc '    env_file:' "${INSTALL_DIR}/docker-compose.yml")" \
	"passes the full environment file only to the application"
assert_eq \
	"2" \
	"$(grep -Fc '/var/run/docker.sock:/var/run/docker.sock' "${INSTALL_DIR}/docker-compose.yml")" \
	"mounts the Docker socket only in the updater and restart helper"

if [ "$(stat -f '%Lp' "${INSTALL_DIR}/docker-compose.yml" 2>/dev/null || stat -c '%a' "${INSTALL_DIR}/docker-compose.yml")" != "600" ]; then
	printf 'FAIL: generated docker-compose.yml is not mode 600\n' >&2
	exit 1
fi

INSTALL_DIR="${TEST_TMP}/updates-disabled"
mkdir -p "$INSTALL_DIR"
AUTO_UPDATE="false"
write_compose_file
assert_file_not_contains "${INSTALL_DIR}/docker-compose.yml" "com.centurylinklabs.watchtower.enable" "omits update labels when disabled"
assert_file_not_contains "${INSTALL_DIR}/docker-compose.yml" "  updater:" "omits the updater service when disabled"
assert_file_contains "${INSTALL_DIR}/docker-compose.yml" "  restart-helper:" "keeps restart operations available when updates are disabled"
assert_eq \
	"1" \
	"$(grep -Fc '/var/run/docker.sock:/var/run/docker.sock' "${INSTALL_DIR}/docker-compose.yml")" \
	"mounts the Docker socket only in the restart helper when updates are disabled"

assert_file_contains "${TEST_DIR}/../docker-compose.yml" "    profiles:" "gates the static updater behind a Compose profile"
assert_file_contains "${TEST_DIR}/../docker-compose.yml" "      - auto-update" "names the static updater profile"
assert_file_contains "${TEST_DIR}/../.env.example" "COMPOSE_PROFILES=auto-update" "enables the static updater profile by default"
assert_file_contains "${TEST_DIR}/../docker-compose.yml" 'image: ${UPDATER_IMAGE:-nickfedor/watchtower@sha256:c1dfdf27fe805dcfefe1cf048cee6960a511c097a99aa355b0bc4be6e6bb3bdf}' "pins the static updater default"
assert_file_contains "${TEST_DIR}/../../Dockerfile.ops" "FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd" "pins the restart helper base image"
assert_file_contains "${TEST_DIR}/../../Dockerfile" "ARG NODEJS_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d" "pins the application base image"
assert_file_not_contains "${TEST_DIR}/../../Dockerfile" "npm@latest" "does not install a mutable npm release"
assert_file_contains "${TEST_DIR}/../../Dockerfile" "@paralleldrive/cuid2@2.2.2" "pins the runtime cuid2 package"
assert_file_contains "${TEST_DIR}/../../Dockerfile" "ts-node@10.9.1" "pins the runtime ts-node package"

DOCUMENTED_INSTALLER_SHA256="$({
	sed -n "/sha256sum -c -/s/.*'\([0-9a-f]\{64\}\)'.*/\1/p" "${TEST_DIR}/../README.md"
} | sort -u)"
assert_eq \
	"$(sha256_file "${TEST_DIR}/../one-click-install.sh")" \
	"$DOCUMENTED_INSTALLER_SHA256" \
	"keeps the documented installer checksum synchronized"

if grep -Eq '(curl|wget)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba)?sh|https://(ghproxy|ghfast|gh-proxy|github\.xiaohangyun)' \
	"${TEST_DIR}/../README.md" \
	"${TEST_DIR}/../../README.md" \
	"${TEST_DIR}/../../SECONDARY_DEVELOPMENT.md" \
	"${TEST_DIR}/../../docs/docs/Installation/docker-compose.md" \
	"${TEST_DIR}/../../docs/docs/Installation/linux.md" \
	"${TEST_DIR}/../../install.ztnet/README.md" \
	"${TEST_DIR}/../../scripts/prepare-github-fork.ps1"; then
	printf 'FAIL: deployment documentation still executes or recommends an untrusted proxy\n' >&2
	exit 1
fi

assert_file_contains "${TEST_DIR}/../../README.md" "[Secure Installation Instructions](deploy/README.md)" "keeps the root installation entrypoint on the hardened guide"
assert_file_not_contains "${TEST_DIR}/../../docs/docs/Installation/docker-compose.md" "3000:3000" "removes the public-port legacy Compose example"
assert_file_not_contains "${TEST_DIR}/../../docs/docs/Installation/docker-compose.md" "random_secret" "removes predictable credentials from executable installation guidance"
assert_file_contains "${TEST_DIR}/../../docs/docs/Installation/docker-compose.md" "one-click deployment guide" "routes the documentation site to the hardened installer"
assert_file_contains "${TEST_DIR}/../../docs/docs/Installation/linux.md" "not a supported installation" "deprecates the unsafe standalone installer"
assert_file_contains "${TEST_DIR}/../../install.ztnet/README.md" "must not be executed" "marks legacy installer sources as historical only"
assert_file_not_contains "${TEST_DIR}/../../scripts/prepare-github-fork.ps1" "<your-org>/<your-repo>" "does not depend on a missing repository placeholder"
assert_file_contains "${TEST_DIR}/../../scripts/prepare-github-fork.ps1" '$SourceRepository = "csbsgyl/ztnet-custom"' "tracks the repository identifier that will be replaced"
assert_file_contains "${TEST_DIR}/../../scripts/prepare-github-fork.ps1" '$content.Replace("repo='"'"'$SourceRepository'"'"'", "repo='"'"'$Repository'"'"'")' "updates the immutable-download repository without rewriting helper provenance"
assert_file_contains "${TEST_DIR}/../../scripts/prepare-github-fork.ps1" '"deploy/one-click-install.sh"' "updates the fork application image default"
assert_file_contains "${TEST_DIR}/../../scripts/prepare-github-fork.ps1" 'Get-FileHash -Algorithm SHA256' "recomputes the installer checksum after rewriting it"
assert_file_contains "${TEST_DIR}/../../scripts/prepare-github-fork.ps1" '"src/server/systemUpdate.ts"' "updates the in-app update repository defaults"

printf 'one-click installer tests passed\n'
