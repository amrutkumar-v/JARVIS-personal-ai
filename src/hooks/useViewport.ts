import { useEffect, useState } from 'react'
import type { ViewportSize } from '../panel/types'

export function useViewport(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }))

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return size
}
