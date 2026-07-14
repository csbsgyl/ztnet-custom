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

compose_cmd() {
	if docker compose version >/dev/null 2>&1; then
		docker compose "$@"
	elif command_exists docker-compose; then
		docker-compose "$@"
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

	if [ ! -e /dev/net/tun ]; then
		warn "/dev/net/tun was not found. ZeroTier may fail until TUN support is enabled on this host."
	fi

	mkdir -p "$INSTALL_DIR"
	write_env_file
	write_compose_file

	info "Using image: ${ZTNET_IMAGE}"
	info "Writing deployment files to ${INSTALL_DIR}"

	cd "$INSTALL_DIR"
	compose_cmd pull
	compose_cmd up -d

	info "ZTNET deployment started."
	info "Open: ${NEXTAUTH_URL}"
	info "View logs: cd ${INSTALL_DIR} && docker compose logs -f ztnet"
}

main "$@"
