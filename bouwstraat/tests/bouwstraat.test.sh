#!/usr/bin/env bash
# The bouwstraat tooling, driven end to end with stand-ins for nix, skopeo and
# cosign.
#
# What this covers is the part that only breaks in production: the order of
# gate/build/promote/pin, that the digest actually reaches the catalog, that the
# entry template survives the round trip, and that the checks that are supposed
# to refuse something still do. It does not test the image - that is `nix eval`
# in the gate and a boot on a test cluster, and pretending otherwise here would
# be a test that passes while the image does not boot.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
flake_dir="$(cd "$here/.." && pwd)"
repo_dir="$(cd "$flake_dir/.." && pwd)"
real_catalog="$repo_dir/webui/public/catalog.json"

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A throwaway repository: bouwstraat.sh insists on a real git revision for a pin
# (an image nobody can rebuild from a revision is not evidence of anything), so
# "unknown" has to be genuinely impossible in the test.
mkdir -p "$work/repo/bouwstraat" "$work/repo/webui/public" "$work/bin"
cp -r "$flake_dir/." "$work/repo/bouwstraat/"
cp "$real_catalog" "$work/repo/webui/public/catalog.json"

git -c init.defaultBranch=main init -q "$work/repo"
git -C "$work/repo" -c user.email=test@example.invalid -c user.name=test add -A
git -C "$work/repo" -c user.email=test@example.invalid -c user.name=test commit -qm "fixture"

# ── stand-ins ────────────────────────────────────────────────────────

cat > "$work/bin/nix" <<'NIX'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  *"eval --json"*"--apply builtins.attrNames"*) echo '["mytops-vm-desktop"]' ;;
  *"eval --raw"*) echo "/nix/store/fake-toplevel.drv" ;;
  *"packages.x86_64-linux.qcow2"*)
    out="$(mktemp -d)"
    # Big enough to be a file, small enough to be a test fixture.
    printf 'qcow2-fixture' > "$out/nixos.qcow2"
    echo "$out"
    ;;
  *"packages.x86_64-linux.ociImage"*)
    out="$(mktemp)"
    printf 'oci-archive-fixture' > "$out"
    echo "$out"
    ;;
  *) echo "fake nix: unhandled: $args" >&2; exit 2 ;;
esac
NIX

cat > "$work/bin/skopeo" <<'SKOPEO'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  copy) exit 0 ;;
  inspect) echo "sha256:1111111111111111111111111111111111111111111111111111111111111111" ;;
  *) echo "fake skopeo: unhandled: $*" >&2; exit 2 ;;
esac
SKOPEO

cat > "$work/bin/cosign" <<'COSIGN'
#!/usr/bin/env bash
exit 0
COSIGN

chmod +x "$work/bin/nix" "$work/bin/skopeo" "$work/bin/cosign"

bouwstraat="$work/repo/bouwstraat/scripts/bouwstraat.sh"
catalog="$work/repo/webui/public/catalog.json"
export PATH="$work/bin:$PATH"
export NIX="$work/bin/nix" SKOPEO="$work/bin/skopeo" COSIGN="$work/bin/cosign"
export CATALOG="$catalog" HOST="mytops-vm-desktop" ENTRY_ID="nixos-desktop"
export REGISTRY="registry.test.invalid" IMAGE_NAME="mytops/desktop-nixos"

run() { "$bouwstraat" "$@" 2>&1; }

echo "unpinned vm entry is refused"
python_tmp="$work/repo/webui/public/catalog.json"
node -e '
const fs = require("node:fs")
const p = process.argv[1]
const c = JSON.parse(fs.readFileSync(p, "utf8"))
c.apps.push({
  id: "bad-desktop", name: "Bad", description: "x", type: "desktop",
  runtime: "vm-nixos", persistence: "persistent", lifecycle: "suspend",
  icon: "x", image: "registry.test.invalid/mytops/desktop-nixos:latest",
  groups: ["bad-desktop"],
})
fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n")
' "$python_tmp"
if run verify >/dev/null; then
  fail "verify accepted a vm entry tagged instead of pinned"
else
  pass "verify refused an unpinned vm image"
fi

# Back to a clean catalog for the rest of the run.
cp "$real_catalog" "$catalog"

echo "gate"
if run gate >/dev/null; then pass "gate passes on a consistent catalog"; else fail "gate failed on a consistent catalog"; fi

echo "build"
build_out="$(run build)"
if printf '%s' "$build_out" | grep -q "disk sha256:"; then
  pass "build reports the disk digest"
else
  fail "build did not report a disk digest"
fi
if [ -r "$work/repo/bouwstraat/.oci-image-path" ]; then
  pass "build hands the image path to promote"
else
  fail "build did not record the image path"
fi

echo "promote"
promote_out="$(run promote)"
if printf '%s' "$promote_out" | grep -q "sha256:1111"; then
  pass "promote reports the registry digest"
else
  fail "promote did not report a digest"
fi
if printf '%s' "$promote_out" | grep -q "signed"; then
  pass "promote signs the digest"
else
  fail "promote did not sign"
fi
if [ -r "$work/repo/bouwstraat/.digest" ]; then
  pass "promote records the digest for pin"
else
  fail "promote did not record the digest"
fi

echo "pin"
pin_out="$(run pin)"
if printf '%s' "$pin_out" | grep -q "updated nixos-desktop\|added nixos-desktop"; then
  pass "pin writes the entry"
else
  fail "pin did not write the entry"
fi

entry="$(node -e '
const fs = require("node:fs")
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const e = c.apps.find((x) => x.id === "nixos-desktop")
process.stdout.write(JSON.stringify(e ?? null))
' "$catalog")"

check_entry() {
  node -e '
const entry = JSON.parse(process.argv[1])
const [field, expected] = [process.argv[2], process.argv[3]]
const actual = field.split(".").reduce((o, k) => (o ?? {})[k], entry)
process.exit(String(actual ?? "") === expected ? 0 : 1)
' "$entry" "$1" "$2"
}

check_entry "image" "registry.test.invalid/mytops/desktop-nixos@sha256:1111111111111111111111111111111111111111111111111111111111111111" \
  && pass "the image is pinned to the promoted digest" || fail "the image is not pinned"
check_entry "runtime" "vm-nixos" && pass "the runtime survives the pin" || fail "runtime lost"
check_entry "groups.0" "nixos-desktop" && pass "the group ACL survives the pin" || fail "group ACL lost"
check_entry "source.flake" "bouwstraat#nixosConfigurations.mytops-vm-desktop" \
  && pass "provenance names the flake attribute" || fail "provenance missing"

rev="$(node -e '
const entry = JSON.parse(process.argv[1]); process.stdout.write(String(entry.source?.rev ?? ""))
' "$entry")"
if printf '%s' "$rev" | grep -qE '^[0-9a-f]{40}$'; then
  pass "provenance carries a full revision"
else
  fail "provenance revision is not a git revision: $rev"
fi

echo "gate after pin"
if run gate >/dev/null; then pass "gate passes with the pinned entry"; else fail "gate failed after pin"; fi
if run verify >/dev/null; then pass "verify passes with the pinned entry"; else fail "verify failed after pin"; fi

echo "a bad digest is refused"
if run pin "sha256:notahash" "registry.test.invalid/mytops/desktop-nixos" >/dev/null; then
  fail "pin accepted a malformed digest"
else
  pass "pin refused a malformed digest"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "bouwstraat tooling: all checks passed"
else
  echo "bouwstraat tooling: $failures failed"
  exit 1
fi
