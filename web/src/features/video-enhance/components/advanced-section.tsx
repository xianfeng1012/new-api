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
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { ON_FAILURE_OPTIONS } from '../api'
import type { EnhanceSetting } from '../types'

type AdvancedSectionProps = {
  setting: EnhanceSetting
  onChange: (patch: Partial<EnhanceSetting>) => void
  disabled?: boolean
}

export function AdvancedSection(props: AdvancedSectionProps) {
  const { t } = useTranslation()
  const { setting, onChange, disabled } = props

  return (
    <div className='space-y-4'>
      <div className='grid gap-4 lg:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-channel-id'>{t('Credential channel')}</Label>
          <div className='flex items-center gap-2'>
            <Input
              id='enhance-channel-id'
              type='number'
              value={String(setting.channel_id)}
              disabled={disabled}
              onChange={(event) => {
                const parsed = Number(event.target.value)
                onChange({
                  channel_id: Number.isFinite(parsed) ? parsed : 0,
                })
              }}
            />
            <Button
              type='button'
              variant='outline'
              render={<Link to='/channels' />}
            >
              {t('Open channels page')}
            </Button>
          </div>
          <p className='text-muted-foreground text-xs'>
            {t(
              'The channel that stores the MediaKit key. It wins over the base URL below.'
            )}
          </p>
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-base-url'>{t('MediaKit base URL')}</Label>
          <Input
            id='enhance-base-url'
            value={setting.base_url}
            disabled={disabled}
            placeholder='https://mediakit.cn-beijing.volces.com'
            onChange={(event) => onChange({ base_url: event.target.value })}
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-timeout'>{t('Timeout (minutes)')}</Label>
          <Input
            id='enhance-timeout'
            type='number'
            value={String(setting.timeout_minutes)}
            disabled={disabled}
            onChange={(event) => {
              const parsed = Number(event.target.value)
              onChange({
                timeout_minutes: Number.isFinite(parsed)
                  ? parsed
                  : setting.timeout_minutes,
              })
            }}
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-retries'>{t('Max retries')}</Label>
          <Input
            id='enhance-retries'
            type='number'
            value={String(setting.max_retries)}
            disabled={disabled}
            onChange={(event) => {
              const parsed = Number(event.target.value)
              onChange({
                max_retries: Number.isFinite(parsed)
                  ? parsed
                  : setting.max_retries,
              })
            }}
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-on-failure'>{t('Failure policy')}</Label>
          <Select
            value={setting.on_failure || 'deliver_original'}
            disabled={disabled}
            onValueChange={(value) => {
              if (value) onChange({ on_failure: value })
            }}
          >
            <SelectTrigger id='enhance-on-failure' className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ON_FAILURE_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t('Deliver the original video and keep the original charge')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}
