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

import { ENHANCE_DEFAULTS } from '../api'
import {
  enhanceCoefficient,
  enhanceCostCNY,
  enhanceQuotaForUsage,
  fpsMultiplier,
  normalizeResolutionTier,
} from '../lib/price'
import type { EnhanceSetting } from '../types'

const setting: EnhanceSetting = ENHANCE_DEFAULTS

describe('normalizeResolutionTier', () => {
  test('maps aliases and unknown tiers one tier up', () => {
    expect(normalizeResolutionTier('720p')).toBe('720p')
    expect(normalizeResolutionTier('HD')).toBe('720p')
    expect(normalizeResolutionTier('1080P')).toBe('1080p')
    expect(normalizeResolutionTier('1440p')).toBe('2k')
    expect(normalizeResolutionTier('2160p')).toBe('4k')
    expect(normalizeResolutionTier('weird')).toBe('1080p')
  })
})

describe('fpsMultiplier', () => {
  test('keeps 1 for the source frame rate and steps up with the table', () => {
    expect(fpsMultiplier(0, setting.fps_multipliers)).toBe(1)
    expect(fpsMultiplier(24, setting.fps_multipliers)).toBe(1)
    expect(fpsMultiplier(30, setting.fps_multipliers)).toBe(1)
    expect(fpsMultiplier(60, setting.fps_multipliers)).toBe(2)
    expect(fpsMultiplier(120, setting.fps_multipliers)).toBe(4)
    expect(fpsMultiplier(240, setting.fps_multipliers)).toBe(4)
  })
})

describe('enhanceCoefficient', () => {
  test('matches the official examples', () => {
    expect(enhanceCoefficient(setting, 'standard', '1080p', 30)).toBe(2)
    expect(enhanceCoefficient(setting, 'professional', '1080p', 30)).toBe(20)
    expect(enhanceCoefficient(setting, 'generative', '4k', 120)).toBe(32)
    expect(enhanceCoefficient(setting, 'standard', '720p', 24)).toBe(1)
  })

  test('returns 0 for an unknown tool version', () => {
    expect(enhanceCoefficient(setting, 'unknown', '720p', 24)).toBe(0)
  })
})

describe('enhanceCostCNY', () => {
  test('bills output minutes by coefficient and list price', () => {
    // official example: 10 minutes, 1080p <=30fps, standard edition
    expect(
      enhanceCostCNY(setting, 'standard', '1080p', 30, 600)
    ).toBeCloseTo(15, 6)
    // official example: 10 minutes, 1080p <=30fps, professional edition
    expect(
      enhanceCostCNY(setting, 'professional', '1080p', 30, 600)
    ).toBeCloseTo(150, 6)
  })
})

describe('enhanceQuotaForUsage', () => {
  test('reproduces the two verified production charges', () => {
    // child task 2395: standard, 720p, 24fps, 5.089s -> quota 5010
    expect(
      enhanceQuotaForUsage(setting, 'standard', '720p', 24, 5.089)
    ).toBe(5010)
    // child task 2394: standard, 720p, 24fps, 30.094s -> quota 29630
    expect(
      enhanceQuotaForUsage(setting, 'standard', '720p', 24, 30.094)
    ).toBe(29630)
  })

  test('a zero cost never produces a charge', () => {
    expect(enhanceQuotaForUsage(setting, 'unknown', '720p', 24, 5)).toBe(0)
    expect(enhanceQuotaForUsage(setting, 'standard', '720p', 24, 0)).toBe(0)
  })
})
