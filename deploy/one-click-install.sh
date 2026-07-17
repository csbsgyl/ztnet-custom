#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

POSTGRES_USER_PROVIDED="${POSTGRES_USER+x}"
POSTGRES_DB_PROVIDED="${POSTGRES_DB+x}"
POSTGRES_PASSWORD_PROVIDED="${POSTGRES_PASSWORD+x}"
NEXTAUTH_SECRET_PROVIDED="${NEXTAUTH_SECRET+x}"
NEXTAUTH_URL_PROVIDED="${NEXTAUTH_URL+x}"
INITIAL_ADMIN_EMAIL_PROVIDED="${INITIAL_ADMIN_EMAIL+x}"
RATE_LIMIT_TRUST_PROXY_PROVIDED="${RATE_LIMIT_TRUST_PROXY+x}"
PUBLIC_BIND_EXTERNAL_PROVIDED="${PUBLIC_BIND+x}"
PUBLIC_BIND_PROVIDED="$PUBLIC_BIND_EXTERNAL_PROVIDED"
AUTO_UPDATE_PROVIDED="${AUTO_UPDATE+x}"
AUTO_UPDATE_INTERVAL_PROVIDED="${AUTO_UPDATE_INTERVAL+x}"
AUTO_UPDATE_CLEANUP_PROVIDED="${AUTO_UPDATE_CLEANUP+x}"
ZTNET_MIRROR_IMAGES_PROVIDED="${ZTNET_MIRROR_IMAGES+x}"
ZTNET_IMAGE_PROVIDED="${ZTNET_IMAGE+x}"
RESTART_HELPER_IMAGE_PROVIDED="${RESTART_HELPER_IMAGE+x}"
RESTART_HELPER_SOURCE_SHA256_PROVIDED="${RESTART_HELPER_SOURCE_SHA256+x}"
RESTART_HELPER_MIRROR_IMAGES_PROVIDED="${RESTART_HELPER_MIRROR_IMAGES+x}"
UPDATE_API_TOKEN_PROVIDED="${UPDATE_API_TOKEN+x}"
UPDATE_API_URL_PROVIDED="${UPDATE_API_URL+x}"
RESTART_API_TOKEN_PROVIDED="${RESTART_API_TOKEN+x}"
RESTART_API_URL_PROVIDED="${RESTART_API_URL+x}"

APP_NAME="${APP_NAME:-ztnet-custom}"
INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
HTTP_PORT="${HTTP_PORT:-3000}"
PUBLIC_BIND="${PUBLIC_BIND:-127.0.0.1}"
APP_SUBNET="${APP_SUBNET:-172.31.255.0/29}"
DEFAULT_ZTNET_IMAGE="ghcr.io/csbsgyl/ztnet-custom:latest"
DEFAULT_ZTNET_MIRROR_IMAGES=""
LEGACY_RESTART_HELPER_IMAGE="ghcr.io/csbsgyl/ztnet-custom:ops-latest"
DEFAULT_RESTART_HELPER_DIGEST="207fe36e7d8ebec6335f83601dac18aa1d2d89cd5b662b63c4277675091533bd"
DEFAULT_RESTART_HELPER_IMAGE="ghcr.io/csbsgyl/ztnet-custom@sha256:${DEFAULT_RESTART_HELPER_DIGEST}"
DEFAULT_RESTART_HELPER_SOURCE_SHA256="1038d5e16856ad5bed50d987f01cb57b666b61c85d531e01a5da17bd4ad28fa0"
DEFAULT_RESTART_HELPER_MIRROR_IMAGES=""
DEFAULT_UPDATER_IMAGE="nickfedor/watchtower@sha256:c1dfdf27fe805dcfefe1cf048cee6960a511c097a99aa355b0bc4be6e6bb3bdf"
ZTNET_IMAGE="${ZTNET_IMAGE:-${DEFAULT_ZTNET_IMAGE}}"
RESTART_HELPER_IMAGE="${RESTART_HELPER_IMAGE:-${DEFAULT_RESTART_HELPER_IMAGE}}"
RESTART_HELPER_SOURCE_SHA256="${RESTART_HELPER_SOURCE_SHA256:-${DEFAULT_RESTART_HELPER_SOURCE_SHA256}}"
RESTART_HELPER_SOURCE_IMAGE="$RESTART_HELPER_IMAGE"
ZEROTIER_IMAGE="${ZEROTIER_IMAGE:-zyclonite/zerotier:1.14.2}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:15.2-alpine}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-ztnet}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-}"
NEXTAUTH_URL="${NEXTAUTH_URL:-}"
INITIAL_ADMIN_EMAIL="${INITIAL_ADMIN_EMAIL:-}"
RATE_LIMIT_TRUST_PROXY="${RATE_LIMIT_TRUST_PROXY:-false}"
INSTALL_DOCKER="${INSTALL_DOCKER:-0}"
DOCKER_MIRROR_MODE="${DOCKER_MIRROR_MODE:-never}"
DOCKER_MIRROR_URL="${DOCKER_MIRROR_URL:-https://docker.xiaohangyun.org}"
DOCKER_PULL_TIMEOUT="${DOCKER_PULL_TIMEOUT:-0}"
REGISTRY_PROBE_TIMEOUT="${REGISTRY_PROBE_TIMEOUT:-8}"
ZTNET_MIRROR_IMAGE="${ZTNET_MIRROR_IMAGE:-}"
ZTNET_MIRROR_IMAGES="${ZTNET_MIRROR_IMAGES:-}"
RESTART_HELPER_MIRROR_IMAGES="${RESTART_HELPER_MIRROR_IMAGES:-}"
ZEROTIER_MIRROR_IMAGE="${ZEROTIER_MIRROR_IMAGE:-}"
POSTGRES_MIRROR_IMAGE="${POSTGRES_MIRROR_IMAGE:-}"
AUTO_UPDATE="${AUTO_UPDATE:-true}"
AUTO_UPDATE_INTERVAL="${AUTO_UPDATE_INTERVAL:-3600}"
AUTO_UPDATE_CLEANUP="${AUTO_UPDATE_CLEANUP:-false}"
UPDATE_API_URL="${UPDATE_API_URL:-http://updater:8080}"
UPDATE_API_TOKEN="${UPDATE_API_TOKEN:-}"
RESTART_API_URL="${RESTART_API_URL:-http://restart-helper:8081}"
RESTART_API_TOKEN="${RESTART_API_TOKEN:-}"
UPDATER_IMAGE="${UPDATER_IMAGE:-${DEFAULT_UPDATER_IMAGE}}"
UPDATER_MIRROR_IMAGE="${UPDATER_MIRROR_IMAGE:-}"

