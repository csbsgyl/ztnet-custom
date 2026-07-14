#!/usr/bin/env bash
set -Eeuo pipefail

POSTGRES_USER_PROVIDED="${POSTGRES_USER+x}"
POSTGRES_DB_PROVIDED="${POSTGRES_DB+x}"
POSTGRES_PASSWORD_PROVIDED="${POSTGRES_PASSWORD+x}"
NEXTAUTH_SECRET_PROVIDED="${NEXTAUTH_SECRET+x}"
NEXTAUTH_URL_PROVIDED="${NEXTAUTH_URL+x}"
AUTO_UPDATE_PROVIDED="${AUTO_UPDATE+x}"
AUTO_UPDATE_INTERVAL_PROVIDED="${AUTO_UPDATE_INTERVAL+x}"
AUTO_UPDATE_CLEANUP_PROVIDED="${AUTO_UPDATE_CLEANUP+x}"
ZTNET_MIRROR_IMAGES_PROVIDED="${ZTNET_MIRROR_IMAGES+x}"
UPDATE_API_TOKEN_PROVIDED="${UPDATE_API_TOKEN+x}"
UPDATE_API_URL_PROVIDED="${UPDATE_API_URL+x}"

APP_NAME="${APP_NAME:-ztnet-custom}"
INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
HTTP_PORT="${HTTP_PORT:-3000}"
APP_SUBNET="${APP_SUBNET:-172.31.255.0/29}"
DEFAULT_ZTNET_IMAGE="ghcr.io/csbsgyl/ztnet-custom:latest"
DEFAULT_ZTNET_MIRROR_IMAGES="ghcr.nju.edu.cn/csbsgyl/ztnet-custom:latest,ghcr.dockerproxy.net/csbsgyl/ztnet-custom:latest,ghcr.1ms.run/csbsgyl/ztnet-custom:latest,ghcr.chenby.cn/csbsgyl/ztnet-custom:latest"
ZTNET_IMAGE="${ZTNET_IMAGE:-${DEFAULT_ZTNET_IMAGE}}"
ZEROTIER_IMAGE="${ZEROTIER_IMAGE:-zyclonite/zerotier:1.14.2}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:15.2-alpine}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-ztnet}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-}"
NEXTAUTH_URL="${NEXTAUTH_URL:-}"
INSTALL_DOCKER="${INSTALL_DOCKER:-auto}"
DOCKER_MIRROR_MODE="${DOCKER_MIRROR_MODE:-auto}"
DOCKER_MIRROR_URL="${DOCKER_MIRROR_URL:-https://docker.xiaohangyun.org}"
DOCKER_PULL_TIMEOUT="${DOCKER_PULL_TIMEOUT:-0}"
REGISTRY_PROBE_TIMEOUT="${REGISTRY_PROBE_TIMEOUT:-8}"
ZTNET_MIRROR_IMAGE="${ZTNET_MIRROR_IMAGE:-}"
ZTNET_MIRROR_IMAGES="${ZTNET_MIRROR_IMAGES:-}"
ZEROTIER_MIRROR_IMAGE="${ZEROTIER_MIRROR_IMAGE:-}"
POSTGRES_MIRROR_IMAGE="${POSTGRES_MIRROR_IMAGE:-}"
AUTO_UPDATE="${AUTO_UPDATE:-true}"
AUTO_UPDATE_INTERVAL="${AUTO_UPDATE_INTERVAL:-3600}"
AUTO_UPDATE_CLEANUP="${AUTO_UPDATE_CLEANUP:-false}"
UPDATE_API_URL="${UPDATE_API_URL:-http://updater:8080}"
UPDATE_API_TOKEN="${UPDATE_API_TOKEN:-}"
UPDATER_IMAGE="${UPDATER_IMAGE:-nickfedor/watchtower:1.19.0}"
UPDATER_MIRROR_IMAGE="${UPDATER_MIRROR_IMAGE:-}"

