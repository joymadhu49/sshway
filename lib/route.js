const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

// Runs inside OpenSSH Match exec, so it must stay POSIX sh and finish fast when away from home.
const probeScript = `#!/bin/sh
# Written by sshway. Exits 0 only on the saved network when the LAN address answers.
# Usage: probe <address> <port> <network>  or  probe --network
PATH="$PATH:/usr/sbin:/sbin:/usr/bin:/bin"
os=$(uname -s)

gateway() {
  if [ "$os" = Darwin ]; then
    route -n get default 2>/dev/null | awk '$1 == "gateway:" { print $2; exit }'
  else
    ip route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "via") { print $(i + 1); exit } }'
  fi
}

network() {
  gw=$(gateway)
  [ -n "$gw" ] || return 1
  if [ "$os" = Darwin ]; then
    mac=$(arp -n "$gw" 2>/dev/null | awk '{ print $4; exit }')
  else
    mac=$(ip neigh show "$gw" 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "lladdr") { print $(i + 1); exit } }')
  fi
  printf '%s\\n' "$mac" | awk -F: 'NF == 6 { out = ""; for (i = 1; i <= 6; i++) { o = tolower($i); if (length(o) == 1) o = "0" o; out = out (i > 1 ? ":" : "") o }; print out; ok = 1 } END { exit !ok }'
}

if [ "$1" = --network ]; then
  network
  exit
fi
[ $# -eq 3 ] || exit 2
[ "$(network)" = "$3" ] || exit 1
command -v nc >/dev/null 2>&1 || exit 0
if [ "$os" = Darwin ]; then
  nc -z -G 1 -w 1 "$1" "$2" >/dev/null 2>&1
else
  nc -z -w 1 "$1" "$2" >/dev/null 2>&1
fi
`;

function probeCommand(item) {
  return `sh ~/.ssh/sshway/probe ${item.lan} ${item.port || 22} ${item.network}`;
}

function runProbe(file, args) {
  return spawnSync('sh', [file, ...args], { encoding: 'utf8', timeout: 5000 });
}

function currentNetwork(file) {
  const result = runProbe(file, ['--network']);
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolve(name) {
  const result = spawnSync('ssh', ['-G', name], { encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ssh -G ${name} failed: ${result.stderr.trim()}`);
  const value = key => result.stdout.match(new RegExp(`^${key} (.+)$`, 'm'))?.[1];
  return { hostname: value('hostname'), port: Number(value('port') || 22) };
}

function connectTime(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const start = performance.now();
    const socket = net.connect({ host, port });
    const finish = ms => {
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(timeout, () => finish(null));
    socket.once('connect', () => finish(performance.now() - start));
    socket.once('error', () => finish(null));
  });
}

function isTailscale(host) {
  if (/\.ts\.net$/i.test(host) || /^fd7a:115c:a1e0:/i.test(host)) return true;
  const parts = host.split('.').map(Number);
  return net.isIPv4(host) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function tailscalePath(host) {
  const candidates = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const command of candidates) {
    if (command.includes('/') && !fs.existsSync(command)) continue;
    const result = spawnSync(command, ['ping', '-c', '1', '--timeout', '3s', host], { encoding: 'utf8', timeout: 8000 });
    if (result.error) continue;
    const pong = `${result.stdout}${result.stderr}`.match(/via (DERP\(([^)]+)\)|\S+) in (\S+)/);
    if (!pong) return null;
    return pong[2] ? { relay: pong[2], time: pong[3] } : { direct: pong[1], time: pong[3] };
  }
  return null;
}

async function status(name, item, files) {
  const lines = [];
  const { hostname, port } = resolve(name);
  const home = item.lan && hostname === item.lan;
  if (item.lan && !home) {
    const here = currentNetwork(files.probe);
    lines.push(here === item.network
      ? `Home network: detected, but ${item.lan}:${item.port || 22} did not answer, so using the fallback.`
      : `Home network: not detected (this network is ${here || 'unknown'}, home is ${item.network}).`);
  }
  const via = home ? `home network ${hostname}` : isTailscale(hostname) ? `Tailscale ${hostname}` : hostname;
  lines.push(`Route: ${via} port ${port}`);

  const times = [];
  for (let i = 0; i < 3; i++) times.push(await connectTime(hostname, port));
  const best = times.filter(ms => ms !== null).sort((a, b) => a - b)[0];
  lines.push(best === undefined ? 'Reachable: no answer within 3 s.' : `Reachable: TCP connect in ${Math.round(best)} ms.`);

  if (!home && isTailscale(hostname)) {
    const tail = tailscalePath(hostname);
    if (!tail) lines.push('Tailscale path: unknown (tailscale CLI not found or no reply).');
    else if (tail.direct) lines.push(`Tailscale path: direct (${tail.direct}, ${tail.time}).`);
    else {
      lines.push(`Tailscale path: relayed through DERP ${tail.relay} (${tail.time}).`);
      lines.push('Tip: turn on UPnP or NAT-PMP on the router at either end so Tailscale can connect directly.');
    }
  }
  if (item.reuse) {
    const open = spawnSync('ssh', ['-O', 'check', name], { encoding: 'utf8', timeout: 5000 }).status === 0;
    lines.push(open ? 'Reuse: an open connection is ready; the next ssh starts instantly.' : 'Reuse: on; the next connection stays open for 10 minutes.');
  }
  return lines;
}

module.exports = { probeScript, probeCommand, runProbe, currentNetwork, status, probeFile: dir => path.join(dir, 'probe') };
