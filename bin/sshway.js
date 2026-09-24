#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { add, list, remove, shortcut } = require('../lib/hosts');

function usage() {
  console.log(`sshway: memorable names for standard SSH connections

Usage:
  sshway add <name> <[user@]host> [--port <number>] [--identity <path>]
  sshway list
  sshway connect <name> [-- <remote command...>]
  sshway shortcut <name>
  sshway remove <name>

After add, standard SSH works too: ssh <name>.
Run shortcut to create a one-word command in ~/.local/bin.`);
}

function parseAdd(args) {
  const [name, destination, ...rest] = args;
  if (!name || !destination) throw new Error('Expected a name and [user@]host.');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--port') options.port = value;
    else if (flag === '--identity') options.identity = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return { name, destination, options };
}

function main(args) {
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
    const { name, destination, options } = parseAdd(rest);
    add(name, destination, options);
    console.log(`Saved ${name}. Connect with ssh ${name}.`);
    return 0;
  }
  if (command === 'list') {
    if (rest.length) throw new Error('list takes no arguments.');
    const hosts = list();
    for (const [name, item] of Object.entries(hosts)) {
      console.log(`${name}\t${item.user ? `${item.user}@` : ''}${item.host}${item.port ? `:${item.port}` : ''}`);
    }
    if (!Object.keys(hosts).length) console.log('No saved hosts. Use sshway add.');
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

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`sshway: ${error.message}`);
  process.exitCode = 1;
}
