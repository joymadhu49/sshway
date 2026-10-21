const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/sshway.js');

function workspace(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshway-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  return { home, run };
}

test('add creates native SSH config and preserves existing entries', t => {
  const { home, run } = workspace(t);
  fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
  fs.writeFileSync(path.join(home, '.ssh/config'), 'ServerAliveInterval 17\nHost old\n    HostName old.example.com\n', { mode: 0o600 });
  const added = run('add', 'mini', 'joy@mini.example.com', '--port', '2222');
  assert.equal(added.status, 0, added.stderr);
  const main = fs.readFileSync(path.join(home, '.ssh/config'), 'utf8');
  assert.match(main, /^Include ~\/\.ssh\/sshway\/config/);
  assert.match(main, /Host old\n    HostName old.example.com/);
  assert.equal(fs.statSync(path.join(home, '.ssh/sshway/config')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, '.ssh/sshway/hosts.json')).mode & 0o777, 0o600);
  // ssh expands ~ from the account database, not the HOME override used by this test.
  const absoluteMain = path.join(home, 'absolute-config');
  fs.writeFileSync(absoluteMain, main.replace('Include ~/.ssh/sshway/config', `Include ${path.join(home, '.ssh/sshway/config')}`));
  const resolved = spawnSync('ssh', ['-F', absoluteMain, '-G', 'mini'], { encoding: 'utf8' });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.match(resolved.stdout, /^hostname mini.example.com$/m);
  assert.match(resolved.stdout, /^user joy$/m);
  assert.match(resolved.stdout, /^port 2222$/m);
  assert.match(resolved.stdout, /^serveraliveinterval 17$/m);
  const old = spawnSync('ssh', ['-F', absoluteMain, '-G', 'old'], { encoding: 'utf8' });
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /^hostname old.example.com$/m);
  assert.match(old.stdout, /^serveraliveinterval 17$/m);
  assert.match(run('list').stdout, /mini\tjoy@mini.example.com:2222/);
});

