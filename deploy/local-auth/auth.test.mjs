import { strict as assert } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createAuthServer } from './server.mjs'
import { AuthStore } from './store.mjs'

test('protects sessions, records access and omits supplied passwords from SQLite', async function _TestAuth() {
  const strDataDir = mkdtempSync(join(tmpdir(), 'battle-city-auth-'))
  const strDbPath = join(strDataDir, 'account-actual.db')
  const strPassword = randomBytes(24).toString('hex')
  const strRejectedPassword = randomBytes(24).toString('hex')
  const oStore = new AuthStore(strDataDir)
  const oServer = createAuthServer(oStore)
  const strOrigin = 'http://127.0.0.1:8081'
  oServer.listen(0, '127.0.0.1')
  await once(oServer, 'listening')
  const strUrl = `http://127.0.0.1:${oServer.address().port}`

  function _Post(strPath, strOriginHeader, oParams, strCookie = '') {
    return fetch(`${strUrl}${strPath}`, {
      method: 'POST',
      headers: { origin: strOriginHeader, cookie: strCookie },
      body: new URLSearchParams(oParams),
      redirect: 'manual',
    })
  }

  function _Check(strCookie = '', strGameUri = '/battle-city/') {
    return fetch(`${strUrl}/check`, { headers: { cookie: strCookie, 'x-game-uri': strGameUri } })
  }

  try {
    await oStore.initializeAccount('tester', strPassword)
    await assert.rejects(
      oStore.initializeAccount('another', strPassword),
      /already been initialized/,
    )
    assert.equal((await _Check()).status, 401)
    assert.equal((await fetch(`${strUrl}/login`)).status, 200)
    assert.equal((await _Post('/register', strOrigin, {})).status, 404)
    assert.equal((await _Post('/login', 'https://example.test', {})).status, 403)
    const oFailed = await _Post('/login', strOrigin, {
      username: 'tester',
      password: strRejectedPassword,
    })
    assert.equal(oFailed.status, 401)
    assert.equal(oFailed.headers.has('set-cookie'), false)
    assert.equal((await _Check()).status, 401)

    const oLogin = await _Post('/login', strOrigin, { username: 'tester', password: strPassword })
    assert.equal(oLogin.status, 303)
    assert.equal(oLogin.headers.get('location'), '/battle-city/')
    const strSetCookie = oLogin.headers.get('set-cookie')
    assert.match(strSetCookie, /HttpOnly; SameSite=Strict/)
    const strCookie = strSetCookie.split(';', 1)[0]
    assert.equal((await _Check(strCookie, '/battle-city/assets/game.js')).status, 204)
    assert.equal((await _Check(strCookie)).status, 204)
    assert.equal((await _Check(strCookie)).status, 204)

    const oLogout = await _Post('/logout', strOrigin, {}, strCookie)
    assert.equal(oLogout.status, 303)
    assert.equal((await _Check(strCookie)).status, 401)

    for (let nAttempt = 0; nAttempt < 6; nAttempt += 1) {
      const oResult = await _Post('/login', strOrigin, {
        username: 'unknown',
        password: strRejectedPassword,
      })
      assert.equal(oResult.status, 401)
    }
    assert.equal(
      (await _Post('/login', strOrigin, { username: 'tester', password: strPassword })).status,
      429,
    )

    const oDb = new DatabaseSync(strDbPath, { readOnly: true })
    try {
      const arrEvents = oDb.prepare('SELECT event, user_id FROM login_events ORDER BY id').all()
      assert.equal(
        arrEvents.filter(function _Opened(oEvent) {
          return oEvent.event === 'game_opened' && oEvent.user_id === 1
        }).length,
        1,
      )
      assert.ok(
        arrEvents.some(function _FailedKnown(oEvent) {
          return oEvent.event === 'login_failed' && oEvent.user_id === 1
        }),
      )
      assert.ok(
        arrEvents.some(function _FailedUnknown(oEvent) {
          return oEvent.event === 'login_failed' && oEvent.user_id == null
        }),
      )
      const bufDb = readFileSync(strDbPath)
      for (const strSecret of [strPassword, strRejectedPassword, strCookie.split('=')[1]]) {
        assert.equal(bufDb.includes(strSecret), false)
      }
    } finally {
      oDb.close()
    }
  } finally {
    await new Promise(function _Stop(fnResolve) {
      oServer.close(fnResolve)
    })
    oStore.close()
    unlinkSync(strDbPath)
    rmdirSync(strDataDir)
  }
})
