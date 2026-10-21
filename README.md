# sshway

[![CI](https://github.com/joymadhu49/sshway/actions/workflows/ci.yml/badge.svg)](https://github.com/joymadhu49/sshway/actions/workflows/ci.yml)

Give SSH connections memorable names. `sshway` writes ordinary OpenSSH configuration, so the names also work with `ssh`, `scp`, `sftp`, Git, and tools that use SSH.

It supports macOS and Linux. It needs Node.js 22 or newer to manage hosts, plus OpenSSH to connect. It has no runtime npm dependencies, server, account, or password store. Tailscale is optional; a DNS name or IP address also works.

## Install

```sh
git clone https://github.com/joymadhu49/sshway.git
cd sshway
pnpm add --global .
```

Without pnpm, run `npm install --global .` from the checkout. The GitHub release also provides a package archive that can be installed with `pnpm add --global ./sshway-<version>.tgz` after downloading it. The package is not published to npm.

## Save a host

```sh
sshway add mini alex@mini.example.com
ssh mini
```

Use your machine's actual DNS name in place of the example. A Tailscale MagicDNS name follows the machine if its local network IP changes. You can also use a normal domain or an IP address:

```sh
sshway add server ubuntu@server.example.com --port 2222 --identity ~/.ssh/work_ed25519
ssh server
```

If the remote user matches your local user, you can omit `user@`. Your existing SSH keys or SSH agent handle authentication. On first connection, verify the remote host key before accepting it.

## Make a one-word command

```sh
sshway shortcut mini
mini
```

This creates `~/.local/bin/mini`. That directory must be on your `PATH`. If it is not, add this line to `~/.zshrc` or `~/.bashrc`, then open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

`sshway` refuses to replace a different executable already on `PATH`. The shortcut simply runs `ssh mini` and passes through any extra arguments. If a shell alias or function already uses that name, choose another name or remove the conflict yourself.

## Use the home network when you are there

A Tailscale name works everywhere, but when Tailscale cannot connect directly it relays traffic through a distant server. Give the host its LAN address too, and `ssh mini` uses it whenever you are on that network:

```sh
sshway add mini alex@mini.tailnet-name.ts.net --lan 192.168.1.20
```

Run this while you are on the host's network. `sshway` records that network by its router's MAC address and checks that the LAN address answers. To set it up from elsewhere, pass the router's MAC address yourself. Running `sshway network` on the host prints it:

```sh
sshway set mini --lan 192.168.1.20 --network 10:7c:61:9a:bf:98
```

Each connection checks the network first. Away from home that check needs no network traffic and takes a few milliseconds, so the main address is used without delay. At home the LAN address is used only if it answers within one second. Both routes verify the same host key, saved under the host's name, so another device using that LAN address on a different network cannot impersonate the host. Give the host a fixed LAN address, such as a DHCP reservation on your router.

## Faster reconnects

```sh
sshway set mini --reuse
```

The first connection stays open in the background for 10 minutes after you disconnect, and later `ssh`, `scp`, and Git commands to that host reuse it instead of connecting again.

## Check the route

```sh
sshway status mini
```

This shows which address is in use and how long a TCP connection takes. For a Tailscale address it also asks Tailscale whether the path is direct or relayed. A relayed path is usually much slower; turning on UPnP or NAT-PMP on the router at either end often lets Tailscale connect directly.

A one-word shortcut prints the address it is about to use, such as `sshway: mini via 192.168.1.20`, when run in a terminal.

## Other commands

```sh
sshway list
sshway connect mini
sshway connect mini -- uptime
sshway set mini --no-lan --no-reuse
sshway remove mini
sshway --help
```

`remove` also deletes the one-word command if `sshway` created it. For all SSH options, use native SSH directly, such as `ssh -L 8080:localhost:8080 mini`.

## How it works

`sshway` inserts one `Include ~/.ssh/sshway/config` line at the top of `~/.ssh/config`, preserving the rest of that file. Its own host entries are stored in `~/.ssh/sshway/config`; its data is stored in `~/.ssh/sshway/hosts.json`. LAN routing adds an OpenSSH `Match exec` block that runs the small shell script `~/.ssh/sshway/probe`, and connection reuse keeps its sockets in `~/.ssh/sshway/sockets`. When LAN routing is turned on, `sshway` copies any key you already trust for the main address to an entry under the host's name in `~/.ssh/known_hosts`. These files are readable only by your user. It never changes the remote machine or installs a daemon. The probe needs `nc` to check the LAN address; without it, the LAN address is used whenever you are on the home network.

OpenSSH reads the first value it finds for most settings. Putting the managed include first makes the saved host name take precedence. Choose a name that does not conflict with an existing SSH host or local command.

`ssh mac mini` means “connect to `mac` and run `mini` remotely.” Use `ssh mini` or a one-word `mini` shortcut for an interactive session.

## Development

```sh
pnpm test
pnpm pack
```
