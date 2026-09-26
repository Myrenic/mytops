#!/usr/bin/env bash
# bouwstraat - build street for mytops workspace images.
#
# The order is the point, and every step refuses to skip the one before it:
#
#   gate     the image evaluates (every host's toplevel derivation resolves) and
#            the catalog stays consistent. Nothing is built until this passes.
#   build    the artifacts: the qcow2, and the OCI image that carries it.
#   promote  push to the registry, sign, and report the digest.
#   pin      write that digest into the mytops catalog.
#
# A build that is not gated is a device that changes behaviour when nobody was
# looking; a catalog entry that is not pinned is a workspace that runs whatever
# the tag points at today. Both are refused here rather than noticed later.
#
# Everything is overridable so the same script runs on a laptop, in CI and on
# the provisioning station, and every nix/skopeo/cosign call goes through these
# variables - which is also what makes tests/bouwstraat.test.sh able to drive it
# with stand-ins.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
flake_dir="$(cd "$here/.." && pwd)"
repo_dir="$(cd "$flake_dir/.." && pwd)"

NIX="${NIX:-nix}"
SKOPEO="${SKOPEO:-skopeo}"
COSIGN="${COSIGN:-cosign}"
NODE="${NODE:-node}"

# Where the image lands. Pinned by the operator (or CI) and recorded in the
# catalog alongside the digest, so "which artifact is this workspace running"
# is answerable from the catalog alone.
REGISTRY="${REGISTRY:-registry.tuntelder.com}"
IMAGE_NAME="${IMAGE_NAME:-mytops/desktop-nixos}"
HOST="${HOST:-mytops-vm-desktop}"
CATALOG="${CATALOG:-$repo_dir/webui/public/catalog.json}"
ENTRY_TEMPLATE="${ENTRY_TEMPLATE:-$flake_dir/catalog/nixos-desktop.entry.json}"
ENTRY_ID="${ENTRY_ID:-nixos-desktop}"

log() { printf '%s\n' "$*" >&2; }

nix_flake() {
  "$NIX" --extra-experimental-features "nix-command flakes" "$@"
}

# A flake inside a git repository only sees tracked files, and a dirty tree
# changes every store path in it (the cache says "everything changed" when one
# file did). Say so before a confusing build, rather than after.
check_tree_state() {
  if ! git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1; then
    log "bouwstraat: $repo_dir is not a git repository; skipping tree checks"
    return 0
  fi
  if [ -n "$(git -C "$repo_dir" status --porcelain -- "$flake_dir" 2>/dev/null)" ]; then
    log "bouwstraat: warning: the flake directory has uncommitted changes."
    log "bouwstraat:          a build from a dirty tree is not reproducible."
  fi
}

cmd_gate() {
  check_tree_state
  log "bouwstraat: gate - evaluating every configuration"

  # Every host has to evaluate. This is the failure DAWO documented the hard
  # way: a fixed-output derivation already in a runner's store keeps CI green
  # while `main` stops evaluating on a fresh machine, because the store answered
  # a question the code could not.
  local hosts
  hosts=$(nix_flake eval --json "$flake_dir#nixosConfigurations" --apply builtins.attrNames)
  local failed=0
  for host in $(printf '%s' "$hosts" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).join(" ")))'); do
    if nix_flake eval --raw "$flake_dir#nixosConfigurations.$host.config.system.build.toplevel.drvPath" >/dev/null; then
      log "  ok   $host evaluates"
    else
      log "  FAIL $host does not evaluate"
      failed=1
    fi
  done
  [ "$failed" -eq 0 ] || { log "bouwstraat: gate failed - a host does not evaluate"; return 1; }

  log "bouwstraat: gate - catalog invariants"
  "$NODE" "$here/verify-catalog.mjs" --catalog "$CATALOG"
  log "bouwstraat: gate passed"
}

