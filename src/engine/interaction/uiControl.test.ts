import { describe, expect, it } from 'vitest'
import {
  detectUiControlIntent,
  detectUiControlCommands,
  environmentChoices,
  panelChoices,
  themeChoices,
  MAX_UI_CONTROL_COMMANDS,
} from './uiControl'
import type { UiControlIntent } from './uiControl'

function panel(intent: UiControlIntent | undefined): UiControlIntent | undefined {
  return intent
}

describe('uiControl — environment switching', () => {
  it('switch to a known environment by id', () => {
    const i = detectUiControlIntent('switch to astra')
    expect(i?.kind).toBe('switch_environment')
    expect(i?.environmentId).toBe('astra')
    expect(i?.environmentKnown).toBe(true)
  })

  it('switch by label and synonyms', () => {
    expect(detectUiControlIntent('go to the arc reactor')?.environmentId).toBe('arc')
    expect(detectUiControlIntent('change into space')?.environmentId).toBe('space')
    expect(detectUiControlIntent('set environment to the tunnel')?.environmentId).toBe('tunnel')
    expect(detectUiControlIntent('move over to the control deck')?.environmentId).toBe('control')
  })

  it('environment words without a switch verb', () => {
    const i = detectUiControlIntent('take me to the astra environment')
    expect(i?.kind).toBe('switch_environment')
    expect(i?.environmentId).toBe('astra')
  })

  it('next / previous environment', () => {
    expect(detectUiControlIntent('next environment')?.kind).toBe('next_environment')
    expect(detectUiControlIntent('go to the next environment')?.kind).toBe('next_environment')
    expect(detectUiControlIntent('previous environment')?.kind).toBe('previous_environment')
    expect(detectUiControlIntent('go back one environment')?.kind).toBe('previous_environment')
  })

  it('records presentation label from the registry', () => {
    const i = detectUiControlIntent('switch to astra')
    expect(i?.environmentLabel).toBe('Astra HUD')
  })

  it('unknown environment with explicit wording is reported honestly', () => {
    const i = detectUiControlIntent('switch to the mars environment')
    expect(i?.kind).toBe('switch_environment')
    expect(i?.environmentKnown).toBe(false)
    expect(i?.environmentId).toBeUndefined()
  })

  it('does not hijack ordinary requests', () => {
    expect(detectUiControlIntent('open the pdf')).toBeUndefined()
    expect(detectUiControlIntent('go to settings')).toBeUndefined()
    expect(detectUiControlIntent('search for the arc reactor')).toBeUndefined()
    expect(detectUiControlIntent('what can you do')).toBeUndefined()
    expect(detectUiControlIntent('how are you')).toBeUndefined()
  })
})