MIRROR_REGISTRY=""
MIRROR_API_URL=""
MIRROR_AVAILABLE=0
PUBLIC_BIND_LEGACY=0

info() {
	printf '\033[1;34m[INFO]\033[0m %s\n' "$*"
}

warn() {
	printf '\033[1;33m[WARN]\033[0m %s\n' "$*"
}

fail() {
	printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2
	exit 1
}

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

is_unsigned_integer() {
	case "$1" in
		"" | *[!0-9]*) return 1 ;;
		*) return 0 ;;
	esac
}

normalize_boolean() {
	local variable_name="$1"
	local value="$2"

	case "$value" in
		1 | true | TRUE | yes | YES | on | ON) printf -v "$variable_name" '%s' "true" ;;
		0 | false | FALSE | no | NO | off | OFF) printf -v "$variable_name" '%s' "false" ;;
		*) fail "${variable_name} must be true or false." ;;
	esac
}

validate_auto_update() {
	normalize_boolean "AUTO_UPDATE" "$AUTO_UPDATE"
	normalize_boolean "AUTO_UPDATE_CLEANUP" "$AUTO_UPDATE_CLEANUP"
	is_unsigned_integer "$AUTO_UPDATE_INTERVAL" || fail "AUTO_UPDATE_INTERVAL must be an unsigned integer."
	[ "$AUTO_UPDATE_INTERVAL" -ge 60 ] || fail "AUTO_UPDATE_INTERVAL must be at least 60 seconds."
}

is_loopback_bind() {
	case "$1" in
		127.0.0.1) return 0 ;;
		*) return 1 ;;
	esac
}

validate_public_access() {
	case "$PUBLIC_BIND" in
		"" | *[[:space:]]* | *:*) fail "PUBLIC_BIND must be a single IPv4 address." ;;
	esac

	if is_loopback_bind "$PUBLIC_BIND"; then
		return
	fi
	if [ "$PUBLIC_BIND_LEGACY" = "1" ]; then
		warn "Preserving the legacy public bind at ${PUBLIC_BIND}. Set PUBLIC_BIND=127.0.0.1 and use the verified SSH/reverse-proxy bootstrap before the next migration."
		return
	fi
	if [ "$PUBLIC_BIND_PROVIDED" != "x" ]; then
		fail "Public listening is disabled by default. Set PUBLIC_BIND explicitly only after the first administrator is created behind a trusted HTTPS reverse proxy."
	fi
	case "$NEXTAUTH_URL" in
		https://*) ;;
		*) fail "A non-loopback PUBLIC_BIND requires an explicit HTTPS NEXTAUTH_URL." ;;
	esac
	warn "PUBLIC_BIND=${PUBLIC_BIND} exposes the application beyond this host. Restrict the port with a firewall and complete administrator bootstrap before allowing untrusted traffic."
}

