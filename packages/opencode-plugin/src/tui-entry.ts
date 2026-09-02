import CuppetTuiPlugin from './tui.js'
import { installPe3TuiNavigation } from './pe3-tui.js'

type TuiApi = Parameters<typeof CuppetTuiPlugin.tui>[0]

const CuppetPe3TuiPlugin = {
  id: 'cuppet-tui' as const,
  async tui(api: TuiApi) {
    await CuppetTuiPlugin.tui(api)
    installPe3TuiNavigation(api)
  },
}

export default CuppetPe3TuiPlugin
