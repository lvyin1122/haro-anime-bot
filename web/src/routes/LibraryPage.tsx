import { useQuery } from '@tanstack/react-query';

import { api } from '../api';
import { useT } from '../i18n';
import { ReadyToWatch } from '../components/ReadyToWatch';

export function LibraryPage() {
  const t = useT();
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const builtin = health.data?.playerMode !== 'jellyfin';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">{t('library.title')}</h1>
        <p className="mt-0.5 text-xs text-ink-500">
          {builtin ? t('library.subtitleBuiltin') : t('library.subtitleJellyfin')}
        </p>
      </div>

      <ReadyToWatch limit={100} />
    </div>
  );
}