validate_restart_helper_config() {
	local candidate
	local -a mirror_images=()

	if ! image_reference_is_digest_pinned "$RESTART_HELPER_IMAGE"; then
		fail "RESTART_HELPER_IMAGE must use an immutable @sha256 reference."
	fi
	if [ -n "$RESTART_HELPER_MIRROR_IMAGES" ]; then
		IFS=',' read -r -a mirror_images <<< "$RESTART_HELPER_MIRROR_IMAGES"
		for candidate in "${mirror_images[@]}"; do
			candidate="$(trim_whitespace "$candidate")"
			[ -n "$candidate" ] || continue
			if ! image_reference_is_digest_pinned "$candidate"; then
				fail "Every RESTART_HELPER_MIRROR_IMAGES entry must use an immutable @sha256 reference."
			fi
		done
	fi
	if [[ ! "$RESTART_HELPER_SOURCE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
		fail "RESTART_HELPER_SOURCE_SHA256 must be a lowercase SHA-256 digest."
	fi
	if ! command_exists sha256sum && ! command_exists shasum && ! command_exists openssl; then
		fail "A SHA-256 tool (sha256sum, shasum, or openssl) is required to verify the restart helper."
	fi
}

validate_updater_config() {
	if ! image_reference_is_digest_pinned "$UPDATER_IMAGE"; then
		fail "UPDATER_IMAGE must use an immutable @sha256 reference."
	fi
	if [ -n "$UPDATER_MIRROR_IMAGE" ] && ! image_reference_is_digest_pinned "$UPDATER_MIRROR_IMAGE"; then
		fail "UPDATER_MIRROR_IMAGE must use an immutable @sha256 reference."
	fi
}

validate_runtime_security() {
	normalize_boolean "RATE_LIMIT_TRUST_PROXY" "$RATE_LIMIT_TRUST_PROXY"
}

read_existing_env_value() {
	local file="$1"
	local key="$2"

	awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$file"
}

restore_existing_value() {
	local variable_name="$1"
	local was_provided="$2"
	local key="$3"
	local file="$4"
	local value

	if [ "$was_provided" = "x" ]; then
		return
	fi

	value="$(read_existing_env_value "$file" "$key" || true)"
	if [ -n "$value" ]; then
		printf -v "$variable_name" '%s' "$value"
	fi
}

migrate_legacy_restart_helper_image() {
	local legacy_registry
	local legacy_suffix="/${LEGACY_RESTART_HELPER_IMAGE#*/}"

	[ "$RESTART_HELPER_IMAGE_PROVIDED" != "x" ] || return
	case "$RESTART_HELPER_IMAGE" in
		*"$legacy_suffix") ;;
		*) return ;;
	esac

	legacy_registry="${RESTART_HELPER_IMAGE%"$legacy_suffix"}"
	case "$legacy_registry" in
		"" | */*) return ;;
	esac

	warn "Migrating the restart helper from mutable ops-latest to the verified digest on ${legacy_registry}."
	RESTART_HELPER_IMAGE="${legacy_registry}/csbsgyl/ztnet-custom@sha256:${DEFAULT_RESTART_HELPER_DIGEST}"
	RESTART_HELPER_SOURCE_SHA256="$DEFAULT_RESTART_HELPER_SOURCE_SHA256"
}

load_existing_environment() {
	local file="${INSTALL_DIR}/.env"

	if [ ! -f "$file" ]; then
		return
	fi

	info "Preserving existing deployment settings from ${file}"
	restore_existing_value "POSTGRES_USER" "$POSTGRES_USER_PROVIDED" "POSTGRES_USER" "$file"
	restore_existing_value "POSTGRES_DB" "$POSTGRES_DB_PROVIDED" "POSTGRES_DB" "$file"
	restore_existing_value "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD_PROVIDED" "POSTGRES_PASSWORD" "$file"
	restore_existing_value "NEXTAUTH_SECRET" "$NEXTAUTH_SECRET_PROVIDED" "NEXTAUTH_SECRET" "$file"
	restore_existing_value "NEXTAUTH_URL" "$NEXTAUTH_URL_PROVIDED" "NEXTAUTH_URL" "$file"
	restore_existing_value "INITIAL_ADMIN_EMAIL" "$INITIAL_ADMIN_EMAIL_PROVIDED" "INITIAL_ADMIN_EMAIL" "$file"
	restore_existing_value "RATE_LIMIT_TRUST_PROXY" "$RATE_LIMIT_TRUST_PROXY_PROVIDED" "RATE_LIMIT_TRUST_PROXY" "$file"
	local existing_public_bind
	local existing_nextauth_url
	existing_public_bind="$(read_existing_env_value "$file" "PUBLIC_BIND" || true)"
	if [ -n "$existing_public_bind" ]; then
		restore_existing_value "PUBLIC_BIND" "$PUBLIC_BIND_EXTERNAL_PROVIDED" "PUBLIC_BIND" "$file"
		PUBLIC_BIND_PROVIDED="x"
		if [ -z "$PUBLIC_BIND_EXTERNAL_PROVIDED" ] && ! is_loopback_bind "$existing_public_bind"; then
			existing_nextauth_url="$(read_existing_env_value "$file" "NEXTAUTH_URL" || true)"
			case "$existing_nextauth_url" in
				https://*) ;;
				*) PUBLIC_BIND_LEGACY=1 ;;
			esac
		fi
	elif [ -z "$PUBLIC_BIND_EXTERNAL_PROVIDED" ]; then
		PUBLIC_BIND="0.0.0.0"
		PUBLIC_BIND_PROVIDED="x"
		PUBLIC_BIND_LEGACY=1
		warn "Existing deployment has no PUBLIC_BIND; preserving its legacy 0.0.0.0 listener during migration."
	fi
	restore_existing_value "AUTO_UPDATE" "$AUTO_UPDATE_PROVIDED" "AUTO_UPDATE" "$file"
	restore_existing_value "AUTO_UPDATE_INTERVAL" "$AUTO_UPDATE_INTERVAL_PROVIDED" "AUTO_UPDATE_INTERVAL" "$file"
	restore_existing_value "AUTO_UPDATE_CLEANUP" "$AUTO_UPDATE_CLEANUP_PROVIDED" "AUTO_UPDATE_CLEANUP" "$file"
	restore_existing_value "ZTNET_IMAGE" "$ZTNET_IMAGE_PROVIDED" "ZTNET_IMAGE" "$file"
	restore_existing_value "UPDATE_API_URL" "$UPDATE_API_URL_PROVIDED" "UPDATE_API_URL" "$file"
	restore_existing_value "UPDATE_API_TOKEN" "$UPDATE_API_TOKEN_PROVIDED" "UPDATE_API_TOKEN" "$file"
	restore_existing_value "RESTART_API_URL" "$RESTART_API_URL_PROVIDED" "RESTART_API_URL" "$file"
	restore_existing_value "RESTART_API_TOKEN" "$RESTART_API_TOKEN_PROVIDED" "RESTART_API_TOKEN" "$file"
	restore_existing_value "RESTART_HELPER_IMAGE" "$RESTART_HELPER_IMAGE_PROVIDED" "RESTART_HELPER_IMAGE" "$file"
	restore_existing_value "RESTART_HELPER_SOURCE_SHA256" "$RESTART_HELPER_SOURCE_SHA256_PROVIDED" "RESTART_HELPER_SOURCE_SHA256" "$file"
	migrate_legacy_restart_helper_image
}

probe_url() {
	local status

	command_exists curl || return 1
	status="$(curl -sS -o /dev/null -w '%{http_code}' \
		--connect-timeout "$REGISTRY_PROBE_TIMEOUT" \
		--max-time "$REGISTRY_PROBE_TIMEOUT" \
		"$1" 2>/dev/null || true)"

	case "$status" in
		200 | 401 | 403) return 0 ;;
		*) return 1 ;;
	esac
}

normalize_mirror_url() {
	local url="${DOCKER_MIRROR_URL%/}"

	case "$url" in
		https://*) ;;
		*) fail "DOCKER_MIRROR_URL must be an HTTPS registry URL." ;;
	esac

	MIRROR_REGISTRY="${url#https://}"
	case "$MIRROR_REGISTRY" in
		"" | */*) fail "DOCKER_MIRROR_URL must not contain a path." ;;
	esac
	MIRROR_API_URL="${url}/v2/"
}

