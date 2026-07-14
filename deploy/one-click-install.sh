#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="${APP_NAME:-ztnet-custom}"
INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
HTTP_PORT="${HTTP_PORT:-3000}"
APP_SUBNET="${APP_SUBNET:-172.31.255.0/29}"
ZTNET_IMAGE="${ZTNET_IMAGE:-ghcr.io/csbsgyl/ztnet-custom:latest}"
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
DOCKER_PULL_TIMEOUT="${DOCKER_PULL_TIMEOUT:-300}"
REGISTRY_PROBE_TIMEOUT="${REGISTRY_PROBE_TIMEOUT:-8}"
ZTNET_MIRROR_IMAGE="${ZTNET_MIRROR_IMAGE:-}"
ZEROTIER_MIRROR_IMAGE="${ZEROTIER_MIRROR_IMAGE:-}"
POSTGRES_MIRROR_IMAGE="${POSTGRES_MIRROR_IMAGE:-}"

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

run_docker_pull() {
	local image="$1"

	info "Pulling image: ${image}"
	if command_exists timeout && [ "$DOCKER_PULL_TIMEOUT" -gt 0 ]; then
		timeout "$DOCKER_PULL_TIMEOUT" docker pull "$image"
	else
		docker pull "$image"
	fi
}

select_image() {
	local variable_name="$1"
	local direct_image="$2"
	local explicit_mirror="$3"
	local fallback_name="$4"
	local mirror_image=""
	local registry_url
	local direct_reachable=1
	local preferred_image
	local alternate_image

	if [ "$DOCKER_MIRROR_MODE" != "never" ]; then
		if [ -n "$explicit_mirror" ]; then
			mirror_image="$explicit_mirror"
		elif [ "$MIRROR_AVAILABLE" -eq 1 ]; then
			mirror_image="$(mirror_image_for "$direct_image" || true)"
		fi
	fi

	if [ "$mirror_image" = "$direct_image" ]; then
		mirror_image=""
	fi

	if command_exists curl; then
		registry_url="$(image_registry_url "$direct_image")"
		if ! probe_url "$registry_url"; then
			direct_reachable=0
			warn "Source registry probe failed for ${direct_image}."
		fi
	fi

	preferred_image="$direct_image"
	alternate_image="$mirror_image"
	if [ -n "$mirror_image" ] && { [ "$DOCKER_MIRROR_MODE" = "always" ] || [ "$direct_reachable" -eq 0 ]; }; then
		preferred_image="$mirror_image"
		alternate_image="$direct_image"
	fi

	if run_docker_pull "$preferred_image"; then
		printf -v "$variable_name" '%s' "$preferred_image"
		return
	fi

	warn "Image pull failed: ${preferred_image}"
	if [ -n "$alternate_image" ] && run_docker_pull "$alternate_image"; then
		printf -v "$variable_name" '%s' "$alternate_image"
		return
	fi

	if docker image inspect "$preferred_image" >/dev/null 2>&1; then
		warn "Using cached image after pull failure: ${preferred_image}"
		printf -v "$variable_name" '%s' "$preferred_image"
		return
	fi
	if [ -n "$alternate_image" ] && docker image inspect "$alternate_image" >/dev/null 2>&1; then
		warn "Using cached image after pull failure: ${alternate_image}"
		printf -v "$variable_name" '%s' "$alternate_image"
		return
	fi

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
		docker compose up -d --pull never
	elif command_exists docker-compose; then
		docker-compose up -d
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

	cat > "${INSTALL_DIR}/.env" <<EOF
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_PORT=5432
NEXTAUTH_URL=${NEXTAUTH_URL}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
NEXTAUTH_URL_INTERNAL=http://ztnet:3000
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
    depends_on:
      - postgres
      - zerotier

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
	install_docker_if_needed
	configure_mirror

	select_image "ZTNET_IMAGE" "$ZTNET_IMAGE" "$ZTNET_MIRROR_IMAGE" "ZTNET_MIRROR_IMAGE"
	select_image "ZEROTIER_IMAGE" "$ZEROTIER_IMAGE" "$ZEROTIER_MIRROR_IMAGE" "ZEROTIER_MIRROR_IMAGE"
	select_image "POSTGRES_IMAGE" "$POSTGRES_IMAGE" "$POSTGRES_MIRROR_IMAGE" "POSTGRES_MIRROR_IMAGE"

	if [ ! -e /dev/net/tun ]; then
		warn "/dev/net/tun was not found. ZeroTier may fail until TUN support is enabled on this host."
	fi

	mkdir -p "$INSTALL_DIR"
	write_env_file
	write_compose_file

	info "Using ZTNET image: ${ZTNET_IMAGE}"
	info "Using ZeroTier image: ${ZEROTIER_IMAGE}"
	info "Using PostgreSQL image: ${POSTGRES_IMAGE}"
	info "Writing deployment files to ${INSTALL_DIR}"

	cd "$INSTALL_DIR"
	compose_up

	info "ZTNET deployment started."
	info "Open: ${NEXTAUTH_URL}"
	info "View logs: cd ${INSTALL_DIR} && docker compose logs -f ztnet"
}

if [ "${ZTNET_INSTALLER_SOURCE_ONLY:-0}" != "1" ]; then
	main "$@"
fi
