#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { add, ensureProbe, list, locations, remove, set, shareHostKey, shortcut } = require('../lib/hosts');
const { currentNetwork, runProbe, status } = require('../lib/route');

function usage() {
  console.log(`sshway: memorable names for standard SSH connections

Usage:
  sshway add <name> <[user@]host> [options]
  sshway set <name> [options]
  sshway list
  sshway status <name>
  sshway connect <name> [-- <remote command...>]
  sshway shortcut <name>
  sshway remove <name>
  sshway network

Options:
  --port <number>      SSH port
  --identity <path>    private key file
  --lan <ip>           use this address when on the host's home network
  --network <mac>      home router MAC address (detected when omitted)
  --no-lan             always use the main host address
  --reuse              keep connections open for 10 minutes for instant reconnects
  --no-reuse           stop reusing connections

After add, standard SSH works too: ssh <name>.
Run shortcut to create a one-word command in ~/.local/bin.`);
}

function parseOptions(args, { clear = false } = {}) {
  const values = { '--port': 'port', '--identity': 'identity', '--lan': 'lan', '--network': 'network' };
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--reuse') options.reuse = true;
    else if (clear && flag === '--no-reuse') options.reuse = null;
    else if (clear && flag === '--no-lan') options.lan = options.network = null;
    else if (Object.hasOwn(values, flag)) {
      const value = args[++i];
      if (!value) throw new Error(`Missing value for ${flag}.`);
      options[values[flag]] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

// Without --network, record the network we are on, but only after proving the LAN address answers here.
function detectNetwork(options, port) {
  if (!options.lan || options.network) return;
  const probe = ensureProbe();
  const network = currentNetwork(probe);
  if (!network) throw new Error('Cannot identify this network. Pass --network <router MAC>.');
  if (runProbe(probe, [options.lan, String(port || 22), network]).status !== 0) {
    throw new Error(`Cannot reach ${options.lan}:${port || 22} from this network. Run this on the host's home network, or pass --network with that router's MAC address (sshway network prints it).`);
  }
  options.network = network;
}

function describe(name, item) {
  if (item.lan) {
    console.log(`${name} uses ${item.lan} on network ${item.network}, otherwise ${item.host}.`);
    if (shareHostKey(name, item)) console.log(`Copied the trusted host key for ${item.host} to ${name}.`);
  }
  if (item.reuse) console.log(`${name} keeps connections open for 10 minutes.`);
}

async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    usage();
    return 0;
  }
  if (command === '--version' || command === '-v') {
    console.log(require('../package.json').version);
    return 0;
  }
  if (command === 'add') {
    const [name, destination, ...flags] = rest;
    if (!name || !destination) throw new Error('Expected a name and [user@]host.');
    const options = parseOptions(flags);
    detectNetwork(options, options.port);
    describe(name, add(name, destination, options));
    console.log(`Saved ${name}. Connect with ssh ${name}.`);
    return 0;
  }
  if (command === 'set') {
    const [name, ...flags] = rest;
    if (!name || !flags.length) throw new Error('Expected a host name and at least one option.');
    const options = parseOptions(flags, { clear: true });
    const existing = list()[name];
    if (!existing) throw new Error('Unknown host. Use sshway list.');
    detectNetwork(options, options.port || existing.port);
    describe(name, set(name, options));
    console.log(`Updated ${name}.`);
    return 0;
  }
  if (command === 'list') {
    if (rest.length) throw new Error('list takes no arguments.');
    const hosts = list();
    for (const [name, item] of Object.entries(hosts)) {
      const extra = [item.lan ? `home ${item.lan}` : '', item.reuse ? 'reuse' : ''].filter(Boolean);
      console.log([`${name}`, `${item.user ? `${item.user}@` : ''}${item.host}${item.port ? `:${item.port}` : ''}`, ...extra].join('\t'));
    }
    if (!Object.keys(hosts).length) console.log('No saved hosts. Use sshway add.');
    return 0;
  }
  if (command === 'status') {
    if (rest.length !== 1) throw new Error('Expected one host name.');
    const item = list()[rest[0]];
    if (!item) throw new Error('Unknown host. Use sshway list.');
    ensureProbe();
    for (const line of await status(rest[0], item, locations())) console.log(line);
    return 0;
  }
  if (command === 'network') {
    if (rest.length) throw new Error('network takes no arguments.');
    const network = currentNetwork(ensureProbe());
    if (!network) throw new Error('Cannot identify this network.');
    console.log(network);
    return 0;
  }
  if (command === 'remove') {
    if (rest.length !== 1) throw new Error('Expected one host name.');
    remove(rest[0]);
    console.log(`Removed ${rest[0]}.`);
    return 0;
  }
  if (command === 'shortcut') {
    if (rest.length !== 1) throw new Error('Expected one host name.');
    const result = shortcut(rest[0]);
    console.log(`Created ${result.path}. Run ${rest[0]} to connect.`);
    if (!result.onPath) console.log('Add ~/.local/bin to PATH, then open a new terminal.');
    return 0;
  }
  if (command === 'connect') {
    const [name, ...sshArgs] = rest;
    if (!name || !Object.hasOwn(list(), name)) throw new Error('Unknown host. Use sshway list.');
    const commandArgs = sshArgs[0] === '--' ? sshArgs.slice(1) : sshArgs;
    const child = spawnSync('ssh', [name, ...commandArgs], { stdio: 'inherit' });
    if (child.error) throw child.error;
    return child.status ?? 1;
  }
  throw new Error(`Unknown command: ${command}. Use sshway --help.`);
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code;
}, error => {
  console.error(`sshway: ${error.message}`);
  process.exitCode = 1;
});
