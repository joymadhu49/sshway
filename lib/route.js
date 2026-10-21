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

const windows = process.platform === 'win32';

// OpenSSH for Windows runs Match exec through cmd.exe and rejects any quotes, so it calls the sshway command on PATH.
function probeCommand(item) {
  const args = `${item.lan} ${item.port || 22} ${item.network}`;
  return windows ? `sshway probe ${args}` : `sh ~/.ssh/sshway/probe ${args}`;
}

function normalizeMac(mac) {
  const parts = String(mac).toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || !parts.every(part => /^[0-9a-f]{1,2}$/.test(part))) return null;
  return parts.map(part => part.padStart(2, '0')).join(':');
}

// Windows `route print -4 0.0.0.0`: the active default route with the lowest metric.
function parseRoute(text) {
  let best = null;
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 5 && cols[0] === '0.0.0.0' && cols[1] === '0.0.0.0' && net.isIPv4(cols[2])) {
      const metric = Number(cols[4]);
      if (!best || metric < best.metric) best = { gateway: cols[2], metric };
    }
  }
  return best ? best.gateway : null;
}

// Windows `arp -a <gateway>`: "  10.1.0.1   12-34-56-78-9a-bc   dynamic".
function parseArp(text, gateway) {
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === gateway && cols[1]) return normalizeMac(cols[1]);
  }
  return null;
}

function windowsNetwork() {
  const route = spawnSync('route', ['print', '-4', '0.0.0.0'], { encoding: 'utf8', timeout: 5000 });
  const gateway = route.status === 0 ? parseRoute(route.stdout) : null;
  if (!gateway) return null;
  const arp = spawnSync('arp', ['-a', gateway], { encoding: 'utf8', timeout: 5000 });
  return arp.status === 0 ? parseArp(arp.stdout, gateway) : null;
}

function runProbe(file, args) {
  return spawnSync('sh', [file, ...args], { encoding: 'utf8', timeout: 5000 });
}

function currentNetwork(file) {
  if (windows) return windowsNetwork();
  const result = runProbe(file, ['--network']);
  return result.status === 0 ? result.stdout.trim() : null;
}

async function probeLan(file, lan, port, network) {
  if (!windows) return runProbe(file, [lan, String(port), network]).status === 0;
  if (currentNetwork(file) !== network) return false;
  return (await connectTime(lan, port, 1000)) !== null;
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
  if (item.reuse && !windows) {
    const open = spawnSync('ssh', ['-O', 'check', name], { encoding: 'utf8', timeout: 5000 }).status === 0;
    lines.push(open ? 'Reuse: an open connection is ready; the next ssh starts instantly.' : 'Reuse: on; the next connection stays open for 10 minutes.');
  }
  return lines;
}

module.exports = {
  probeScript, probeCommand, currentNetwork, probeLan, status, normalizeMac, parseRoute, parseArp, windows,
  probeFile: dir => path.join(dir, 'probe'),
};
