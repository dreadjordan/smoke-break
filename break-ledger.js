// Smoke Break's permanent record of finished breaks: an append-only file in which every line is sealed to the line before it, so edits, deletions and reordering are detectable.
// It stores raw breaks rather than running totals, so every stat is worked out from the history and a stat added later covers past breaks too.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LEDGER_FILE = 'break-ledger.jsonl';
// Why: never change this, because every existing ledger would stop verifying. It isn't a real secret: the code is public and a user controls their own machine,
// so sealing stops hand edits, not someone who reads this file. Keeping it in the Keychain would add no strength, and ad-hoc signed updates would lose access to it.
const SEAL_KEY = '2580ad1b86233df4b7edf1f5368a713682f21c30d5474aee88edd41f8456dbe2';

function sealEntry(entry, previousSeal) {
  return crypto.createHmac('sha256', SEAL_KEY).update(`${previousSeal}\n${JSON.stringify(entry)}`).digest('hex');
}

function verifyLine(line, previousSeal) {
  try {
    const { seal, ...entry } = JSON.parse(line);
    return seal === sealEntry(entry, previousSeal) ? { entry, seal } : null;
  } catch {
    return null;
  }
}

// Reads every line that verifies, and leaves the file holding only those so that new lines continue a valid chain.
function readVerifiedLedger(ledgerPath) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], lastSeal: '', byteCount: 0, damaged: false };
    throw error;
  }
  const entries = [];
  let lastSeal = '';
  // Verified lines are pure ASCII, so characters and bytes count the same.
  let byteCount = 0;
  let damaged = false;
  for (let lineEnd = text.indexOf('\n'); lineEnd !== -1; lineEnd = text.indexOf('\n', byteCount)) {
    const verified = verifyLine(text.slice(byteCount, lineEnd), lastSeal);
    if (!verified) {
      damaged = true;
      break;
    }
    entries.push(verified.entry);
    lastSeal = verified.seal;
    byteCount = lineEnd + 1;
  }
  // Why: the original is kept, because a failed check can be disk damage rather than cheating, and these breaks may be worth recovering by hand.
  if (damaged) fs.copyFileSync(ledgerPath, `${ledgerPath}.rejected-${Date.now()}`);
  // A final line with no newline is a write cut short by a crash, not tampering, and the next line must not land on the end of it.
  if (byteCount < text.length) fs.truncateSync(ledgerPath, byteCount);
  return { entries, lastSeal, byteCount, damaged };
}

function openBreakLedger(directory) {
  const ledgerPath = path.join(directory, LEDGER_FILE);
  let ledger;
  try {
    ledger = readVerifiedLedger(ledgerPath);
  } catch (error) {
    // Why: stats must never stop a break, and adding to a file that couldn't be read would fork its chain.
    return { entries: [], damaged: true, append: () => { throw error; } };
  }
  const { entries, damaged } = ledger;
  let { lastSeal, byteCount } = ledger;
  return {
    entries,
    damaged,
    append(entry) {
      const seal = sealEntry(entry, lastSeal);
      const line = `${JSON.stringify({ ...entry, seal })}\n`;
      try {
        fs.appendFileSync(ledgerPath, line, { flush: true });
      } catch (error) {
        // Why: a full disk can leave half a line, which would ruin the chain for every break after it.
        fs.truncateSync(ledgerPath, byteCount);
        throw error;
      }
      entries.push(entry);
      lastSeal = seal;
      byteCount += line.length;
    },
  };
}

// Weeks start on Monday. Why: bounded by now, so a break sealed while the clock was set ahead can't inflate today; moving the clock only moves time between days, never adds any.
function breakTimeTotals(entries, now = new Date()) {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime();
  const totals = { daily: 0, weekly: 0, allTime: 0 };
  for (const { endedAt, durationMs } of entries) {
    totals.allTime += durationMs;
    if (endedAt > now.getTime()) continue;
    if (endedAt >= weekStart) totals.weekly += durationMs;
    if (endedAt >= dayStart) totals.daily += durationMs;
  }
  return totals;
}

module.exports = { openBreakLedger, breakTimeTotals };
