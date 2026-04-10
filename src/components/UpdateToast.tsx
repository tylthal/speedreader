import { useServiceWorkerUpdate } from '../hooks/useServiceWorkerUpdate'

export default function UpdateToast() {
  const { updateAvailable, applyUpdate } = useServiceWorkerUpdate()

  if (!updateAvailable) return null

  return (
    <div className="update-toast">
      <span className="update-toast__message">A new version is available</span>
      <button className="update-toast__button" onClick={applyUpdate}>
        Update
      </button>
    </div>
  )
}
