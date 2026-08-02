import { ReadyToWatch } from '../components/ReadyToWatch';

export function LibraryPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Library</h1>
        <p className="mt-0.5 text-xs text-ink-500">
          Everything downloaded and filed into Jellyfin. Play opens the episode in the Jellyfin web
          player.
        </p>
      </div>

      <ReadyToWatch limit={100} />
    </div>
  );
}
