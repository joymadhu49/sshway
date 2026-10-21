const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const releases = process.env.SSHWAY_RELEASES_URL || 'https://api.github.com/repos/joymadhu49/sshway/releases/latest';

function version(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  return result;
}

// A checkout installed with `pnpm add --global .` or `npm install --global .` is linked, so pulling updates it.
function updateCheckout(root) {
  const dirty = run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no']);
  if (dirty.status !== 0) throw new Error(`git status failed in ${root}: ${dirty.stderr.trim()}`);
  if (dirty.stdout.trim()) throw new Error(`${root} has local changes. Commit or stash them, then run sshway update again.`);
  const pull = run('git', ['-C', root, 'pull', '--ff-only']);
  if (pull.status !== 0) throw new Error(`git pull failed in ${root}: ${pull.stderr.trim()}`);
  return { after: version(root), refresh: [process.execPath, [path.join(root, 'bin', 'sshway.js'), 'refresh']] };
}

async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'sshway' } });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function updateArchive(root, before) {
  const release = JSON.parse((await download(releases)).toString('utf8'));
  const latest = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('Could not read the latest release version.');
  if (latest === before) return { after: before };
  const asset = suffix => release.assets?.find(item => item.name === `sshway-${latest}.tgz${suffix}`);
  if (!asset('') || !asset('.sha256')) throw new Error(`Release ${latest} has no sshway-${latest}.tgz and checksum.`);
  const archive = await download(asset('').browser_download_url);
  const expected = (await download(asset('.sha256').browser_download_url)).toString('utf8').trim().split(/\s+/)[0];
  if (crypto.createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Checksum mismatch. Nothing was installed.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshway-update-'));
  try {
    const file = path.join(dir, `sshway-${latest}.tgz`);
    fs.writeFileSync(file, archive);
    const pnpm = root.split(path.sep).includes('pnpm');
    const install = run(pnpm ? 'pnpm' : 'npm', [pnpm ? 'add' : 'install', '--global', file], { stdio: 'inherit' });
    if (install.status !== 0) throw new Error(`${pnpm ? 'pnpm' : 'npm'} could not install the update.`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { after: latest, refresh: ['sshway', ['refresh']] };
}

async function update(root) {
  const before = version(root);
  const checkout = fs.existsSync(path.join(root, '.git'));
  const result = checkout ? updateCheckout(root) : await updateArchive(root, before);
  // Run the refresh with the new code, which may write a different config, probe, or shortcut.
  if (result.refresh) run(result.refresh[0], result.refresh[1], { stdio: 'inherit' });
  return { before, after: result.after };
}

module.exports = { update };
