#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${TEST_DIR}/../.." && pwd)"
SOURCE_REPOSITORY="$(sed -n 's/^\$SourceRepository = "\([^"]*\)"$/\1/p' "${REPO_ROOT}/scripts/prepare-github-fork.ps1")"
TARGET_REPOSITORY="example/ztnet-custom-fork"
[ -n "$SOURCE_REPOSITORY" ] || {
	printf 'FAIL: could not read SourceRepository from prepare-github-fork.ps1\n' >&2
	exit 1
}
[ "$SOURCE_REPOSITORY" != "$TARGET_REPOSITORY" ] || TARGET_REPOSITORY="example/ztnet-custom-fork-next"
VERIFIED_HELPER_REPOSITORY="csbsgyl/ztnet-custom"
TEST_TMP="$(mktemp -d)"
FIXTURE_ROOT="${TEST_TMP}/repo"

cleanup_test() {
	local status=$?
	rm -rf "$TEST_TMP"
	exit "$status"
}
trap cleanup_test EXIT

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

sha256_file() {
	local file="$1"

	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$file" | awk '{ print $1 }'
	else
		shasum -a 256 "$file" | awk '{ print $1 }'
	fi
}

copy_fixture_file() {
	local relative_path="$1"

	mkdir -p "${FIXTURE_ROOT}/$(dirname "$relative_path")"
	cp "${REPO_ROOT}/${relative_path}" "${FIXTURE_ROOT}/${relative_path}"
}

replace_literal() {
	local file="$1"
	local from="$2"
	local to="$3"

	FROM_LITERAL="$from" TO_LITERAL="$to" perl -0pi -e \
		's/\Q$ENV{FROM_LITERAL}\E/$ENV{TO_LITERAL}/g' "$file"
}

simulate_prepare_fork() {
	local source_image="ghcr.io/${SOURCE_REPOSITORY}:latest"
	local target_image="ghcr.io/${TARGET_REPOSITORY}:latest"
	local installer_sha256
	local file

	for file in \
		README.md \
		docs/docs/Installation/docker-compose.md \
		SECONDARY_DEVELOPMENT.md \
		scripts/prepare-github-fork.ps1 \
		src/server/systemUpdate.ts \
		src/server/api/__tests__/systemUpdate/systemUpdate.test.ts \
		src/__tests__/pages/admin/systemUpdate.test.tsx; do
		replace_literal "${FIXTURE_ROOT}/${file}" "$SOURCE_REPOSITORY" "$TARGET_REPOSITORY"
	done

	for file in deploy/.env.example deploy/docker-compose.yml deploy/one-click-install.sh; do
		replace_literal "${FIXTURE_ROOT}/${file}" "$source_image" "$target_image"
	done

	replace_literal \
		"${FIXTURE_ROOT}/deploy/tests/one-click-install-test.sh" \
		"$source_image" \
		"$target_image"
	replace_literal \
		"${FIXTURE_ROOT}/deploy/tests/one-click-install-test.sh" \
		"\$SourceRepository = \"${SOURCE_REPOSITORY}\"" \
		"\$SourceRepository = \"${TARGET_REPOSITORY}\""

	replace_literal \
		"${FIXTURE_ROOT}/deploy/README.md" \
		"repo='${SOURCE_REPOSITORY}'" \
		"repo='${TARGET_REPOSITORY}'"
	replace_literal "${FIXTURE_ROOT}/deploy/README.md" "$source_image" "$target_image"
	installer_sha256="$(sha256_file "${FIXTURE_ROOT}/deploy/one-click-install.sh")"
	INSTALLER_SHA256="$installer_sha256" perl -0pi -e \
		'if (/sha256sum -c -/) { s/[0-9a-f]{64}/$ENV{INSTALLER_SHA256}/g }' \
		"${FIXTURE_ROOT}/deploy/README.md"

	git -C "$FIXTURE_ROOT" remote set-url origin "https://github.com/${TARGET_REPOSITORY}.git"
}

fixture_files=(
	Dockerfile
	Dockerfile.ops
	README.md
	SECONDARY_DEVELOPMENT.md
	container-ops.mjs
	deploy/.env.example
	deploy/README.md
	deploy/docker-compose.yml
	deploy/one-click-install.sh
	deploy/tests/one-click-install-test.sh
	docs/docs/Installation/docker-compose.md
	docs/docs/Installation/linux.md
	install.ztnet/README.md
	scripts/prepare-github-fork.ps1
	src/__tests__/pages/admin/systemUpdate.test.tsx
	src/server/api/__tests__/systemUpdate/systemUpdate.test.ts
	src/server/systemUpdate.ts
)

for fixture_file in "${fixture_files[@]}"; do
	copy_fixture_file "$fixture_file"
done

git -C "$FIXTURE_ROOT" init -q
git -C "$FIXTURE_ROOT" remote add origin "https://github.com/${SOURCE_REPOSITORY}.git"

if command -v pwsh >/dev/null 2>&1; then
	(
		cd "$FIXTURE_ROOT"
		pwsh -NoLogo -NoProfile -File scripts/prepare-github-fork.ps1 \
			-Repository "$TARGET_REPOSITORY"
	)
else
	simulate_prepare_fork
fi

installer_sha256="$(sha256_file "${FIXTURE_ROOT}/deploy/one-click-install.sh")"
documented_sha256="$({
	sed -n "/sha256sum -c -/s/.*'\([0-9a-f]\{64\}\)'.*/\1/p" \
		"${FIXTURE_ROOT}/deploy/README.md"
} | sort -u)"
assert_eq "$installer_sha256" "$documented_sha256" "updates the documented installer checksum after fork rewriting"

assert_file_contains \
	"${FIXTURE_ROOT}/deploy/one-click-install.sh" \
	"DEFAULT_ZTNET_IMAGE=\"ghcr.io/${TARGET_REPOSITORY}:latest\"" \
	"updates the installer application image"
assert_file_contains \
	"${FIXTURE_ROOT}/deploy/one-click-install.sh" \
	"DEFAULT_RESTART_HELPER_IMAGE=\"ghcr.io/${VERIFIED_HELPER_REPOSITORY}@sha256:" \
	"keeps the verified helper provenance unchanged"
assert_file_contains \
	"${FIXTURE_ROOT}/src/server/systemUpdate.ts" \
	"api.github.com/repos/${TARGET_REPOSITORY}/actions/workflows/ghcr-image.yml" \
	"updates the system-update workflow repository"
assert_file_contains \
	"${FIXTURE_ROOT}/src/server/systemUpdate.ts" \
	"ghcr.io/${TARGET_REPOSITORY}:latest" \
	"updates the system-update default image"
assert_file_not_contains \
	"${FIXTURE_ROOT}/src/server/systemUpdate.ts" \
	"$SOURCE_REPOSITORY" \
	"removes source-repository defaults from system update"
assert_file_contains \
	"${FIXTURE_ROOT}/src/server/api/__tests__/systemUpdate/systemUpdate.test.ts" \
	"$TARGET_REPOSITORY" \
	"updates system-update test repository references"
assert_file_contains \
	"${FIXTURE_ROOT}/deploy/tests/one-click-install-test.sh" \
	"\$SourceRepository = \"${TARGET_REPOSITORY}\"" \
	"updates the fork-script assertion"
assert_eq \
	"https://github.com/${TARGET_REPOSITORY}.git" \
	"$(git -C "$FIXTURE_ROOT" remote get-url origin)" \
	"updates the origin remote"

bash "${FIXTURE_ROOT}/deploy/tests/one-click-install-test.sh" >/dev/null

printf 'prepare GitHub fork tests passed\n'
