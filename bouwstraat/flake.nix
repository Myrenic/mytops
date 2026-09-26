{
  description = "mytops bouwstraat - reproducible NixOS workspace images for mytops";

  # Pinned by flake.lock, which is committed. Mutable refs are a deliberate
  # non-feature: see docs/sovereignty.md (phase 1 of DAWO's zero-dependency
  # plan is "pin everything to revs" because that is what makes an update a
  # decision instead of an event).
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);

      # One host today. A second host is a new entry here plus a file in
      # modules/hosts/, never a fork of the modules.
      hosts = {
        mytops-vm-desktop = ./modules/hosts/vm-desktop.nix;
      };

      mkHost =
        path:
        nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [ path ];
        };
    in
    {
      nixosConfigurations = nixpkgs.lib.mapAttrs (_: mkHost) hosts;

      # The consumer contract (DAWO's three layers, ADR-0001):
      #
      #   1. this flake            - blocks and the two tiers, no org branding
      #   2. an org overlay flake  - takes this as an input, adds its own blocks
      #                              (idp, vpn, vdi client, site settings)
      #   3. a device/VM host      - takes core + overlay, pins hardware
      #
      # An overlay therefore never forks the core: it composes it.
      nixosModules = {
        profiles-mytops-core = ./profiles/core.nix;
        profiles-mytops-hardened = ./profiles/hardened.nix;
        hardening-register = ./modules/hardening.nix;
        desktop = ./modules/desktop.nix;
        stream = ./modules/stream.nix;
        home = ./modules/home.nix;
      };

      # The bouwstraat builds exactly two artifacts per host: the qcow2 itself,
      # and an OCI image that carries it, because CDI imports a registry
      # reference and a bare file in a store path is not something the cluster
      # can pull.
      packages.x86_64-linux =
        let
          pkgs = nixpkgs.legacyPackages.x86_64-linux;
          qcow2 = self.nixosConfigurations.mytops-vm-desktop.config.system.build.qcow2;

          # CDI's registry import looks for the disk inside the image's
          # filesystem, so the image is a container with one identifiable file
          # in it - not a tarball someone has to unpack by hand.
          diskRoot = pkgs.runCommand "mytops-disk-root" { } ''
            mkdir -p $out
            cp ${qcow2}/nixos.qcow2 $out/disk.qcow2
          '';
        in
        {
          inherit qcow2;

          ociImage = pkgs.dockerTools.buildImage {
            name = "mytops/desktop-nixos";
            # The tag is a convenience for humans; what the catalog pins is the
            # digest that comes back from the registry, not this string.
            tag = "latest";
            copyToRoot = diskRoot;
            config.Labels = {
              "org.opencontainers.image.title" = "mytops NixOS desktop disk";
              "org.opencontainers.image.description" = "Bootable NixOS workspace disk for the mytops vm-nixos runtime.";
              "mytops.runtime" = "vm-nixos";
              "mytops.workspace-id" = self.nixosConfigurations.mytops-vm-desktop.config.mytops.workspaceId;
            };
          };
        };

      # `nix flake check` is the local half of the gate; scripts/bouwstraat.sh
      # gate is the half that also proves the mytops API can consume what we
      # built (digest pinning, catalog entry) before anything is promoted.
      checks.x86_64-linux = {
        gate = self.nixosConfigurations.mytops-vm-desktop.config.system.build.toplevel;
      };

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
