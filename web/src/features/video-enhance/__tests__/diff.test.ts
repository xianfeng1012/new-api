/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { describe, expect, test } from 'vitest'

import { ENHANCE_DEFAULTS, buildEnhanceDiff, serializeEnhanceValue } from '../api'
import type { EnhanceSecretDraft, EnhanceSetting } from '../types'

const noSecrets: EnhanceSecretDraft = {
  accessKey: '',
  secretKey: '',
  clear: false,
}

const clone = (): EnhanceSetting =>
  JSON.parse(JSON.stringify(ENHANCE_DEFAULTS)) as EnhanceSetting

describe('serializeEnhanceValue', () => {
  test('serializes option values the way the backend stores them', () => {
    expect(serializeEnhanceValue('enabled', true)).toBe('true')
    expect(serializeEnhanceValue('enabled', false)).toBe('false')
    expect(serializeEnhanceValue('markup', 1.15)).toBe('1.15')
    expect(serializeEnhanceValue('output_bucket', '')).toBe('')
    expect(serializeEnhanceValue('rules', [])).toBe('[]')
    expect(serializeEnhanceValue('exclude_models', ['a'])).toBe('["a"]')
  })
})

describe('buildEnhanceDiff', () => {
  test('an untouched page submits nothing', () => {
    const saved = clone()
    expect(buildEnhanceDiff(saved, clone(), noSecrets)).toEqual([])
  })

  test('only the edited field is submitted', () => {
    const saved = clone()
    const draft = clone()
    draft.markup = 1.2
    const entries = buildEnhanceDiff(saved, draft, noSecrets)
    expect(entries).toEqual([{ field: 'markup', value: '1.2' }])
  })

  test('the master switch is never part of the form diff', () => {
    const saved = clone()
    const draft = clone()
    draft.enabled = true
    expect(buildEnhanceDiff(saved, draft, noSecrets)).toEqual([])
  })

  test('rule edits are submitted as JSON', () => {
    const saved = clone()
    const draft = clone()
    draft.rules = [
      {
        models: ['SD-2.0-MZ1'],
        tool_version: 'professional',
        resolution: '1080p',
        fps: 0,
        scene: 'aigc',
      },
    ]
    expect(buildEnhanceDiff(saved, draft, noSecrets)).toEqual([
      {
        field: 'rules',
        value:
          '[{"models":["SD-2.0-MZ1"],"tool_version":"professional","resolution":"1080p","fps":0,"scene":"aigc"}]',
      },
    ])
  })

  test('empty secret inputs never overwrite stored credentials', () => {
    const entries = buildEnhanceDiff(clone(), clone(), {
      accessKey: '',
      secretKey: '',
      clear: false,
    })
    expect(entries).toEqual([])
  })

  test('typed secrets and the explicit clear action are submitted', () => {
    expect(
      buildEnhanceDiff(clone(), clone(), {
        accessKey: 'AK',
        secretKey: '',
        clear: false,
      })
    ).toEqual([{ field: 'tos_access_key', value: 'AK' }])

    expect(
      buildEnhanceDiff(clone(), clone(), {
        accessKey: 'AK',
        secretKey: 'SK',
        clear: true,
      })
    ).toEqual([
      { field: 'tos_access_key', value: '' },
      { field: 'tos_secret_key', value: '' },
    ])
  })
})
