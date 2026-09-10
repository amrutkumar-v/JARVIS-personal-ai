import { StatusDriver } from './StatusDriver'
import { SceneRig } from './SceneRig'
import { CoreEnergy } from './CoreEnergy'
import { CoreRings } from './CoreRings'
import { CoreParticles } from './CoreParticles'

/** Composition of the 3D JARVIS core and its supporting effects. */
export function CoreScene() {
  return (
    <>
      <StatusDriver />
      <SceneRig />
      <CoreEnergy />
      <CoreRings />
      <CoreParticles />
    </>
  )
}