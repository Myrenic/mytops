{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.mytops;

  # One X display per workspace, software rendered. Xvfb instead of a GPU-backed
  # X server because a KubeVirt VM here has no GPU worth the name: the desktop
  # is a framebuffer someone looks at remotely, and Xvfb makes the resolution a
  # build-time fact instead of a property of whatever video device the node
  # attached.
  display = cfg.stream.display;
  displayNumber = lib.removePrefix ":" display;

  xdgRuntimeDir = "/run/mytops/xdg";

  # Every unit in this block gets this PATH. A systemd unit on NixOS starts with
  # /usr/bin:/bin, which is empty, so a script that calls `seq`, `ps`, `kill` or
  # `dbus-daemon` fails with command-not-found - and the failure surfaces as
  # something else entirely. `novnc`'s wrapper checks whether websockify came up
  # with `ps` and reports "Failed to start WebSockets proxy" without it, which put
  # this unit in a two-second restart loop: the port was bound only in the gaps,
  # one probe in six answered, and the workspace reported "starting" forever.
  # `dbus-run-session` spawns `dbus-daemon` by name, so the session unit needs dbus
  # here too - without it the session exits 127 and restarts (19 times) while the
  # stream happily serves the last frame it saw.
  unitPath = with pkgs; [
    coreutils
    procps
    dbus
  ];

  # The variables a desktop session needs and a bare systemd unit does not have.
  # `xfce4-session` finds its session and data files through XDG_DATA_DIRS and its
  # helpers through PATH; with neither set it puts "Unable to load a failsafe
  # session" on a black screen - and every health signal stayed green while it did,
  # because the stream serves whatever the framebuffer happens to hold. A stream
  # that answers 200 is not a desktop that works.
  sessionEnv = [
    "XDG_DATA_DIRS=/run/current-system/sw/share"
    "XDG_CONFIG_DIRS=/run/current-system/sw/etc/xdg"
  ];

  sessionPath = with pkgs; [
    coreutils
    procps
    dbus
    xfce.xfce4-session
    xfce.xfwm4
    xfce.xfce4-panel
    xfce.xfdesktop
    xfce.xfconf
    xfce.xfce4-settings
    xfce.exo
    xfce.tumbler
  ];

  # noVNC's web root has vnc.html but no index.html, and the mytops API decides a
  # workspace is up by GET / answering 200 (guestStreamReady in api/server.mjs).
  # A directory listing would satisfy that check while telling the user nothing,
  # and --file-only turns the listing off anyway - so the image serves an index
  # that goes straight to a connected session. Removing this would leave a
  # workspace that works and reports "starting" forever.
  webRoot = pkgs.runCommand "mytops-novnc-web" { } (
    builtins.concatStringsSep "\n" [
      "mkdir -p $out"
      "cp -r ${pkgs.novnc}/share/webapps/novnc/. $out/"
      "cat > $out/index.html <<'HTMLEOF'"
      "<!doctype html>"
      "<html lang=en><head><meta charset=utf-8>"
      "<title>mytops workspace</title>"
      # A meta refresh, not a script: it works with scripts disabled and in
      # every browser this is opened in.
      "<meta http-equiv=refresh content=\"0;url=vnc.html?autoconnect=1&resize=scale&reconnect=1\">"
      "</head><body>"
      "<a href=\"vnc.html?autoconnect=1&resize=scale&reconnect=1\">open the desktop</a>"
      "</body></html>"
      "HTMLEOF"
    ]
  );

  # Wait for the X socket instead of racing it. A session that starts before its
  # display exists dies with "cannot open display", and systemd would then show
  # a failed unit that is really a timing fact.
  waitForDisplay = pkgs.writeShellScript "mytops-wait-display" ''
    for _ in $(seq 1 100); do
      if [ -S /tmp/.X11-unix/X${displayNumber} ]; then exit 0; fi
      sleep 0.2
    done
    echo "display ${display} did not appear" >&2
    exit 1
  '';
in
{
  options.mytops.stream = {
    enable = lib.mkEnableOption "the browser-reachable stream" // {
      default = true;
    };

    # 8080 is not a free choice: the mytops API builds the VM Service and the
    # readiness probe against 8080 (api/server.mjs, buildVmService and
    # guestStreamReady). Changing it here without changing that is a workspace
    # that reports offline while running.
    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "Port noVNC listens on; must match the VM backend port in the API.";
    };

    display = lib.mkOption {
      type = lib.types.str;
      default = ":1";
    };

    resolution = lib.mkOption {
      type = lib.types.str;
      default = "1920x1080";
      description = ''
        The virtual screen size. A client viewport larger than this cannot be
        served by scaling modes the way the selkies stack did, so it is a real
        upper bound rather than a hint - raise it if users complain about a
        small desktop on large monitors.
      '';
    };

    vncPort = lib.mkOption {
      type = lib.types.port;
      default = 5900;
    };
  };

  config = lib.mkIf (cfg.enable && cfg.stream.enable) {
    systemd.tmpfiles.rules = [
      "d ${xdgRuntimeDir} 0700 ${cfg.user.name} ${cfg.user.name} -"
    ];

    systemd.services.mytops-xvfb = {
      description = "mytops virtual X display";
      wantedBy = [ "multi-user.target" ];
      after = [ "mytops-home.service" ];
      path = unitPath;
      serviceConfig = {
        Type = "simple";
        User = cfg.user.name;
        Restart = "always";
        RestartSec = 2;
        ExecStart = lib.concatStringsSep " " [
          # `xorg.xvfb`, not `xvfb`: the top-level alias does not exist on the
          # pinned nixpkgs, and the error only surfaces when the unit is forced.
          "${pkgs.xorg.xvfb}/bin/Xvfb"
          display
          "-screen 0 ${cfg.stream.resolution}x24"
          "-nolisten tcp"
          "-noreset"
        ];
      };
    };

    systemd.services.mytops-desktop = {
      description = "mytops desktop session";
      wantedBy = [ "multi-user.target" ];
      requires = [ "mytops-xvfb.service" ];
      after = [
        "mytops-xvfb.service"
        "mytops-home.service"
      ];
      # The wait loop is shell that calls seq and sleep; a systemd unit without
      # an explicit path gets /usr/bin:/bin, where neither exists.
      path = sessionPath;

      serviceConfig = {
        Type = "simple";
        User = cfg.user.name;
        Restart = "always";
        RestartSec = 5;
        WorkingDirectory = "/home/" + cfg.user.name;
        ExecStartPre = waitForDisplay;
        # A session bus per session, not the system one: dbus-run-session gives
        # the desktop its own bus and tears it down with the session.
        ExecStart = "${pkgs.dbus}/bin/dbus-run-session -- ${cfg.desktop.sessionCommand}";
        Environment = [
          "DISPLAY=${display}"
          "HOME=/home/${cfg.user.name}"
          "XDG_RUNTIME_DIR=${xdgRuntimeDir}"
          "XDG_SESSION_TYPE=x11"
        ] ++ sessionEnv;
      };
    };

    systemd.services.mytops-vnc = {
      description = "mytops VNC server on the virtual display";
      wantedBy = [ "multi-user.target" ];
      requires = [ "mytops-xvfb.service" ];
      after = [
        "mytops-xvfb.service"
        "mytops-desktop.service"
      ];
      path = unitPath;

      serviceConfig = {
        Type = "simple";
        User = cfg.user.name;
        Restart = "always";
        RestartSec = 2;
        ExecStartPre = waitForDisplay;
        # -localhost: the RFB port is reached by the websocket bridge in this
        # pod and by nothing else. Without it, every pod on the cluster could
        # open the desktop on the pod IP and skip the route, the oauth2-proxy
        # chain and the owner check entirely.
        ExecStart = lib.concatStringsSep " " [
          "${pkgs.x11vnc}/bin/x11vnc"
          "-display ${display}"
          "-rfbport ${toString cfg.stream.vncPort}"
          "-localhost"
          "-forever"
          "-shared"
          "-nopw"
          "-quiet"
        ];
      };
    };

    systemd.services.mytops-web = {
      description = "mytops noVNC web front";
      wantedBy = [ "multi-user.target" ];
      requires = [ "mytops-vnc.service" ];
      after = [ "mytops-vnc.service" ];
      # `novnc` is a shell wrapper: it starts websockify and then checks whether
      # it came up. Without `ps` it decides the proxy failed and exits 1, so the
      # unit restarts forever and the port is only briefly bound.
      path = unitPath;
      serviceConfig = {
        Type = "simple";
        Restart = "always";
        RestartSec = 2;
        # `novnc` is noVNC's own launcher (upstream's novnc_proxy): it starts the
        # websocket bridge and serves the client from its own share directory,
        # so neither the web root nor the bridge implementation is a path this
        # repository has to keep correct. It listens on the pod IP the Service
        # points at and forwards to the loopback-only RFB port above.
        #
        # --file-only turns off directory listing: a workspace host is reachable
        # by anyone who can guess it, and a browsable file list is a map of the
        # image.
        ExecStart = lib.concatStringsSep " " [
          "${pkgs.novnc}/bin/novnc"
          "--listen 0.0.0.0:${toString cfg.stream.port}"
          "--vnc 127.0.0.1:${toString cfg.stream.vncPort}"
          "--web ${webRoot}"
          "--file-only"
        ];
      };
    };
  };
}