configure_mirror() {
	case "$DOCKER_MIRROR_MODE" in
		auto | always | never) ;;
		*) fail "DOCKER_MIRROR_MODE must be auto, always, or never." ;;
	esac

	is_unsigned_integer "$DOCKER_PULL_TIMEOUT" || fail "DOCKER_PULL_TIMEOUT must be an unsigned integer."
	is_unsigned_integer "$REGISTRY_PROBE_TIMEOUT" || fail "REGISTRY_PROBE_TIMEOUT must be an unsigned integer."
	[ "$REGISTRY_PROBE_TIMEOUT" -gt 0 ] || fail "REGISTRY_PROBE_TIMEOUT must be greater than zero."

	if [ "$DOCKER_MIRROR_MODE" = "never" ]; then
		info "Docker registry mirror is disabled."
		return
	fi

	normalize_mirror_url
	if ! command_exists curl; then
		warn "curl is unavailable, so mirror health cannot be probed. Pull fallback will still be attempted."
		MIRROR_AVAILABLE=1
		return
	fi

	if probe_url "$MIRROR_API_URL"; then
		MIRROR_AVAILABLE=1
		info "Docker registry mirror is available: ${DOCKER_MIRROR_URL}"
	elif [ "$DOCKER_MIRROR_MODE" = "always" ]; then
		MIRROR_AVAILABLE=1
		warn "Mirror health probe failed, but always mode will still try it before the source registry."
	else
		warn "Docker registry mirror is unavailable. Source registries will be used."
	fi
}

