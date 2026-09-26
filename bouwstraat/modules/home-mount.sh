#!/bin/sh
# Mount the mytops home volume over the user's home directory.
#
# Runs as a oneshot before anything draws a screen. Three outcomes, and being
# explicit about which one happened is the point:
#
#   no source file   - an ephemeral entry, or a launch that never resolved the
#                      claim. The workspace still starts (a desktop with a
#                      throwaway home beats no desktop), and mytops-verify
#                      reports the missing home rather than pretending.
#   mount fails      - logged loudly, workspace still starts. The failure mode
#                      we refuse is a login that silently writes into the root
#                      disk and disappears on the next rebuild.
#   mounted          - idempotent: a reboot or a restart of the unit re-uses it.
set -eu

: "${MOUNT_POINT:?MOUNT_POINT is required}"
: "${SOURCE_FILE:?SOURCE_FILE is required}"
: "${OWNER_UID:?OWNER_UID is required}"

if [ ! -r "$SOURCE_FILE" ]; then
  echo "mytops-home: no home source at $SOURCE_FILE - starting without a home volume" >&2
  exit 0
fi

source=$(cat "$SOURCE_FILE")
if [ -z "$source" ]; then
  echo "mytops-home: $SOURCE_FILE is empty - starting without a home volume" >&2
  exit 0
fi

if mountpoint -q "$MOUNT_POINT"; then
  echo "mytops-home: $MOUNT_POINT is already mounted"
  exit 0
fi

mkdir -p "$MOUNT_POINT"

# hard, not soft: soft turns a storage blip into silent data loss for anything
# that does not check its writes, and a workspace profile is exactly that.
# _netdev so the mount machinery knows it needs the network up first.
if ! mount -t nfs -o nfsvers=4.1,hard,noatime,_netdev "$source" "$MOUNT_POINT"; then
  echo "mytops-home: could not mount $source at $MOUNT_POINT - continuing with a local home" >&2
  exit 0
fi

# A brand-new Longhorn volume is handed over owned by root, and the desktop runs
# as uid 1000. The home agent does the same hand-over for containers (it runs as
# root for exactly this reason). Guarded by the owner check so a big home is not
# walked on every boot.
if [ "$(stat -c %u "$MOUNT_POINT")" != "$OWNER_UID" ]; then
  echo "mytops-home: handing $MOUNT_POINT to uid $OWNER_UID"
  chown -R "$OWNER_UID:$OWNER_UID" "$MOUNT_POINT" || echo "mytops-home: chown failed; the desktop may not be able to write its profile" >&2
fi

touch /run/mytops/home-mounted
echo "mytops-home: $source mounted at $MOUNT_POINT"
