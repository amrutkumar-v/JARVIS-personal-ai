import { useCallback } from 'react'
import type { CameraUiState } from '../../state/jarvis.store'

interface Props {
  camera: CameraUiState
  onToggle: () => void
  onCapture: () => void
  onSetVideo: (element: HTMLVideoElement | null) => void
}

const PERMISSION_LABELS: Record<CameraUiState['permission'], string> = {
  unknown: 'permission not requested',
  granted: 'permission granted',
  denied: 'permission denied',
  'in-use': 'camera in use elsewhere',
  incompatible: 'no matching camera',
  unavailable: 'no webcam surface',
}

/**
 * Phase 2.7 — real webcam panel. `active` is only true after REAL getUserMedia
 * grace; every label below mirrors the actual browser/device state. The panel
 * never renders a fake frame.
 *
 * Phase 10 — hand gestures follow the camera automatically: no separate
 * toggle, so this panel stays the single privacy control. Turn the camera off
 * and gesture dies with the stream.
 */
export function CameraPanel({ camera, onToggle, onCapture, onSetVideo }: Props) {
  const setVideoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      onSetVideo(el)
    },
    [onSetVideo],
  )

  return (
    <div className={`camera-panel${camera.active ? ' is-active' : ''}`} data-permission={camera.permission}>
      <div className="camera-head">
        <span className="camera-title">CAMERA</span>
        <span className="camera-permission" role="status">
          {camera.active ? 'LIVE' : PERMISSION_LABELS[camera.permission]}
        </span>
      </div>

      <div className="camera-frame">
        {camera.active ? (
          <video
            className="camera-preview"
            ref={setVideoRef}
            autoPlay
            playsInline
            muted
          />
        ) : (
          <div className="camera-empty" aria-hidden="true">
            {camera.available ? 'CAMERA OFF' : 'NO CAMERA'}
          </div>
        )}
      </div>

      <div className="camera-controls">
        <button
          type="button"
          className="camera-toggle"
          onClick={onToggle}
          disabled={!camera.available}
          aria-pressed={camera.active}
        >
          {camera.active ? 'Turn off' : 'Turn on'}
        </button>
        <button
          type="button"
          className="camera-capture"
          onClick={onCapture}
          disabled={!camera.active}
        >
          Capture frame
        </button>
      </div>

      {camera.reason ? <p className="camera-reason">{camera.reason}</p> : null}
    </div>
  )
}