image_is_docker_hub() {
	local image="$1"
	local first

	case "$image" in
		docker.io/* | index.docker.io/* | registry-1.docker.io/*) return 0 ;;
	esac

	first="${image%%/*}"
	if [ "$first" = "$image" ]; then
		return 0
	fi

	case "$first" in
		*.* | *:* | localhost) return 1 ;;
		*) return 0 ;;
	esac
}

image_registry_url() {
	local image="$1"
	local registry

	if image_is_docker_hub "$image"; then
		printf 'https://registry-1.docker.io/v2/'
		return
	fi

	registry="${image%%/*}"
	printf 'https://%s/v2/' "$registry"
}

mirror_image_for() {
	local image="$1"
	local path

	[ -n "$MIRROR_REGISTRY" ] || return 1
	case "$image" in
		"$MIRROR_REGISTRY"/*) return 1 ;;
	esac

	if ! image_is_docker_hub "$image"; then
		return 1
	fi

	path="${image#docker.io/}"
	path="${path#index.docker.io/}"
	path="${path#registry-1.docker.io/}"
	if [[ "$path" != */* ]]; then
		path="library/${path}"
	fi

	printf '%s/%s' "$MIRROR_REGISTRY" "$path"
}

trim_whitespace() {
	local value="$1"

	value="${value#"${value%%[![:space:]]*}"}"
	value="${value%"${value##*[![:space:]]}"}"
	printf '%s' "$value"
}

configure_ztnet_mirror_images() {
	if [ -n "$ZTNET_MIRROR_IMAGE" ]; then
		if [ -n "$ZTNET_MIRROR_IMAGES" ]; then
			ZTNET_MIRROR_IMAGES="${ZTNET_MIRROR_IMAGE},${ZTNET_MIRROR_IMAGES}"
		else
			ZTNET_MIRROR_IMAGES="$ZTNET_MIRROR_IMAGE"
		fi
	fi
}

run_docker_pull() {
	local image="$1"
	local status

	info "Pulling image: ${image}"
	if command_exists timeout && [ "$DOCKER_PULL_TIMEOUT" -gt 0 ]; then
		if timeout "$DOCKER_PULL_TIMEOUT" docker pull "$image"; then
			return
		else
			status=$?
			if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
				warn "Image pull exceeded DOCKER_PULL_TIMEOUT=${DOCKER_PULL_TIMEOUT} seconds."
			fi
			return "$status"
		fi
	else
		docker pull "$image"
	fi
}

select_image() {
	local variable_name="$1"
	local direct_image="$2"
	local explicit_mirrors="$3"
	local fallback_name="$4"
	local validator="${5:-}"
	local generated_mirror=""
	local registry_url
	local candidate
	local existing
	local seen
	local -a raw_mirrors=()
	local -a mirror_images=()
	local -a candidates=()
	local -a attempted=()

	if [ "$DOCKER_MIRROR_MODE" != "never" ]; then
		if [ -n "$explicit_mirrors" ]; then
			IFS=',' read -r -a raw_mirrors <<< "$explicit_mirrors"
			for candidate in "${raw_mirrors[@]}"; do
				candidate="$(trim_whitespace "$candidate")"
				if [ -n "$candidate" ] && [ "$candidate" != "$direct_image" ]; then
					mirror_images+=("$candidate")
				fi
			done
		elif [ "$MIRROR_AVAILABLE" -eq 1 ]; then
			generated_mirror="$(mirror_image_for "$direct_image" || true)"
			if [ -n "$generated_mirror" ] && [ "$generated_mirror" != "$direct_image" ]; then
				mirror_images+=("$generated_mirror")
			fi
		fi
	fi

	if command_exists curl; then
		registry_url="$(image_registry_url "$direct_image")"
		if ! probe_url "$registry_url"; then
			warn "Source registry probe failed for ${direct_image}."
		fi
	fi

	if [ "${#mirror_images[@]}" -gt 0 ] && [ "$DOCKER_MIRROR_MODE" = "always" ]; then
		candidates+=("${mirror_images[@]}")
		candidates+=("$direct_image")
	else
		candidates+=("$direct_image")
		if [ "${#mirror_images[@]}" -gt 0 ]; then
			candidates+=("${mirror_images[@]}")
		fi
	fi

	for candidate in "${candidates[@]}"; do
		seen=0
		if [ "${#attempted[@]}" -gt 0 ]; then
			for existing in "${attempted[@]}"; do
				if [ "$candidate" = "$existing" ]; then
					seen=1
					break
				fi
			done
		fi
		[ "$seen" -eq 1 ] && continue

		attempted+=("$candidate")
		if run_docker_pull "$candidate"; then
			if [ -n "$validator" ] && ! "$validator" "$candidate"; then
				warn "Image is incompatible with ${variable_name}: ${candidate}"
				continue
			fi
			printf -v "$variable_name" '%s' "$candidate"
			return
		fi
		warn "Image pull failed: ${candidate}"
	done

	for candidate in "${attempted[@]}"; do
		if docker image inspect "$candidate" >/dev/null 2>&1; then
			if [ -n "$validator" ] && ! "$validator" "$candidate"; then
				warn "Cached image is incompatible with ${variable_name}: ${candidate}"
				continue
			fi
			warn "Using cached image after pull failure: ${candidate}"
			printf -v "$variable_name" '%s' "$candidate"
			return
		fi
	done

	if [ -n "$validator" ]; then
		fail "Unable to find a compatible image for ${variable_name}. Set ${fallback_name} to a current fork image or wait for the image build to finish."
	fi
	fail "Unable to pull ${direct_image}. Set ${fallback_name} to a reachable registry copy or check registry connectivity."
}

sha256_file() {
	local file="$1"

	if command_exists sha256sum; then
		sha256sum "$file" | awk '{ print $1 }'
	elif command_exists shasum; then
		shasum -a 256 "$file" | awk '{ print $1 }'
	elif command_exists openssl; then
		openssl dgst -sha256 "$file" | awk '{ print $NF }'
	else
		return 1
	fi
}

image_reference_is_digest_pinned() {
	[[ "$1" =~ @sha256:[0-9a-f]{64}$ ]]
}

image_has_restart_helper() {
	local image="$1"
	local temporary_directory
	local container_id=""
	local helper_path
	local actual_sha256=""
	local valid=1

	if ! image_reference_is_digest_pinned "$image"; then
		warn "Restart helper images must use an immutable @sha256 reference: ${image}"
		return 1
	fi

	temporary_directory="$(mktemp -d)"
	helper_path="${temporary_directory}/container-ops.mjs"
	container_id="$(docker create "$image" 2>/dev/null || true)"
	if [ -n "$container_id" ] &&
		docker cp "${container_id}:/app/container-ops.mjs" "$helper_path" >/dev/null 2>&1 &&
		[ -f "$helper_path" ] &&
		[ ! -L "$helper_path" ] &&
		actual_sha256="$(sha256_file "$helper_path" 2>/dev/null)" &&
		[ "$actual_sha256" = "$RESTART_HELPER_SOURCE_SHA256" ]; then
		valid=0
	fi

	if [ -n "$container_id" ]; then
		docker rm -f "$container_id" >/dev/null 2>&1 || true
	fi
	rm -rf "$temporary_directory"
	return "$valid"
}

require_root() {
	if [ "$(id -u)" -ne 0 ]; then
		fail "Please run the downloaded and verified installer as root, for example: sudo bash ./one-click-install.sh"
	fi
}

random_secret() {
	if command_exists openssl; then
		openssl rand -hex 32
	elif command_exists od; then
		od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
	else
		fail "Cannot generate a random secret because neither openssl nor od is available."
	fi
}

check_host() {
	if [ "$(uname -s)" != "Linux" ]; then
		fail "This installer targets Linux hosts because the ZeroTier container needs /dev/net/tun."
	fi

	case "$(uname -m)" in
		x86_64 | amd64 | aarch64 | arm64)
			;;
		*)
			fail "Unsupported CPU architecture: $(uname -m). The bundled ztmkworld binary supports linux/amd64 and linux/arm64."
			;;
	esac
}

