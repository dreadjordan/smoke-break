// Asks GitHub whether a newer Smoke Break has been released, and offers it to the user.
// Updating opens the download page rather than installing, because replacing an app in place needs a paid signing certificate on macOS.
const { dialog, net, shell } = require('electron');
const path = require('node:path');

const LATEST_RELEASE_API = 'https://api.github.com/repos/dreadjordan/smoke-break/releases/latest';
const DOWNLOAD_PAGE = 'https://github.com/dreadjordan/smoke-break/releases/latest';
const REQUEST_TIMEOUT_MS = 10000;

function isNewer(candidate, current) {
  const candidateParts = candidate.split('.').map(Number);
  const currentParts = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index];
  }
  return false;
}

// The newer version on offer, or null. Why: being offline, rate limited or having no release yet is normal, and never worth bothering the user with.
async function findNewerVersion(currentVersion) {
  try {
    const response = await net.fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Smoke Break' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const version = String((await response.json()).tag_name).replace(/^v/, '');
    return isNewer(version, currentVersion) ? version : null;
  } catch {
    return null;
  }
}

async function offerUpdate(version, currentVersion, { onSkip, onNever }) {
  const { response } = await dialog.showMessageBox({
    message: `Smoke Break ${version} is available`,
    detail: `You have version ${currentVersion}.`,
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    buttons: ['Update', 'Skip', 'Never Remind Me'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) shell.openExternal(DOWNLOAD_PAGE);
  else if (response === 1) onSkip();
  else onNever();
}

module.exports = { findNewerVersion, offerUpdate };
