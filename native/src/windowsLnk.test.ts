import { describe, expect, it } from 'vitest'
import { parseShellLinkTarget } from './windowsLnk.js'
import {
  FLAG_HAS_LINK_INFO,
  FLAG_HAS_ID_LIST,
  buildLinkInfoAnsi,
  buildLinkInfoUnicode,
  buildShellLink,
} from './testingLnk.js'

describe('parseShellLinkTarget — pure-Node .lnk target extraction', () => {
  it('extracts an ANSI LocalBasePath from a minimal link', () => {
    const data = buildShellLink({ linkFlags: FLAG_HAS_LINK_INFO, linkInfo: buildLinkInfoAnsi('C:\\Tools\\MyApp.exe') })
    expect(parseShellLinkTarget(data)).toBe('C:\\Tools\\MyApp.exe')
  })

  it('prefers the Unicode LocalBasePath when both are present', () => {
    const data = buildShellLink({
      linkFlags: FLAG_HAS_LINK_INFO,
      linkInfo: buildLinkInfoUnicode('C:\\Tools\\lanic.exe', 'C:\\ユニコード\\アプリ.exe'),
    })
    expect(parseShellLinkTarget(data)).toBe('C:\\ユニコード\\アプリ.exe')
  })

  it('skips a LinkTargetIDList to reach LinkInfo', () => {
    const idList = Buffer.from([0x00, 0x1f, 0x00, 0x59, 0x00]) // arbitrary non-empty list bytes
    const data = buildShellLink({
      linkFlags: FLAG_HAS_LINK_INFO | FLAG_HAS_ID_LIST,
      linkTargetIDList: idList,
      linkInfo: buildLinkInfoAnsi('C:\\Start\\Menu\\Prog.exe'),
    })
    expect(parseShellLinkTarget(data)).toBe('C:\\Start\\Menu\\Prog.exe')
  })

  it('returns null for buffers that are too small to be a link', () => {
    expect(parseShellLinkTarget(Buffer.alloc(20))).toBeNull()
    expect(parseShellLinkTarget(Buffer.alloc(75))).toBeNull()
  })

  it('returns null when the magic or CLSID is wrong', () => {
    const data = buildShellLink({ linkFlags: FLAG_HAS_LINK_INFO, linkInfo: buildLinkInfoAnsi('C:\\a.exe') })
    data.writeUInt32LE(0x12345678, 0)
    expect(parseShellLinkTarget(data)).toBeNull()

    const badClsid = buildShellLink({ linkFlags: FLAG_HAS_LINK_INFO, linkInfo: buildLinkInfoAnsi('C:\\a.exe') })
    badClsid[0x12] = 0xff
    expect(parseShellLinkTarget(badClsid)).toBeNull()
  })

  it('returns null when there is no LinkInfo block', () => {
    expect(parseShellLinkTarget(buildShellLink({ linkFlags: 0 }))).toBeNull()
  })

  it('returns null when LinkInfo has no LocalBasePath offset', () => {
    const info = buildLinkInfoAnsi('C:\\a.exe')
    info.writeUInt32LE(0, 0x10) // LocalBasePathOffset = 0
    const data = buildShellLink({ linkFlags: FLAG_HAS_LINK_INFO, linkInfo: info })
    expect(parseShellLinkTarget(data)).toBeNull()
  })

  it('returns null when declared sizes overflow the buffer (no OOB panic)', () => {
    const info = buildLinkInfoAnsi('C:\\a.exe')
    info.writeUInt32LE(0xffff_fff0, 0) // absurd LinkInfoSize
    const data = buildShellLink({ linkFlags: FLAG_HAS_LINK_INFO, linkInfo: info })
    expect(parseShellLinkTarget(data)).toBeNull()
  })

  it('returns null for whitespace-only or oversized paths', () => {
    expect(parseShellLinkTarget(buildShellLink({ linkFlags: FLAG_HAS_LINK_INFO, linkInfo: buildLinkInfoAnsi('   ') }))).toBeNull()
    const huge = 'C:\\' + 'x'.repeat(600) + '.exe'
    expect(parseShellLinkTarget(buildShellLink({ linkFlags: FLAG_HAS_LINK_INFO, linkInfo: buildLinkInfoAnsi(huge) }))).toBeNull()
  })
})