detect_host() {
	if [ -n "${PUBLIC_HOST:-}" ]; then
		printf '%s' "$PUBLIC_HOST"
		return
	fi

	if command_exists ip; then
		local route_ip
		route_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}' || true)"
		if [ -n "$route_ip" ]; then
			printf '%s' "$route_ip"
			return
		fi
	fi

	if command_exists hostname; then
		local host_ip
		host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
		if [ -n "$host_ip" ]; then
			printf '%s' "$host_ip"
			return
		fi
	fi

	printf 'localhost'
}

install_docker_if_needed() {
	local installer
	local status

	if command_exists docker; then
		return
	fi

	case "$INSTALL_DOCKER" in
		0 | false) fail "Docker is not installed. Install Docker from your distribution or Docker's signed package repository. Set INSTALL_DOCKER=auto only to explicitly trust Docker's convenience installer." ;;
		auto) ;;
		*) fail "INSTALL_DOCKER must be 0, false, or auto." ;;
	esac

	info "Docker was not found. Installing Docker using get.docker.com..."
	if ! command_exists curl; then
		fail "curl is required to install Docker automatically."
	fi

	installer="$(mktemp)"
	if ! curl -fsSL https://get.docker.com -o "$installer"; then
		rm -f "$installer"
		fail "Unable to download Docker's convenience installer."
	fi
	chmod 700 "$installer"
	if sh "$installer"; then
		status=0
	else
		status=$?
	fi
	rm -f "$installer"
	[ "$status" -eq 0 ] || return "$status"
}

compose_up() {
	if docker compose version >/dev/null 2>&1; then
		docker compose up -d --pull never --remove-orphans
	elif command_exists docker-compose; then
		docker-compose up -d --remove-orphans
	else
		fail "Docker Compose is not available. Install the Docker Compose plugin."
	fi
}

