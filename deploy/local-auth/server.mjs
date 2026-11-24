import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AuthStore, g_strDataDir, hasLocalAccount, readAudit, sessionSeconds } from './store.mjs'

const g_strCookieName = 'battle_city_session'
const g_strGamePath = '/battle-city/'
const g_setOrigins = new Set(['http://127.0.0.1:8081', 'http://localhost:8081'])
const g_dwBodyLimit = 2048
const g_dwLoginWindowMs = 60_000
const g_dwLoginLimit = 8
const g_dwConcurrentChecks = 2
const g_oPages = {
  form: `<form method="post" action="/login">
      <label>Username<input name="username" autocomplete="username" required maxlength="64"></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label>
      <button type="submit">Sign in</button>
    </form>`,
  session: `<a class="action" href="${g_strGamePath}">Continue to game</a>
    <form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
}

function _SendPage(oResponse, nStatus, strMessage = '', bSignedIn = false) {
  oResponse.writeHead(nStatus, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  })
  oResponse.end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Battle City sign in</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#171611;color:#f4ecd9}
body{margin:0;min-height:100vh;display:grid;place-items:center}
main{box-sizing:border-box;width:min(100% - 2rem,24rem);padding:1.5rem;background:#28231a;border-top:4px solid #ffc960}
h1{margin:0 0 1.25rem;font-size:1.7rem}label{display:block;margin-bottom:1rem}
input{box-sizing:border-box;width:100%;margin-top:.35rem;padding:.65rem;border:1px solid #aa9065;background:#171611;color:inherit;font:inherit}
button,.action{display:block;box-sizing:border-box;width:100%;margin-top:.75rem;padding:.65rem;border:0;background:#ffc960;color:#1c1710;font:inherit;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}
p{color:#ffb6a5}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid white;outline-offset:2px}
</style>
<main><h1>Battle City</h1>${strMessage ? `<p role="alert">${strMessage}</p>` : ''}${bSignedIn ? g_oPages.session : g_oPages.form}</main>
</html>`)
}

function _ReadSessionCookie(oRequest) {
  const arrCookies = (oRequest.headers.cookie ?? '').split(';')
  let strToken = ''
  for (const strCookie of arrCookies) {
    const arrMatch = strCookie.trim().match(/^battle_city_session=([A-Za-z0-9_-]{43})$/)
    if (arrMatch) {
      strToken = arrMatch[1]
    }
  }
  return strToken
}

function _SessionCookie(strToken, nMaxAge) {
  return `${g_strCookieName}=${strToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${nMaxAge}`
}

async function _ReadLoginForm(oRequest) {
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(oRequest.headers['content-type'] ?? '')
  ) {
    return null
  }

  const arrChunks = []
  let dwBytes = 0
  for await (const bufChunk of oRequest) {
    dwBytes += bufChunk.length
    if (dwBytes > g_dwBodyLimit) {
      return null
    }
    arrChunks.push(bufChunk)
  }

  const oForm = new URLSearchParams(Buffer.concat(arrChunks).toString('utf8'))
  const strUsername = oForm.get('username') ?? ''
  const strPassword = oForm.get('password') ?? ''
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(strUsername) &&
    strPassword &&
    Buffer.byteLength(strPassword) <= 256
    ? { strUsername, strPassword }
    : null
}

