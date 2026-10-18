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
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import type { EnhanceSecretDraft, EnhanceSecrets, EnhanceSetting } from '../types'

type OutputSectionProps = {
  setting: EnhanceSetting
  secrets: EnhanceSecrets
  secretDraft: EnhanceSecretDraft
  onChange: (patch: Partial<EnhanceSetting>) => void
  onSecretChange: (patch: Partial<EnhanceSecretDraft>) => void
  disabled?: boolean
}

function SecretState(props: { configured: boolean }) {
  const { t } = useTranslation()
  return (
    <Badge variant={props.configured ? 'secondary' : 'outline'}>
      {props.configured ? t('Configured') : t('Not configured')}
    </Badge>
  )
}

export function OutputSection(props: OutputSectionProps) {
  const { t } = useTranslation()
  const { setting, secrets, secretDraft, onChange, onSecretChange, disabled } =
    props

  return (
    <div className='space-y-4'>
      <Alert>
        <AlertDescription>
          {t(
            'Leave the bucket empty to keep MediaKit 24h temporary links. With a bucket configured, the artifact URL is rebuilt from the public base URL or a presigned URL.'
          )}
        </AlertDescription>
      </Alert>

      <div className='grid gap-4 lg:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-output-bucket'>
            {t('Object storage bucket')}
          </Label>
          <Input
            id='enhance-output-bucket'
            value={setting.output_bucket}
            disabled={disabled}
            placeholder='tos://your-bucket'
            onChange={(event) =>
              onChange({ output_bucket: event.target.value })
            }
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-public-base-url'>
            {t('Public base URL')}
          </Label>
          <Input
            id='enhance-public-base-url'
            value={setting.public_base_url}
            disabled={disabled}
            placeholder='https://your-bucket.tos-cn-beijing.volces.com'
            onChange={(event) =>
              onChange({ public_base_url: event.target.value })
            }
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-tos-region'>{t('TOS region')}</Label>
          <Input
            id='enhance-tos-region'
            value={setting.tos_region}
            disabled={disabled}
            placeholder='cn-beijing'
            onChange={(event) => onChange({ tos_region: event.target.value })}
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-presign-ttl'>
            {t('Presigned URL TTL (seconds)')}
          </Label>
          <Input
            id='enhance-presign-ttl'
            type='number'
            value={String(setting.presign_ttl_seconds)}
            disabled={disabled}
            onChange={(event) => {
              const parsed = Number(event.target.value)
              onChange({
                presign_ttl_seconds: Number.isFinite(parsed)
                  ? parsed
                  : setting.presign_ttl_seconds,
              })
            }}
          />
        </div>
      </div>

      <div className='grid gap-4 lg:grid-cols-2'>
        <div className='space-y-1.5'>
          <div className='flex items-center gap-2'>
            <Label htmlFor='enhance-tos-access-key'>
              {t('TOS access key')}
            </Label>
            <SecretState configured={secrets.hasTosAccessKey} />
          </div>
          <Input
            id='enhance-tos-access-key'
            type='password'
            autoComplete='off'
            value={secretDraft.accessKey}
            disabled={disabled || secretDraft.clear}
            placeholder={
              secrets.hasTosAccessKey
                ? t('Leave blank to keep the saved value')
                : ''
            }
            onChange={(event) =>
              onSecretChange({ accessKey: event.target.value })
            }
          />
        </div>
        <div className='space-y-1.5'>
          <div className='flex items-center gap-2'>
            <Label htmlFor='enhance-tos-secret-key'>
              {t('TOS secret key')}
            </Label>
            <SecretState configured={secrets.hasTosSecretKey} />
          </div>
          <Input
            id='enhance-tos-secret-key'
            type='password'
            autoComplete='off'
            value={secretDraft.secretKey}
            disabled={disabled || secretDraft.clear}
            placeholder={
              secrets.hasTosSecretKey
                ? t('Leave blank to keep the saved value')
                : ''
            }
            onChange={(event) =>
              onSecretChange({ secretKey: event.target.value })
            }
          />
        </div>
      </div>

      <div className='flex items-center gap-2'>
        <Checkbox
          id='enhance-clear-secrets'
          checked={secretDraft.clear}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onSecretChange({ clear: checked === true })
          }
        />
        <Label htmlFor='enhance-clear-secrets' className='text-sm font-normal'>
          {t('Clear saved TOS credentials')}
        </Label>
      </div>
    </div>
  )
}