describe('uiControl — panel commands', () => {
  it('open a panel', () => {
    const i = detectUiControlIntent('open the core')
    expect(i?.kind).toBe('open_panel')
    expect(i?.panelId).toBe('core')
    expect(i?.panelKnown).toBe(true)
    expect(panel(i)?.panelLabel).toBe('JARVIS Core')
  })

  it('close / hide a panel', () => {
    expect(detectUiControlIntent('close the system panel')?.kind).toBe('close_panel')
    expect(detectUiControlIntent('close the system panel')?.panelId).toBe('system')
    expect(detectUiControlIntent('hide the devices')?.kind).toBe('close_panel')
    expect(detectUiControlIntent('hide the devices')?.panelId).toBe('devices')
    expect(detectUiControlIntent('dismiss the vision panel')?.kind).toBe('close_panel')
    expect(detectUiControlIntent('dismiss the vision panel')?.panelId).toBe('vision')
  })

  it('toggle and focus a panel', () => {
    expect(detectUiControlIntent('toggle the system panel')?.kind).toBe('toggle_panel')
    expect(detectUiControlIntent('toggle the system panel')?.panelId).toBe('system')
    expect(detectUiControlIntent('focus the conversation')?.kind).toBe('focus_panel')
    expect(detectUiControlIntent('focus the conversation')?.panelId).toBe('conversation')
    expect(detectUiControlIntent('bring the core to the front')?.kind).toBe('focus_panel')
    expect(detectUiControlIntent('bring the core to the front')?.panelId).toBe('core')
  })

  it('show / display / start open a panel', () => {
    expect(detectUiControlIntent('show me the files')?.kind).toBe('open_panel')
    expect(detectUiControlIntent('show me the files')?.panelId).toBe('files')
    expect(detectUiControlIntent('display the apps')?.kind).toBe('open_panel')
    expect(detectUiControlIntent('display the apps')?.panelId).toBe('applications')
    expect(detectUiControlIntent('open the environment selector')?.panelId).toBe('environments')
    expect(detectUiControlIntent('open the environment selector')?.kind).toBe('open_panel')
  })

  it('panel synonyms resolve', () => {
    expect(detectUiControlIntent('open the main panel')?.panelId).toBe('core')
    expect(detectUiControlIntent('show the home')?.panelId).toBe('core')
    expect(detectUiControlIntent('open the session log')?.panelId).toBe('conversation')
    expect(detectUiControlIntent('open the chat')?.panelId).toBe('conversation')
    expect(detectUiControlIntent('close activity')?.panelId).toBe('activity')
    expect(detectUiControlIntent('show me the system status')?.panelId).toBe('system')
  })

  it('camera requires an explicit modal suffix (Phase 2.7 stays the owner)', () => {
    expect(detectUiControlIntent('open the camera')).toBeUndefined()
    expect(detectUiControlIntent('close the camera')).toBeUndefined()
    expect(detectUiControlIntent('hide the camera')).toBeUndefined()
    expect(detectUiControlIntent('toggle the camera')).toBeUndefined()
    expect(detectUiControlIntent('open the camera panel')?.panelId).toBe('camera')
    expect(detectUiControlIntent('open the camera panel')?.kind).toBe('open_panel')
    expect(detectUiControlIntent('hide the camera view')?.panelId).toBe('camera')
    expect(detectUiControlIntent('hide the camera view')?.kind).toBe('close_panel')
  })

  it('unknown panel with modal suffix is reported honestly', () => {
    const i = detectUiControlIntent('open the calculator panel')
    expect(i?.kind).toBe('open_panel')
    expect(i?.panelKnown).toBe(false)
  })

  it('does not hijack non-panel open/close phrasing', () => {
    expect(detectUiControlIntent('open notepad')).toBeUndefined()
    expect(detectUiControlIntent('open the pdf')).toBeUndefined()
    expect(detectUiControlIntent('close the door')).toBeUndefined()
    expect(detectUiControlIntent('start the engine')).toBeUndefined()
    expect(detectUiControlIntent('rice')).toBeUndefined()
  })

  it('does not claim INFORMATION requests about a panel (verb as predicate)', () => {
    // "open" here is a state predicate about the panel, not a command to open
    // it: answering by opening the panel would be a wrong ACTION for a question.
    expect(detectUiControlIntent('tell me what applications are open')).toBeUndefined()
    expect(detectUiControlIntent('what applications are open')).toBeUndefined()
    expect(detectUiControlIntent('what applications are open?')).toBeUndefined()
    expect(detectUiControlIntent('which panels are open')).toBeUndefined()
    expect(detectUiControlIntent('is the session panel open')).toBeUndefined()
    expect(detectUiControlIntent('are the devices open')).toBeUndefined()
    expect(detectUiControlIntent('what windows are open')).toBeUndefined()
    // ...while the imperative forms of the same panel still work.
    expect(detectUiControlIntent('open the applications panel')?.panelId).toBe('applications')
    expect(detectUiControlIntent('can you open the applications panel')?.panelId).toBe('applications')
    expect(detectUiControlIntent('please show me the devices')?.panelId).toBe('devices')
  })

  it('does not claim a compound when the information half is not a command', () => {
    // The whole compound must parse; an informational fragment aborts it so the
    // request flows to the agent instead of half-executing a panel change.
    expect(detectUiControlCommands('open the core panel and tell me what windows are open')).toEqual([])
  })
})

