import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Where this extension can run.
 *
 * Linux and macOS share everything it depends on: symlinks for shared history,
 * a POSIX login shell for the CLI, and — the part that matters — Claude Code
 * keeping its OAuth token as a FILE (`<CLAUDE_CONFIG_DIR>/.credentials.json`).
 * On macOS that last one is conditional: Claude Code prefers the Keychain and
 * only falls back to the file, see credentialsInKeychain().
 */
export function isSupportedPlatform(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin';
}

/**
 * True when this Mac's Claude Code keeps its token in the Keychain instead of
 * `.credentials.json`.
 *
 * The file-based flows copy, compare and delete that file. On a Keychain-backed
 * Mac there is no file to act on, so the extension runs in KEYCHAIN MODE there
 * instead (see keychainMode()).
 *
 * The fingerprint is the default account: `~/.claude.json` names a signed-in
 * account but `~/.claude/.credentials.json` does not exist. Our own sign-out
 * clears that identity along with the token (see reclaim.signOut), so a leftover
 * identity without a token is Claude Code's Keychain at work, not our doing.
 */
export function credentialsInKeychain(): boolean {
  if (process.platform !== 'darwin') return false;
  const home = os.homedir();
  if (fs.existsSync(path.join(home, '.claude', '.credentials.json'))) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')) as {
      oauthAccount?: { emailAddress?: string };
    };
    return Boolean(cfg.oauthAccount?.emailAddress);
  } catch {
    return false; // no config yet — nothing signed in, nothing to misread
  }
}

/**
 * Tells Claude Code which dir's credential slot to use, independently of
 * CLAUDE_CONFIG_DIR. Verified against the CLI: with an empty CLAUDE_CONFIG_DIR
 * and this pointing at a signed-in dir, `claude auth status` reports signed in.
 * On a Keychain-backed Mac the slot is a Keychain entry derived from this path.
 */
export const SECURE_ENV_VAR = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

/**
 * The SECURE_ENV_VAR value that selects `dir`'s slot.
 *
 * The default `~/.claude` is the exception, verified against a Keychain-backed
 * install: its slot (the plain "Claude Code-credentials" entry) is reached only
 * with an EMPTY value. Spelling out its path selects a different, path-derived
 * entry — as does setting CLAUDE_CONFIG_DIR to it — and reads as signed out.
 */
export function slotEnvValue(dir: string): string {
  return path.normalize(dir) === path.normalize(path.join(os.homedir(), '.claude')) ? '' : dir;
}

/** The slot dir a SECURE_ENV_VAR value selects — the inverse of slotEnvValue. */
export function slotDirFromEnv(value: string | undefined): string | undefined {
  return value === '' ? path.join(os.homedir(), '.claude') : value;
}

let keychain: boolean | undefined;

/**
 * KEYCHAIN MODE — a Mac whose Claude Code keeps tokens in the Keychain.
 *
 * Tokens can't be copied between dirs there without handling raw secrets, so the
 * model changes shape: an account's store dir IS its credential slot, and every
 * window running it points CLAUDE_SECURESTORAGE_CONFIG_DIR at that store while
 * CLAUDE_CONFIG_DIR stays on the window's own working dir (config + history).
 * Claude Code owns the Keychain entry; this extension never reads or writes one.
 *
 * The price: a sign-in writes into the window's slot — the bound account's — so
 * it REPLACES that account. New accounts come from "Add Account", which gives
 * the window a fresh, empty slot to sign in to.
 *
 * Decided once per activation — the mode must not flip under a running window —
 * and remembered on disk once detected: forgetting the default account clears
 * the very identity credentialsInKeychain() looks for, and falling back to file
 * mode afterwards would read every Keychain account as signed out.
 */
export function keychainMode(): boolean {
  if (keychain !== undefined) return keychain;
  if (process.platform !== 'darwin') return (keychain = false);
  const marker = path.join(os.homedir(), '.claude-windows', '.keychain-mode');
  keychain = fs.existsSync(marker) || credentialsInKeychain();
  if (keychain) {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, '', { mode: 0o600 });
    } catch {
      /* best-effort: the fingerprint still holds until the default account is forgotten */
    }
  }
  return keychain;
}