MIRROR_REGISTRY=""
MIRROR_API_URL=""
MIRROR_AVAILABLE=0

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
	restore_existing_value "AUTO_UPDATE" "$AUTO_UPDATE_PROVIDED" "AUTO_UPDATE" "$file"
	restore_existing_value "AUTO_UPDATE_INTERVAL" "$AUTO_UPDATE_INTERVAL_PROVIDED" "AUTO_UPDATE_INTERVAL" "$file"
	restore_existing_value "AUTO_UPDATE_CLEANUP" "$AUTO_UPDATE_CLEANUP_PROVIDED" "AUTO_UPDATE_CLEANUP" "$file"
	restore_existing_value "UPDATE_API_URL" "$UPDATE_API_URL_PROVIDED" "UPDATE_API_URL" "$file"
	restore_existing_value "UPDATE_API_TOKEN" "$UPDATE_API_TOKEN_PROVIDED" "UPDATE_API_TOKEN" "$file"
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
	if [ "$ZTNET_MIRROR_IMAGES_PROVIDED" != "x" ] && [ "$ZTNET_IMAGE" = "$DEFAULT_ZTNET_IMAGE" ]; then
		ZTNET_MIRROR_IMAGES="$DEFAULT_ZTNET_MIRROR_IMAGES"
	fi

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
	local prefer_mirrors="${5:-false}"
	local generated_mirror=""
	local registry_url
	local direct_reachable=1
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
			direct_reachable=0
			warn "Source registry probe failed for ${direct_image}."
		fi
	fi

	if [ "${#mirror_images[@]}" -gt 0 ] && {
		[ "$DOCKER_MIRROR_MODE" = "always" ] ||
			[ "$direct_reachable" -eq 0 ] ||
			[ "$prefer_mirrors" = "true" ]
	}; then
		candidates+=("${mirror_images[@]}")
		candidates+=("$direct_image")
	else
		candidates+=("$direct_image")
		candidates+=("${mirror_images[@]}")
	fi

	for candidate in "${candidates[@]}"; do
		seen=0
		for existing in "${attempted[@]}"; do
			if [ "$candidate" = "$existing" ]; then
				seen=1
				break
			fi
		done
		[ "$seen" -eq 1 ] && continue

		attempted+=("$candidate")
		if run_docker_pull "$candidate"; then
			printf -v "$variable_name" '%s' "$candidate"
			return
		fi
		warn "Image pull failed: ${candidate}"
	done

	for candidate in "${attempted[@]}"; do
		if docker image inspect "$candidate" >/dev/null 2>&1; then
			warn "Using cached image after pull failure: ${candidate}"
			printf -v "$variable_name" '%s' "$candidate"
			return
		fi
	done

	fail "Unable to pull ${direct_image}. Set ${fallback_name} to a reachable registry copy or check registry connectivity."
}

require_root() {
	if [ "$(id -u)" -ne 0 ]; then
		fail "Please run as root, for example: curl -fsSL <script-url> | sudo bash"
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
	if command_exists docker; then
		return
	fi

	if [ "$INSTALL_DOCKER" = "0" ] || [ "$INSTALL_DOCKER" = "false" ]; then
		fail "Docker is not installed. Install Docker first or rerun with INSTALL_DOCKER=auto."
	fi

	info "Docker was not found. Installing Docker using get.docker.com..."
	if ! command_exists curl; then
		fail "curl is required to install Docker automatically."
	fi

	curl -fsSL https://get.docker.com | sh
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
		NEXTAUTH_URL="http://$(detect_host):${HTTP_PORT}"
	fi
	if [ -z "$UPDATE_API_TOKEN" ]; then
		UPDATE_API_TOKEN="$(random_secret)"
	fi

	cat > "${INSTALL_DIR}/.env" <<EOF
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_PORT=5432
NEXTAUTH_URL=${NEXTAUTH_URL}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
NEXTAUTH_URL_INTERNAL=http://ztnet:3000
AUTO_UPDATE=${AUTO_UPDATE}
AUTO_UPDATE_INTERVAL=${AUTO_UPDATE_INTERVAL}
AUTO_UPDATE_CLEANUP=${AUTO_UPDATE_CLEANUP}
ZTNET_IMAGE=${ZTNET_IMAGE}
UPDATE_API_URL=${UPDATE_API_URL}
UPDATE_API_TOKEN=${UPDATE_API_TOKEN}
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
    env_file:
      - .env
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

  ztnet:
    image: ${ZTNET_IMAGE}
    container_name: ${APP_NAME}
    working_dir: /app
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - zerotier:/var/lib/zerotier-one
    ports:
      - "${HTTP_PORT}:3000"
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_PORT: \${POSTGRES_PORT}
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
      NEXTAUTH_URL: \${NEXTAUTH_URL}
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL_INTERNAL: \${NEXTAUTH_URL_INTERNAL}
    networks:
      - app-network
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
EOF
}

main() {
	require_root
	check_host
	load_existing_environment
	validate_auto_update
	install_docker_if_needed
	configure_mirror
	configure_ztnet_mirror_images

	select_image "ZTNET_IMAGE" "$ZTNET_IMAGE" "$ZTNET_MIRROR_IMAGES" "ZTNET_MIRROR_IMAGES" "true"
	select_image "ZEROTIER_IMAGE" "$ZEROTIER_IMAGE" "$ZEROTIER_MIRROR_IMAGE" "ZEROTIER_MIRROR_IMAGE"
	select_image "POSTGRES_IMAGE" "$POSTGRES_IMAGE" "$POSTGRES_MIRROR_IMAGE" "POSTGRES_MIRROR_IMAGE"
	if [ "$AUTO_UPDATE" = "true" ]; then
		select_image "UPDATER_IMAGE" "$UPDATER_IMAGE" "$UPDATER_MIRROR_IMAGE" "UPDATER_MIRROR_IMAGE"
	fi

	if [ ! -e /dev/net/tun ]; then
		warn "/dev/net/tun was not found. ZeroTier may fail until TUN support is enabled on this host."
	fi

	mkdir -p "$INSTALL_DIR"
	write_env_file
	write_compose_file

	info "Using ZTNET image: ${ZTNET_IMAGE}"
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
