#!/usr/bin/env bash
# mytops-verify - what the hardening register actually says on this machine.
#
# The register is data (modules/hardening.nix) and every rule carries the check
# that decides whether it holds here. This script is the only thing that claims
# compliance, so it distinguishes three outcomes instead of two:
#
#   0  the rule holds
#   1  the rule does not hold
#   3  the rule could not be evaluated here (needs root, service not running,
#      clock not synced yet)
#
# Collapsing 3 into 0 is how a report turns into a claim; collapsing it into 1
# makes a fresh boot look broken. The exit code is 1 only when something is
# genuinely wrong.
set -uo pipefail

report="${1:-/etc/mytops/hardening.json}"

if [ ! -r "$report" ]; then
  echo "mytops-verify: cannot read the register report at $report" >&2
  exit 2
fi

level=$(jq -r '.level' "$report")
norms=$(jq -r '.compliance | join(",")' "$report")
vetoed=$(jq -r '.excludeTags | join(",")' "$report")

echo "mytops hardening: level=$level compliance=[$norms] excludeTags=[$vetoed]"
echo

passed=0
failed=0
skipped=0
results="[]"

while IFS=$'\t' read -r id severity summary b64; do
  script=$(printf '%s' "$b64" | base64 -d)
  out=$(bash -c "$script" 2>&1)
  rc=$?
  case "$rc" in
    0)
      printf 'PASS  %-24s (%s)\n' "$id" "$severity"
      passed=$((passed + 1))
      state=pass
      ;;
    3)
      printf 'SKIP  %-24s (%s)\n' "$id" "$severity"
      [ -n "$out" ] && printf '        %s\n' "$out"
      skipped=$((skipped + 1))
      state=skip
      ;;
    *)
      printf 'FAIL  %-24s (%s)\n' "$id" "$severity"
      printf '        %s\n' "$summary"
      [ -n "$out" ] && printf '        %s\n' "$out"
      failed=$((failed + 1))
      state=fail
      ;;
  esac
  results=$(jq -c --arg id "$id" --arg state "$state" --arg severity "$severity" \
    '. + [{id: $id, severity: $severity, state: $state}]' <<<"$results")
done < <(jq -r '.rules[] | select(.enabled) | [.id, .severity, .summary, (.check | @base64)] | @tsv' "$report")

disabled=$(jq -r '[.rules[] | select(.enabled | not) | .id] | join(",")' "$report")
echo
echo "rules: $passed hold, $failed violated, $skipped not evaluated"
[ "$disabled" != "" ] && echo "off:   $disabled"

# A machine-readable copy for whatever asks later (the console has no way to
# know a workspace's posture otherwise). Best effort: a read-only /run or a
# non-root caller must not turn a verification into a failure.
if [ -d /run/mytops ] && [ -w /run/mytops ]; then
  jq -n \
    --arg level "$level" \
    --argjson passed "$passed" \
    --argjson failed "$failed" \
    --argjson skipped "$skipped" \
    --argjson rules "$results" \
    '{level: $level, passed: $passed, failed: $failed, skipped: $skipped, rules: $rules}' \
    > /run/mytops/hardening-result.json 2>/dev/null || true
fi

[ "$failed" -eq 0 ]
