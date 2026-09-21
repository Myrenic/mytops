#!/bin/sh
set -eu
# MAX_LIFETIME_MINUTES comes from the container env.
MAX_MINUTES="${MAX_LIFETIME_MINUTES:-480}"
echo "Culling workspaces older than ${MAX_MINUTES}m (only lifecycle=ephemeral|disposable)"

NOW=$(date +%s)

# A workspace's creation time is only useful if it can be read. GNU date first,
# then busybox's -D form: this image's /bin/date IS busybox, which cannot parse
# an ISO timestamp with -d. Treating that failure as "epoch 0" made every
# workspace look 29 million minutes old and deleted it on sight, so an
# unparsable timestamp skips the workspace instead.
age_minutes() {
  _ts=$(date -d "$1" +%s 2>/dev/null ||
    date -D "%Y-%m-%dT%H:%M:%SZ" -d "$1" +%s 2>/dev/null || echo "")
  [ -z "$_ts" ] && return 1
  echo $(( (NOW - _ts) / 60 ))
}

# Only disposable sessions are culled by age. "suspend" means the entry should
# be stopped when idle, not deleted after a fixed lifetime - and this job has no
# idle signal, only creation age. Culling suspend/persistent workspaces by age
# would delete work that is still in use.
cullable() {
  case "$1" in
    ephemeral | disposable) return 0 ;;
    *) return 1 ;;
  esac
}

# The label keys below must match the labels api/server.mjs puts on a workspace
# (mytops-owner, mytops-lifecycle, mytops-runtime). Keeping this file as
# reviewable text - it is encoded into the ConfigMap by the build, not stored as
# a blob - is what makes that checkable: as binaryData it silently skipped every
# workspace for weeks after a rename nothing could grep for.
#
# Nothing here may delete an object named `home-*`: that is the user's home
# volume, and it outlives every workspace on purpose.

echo "-- container workspaces"
kubectl get deploy -n services \
  -l app.kubernetes.io/component=session \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\t"}{.metadata.labels.mytops-owner}{"\t"}{.metadata.labels.mytops-lifecycle}{"\n"}{end}' |
while IFS="$(printf '\t')" read -r name created owner lifecycle; do
  [ -z "$name" ] && continue
  if ! cullable "${lifecycle:-}"; then
    echo "Skipping ${name} (lifecycle=${lifecycle:-unset}, owner: ${owner})"
    continue
  fi
  if ! age=$(age_minutes "$created"); then
    echo "Skipping ${name}: cannot parse creationTimestamp '${created}'"
    continue
  fi
  if [ "$age" -ge "$MAX_MINUTES" ]; then
    echo "Culling ${name} (age: ${age}m, lifecycle: ${lifecycle}, owner: ${owner})"
    kubectl delete deploy "$name" -n services --ignore-not-found 2>&1 || true
    kubectl delete svc "$name" -n services --ignore-not-found 2>&1 || true
    kubectl delete ingressroute "$name" -n network --ignore-not-found 2>&1 || true
  else
    echo "Keeping ${name} (age: ${age}m)"
  fi
done

# VM workspaces: the VM, its cloud-init Secret, Service and route, plus the root
# disk (DataVolume, PVC and the Longhorn volume behind it - the storage class
# retains, so a deleted PVC alone leaves the disk). The user's home volume is
# not part of any of this and is never matched here.
echo "-- vm workspaces"
kubectl get vm -n kubevirt \
  -l mytops-runtime \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\t"}{.metadata.labels.mytops-owner}{"\t"}{.metadata.labels.mytops-lifecycle}{"\n"}{end}' |
while IFS="$(printf '\t')" read -r name created owner lifecycle; do
  [ -z "$name" ] && continue
  case "$name" in home-*) continue ;; esac
  if ! cullable "${lifecycle:-}"; then
    echo "Skipping ${name} (lifecycle=${lifecycle:-unset}, owner: ${owner})"
    continue
  fi
  if ! age=$(age_minutes "$created"); then
    echo "Skipping ${name}: cannot parse creationTimestamp '${created}'"
    continue
  fi
  if [ "$age" -lt "$MAX_MINUTES" ]; then
    echo "Keeping ${name} (age: ${age}m)"
    continue
  fi

  echo "Culling ${name} (age: ${age}m, lifecycle: ${lifecycle}, owner: ${owner})"
  pv=$(kubectl get pvc "$name" -n kubevirt -o jsonpath='{.spec.volumeName}' 2>/dev/null || true)
  kubectl delete vm "$name" -n kubevirt --ignore-not-found 2>&1 || true
  kubectl delete vmi "$name" -n kubevirt --ignore-not-found 2>&1 || true
  kubectl delete datavolume "$name" -n kubevirt --ignore-not-found 2>&1 || true
  kubectl delete pvc "$name" -n kubevirt --ignore-not-found 2>&1 || true
  kubectl delete secret "$name-cloudinit" -n kubevirt --ignore-not-found 2>&1 || true
  kubectl delete svc "$name-svc" -n kubevirt --ignore-not-found 2>&1 || true
  kubectl delete ingressroute "$name" -n network --ignore-not-found 2>&1 || true
  if [ -n "$pv" ]; then
    # Give the PVC a moment to go before dropping the volume: deleting it while
    # the PVC still exists lets the CSI driver recreate the Longhorn volume.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kubectl get pvc "$name" -n kubevirt >/dev/null 2>&1 || break
      sleep 2
    done
    kubectl delete "volumes.longhorn.io/$pv" -n storage --ignore-not-found 2>&1 || true
  fi
done

# CDI imports a VM disk through a scratch volume (`prime-<uuid>-scratch`) that it
# deletes when the import finishes. The storage class retains, so every import
# leaves the PV behind as Released with its Longhorn volume still allocated -
# 10Gi per VM build, which adds up fast now that rebuilding a VM is cheap. Match
# strictly on CDI's scratch naming in the PV's claimRef, so a workspace's own
# disk (`ws-...`) or a home volume (`home-...`) can never be selected.
echo "-- released import scratch volumes"
kubectl get pv \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.spec.claimRef.name}{"\n"}{end}' |
while IFS="$(printf '\t')" read -r pvname phase claim; do
  [ -z "$pvname" ] && continue
  case "$claim" in
    prime-*-scratch) ;;
    *) continue ;;
  esac
  [ "$phase" = "Released" ] || continue
  echo "Releasing import scratch ${pvname} (was ${claim})"
  kubectl delete pv "$pvname" --ignore-not-found 2>&1 || true
  kubectl delete "volumes.longhorn.io/$pvname" -n storage --ignore-not-found 2>&1 || true
done

echo "Done."