test('rejects config injection and invalid port without changing SSH config', t => {
  const { home, run } = workspace(t);
  assert.equal(run('add', 'mini', 'joy@mini.example.com').status, 0);
  const file = path.join(home, '.ssh/sshway/config');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(run('add', 'evil\nProxyCommand', 'a@b').status, 1);
  assert.equal(run('add', 'bad', 'a@host\nProxyCommand', '--port', '22').status, 1);
  assert.equal(run('add', 'bad', 'a@host', '--port', '0').status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('shortcut runs SSH and remove deletes only its own shortcut', t => {
  const { home, run } = workspace(t);
  assert.equal(run('add', 'mini', 'joy@mini.example.com').status, 0);
  assert.equal(run('shortcut', 'mini').status, 0);
  const shortcut = path.join(home, '.local/bin/mini');
  assert.equal(fs.statSync(shortcut).mode & 0o111, 0o111);
  const fakeBin = path.join(home, 'fake-bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'ssh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const invoked = spawnSync(shortcut, ['uptime'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(invoked.stdout, 'mini\nuptime\n');
  assert.equal(run('remove', 'mini').status, 0);
  assert.equal(fs.existsSync(shortcut), false);
  assert.equal(run('list').stdout.trim(), 'No saved hosts. Use sshway add.');
});

test('shortcut refuses to shadow another command', t => {
  const { home, run } = workspace(t);
  assert.equal(run('add', 'node', 'joy@mini.example.com').status, 0);
  assert.equal(run('shortcut', 'node').status, 1);
  assert.equal(fs.existsSync(path.join(home, '.local/bin/node')), false);
});

test('refuses to replace a symlinked SSH config', t => {
  const { home, run } = workspace(t);
  const ssh = path.join(home, '.ssh');
  fs.mkdirSync(ssh);
  const original = path.join(home, 'original-config');
  fs.writeFileSync(original, 'Host original\n    HostName original.example.com\n');
  fs.symlinkSync(original, path.join(ssh, 'config'));
  assert.equal(run('add', 'mini', 'alex@mini.example.com').status, 1);
  assert.equal(fs.readFileSync(original, 'utf8'), 'Host original\n    HostName original.example.com\n');
});

// Fake route/arp/nc let the LAN probe run anywhere; FAKE_MAC and FAKE_NC choose the network and reachability.
function fakeNetwork(home) {
  const bin = path.join(home, 'fake-net');
  fs.mkdirSync(bin);
  const tools = {
    uname: 'echo Darwin',
    route: 'echo "    gateway: 10.0.0.1"',
    arp: 'echo "? (10.0.0.1) at ${FAKE_MAC:-4e:5d:6a:1:88:64} on en0 ifscope [ethernet]"',
    nc: 'echo "$@" >> "$HOME/nc.log"; exit ${FAKE_NC:-0}',
  };
  for (const [name, body] of Object.entries(tools)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return (extra = {}) => ({ ...process.env, HOME: home, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}`, ...extra });
}

function resolvedHost(home, env, name) {
  const main = path.join(home, 'absolute-config');
  fs.writeFileSync(main, `Include ${path.join(home, '.ssh/sshway/config')}\nHost other\n    HostName other.example.com\n`);
  const result = spawnSync('ssh', ['-F', main, '-G', name], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('lan routing uses the LAN address only on the home network when it answers', t => {
  const { home, run } = workspace(t);
  const env = fakeNetwork(home);
  assert.equal(run('add', 'mini', 'joy@mini.tail1234.ts.net', '--lan', '192.168.50.119', '--network', '4E:5D:6A:01:88:64').status, 0);
  const config = fs.readFileSync(path.join(home, '.ssh/sshway/config'), 'utf8');
  assert.match(config, /^Match originalhost mini exec "sh ~\/\.ssh\/sshway\/probe 192\.168\.50\.119 22 4e:5d:6a:01:88:64"\n    HostName 192\.168\.50\.119$/m);
  assert.equal(fs.statSync(path.join(home, '.ssh/sshway/probe')).mode & 0o777, 0o700);

  const atHome = resolvedHost(home, env(), 'mini');
  assert.match(atHome, /^hostname 192\.168\.50\.119$/m);
  assert.match(atHome, /^hostkeyalias mini$/m);
  assert.match(atHome, /^user joy$/m);
  assert.match(resolvedHost(home, env({ FAKE_MAC: '10:7c:61:9a:bf:98' }), 'mini'), /^hostname mini\.tail1234\.ts\.net$/m);
  assert.match(resolvedHost(home, env({ FAKE_NC: '1' }), 'mini'), /^hostname mini\.tail1234\.ts\.net$/m);

  fs.rmSync(path.join(home, 'nc.log'));
  assert.match(resolvedHost(home, env(), 'other'), /^hostname other\.example\.com$/m);
  assert.equal(fs.existsSync(path.join(home, 'nc.log')), false, 'other hosts must not run the probe');
});

test('add detects the current network and refuses a LAN address that does not answer', t => {
  const { home } = workspace(t);
  const env = fakeNetwork(home);
  const run = (extra, ...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: env(extra) });
  const failed = run({ FAKE_NC: '1' }, 'add', 'mini', 'joy@mini.example.com', '--lan', '192.168.50.119');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Cannot reach 192\.168\.50\.119:22/);
  assert.equal(fs.existsSync(path.join(home, '.ssh/sshway/hosts.json')), false);

  const added = run({}, 'add', 'mini', 'joy@mini.example.com', '--lan', '192.168.50.119', '--port', '2222');
  assert.equal(added.status, 0, added.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.ssh/sshway/hosts.json'), 'utf8')).mini;
  assert.equal(saved.network, '4e:5d:6a:01:88:64');
  assert.match(fs.readFileSync(path.join(home, 'nc.log'), 'utf8'), /192\.168\.50\.119 2222/);
  assert.equal(run({}, 'network').stdout, '4e:5d:6a:01:88:64\n');
  assert.match(run({}, 'list').stdout, /^mini\tjoy@mini\.example\.com:2222\thome 192\.168\.50\.119$/m);
});

test('set toggles reuse and LAN routing on an existing host', t => {
  const { home, run } = workspace(t);
  assert.equal(run('add', 'mini', 'joy@mini.example.com').status, 0);
  assert.equal(run('set', 'mini', '--reuse', '--lan', '10.0.0.5', '--network', 'aa:bb:cc:dd:ee:ff').status, 0);
  let config = fs.readFileSync(path.join(home, '.ssh/sshway/config'), 'utf8');
  assert.match(config, /ControlMaster auto\n    ControlPath ~\/\.ssh\/sshway\/sockets\/%C\n    ControlPersist 10m/);
  assert.match(config, /^Match originalhost mini exec/m);
  assert.equal(fs.statSync(path.join(home, '.ssh/sshway/sockets')).mode & 0o777, 0o700);
  assert.match(run('list').stdout, /^mini\tjoy@mini\.example\.com\thome 10\.0\.0\.5\treuse$/m);

  assert.equal(run('set', 'mini', '--no-lan', '--no-reuse').status, 0);
  config = fs.readFileSync(path.join(home, '.ssh/sshway/config'), 'utf8');
  assert.doesNotMatch(config, /Match|Control|HostKeyAlias/);
  assert.equal(run('set', 'mini', '--network', 'aa:bb:cc:dd:ee:ff').status, 1);
  assert.equal(run('set', 'mini', '--lan', 'not-an-ip', '--network', 'aa:bb:cc:dd:ee:ff').status, 1);
  assert.equal(run('set', 'mini', '--lan', '10.0.0.5', '--network', 'aa:bb:cc"\nProxyCommand x').status, 1);
});

test('lan routing shares the trusted host key with the alias', t => {
  const { home, run } = workspace(t);
  const key = path.join(home, 'key');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]).status, 0);
  const publicKey = fs.readFileSync(`${key}.pub`, 'utf8').split(' ').slice(0, 2).join(' ');
  fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
  const known = path.join(home, '.ssh/known_hosts');
  fs.writeFileSync(known, `mini.example.com ${publicKey}\n`, { mode: 0o600 });
  const added = run('add', 'mini', 'joy@mini.example.com', '--lan', '10.0.0.5', '--network', 'aa:bb:cc:dd:ee:ff');
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /Copied the trusted host key/);
  assert.equal(fs.readFileSync(known, 'utf8'), `mini.example.com ${publicKey}\nmini ${publicKey}\n`);
  assert.equal(run('set', 'mini', '--reuse').status, 0);
  assert.equal(fs.readFileSync(known, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('shortcut upgrades and removes shortcuts from earlier versions', t => {
  const { home, run } = workspace(t);
  assert.equal(run('add', 'mini', 'joy@mini.example.com').status, 0);
  const target = path.join(home, '.local/bin/mini');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '#!/bin/sh\n# sshway managed shortcut\nexec ssh mini "$@"\n', { mode: 0o755 });
  assert.equal(run('shortcut', 'mini').status, 0);
  assert.match(fs.readFileSync(target, 'utf8'), /ssh -G mini/);
  fs.writeFileSync(target, '#!/bin/sh\n# sshway managed shortcut\nexec ssh mini "$@"\n', { mode: 0o755 });
  assert.equal(run('remove', 'mini').status, 0);
  assert.equal(fs.existsSync(target), false);
});

test('status reports the route and connect time', async t => {
  const { home, run } = workspace(t);
  const net = require('node:net');
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  assert.equal(run('add', 'local', 'joy@127.0.0.1', '--port', String(server.address().port)).status, 0);
  // ssh reads the account's real ~/.ssh/config, so point it at this workspace's config instead.
  const main = path.join(home, 'absolute-config');
  fs.writeFileSync(main, `Include ${path.join(home, '.ssh/sshway/config')}\n`);
  const realSsh = spawnSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec ${realSsh} -F ${main} "$@"\n`, { mode: 0o755 });
  const result = await new Promise(resolve => {
    require('node:child_process').execFile(process.execPath, [cli, 'status', 'local'], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  assert.equal(result.error, null, result.stderr);
  assert.match(result.stdout, new RegExp(`^Route: 127\\.0\\.0\\.1 port ${server.address().port}$`, 'm'));
  assert.match(result.stdout, /^Reachable: TCP connect in \d+ ms\.$/m);
});

function copyPackage(target, version) {
  fs.mkdirSync(target, { recursive: true });
  for (const item of ['bin', 'lib', 'README.md', 'LICENSE']) fs.cpSync(path.resolve(__dirname, '..', item), path.join(target, item), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
}

function execCli(file, args, env) {
  return new Promise(resolve => {
    require('node:child_process').execFile(process.execPath, [file, ...args], { env }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('update pulls a linked git checkout and refreshes old shortcuts', async t => {
  const { home } = workspace(t);
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    assert.equal(result.status, 0, result.stderr);
  };
  const origin = path.join(home, 'origin');
  copyPackage(origin, '0.1.0');
  git(origin, 'init', '-q');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'old');
  const checkout = path.join(home, 'checkout');
  git(home, 'clone', '-q', origin, checkout);
  copyPackage(origin, '0.9.0');
  git(origin, 'commit', '-qam', 'new');

  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const cli = path.join(checkout, 'bin/sshway.js');
  assert.equal(spawnSync(process.execPath, [cli, 'add', 'mini', 'joy@mini.example.com'], { env }).status, 0);
  const shortcut = path.join(home, '.local/bin/mini');
  fs.mkdirSync(path.dirname(shortcut), { recursive: true });
  fs.writeFileSync(shortcut, '#!/bin/sh\n# sshway managed shortcut\nexec ssh mini "$@"\n', { mode: 0o755 });

  fs.appendFileSync(path.join(checkout, 'README.md'), 'local edit\n');
  const dirty = await execCli(cli, ['update'], env);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /has local changes/);
  git(checkout, 'checkout', '--', 'README.md');

  const updated = await execCli(cli, ['update'], env);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /Upgraded shortcuts: mini\./);
  assert.match(updated.stdout, /Updated sshway 0\.1\.0 to 0\.9\.0\./);
  assert.match(fs.readFileSync(shortcut, 'utf8'), /ssh -G mini/);
  assert.match((await execCli(cli, ['update'], env)).stdout, /0\.9\.0 is already the newest version/);
});

test('update installs a verified release archive', async t => {
  const { home } = workspace(t);
  const installed = path.join(home, 'installed');
  copyPackage(installed, '0.1.0');
  const source = path.join(home, 'source');
  copyPackage(source, '0.9.0');
  const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', home], { cwd: source, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const archive = fs.readFileSync(path.join(home, 'sshway-0.9.0.tgz'));
  let checksum = require('node:crypto').createHash('sha256').update(archive).digest('hex');

  const http = require('node:http');
  const server = http.createServer((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/latest') {
      response.end(JSON.stringify({ tag_name: 'v0.9.0', assets: [
        { name: 'sshway-0.9.0.tgz', browser_download_url: `${base}/a.tgz` },
        { name: 'sshway-0.9.0.tgz.sha256', browser_download_url: `${base}/a.sha256` },
      ] }));
    } else if (request.url === '/a.tgz') response.end(archive);
    else if (request.url === '/a.sha256') response.end(`${checksum}  sshway-0.9.0.tgz\n`);
    else response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const prefix = path.join(home, 'prefix');
  const env = {
    ...process.env, HOME: home, npm_config_prefix: prefix, npm_config_update_notifier: 'false',
    PATH: `${path.join(prefix, 'bin')}:${process.env.PATH}`,
    SSHWAY_RELEASES_URL: `http://127.0.0.1:${server.address().port}/latest`,
  };
  const cli = path.join(installed, 'bin/sshway.js');
  checksum = '0'.repeat(64);
  const bad = await execCli(cli, ['update'], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Checksum mismatch/);
  assert.equal(fs.existsSync(prefix), false);

  checksum = require('node:crypto').createHash('sha256').update(archive).digest('hex');
  const updated = await execCli(cli, ['update'], env);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /Updated sshway 0\.1\.0 to 0\.9\.0\./);
  assert.equal(JSON.parse(fs.readFileSync(path.join(prefix, 'lib/node_modules/sshway/package.json'), 'utf8')).version, '0.9.0');
  assert.match((await execCli(path.join(prefix, 'lib/node_modules/sshway/bin/sshway.js'), ['update'], env)).stdout, /already the newest/);
});