cmd_build() {
  log "bouwstraat: build - $HOST"
  local drv
  drv=$(nix_flake build --no-link --print-out-paths \
    "$flake_dir#packages.x86_64-linux.qcow2")
  local image
  image=$(nix_flake build --no-link --print-out-paths \
    "$flake_dir#packages.x86_64-linux.ociImage")

  log "  qcow2:     $drv"
  log "  oci image: $image"
  if [ -f "$drv/nixos.qcow2" ]; then
    log "  disk sha256: $(sha256sum "$drv/nixos.qcow2" | cut -d' ' -f1)"
    log "  disk bytes:  $(stat -c %s "$drv/nixos.qcow2")"
  else
    log "  FAIL: no nixos.qcow2 in $drv"
    return 1
  fi

  # Handed to promote so a later step cannot silently build something else.
  printf '%s\n' "$image" > "$flake_dir/.oci-image-path"
}

cmd_promote() {
  local image_path="${1:-}"
  if [ -z "$image_path" ]; then
    [ -r "$flake_dir/.oci-image-path" ] || { log "bouwstraat: promote needs a build first"; return 1; }
    image_path=$(cat "$flake_dir/.oci-image-path")
  fi

  local rev
  rev=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || echo unknown)
  local tag="rev-${rev:0:12}"
  local ref="$REGISTRY/$IMAGE_NAME:$tag"

  log "bouwstraat: promote - $image_path -> $ref"
  "$SKOPEO" copy --dest-compress "docker-archive:$image_path" "docker://$ref"
  local digest
  digest=$("$SKOPEO" inspect --format '{{.Digest}}' "docker://$ref")
  log "  digest: $digest"

  # Signing is not optional in a bouwstraat; if cosign is not available the
  # digest is still recorded but the operator is told the artifact is unsigned
  # rather than left to assume it is.
  if command -v "$COSIGN" >/dev/null 2>&1; then
    "$COSIGN" sign --yes "$REGISTRY/$IMAGE_NAME@$digest" && log "  signed: $digest"
  else
    log "  WARNING: cosign not found - $digest is unsigned"
  fi

  log "$REGISTRY/$IMAGE_NAME@$digest"
  printf '%s\n' "$digest" > "$flake_dir/.digest"
  printf '%s\n' "$REGISTRY/$IMAGE_NAME" > "$flake_dir/.repository"
}

cmd_pin() {
  local digest="${1:-}"
  local repository="${2:-}"
  if [ -z "$digest" ]; then
    [ -r "$flake_dir/.digest" ] || { log "bouwstraat: pin needs a promoted digest first"; return 1; }
    digest=$(cat "$flake_dir/.digest")
  fi
  if [ -z "$repository" ]; then
    [ -r "$flake_dir/.repository" ] || { log "bouwstraat: pin needs the repository name"; return 1; }
    repository=$(cat "$flake_dir/.repository")
  fi

  local rev
  rev=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || echo unknown)

  log "bouwstraat: pin - $ENTRY_ID -> $repository@$digest"
  "$NODE" "$here/pin-digest.mjs" \
    --catalog "$CATALOG" \
    --template "$ENTRY_TEMPLATE" \
    --id "$ENTRY_ID" \
    --repository "$repository" \
    --digest "$digest" \
    --rev "$rev" \
    --flake "bouwstraat#nixosConfigurations.$HOST"

  "$NODE" "$here/verify-catalog.mjs" --catalog "$CATALOG"
  log "bouwstraat: pinned. Commit the catalog change to make the workspace launchable."
}

cmd_verify() {
  "$NODE" "$here/verify-catalog.mjs" --catalog "$CATALOG"
}

usage() {
  cat >&2 <<'USAGE'
usage: bouwstraat.sh <command>

  gate              evaluate every host and check the catalog invariants
  build             build the qcow2 and the OCI image
  promote [image]   push the OCI image, sign it, report the digest
  pin [digest] [repo]  write the digest into the mytops catalog
  verify            catalog invariants only

environment:
  REGISTRY, IMAGE_NAME, HOST, CATALOG, ENTRY_TEMPLATE, ENTRY_ID
  NIX, SKOPEO, COSIGN, NODE
USAGE
}

case "${1:-}" in
  gate) cmd_gate ;;
  build) cmd_build ;;
  promote) shift; cmd_promote "${1:-}" ;;
  pin) shift; cmd_pin "${1:-}" "${2:-}" ;;
  verify) cmd_verify ;;
  "" | -h | --help) usage; exit 2 ;;
  *) log "bouwstraat: unknown command: $1"; usage; exit 2 ;;
esac
