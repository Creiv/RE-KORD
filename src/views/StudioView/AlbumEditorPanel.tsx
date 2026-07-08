import type { StudioPanelsState } from "./types";
import { StudioCoversPane } from "../../components/StudioCoversPane";
type Props = { state: StudioPanelsState };

export function AlbumEditorPanel({ state: s }: Props) {
  const {
    artBusy,
    artQuery,
    setArtQuery,
    artRes,
    coverPickArtist,
    setCoverPickArtist,
    albumForCover,
    setAlbumForCover,
    libraryArtistsSorted,
    coverAlbumsForPick,
    useCurrentForArt,
    doArtSearch,
    applyCover
  } = s;
  return (
            <StudioCoversPane
              coverPickArtist={coverPickArtist}
              setCoverPickArtist={setCoverPickArtist}
              albumForCover={albumForCover}
              setAlbumForCover={setAlbumForCover}
              libraryArtistsSorted={libraryArtistsSorted}
              coverAlbumsForPick={coverAlbumsForPick}
              artQuery={artQuery}
              setArtQuery={setArtQuery}
              artBusy={artBusy}
              artRes={artRes}
              onUseCurrentForArt={useCurrentForArt}
              onArtSearch={doArtSearch}
              onApplyCover={applyCover}
            />
  );
}
