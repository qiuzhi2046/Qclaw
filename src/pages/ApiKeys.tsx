import {
  buildKnownProviderEnvKeyMap,
  buildKnownProviderNameMap,
} from '../lib/openclaw-provider-registry'
import ModelCenter, { type SetupModelContext } from './ModelCenter'

const PROVIDER_NAME_MAP = buildKnownProviderNameMap()
const PROVIDER_ENV_KEY_MAP = buildKnownProviderEnvKeyMap()

export type { SetupModelContext } from './ModelCenter'

export default function ApiKeys({ onNext }: { onNext: (context: SetupModelContext) => void | Promise<void> }) {
  return (
    <ModelCenter
      onConfigured={onNext}
      providerNames={PROVIDER_NAME_MAP}
      envKeyMap={PROVIDER_ENV_KEY_MAP}
      collapsible={false}
      showSkipWhenConfigured
    />
  )
}
