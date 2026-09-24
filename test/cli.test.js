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
  fs.writeFileSync(path.join(home, '.ssh/config'), 'Host old\n    HostName old.example.com\n', { mode: 0o600 });
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
