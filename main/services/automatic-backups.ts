import { getSettingValue, upsertSettings } from '../db';

export const AUTOMATIC_BACKUPS_SETTING_KEY = 'automatic_backups_enabled';

/**
 * Master switch for scheduled backups (local and Google Drive), off until turned on; manual and
 * update backups ignore it.
 */
export function areAutomaticBackupsEnabled(): boolean {
  return getSettingValue(AUTOMATIC_BACKUPS_SETTING_KEY) === 'true';
}

export function setAutomaticBackupsEnabled(enabled: boolean): void {
  upsertSettings({ [AUTOMATIC_BACKUPS_SETTING_KEY]: enabled ? 'true' : 'false' });
}
