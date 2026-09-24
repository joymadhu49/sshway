# sshway

Give SSH connections memorable names. `sshway` writes ordinary OpenSSH configuration, so the names also work with `ssh`, `scp`, `sftp`, Git, and tools that use SSH.

It supports macOS and Linux. It needs Node.js 20 or newer to manage hosts, plus OpenSSH to connect. It has no runtime npm dependencies, server, account, or password store. Tailscale is optional; a DNS name or IP address also works.

## Install from this project

```sh
cd sshway
pnpm add --global .
```

People without pnpm can use `npm install --global .` from the checkout. During development, run `node bin/sshway.js` without installing it. The package has not been published to npm.

## Save a host

```sh
sshway add mini alex@mini.example.ts.net
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

`sshway` refuses to replace a different command already on `PATH`. The shortcut simply runs `ssh mini` and passes through any extra arguments.

## Other commands

```sh
sshway list
sshway connect mini
sshway connect mini -- uptime
sshway remove mini
sshway --help
```

`remove` also deletes the one-word command if `sshway` created it. For all SSH options, use native SSH directly, such as `ssh -L 8080:localhost:8080 mini`.

## How it works

`sshway` inserts one `Include ~/.ssh/sshway/config` line at the top of `~/.ssh/config`, preserving the rest of that file. Its own host entries are stored in `~/.ssh/sshway/config`; its data is stored in `~/.ssh/sshway/hosts.json`. These files are readable only by your user. It never changes the remote machine or installs a daemon.

OpenSSH reads the first value it finds for most settings. Putting the managed include first makes the saved host name take precedence. Choose a name that does not conflict with an existing SSH host or local command.

`ssh mac mini` means “connect to `mac` and run `mini` remotely.” Use `ssh mini` or a one-word `mini` shortcut for an interactive session.

## Development

```sh
pnpm test
pnpm pack
```
