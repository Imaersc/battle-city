import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const g_fnScrypt = promisify(scrypt)
const g_dwSessionSeconds = 8 * 60 * 60
const g_dwAuditRetentionMs = 7 * 24 * 60 * 60 * 1000
const g_oScryptOptions = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }
const g_bufDummySalt = randomBytes(16)
const g_bufDummyHash = randomBytes(32)

function _HashToken(strToken) {
  return createHash('sha256').update(strToken).digest('hex')
}

export function localDataDirectory() {
  if (!process.env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is required for the local authentication database.')
  }
  return join(process.env.LOCALAPPDATA, 'BattleCity', 'Auth')
}

export const sessionSeconds = g_dwSessionSeconds

export class AuthStore {
  #m_oDb

  constructor(strDataDir) {
    mkdirSync(strDataDir, { recursive: true, mode: 0o700 })
    this.#m_oDb = new DatabaseSync(join(strDataDir, 'account-actual.db'))
    this.#m_oDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT UNIQUE NOT NULL,
        salt BLOB NOT NULL,
        password_hash BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        first_game_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS login_events (
        id INTEGER PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        event TEXT NOT NULL CHECK (event IN (
          'login_page', 'login_failed', 'login_limited', 'login_succeeded', 'game_opened'
        )),
        user_id INTEGER REFERENCES users(id)
      );
      CREATE TRIGGER IF NOT EXISTS limit_login_events AFTER INSERT ON login_events BEGIN
        DELETE FROM login_events WHERE occurred_at < NEW.occurred_at - ${g_dwAuditRetentionMs}
          OR id <= (SELECT id FROM login_events ORDER BY id DESC LIMIT 1 OFFSET 2000);
      END;
      CREATE TRIGGER IF NOT EXISTS record_login AFTER INSERT ON sessions BEGIN
        INSERT INTO login_events (occurred_at, event, user_id)
          VALUES (NEW.created_at, 'login_succeeded', NEW.user_id);
      END;
      CREATE TRIGGER IF NOT EXISTS record_game_open AFTER UPDATE OF first_game_at ON sessions
        WHEN OLD.first_game_at IS NULL AND NEW.first_game_at IS NOT NULL BEGIN
        INSERT INTO login_events (occurred_at, event, user_id)
          VALUES (NEW.first_game_at, 'game_opened', NEW.user_id);
      END;
    `)
  }

  hasAccount() {
    return this.#m_oDb.prepare('SELECT id FROM users LIMIT 1').get() != null
  }

  async initializeAccount(strUsername, strPassword) {
    if (
      !/^[a-zA-Z0-9_.-]{1,64}$/.test(strUsername) ||
      !strPassword ||
      Buffer.byteLength(strPassword) > 256
    ) {
      throw new Error('Enter a valid username and a password of 1 to 256 bytes.')
    }
    if (this.hasAccount()) {
      throw new Error('The local test account has already been initialized.')
    }

    const bufSalt = randomBytes(16)
    const bufHash = await g_fnScrypt(strPassword, bufSalt, 32, g_oScryptOptions)
    this.#m_oDb
      .prepare('INSERT INTO users (id, username, salt, password_hash) VALUES (1, ?, ?, ?)')
      .run(strUsername, bufSalt, bufHash)
  }

  async verifyCredentials(strUsername, strPassword) {
    const oAccount = this.#m_oDb
      .prepare('SELECT id, salt, password_hash FROM users WHERE username = ?')
      .get(strUsername)
    const bufHash = await g_fnScrypt(
      strPassword,
      oAccount?.salt ?? g_bufDummySalt,
      32,
      g_oScryptOptions,
    )
    const bMatches = timingSafeEqual(bufHash, oAccount?.password_hash ?? g_bufDummyHash)
    return { nAccountId: oAccount?.id ?? null, bValid: oAccount != null && bMatches }
  }

  createSession(nAccountId) {
    const strToken = randomBytes(32).toString('base64url')
    const dwNow = Date.now()
    this.#m_oDb.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(dwNow)
    this.#m_oDb
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(_HashToken(strToken), nAccountId, dwNow, dwNow + g_dwSessionSeconds * 1000)
    return strToken
  }

  checkSession(strToken, bGamePage = false) {
    const strTokenHash = _HashToken(strToken)
    const dwNow = Date.now()
    const oSession = this.#m_oDb
      .prepare(
        'SELECT user_id, first_game_at FROM sessions WHERE token_hash = ? AND expires_at > ?',
      )
      .get(strTokenHash, dwNow)
    if (oSession && bGamePage && oSession.first_game_at == null) {
      this.#m_oDb
        .prepare(
          'UPDATE sessions SET first_game_at = ? WHERE token_hash = ? AND first_game_at IS NULL',
        )
        .run(dwNow, strTokenHash)
    }
    return oSession != null
  }

  deleteSession(strToken) {
    this.#m_oDb.prepare('DELETE FROM sessions WHERE token_hash = ?').run(_HashToken(strToken))
  }

  recordEvent(strEvent, nAccountId = null) {
    this.#m_oDb
      .prepare('INSERT INTO login_events (occurred_at, event, user_id) VALUES (?, ?, ?)')
      .run(Date.now(), strEvent, nAccountId)
  }

  close() {
    this.#m_oDb.close()
  }
}