export function createAuthServer(oStore) {
  const arrAttempts = []
  let dwChecks = 0

  async function _Login(oRequest, oResponse, strOldToken) {
    const oForm = await _ReadLoginForm(oRequest)
    if (!oForm) {
      oStore.recordEvent('login_failed')
      _SendPage(oResponse, 401, 'Invalid username or password.')
      return
    }

    const dwNow = Date.now()
    while (arrAttempts.length && arrAttempts[0] <= dwNow - g_dwLoginWindowMs) {
      arrAttempts.shift()
    }
    if (arrAttempts.length >= g_dwLoginLimit || dwChecks >= g_dwConcurrentChecks) {
      oStore.recordEvent('login_limited')
      oResponse.setHeader('Retry-After', '60')
      _SendPage(oResponse, 429, 'Too many attempts. Try again shortly.')
      return
    }

    arrAttempts.push(dwNow)
    dwChecks += 1
    try {
      const { nAccountId, bValid } = await oStore.verifyCredentials(
        oForm.strUsername,
        oForm.strPassword,
      )
      if (bValid) {
        if (strOldToken) {
          oStore.deleteSession(strOldToken)
        }
        const strToken = oStore.createSession(nAccountId)
        oResponse
          .writeHead(303, {
            Location: g_strGamePath,
            'Set-Cookie': _SessionCookie(strToken, sessionSeconds),
            'Cache-Control': 'no-store',
          })
          .end()
      } else {
        oStore.recordEvent('login_failed', nAccountId)
        _SendPage(oResponse, 401, 'Invalid username or password.')
      }
    } finally {
      dwChecks -= 1
    }
  }

  async function _Dispatch(oRequest, oResponse) {
    const strPath = oRequest.url?.split('?', 1)[0]
    const strMethod = oRequest.method
    const strToken = _ReadSessionCookie(oRequest)

    if (strMethod === 'GET' && strPath === '/check') {
      const strGameUrl = oRequest.headers['x-game-uri']?.split('?', 1)[0]
      const bGamePage = strGameUrl === g_strGamePath || strGameUrl === `${g_strGamePath}index.html`
      oResponse.writeHead(strToken && oStore.checkSession(strToken, bGamePage) ? 204 : 401).end()
    } else if (strMethod === 'GET' && strPath === '/login') {
      const bSignedIn = Boolean(strToken && oStore.checkSession(strToken))
      if (!bSignedIn) {
        oStore.recordEvent('login_page')
      }
      _SendPage(oResponse, 200, '', bSignedIn)
    } else if (strMethod === 'POST' && (strPath === '/login' || strPath === '/logout')) {
      if (!g_setOrigins.has(oRequest.headers.origin)) {
        oResponse.writeHead(403).end()
      } else if (strPath === '/login') {
        await _Login(oRequest, oResponse, strToken)
      } else {
        if (strToken) {
          oStore.deleteSession(strToken)
        }
        oResponse
          .writeHead(303, {
            Location: '/login',
            'Set-Cookie': _SessionCookie('', 0),
            'Cache-Control': 'no-store',
          })
          .end()
      }
    } else {
      oResponse.writeHead(404).end()
    }
  }

  return createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 5_000, maxHeaderSize: 8192 },
    function _OnRequest(oRequest, oResponse) {
      void _Dispatch(oRequest, oResponse).catch(function _OnAuthError() {
        console.error('Local authentication request failed.')
        if (!oResponse.headersSent) {
          oResponse.writeHead(503).end()
        } else {
          oResponse.destroy()
        }
      })
    },
  )
}

async function _Run() {
  const [strAction, strUsername] = process.argv.slice(2)
  if (relative(process.cwd(), process.argv[1]) !== join('deploy', 'local-auth', 'server.mjs')) {
    throw new Error('Run the authentication command from the repository root.')
  } else if (strAction === 'status') {
    process.exitCode = hasLocalAccount(g_strDataDir) ? 0 : 3
  } else if (strAction === 'audit') {
    console.table(readAudit(g_strDataDir))
  } else if (strAction === 'init') {
    const oStore = new AuthStore(g_strDataDir)
    try {
      const strPassword = readFileSync(0, 'utf8').replace(/\r?\n$/, '')
      await oStore.initializeAccount(strUsername ?? '', strPassword)
      console.log('Local test account initialized.')
    } finally {
      oStore.close()
    }
  } else if (strAction === 'serve') {
    if (!hasLocalAccount(g_strDataDir)) {
      throw new Error(
        'Initialize the local test account before starting the authentication server.',
      )
    }
    const oStore = new AuthStore(g_strDataDir)
    const oServer = createAuthServer(oStore)
    oServer.on('close', function _CloseStore() {
      oStore.close()
    })
    oServer.listen(8788, '127.0.0.1', function _ReportReady() {
      console.log('Local authentication server listening on 127.0.0.1:8788.')
    })
  } else {
    throw new Error('Usage: server.mjs init <username> (password on stdin), serve, or audit.')
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))
) {
  try {
    await _Run()
  } catch (oError) {
    console.error(oError.message)
    process.exitCode = 1
  }
}