write_env_file() {
	if [ -z "$POSTGRES_PASSWORD" ]; then
		POSTGRES_PASSWORD="$(random_secret)"
	fi
	if [ -z "$NEXTAUTH_SECRET" ]; then
		NEXTAUTH_SECRET="$(random_secret)"
	fi
	if [ -z "$NEXTAUTH_URL" ]; then
		NEXTAUTH_URL="http://127.0.0.1:${HTTP_PORT}"
	fi
	if [ -z "$UPDATE_API_TOKEN" ]; then
		UPDATE_API_TOKEN="$(random_secret)"
	fi
	if [ -z "$RESTART_API_TOKEN" ]; then
		RESTART_API_TOKEN="$(random_secret)"
	fi
	if [ "${#RESTART_API_TOKEN}" -lt 32 ]; then
		fail "RESTART_API_TOKEN must contain at least 32 characters."
	fi
	if [ "$UPDATE_API_TOKEN" = "$RESTART_API_TOKEN" ]; then
		fail "UPDATE_API_TOKEN and RESTART_API_TOKEN must be different."
	fi

	cat > "${INSTALL_DIR}/.env" <<EOF
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_PORT=5432
PUBLIC_BIND=${PUBLIC_BIND}
NEXTAUTH_URL=${NEXTAUTH_URL}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
NEXTAUTH_URL_INTERNAL=http://ztnet:3000
INITIAL_ADMIN_EMAIL=${INITIAL_ADMIN_EMAIL}
RATE_LIMIT_TRUST_PROXY=${RATE_LIMIT_TRUST_PROXY}
AUTO_UPDATE=${AUTO_UPDATE}
AUTO_UPDATE_INTERVAL=${AUTO_UPDATE_INTERVAL}
AUTO_UPDATE_CLEANUP=${AUTO_UPDATE_CLEANUP}
ZTNET_IMAGE=${ZTNET_IMAGE}
UPDATE_API_URL=${UPDATE_API_URL}
UPDATE_API_TOKEN=${UPDATE_API_TOKEN}
RESTART_API_URL=${RESTART_API_URL}
RESTART_API_TOKEN=${RESTART_API_TOKEN}
RESTART_HELPER_IMAGE=${RESTART_HELPER_SOURCE_IMAGE}
RESTART_HELPER_SOURCE_SHA256=${RESTART_HELPER_SOURCE_SHA256}
EOF
	chmod 600 "${INSTALL_DIR}/.env"
}

write_compose_file() {
	cat > "${INSTALL_DIR}/docker-compose.yml" <<EOF
services:
  postgres:
    image: ${POSTGRES_IMAGE}
    container_name: ${APP_NAME}-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - app-network

  zerotier:
    image: ${ZEROTIER_IMAGE}
    hostname: zerotier
    container_name: ${APP_NAME}-zerotier
    restart: unless-stopped
    volumes:
      - zerotier:/var/lib/zerotier-one
    cap_add:
      - NET_ADMIN
      - SYS_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    networks:
      - app-network
    ports:
      - "9993:9993/udp"
    environment:
      - ZT_OVERRIDE_LOCAL_CONF=true
      - ZT_ALLOW_MANAGEMENT_FROM=${APP_SUBNET}
    labels:
      io.ztnet.instance: "${APP_NAME}"
      io.ztnet.role: zerotier
      io.ztnet.restart-enabled: "true"

  ztnet:
    image: ${ZTNET_IMAGE}
    container_name: ${APP_NAME}
    working_dir: /app
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - zerotier:/var/lib/zerotier-one
      - ./backups:/app/backups
    ports:
      - "${PUBLIC_BIND}:${HTTP_PORT}:3000"
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_PORT: \${POSTGRES_PORT}
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
      NEXTAUTH_URL: \${NEXTAUTH_URL}
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL_INTERNAL: \${NEXTAUTH_URL_INTERNAL}
      INITIAL_ADMIN_EMAIL: \${INITIAL_ADMIN_EMAIL}
      RATE_LIMIT_TRUST_PROXY: \${RATE_LIMIT_TRUST_PROXY}
      RESTART_API_URL: \${RESTART_API_URL}
      RESTART_API_TOKEN: \${RESTART_API_TOKEN}
      BACKUP_DIR: /app/backups
    networks:
      - app-network
      - ops-network
EOF

	if [ "$AUTO_UPDATE" = "true" ]; then
		cat >> "${INSTALL_DIR}/docker-compose.yml" <<EOF
    labels:
      com.centurylinklabs.watchtower.enable: "true"
      com.centurylinklabs.watchtower.scope: "${APP_NAME}"
EOF
	fi

	cat >> "${INSTALL_DIR}/docker-compose.yml" <<EOF
    depends_on:
      - postgres
      - zerotier

  restart-helper:
    image: ${RESTART_HELPER_IMAGE}
    container_name: ${APP_NAME}-restart-helper
    restart: unless-stopped
    entrypoint: ["node", "/app/container-ops.mjs"]
    command: []
    environment:
      OPS_SCOPE: ${APP_NAME}
      OPS_PORT: 8081
      RESTART_API_TOKEN: \${RESTART_API_TOKEN}
    expose:
      - "8081"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
EOF

	cat >> "${INSTALL_DIR}/docker-compose.yml" <<EOF
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - ops-network
    depends_on:
      - zerotier
EOF

	if [ "$AUTO_UPDATE" = "true" ]; then
		cat >> "${INSTALL_DIR}/docker-compose.yml" <<EOF

  updater:
    image: ${UPDATER_IMAGE}
    container_name: ${APP_NAME}-updater
    restart: unless-stopped
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_SCOPE: "${APP_NAME}"
      WATCHTOWER_POLL_INTERVAL: "${AUTO_UPDATE_INTERVAL}"
      WATCHTOWER_CLEANUP: "${AUTO_UPDATE_CLEANUP}"
      WATCHTOWER_HTTP_API_UPDATE: "true"
      WATCHTOWER_HTTP_API_PERIODIC_POLLS: "true"
      WATCHTOWER_HTTP_API_METRICS: "true"
      WATCHTOWER_HTTP_API_TOKEN: \${UPDATE_API_TOKEN}
    labels:
      com.centurylinklabs.watchtower.scope: "${APP_NAME}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - app-network
EOF
	fi

	cat >> "${INSTALL_DIR}/docker-compose.yml" <<EOF

volumes:
  zerotier:
  postgres-data:

networks:
  app-network:
    driver: bridge
    ipam:
      driver: default
      config:
        - subnet: ${APP_SUBNET}
  ops-network:
    driver: bridge
    internal: true
EOF
}