describe('uiControl — compound commands', () => {
  it('"switch to astra and open the core" yields two commands in order', () => {
    const cmds = detectUiControlCommands('switch to astra and open the core')
    expect(cmds).toHaveLength(2)
    expect(cmds[0]).toMatchObject({ kind: 'switch_environment', environmentId: 'astra' })
    expect(cmds[1]).toMatchObject({ kind: 'open_panel', panelId: 'core' })
  })

  it('splits on "then"', () => {
    const cmds = detectUiControlCommands('open the core then close the system panel')
    expect(cmds).toHaveLength(2)
    expect(cmds[0]).toMatchObject({ kind: 'open_panel', panelId: 'core' })
    expect(cmds[1]).toMatchObject({ kind: 'close_panel', panelId: 'system' })
  })

  it('rejects a compound containing a non-command fragment', () => {
    expect(detectUiControlCommands('switch to astra and say hello')).toEqual([])
    expect(detectUiControlCommands('open the core and bring me coffee')).toEqual([])
  })

  it('respects the bound', () => {
    const cmds = detectUiControlCommands('switch to astra and open the core and focus the system panel')
    expect(cmds.length).toBeLessThanOrEqual(MAX_UI_CONTROL_COMMANDS)
    expect(cmds).toHaveLength(2)
  })

  it('single non-compound request still works', () => {
    expect(detectUiControlCommands('switch to astra')?.[0]?.environmentId).toBe('astra')
    expect(detectUiControlCommands('please open the core')?.[0]?.panelId).toBe('core')
  })
})

describe('uiControl — honest choices from registries', () => {
  it('lists the real environments', () => {
    expect(environmentChoices()).toEqual(['Arc Reactor', 'Astra HUD', 'Control Panel', 'Space', 'Tunnel', 'Neural'])
  })

  it('lists the real panels', () => {
    const choices = panelChoices()
    expect(choices).toContain('JARVIS Core')
    expect(choices).toContain('Camera')
    expect(choices).toContain('System')
    expect(choices).toContain('Environments')
  })

  it('lists the real themes', () => {
    expect(themeChoices()).toEqual(['Classic', 'Cyber', 'Stealth', 'Holographic', 'Minimal'])
  })
})

describe('uiControl — theme control', () => {
  it('sets a known theme by id and label', () => {
    const i = detectUiControlIntent('switch the theme to cyber')
    expect(i?.kind).toBe('set_theme')
    expect(i?.themeId).toBe('cyber')
    expect(i?.themeLabel).toBe('Cyber')
    expect(i?.themeKnown).toBe(true)

    expect(detectUiControlIntent('change my theme to stealth')?.themeId).toBe('stealth')
    expect(detectUiControlIntent('make the theme holographic')?.themeId).toBe('holographic')
    expect(detectUiControlIntent('set the appearance to minimal')?.themeId).toBe('minimal')
  })

  it('resolves theme synonyms', () => {
    expect(detectUiControlIntent('switch the theme to cyberpunk')?.themeId).toBe('cyber')
    expect(detectUiControlIntent('set the skin to ninja')?.themeId).toBe('stealth')
    expect(detectUiControlIntent('make the theme iridescent')?.themeId).toBe('holographic')
    expect(detectUiControlIntent('apply the plain look')?.themeId).toBe('minimal')
  })

  it('reports an unknown theme honestly', () => {
    const i = detectUiControlIntent('switch the theme to paisley')
    expect(i?.kind).toBe('set_theme')
    expect(i?.themeKnown).toBe(false)
    expect(i?.themeId).toBeUndefined()
  })

  it('detects next theme', () => {
    expect(detectUiControlIntent('next theme')?.kind).toBe('next_theme')
    expect(detectUiControlIntent('cycle the theme')?.kind).toBe('next_theme')
  })

  it('does not hijack non-theme requests', () => {
    expect(detectUiControlIntent('make it cyber')).toBeUndefined()
    expect(detectUiControlIntent('what theme is this')).toBeUndefined()
    expect(detectUiControlIntent('open notepad')).toBeUndefined()
    expect(detectUiControlIntent('use the camera')).toBeUndefined()
  })

  it('compounds cleanly with panel commands', () => {
    const cmds = detectUiControlCommands('open the core and switch the theme to cyber')
    expect(cmds.map((c) => c.kind)).toEqual(['open_panel', 'set_theme'])
    expect(cmds[1]?.themeId).toBe('cyber')
  })
})