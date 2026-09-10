import { useQuery } from '@tanstack/react-query';

import { api } from '../api';
import { ReadyToWatch } from '../components/ReadyToWatch';

export function LibraryPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const builtin = health.data?.playerMode !== 'jellyfin';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Library</h1>
        <p className="mt-0.5 text-xs text-ink-500">
          {builtin
            ? 'Everything downloaded and filed away. Play opens the episode here, with subtitle, audio track and speed controls.'
            : 'Everything downloaded and filed into Jellyfin. Play opens the episode in the Jellyfin web player.'}
        </p>
      </div>

      <ReadyToWatch limit={100} />
    </div>
  );
}
