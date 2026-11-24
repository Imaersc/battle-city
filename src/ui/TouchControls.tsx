import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'
import type InputManager from '../input/InputManager'
import type { PlayerControl } from '../input/bindings'

interface TOUCH_PRESS {
  elButton: HTMLButtonElement
  strCode: string
}

interface TOUCH_CONTROLS_PROPS {
  oInput: InputManager
  oControl: PlayerControl
  bReady: boolean
  bAwaitingGesture: boolean
  bPaused: boolean
  fnTogglePause: () => void
}

export default function TouchControls({
  oInput,
  oControl,
  bReady,
  bAwaitingGesture,
  bPaused,
  fnTogglePause,
}: TOUCH_CONTROLS_PROPS) {
  const mapPresses = useRef(new Map<number, TOUCH_PRESS>()).current
  const bCanPlay = bReady && !bPaused
  const strPauseLabel = bAwaitingGesture ? 'Tap to start' : bPaused ? 'Resume' : 'Pause'

  function _OnPointerDown(oEvent: PointerEvent<HTMLDivElement>) {
    const elButton = (oEvent.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]')
    const strCode = elButton?.dataset.key
    if (bCanPlay && elButton && strCode && oEvent.button === 0 && oEvent.pointerType !== 'mouse') {
      const nPointerId = oEvent.pointerId
      elButton.setPointerCapture(nPointerId)
      mapPresses.set(nPointerId, { elButton, strCode })
      elButton.dataset.pressed = ''
      oInput.keyDown(strCode, nPointerId)
    }
  }

  function _OnPointerEnd(oEvent: PointerEvent<HTMLDivElement>) {
    const nPointerId = oEvent.pointerId
    const oPress = mapPresses.get(nPointerId)
    if (oPress) {
      mapPresses.delete(nPointerId)
      oInput.keyUp(oPress.strCode, nPointerId)
      const bStillPressed = Array.from(mapPresses.values()).some(function _IsSameButton(oOther) {
        return oOther.elButton === oPress.elButton
      })
      if (!bStillPressed) {
        delete oPress.elButton.dataset.pressed
      }
    }
  }

  function _OnContextMenu(oEvent: MouseEvent<HTMLDivElement>) {
    oEvent.preventDefault()
  }

  useEffect(
    function _WatchTouchLifecycle() {
      function _ReleaseTouches() {
        for (const [nPointerId, oPress] of mapPresses) {
          oInput.keyUp(oPress.strCode, nPointerId)
          delete oPress.elButton.dataset.pressed
          if (oPress.elButton.hasPointerCapture(nPointerId)) {
            oPress.elButton.releasePointerCapture(nPointerId)
          }
        }
        mapPresses.clear()
      }

      function _OnVisibilityChange() {
        if (document.hidden && mapPresses.size > 0) {
          oInput.releaseAll()
          _ReleaseTouches()
        }
      }

      if (!bCanPlay) {
        _ReleaseTouches()
      }
      window.addEventListener('blur', _ReleaseTouches)
      document.addEventListener('visibilitychange', _OnVisibilityChange)

      return function _StopWatchingTouch() {
        window.removeEventListener('blur', _ReleaseTouches)
        document.removeEventListener('visibilitychange', _OnVisibilityChange)
        _ReleaseTouches()
      }
    },
    [bCanPlay, mapPresses, oInput],
  )

  return (
    <div
      className="touch-controls"
      role="group"
      aria-label="Touch controls"
      onPointerDown={_OnPointerDown}
      onPointerUp={_OnPointerEnd}
      onPointerCancel={_OnPointerEnd}
      onLostPointerCapture={_OnPointerEnd}
      onContextMenu={_OnContextMenu}
    >
      <div className="touch-directions">
        <button type="button" data-key={oControl.up} aria-label="Up" disabled={!bCanPlay}>
          ▲
        </button>
        <button type="button" data-key={oControl.left} aria-label="Left" disabled={!bCanPlay}>
          ◀
        </button>
        <button type="button" data-key={oControl.down} aria-label="Down" disabled={!bCanPlay}>
          ▼
        </button>
        <button type="button" data-key={oControl.right} aria-label="Right" disabled={!bCanPlay}>
          ▶
        </button>
      </div>
      <div className="touch-actions">
        <button type="button" onClick={fnTogglePause} disabled={!bReady && !bAwaitingGesture}>
          {strPauseLabel}
        </button>
        <button type="button" data-key={oControl.fire} disabled={!bCanPlay}>
          Fire
        </button>
      </div>
    </div>
  )
}