main() {
	require_root
	check_host
	load_existing_environment
	RESTART_HELPER_SOURCE_IMAGE="$RESTART_HELPER_IMAGE"
	validate_auto_update
	validate_public_access
	validate_restart_helper_config
	validate_updater_config
	validate_runtime_security
	install_docker_if_needed
	configure_mirror
	configure_ztnet_mirror_images

	select_image "ZTNET_IMAGE" "$ZTNET_IMAGE" "$ZTNET_MIRROR_IMAGES" "ZTNET_MIRROR_IMAGES"
	select_image "RESTART_HELPER_IMAGE" "$RESTART_HELPER_IMAGE" "$RESTART_HELPER_MIRROR_IMAGES" "RESTART_HELPER_MIRROR_IMAGES" "image_has_restart_helper"
	select_image "ZEROTIER_IMAGE" "$ZEROTIER_IMAGE" "$ZEROTIER_MIRROR_IMAGE" "ZEROTIER_MIRROR_IMAGE"
	select_image "POSTGRES_IMAGE" "$POSTGRES_IMAGE" "$POSTGRES_MIRROR_IMAGE" "POSTGRES_MIRROR_IMAGE"
	if [ "$AUTO_UPDATE" = "true" ]; then
		select_image "UPDATER_IMAGE" "$UPDATER_IMAGE" "$UPDATER_MIRROR_IMAGE" "UPDATER_MIRROR_IMAGE" "image_reference_is_digest_pinned"
	fi

	if [ ! -e /dev/net/tun ]; then
		warn "/dev/net/tun was not found. ZeroTier may fail until TUN support is enabled on this host."
	fi

	mkdir -p "$INSTALL_DIR"
	mkdir -p "${INSTALL_DIR}/backups"
	chmod 700 "${INSTALL_DIR}/backups"
	write_env_file
	write_compose_file

	info "Using ZTNET image: ${ZTNET_IMAGE}"
	info "Using restart helper image: ${RESTART_HELPER_IMAGE}"
	info "Using ZeroTier image: ${ZEROTIER_IMAGE}"
	info "Using PostgreSQL image: ${POSTGRES_IMAGE}"
	if [ "$AUTO_UPDATE" = "true" ]; then
		info "Automatic ZTNET updates enabled every ${AUTO_UPDATE_INTERVAL} seconds using ${UPDATER_IMAGE}"
	else
		info "Automatic ZTNET updates disabled."
	fi
	info "Writing deployment files to ${INSTALL_DIR}"

	cd "$INSTALL_DIR"
	compose_up

	info "ZTNET deployment started."
	info "Open: ${NEXTAUTH_URL}"
	info "View logs: cd ${INSTALL_DIR} && docker compose logs -f ztnet"
	if [ "$AUTO_UPDATE" = "true" ]; then
		info "Automatic update logs: cd ${INSTALL_DIR} && docker compose logs -f updater"
	fi
}

if [ "${ZTNET_INSTALLER_SOURCE_ONLY:-0}" != "1" ]; then
	main "$@"
fi
