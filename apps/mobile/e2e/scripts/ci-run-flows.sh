#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.."

LAUNCH_ENV=(-e BB_E2E_EMBEDDED_BUNDLE=1)
if [ "${1:-}" = "--dev-client" ]; then
  LAUNCH_ENV=()
  shift
fi

UDID="${1:?simulator udid}"
ARTIFACTS="${2:?artifacts dir}"
shift 2
FLOWS=("$@")
if [ ${#FLOWS[@]} -eq 0 ]; then
  FLOWS=(shell-launch shell-deep-link shell-send shell-send-sidebar-swipe shell-unreachable-server)
fi

export SERVER_URL="${SERVER_URL:-http://127.0.0.1:41999}"
mkdir -p "$ARTIFACTS"

failed=()
for flow in "${FLOWS[@]}"; do
  file="flows/$flow.yaml"
  out="$ARTIFACTS/$flow"
  mkdir -p "$out"
  echo "::group::maestro $flow"
  # shellcheck disable=SC2086
  if maestro --device "$UDID" test \
      ${LAUNCH_ENV[@]+"${LAUNCH_ENV[@]}"} \
      --format junit --output "$out/junit.xml" \
      --test-output-dir "$out" \
      ${MAESTRO_FLAGS:-} \
      "$file" 2>&1 | tee "$out/maestro.log"; then
    echo "PASS $flow"
  else
    echo "FAIL $flow"
    failed+=("$flow")
    # A failed flow can leave the app on any screen; the next flow cold-starts
    # it, but keep a screenshot of where this one ended.
    xcrun simctl io "$UDID" screenshot "$out/final-screen.png" >/dev/null 2>&1 || true
    cleanup="$out/cleanup"
    mkdir -p "$cleanup"
    if maestro --device "$UDID" test \
        ${LAUNCH_ENV[@]+"${LAUNCH_ENV[@]}"} \
        --format junit --output "$cleanup/junit.xml" \
        --test-output-dir "$cleanup" \
        ${MAESTRO_FLAGS:-} \
        "subflows/clear-open-confirmation.yaml" 2>&1 | tee "$cleanup/maestro.log"; then
      echo "RESET after $flow"
    else
      echo "Failed to clear native state after $flow; stopping before the next flow" >&2
      echo "::endgroup::"
      break
    fi
  fi
  echo "::endgroup::"
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed flows: ${failed[*]}" >&2
  exit 1
fi
echo "All ${#FLOWS[@]} flows passed"
