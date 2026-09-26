{ lib, ... }:
{
  mytops.hardening._register = [
    {
      id = "home-mounted";
      severity = "baseline";
      compliance = [ "bio" ];
      tags = [ ];
      summary = "The user's home volume is mounted, when this launch has one.";
      # No configuration: this rule observes rather than sets. It exists because
      # the opposite failure is invisible - the mount failed, the desktop came up
      # on a throwaway home, and every other signal (units active, stream
      # answering, workspace "running") was green. The person using it would have
      # seen an empty home and concluded their work was gone.
      config = _: { };
      check = ''
        source=/run/mytops/home-source
        # An ephemeral entry has no home volume and no source file: not a failure,
        # and not something to report as one.
        if [ ! -s "$source" ]; then
          echo "  this launch has no home volume"
          exit 3
        fi
        if [ ! -d /home/user ]; then
          echo "  /home/user does not exist"
          exit 1
        fi
        if mountpoint -q /home/user; then
          exit 0
        fi
        echo "  /home/user is not a mountpoint although $(cat "$source") was offered"
        exit 1
      '';
    }
  ];
}
