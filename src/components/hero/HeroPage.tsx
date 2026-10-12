import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { CharacterInfo } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useGuidesPanelStore } from '../../stores/guidesPanelStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { haptic } from '../../utils/haptics';
import { hasPermission } from '../../utils/permissions';
import { buildRows, resolveHeroSlides, type HeroSlide, type RowModel } from '../../utils/hero/heroModel';
import { CharacterPreviewModal } from '../character/CharacterPreviewModal';
import { CategoryRows } from './CategoryRows';
import { FeatureInfoModal } from './FeatureInfoModal';
import { HERO_HEIGHT_CLASS, HeroCarousel } from './HeroCarousel';
import { HeroSlideView } from './HeroSlideView';
import { HeroWelcome } from './HeroWelcome';
import { useFeatureSlides } from './useFeatureSlides';

interface HeroPageProps {
  /**
   * Opens the sidebar drawer. Only needed below 1024px, where the character
   * list lives in the drawer; from 1024px the sidebar is already a column.
   */
  onOpenSidebar?: () => void;
}

/** The sidebar becomes a permanent column at Tailwind's `lg`. */
const SIDEBAR_COLUMN_MIN_WIDTH = 1024;

interface FeatureModalState {
  heading: string;
  image?: string;
  bodyMarkdown: string;
}

/**
 * The page ChatView shows when no chat is open (D-H1, D-H2): the hero, then the
 * category rows, scrolling together in this wrapper (`<main>` itself is
 * overflow-hidden).
 *
 * It decides what the top of the page IS — a loading placeholder, the welcome
 * panel, a single static slide, or the carousel — and owns the two modals and
 * the Chat / About / Browse / See all actions, so the pieces below stay dumb.
 */
export function HeroPage({ onOpenSidebar }: HeroPageProps) {
  const { settled, slides } = useFeatureSlides();

  // The hero READS the character and Works lists; it does not fetch them. The
  // sidebar does (fetchCharacters on mount, fetchProjects with project:view), so
  // E6-S3 must keep those calls when it rebuilds the sidebar, or the hero would
  // sit on its loading placeholder for good.
  const characters = useCharacterStore((s) => s.characters);
  const charactersLoaded = useCharacterStore((s) => s.charactersLoaded);
  // A failed fetch leaves charactersLoaded false forever, so "failed" has to be
  // told apart from "not asked yet".
  const charactersFailed = useCharacterStore((s) => !s.isLoading && !s.charactersLoaded && s.charactersFetchFailed);
  const selectCharacter = useCharacterStore((s) => s.selectCharacter);

  const currentUser = useAuthStore((s) => s.currentUser);
  const works = useProjectStore((s) => s.items);
  const canViewWorks = hasPermission(currentUser, 'project:view');

  const settingsOpen = useSettingsPanelStore((s) => s.isOpen);
  const guidesOpen = useGuidesPanelStore((s) => s.isOpen);
  const worksPanelOpen = useProjectStore((s) => s.isOpen);

  const [previewCharacter, setPreviewCharacter] = useState<CharacterInfo | null>(null);
  const [featureModal, setFeatureModal] = useState<FeatureModalState | null>(null);
  // "New this week" is measured from when the page was shown.
  const [now] = useState(() => Date.now());

  const resolved = useMemo(
    () => resolveHeroSlides({ slides, characters, user: currentUser }),
    [slides, characters, currentUser],
  );
  const rows = useMemo(
    () => buildRows({ featured: resolved.featured, characters, works, canViewWorks, now }),
    [resolved.featured, characters, works, canViewWorks, now],
  );

  // D-H14: the carousel pauses (not stops) while any of these is up.
  const paused =
    previewCharacter !== null || featureModal !== null || settingsOpen || guidesOpen || worksPanelOpen;

  const handleChat = useCallback(
    (avatar: string) => {
      haptic();
      void selectCharacter(avatar);
    },
    [selectCharacter],
  );

  const handleFeatureCta = useCallback((slide: Extract<HeroSlide, { type: 'feature' }>) => {
    const modal = slide.config.cta.modal;
    if (modal.kind === 'character') {
      // resolveHeroSlides only keeps this slide when the character exists.
      setPreviewCharacter(slide.modalCharacter);
    } else {
      setFeatureModal({ heading: modal.heading, image: modal.image, bodyMarkdown: modal.bodyMarkdown });
    }
  }, []);

  /**
   * Browse and See all act on today's sidebar (E6-S3 replaces it). Below 1024px
   * the list is in the drawer, so open that first; from 1024px it is a column
   * already and focus is all there is to do. Focus lands a tick later so the
   * drawer has rendered open.
   */
  const revealSidebar = useCallback(
    (targetId: 'character-search' | 'character-list') => {
      if (window.innerWidth < SIDEBAR_COLUMN_MIN_WIDTH) onOpenSidebar?.();
      window.setTimeout(() => {
        document.getElementById(targetId)?.focus({ preventScroll: true });
      }, 0);
    },
    [onOpenSidebar],
  );

  const handleSeeAll = useCallback(
    (rowId: RowModel['id']) => {
      if (rowId === 'works') {
        // There is no "My Characters" yet; the Works panel is the works list.
        useProjectStore.getState().openPanel();
      } else {
        revealSidebar('character-list');
      }
    },
    [revealSidebar],
  );

  const settledNow = settled && (charactersLoaded || charactersFailed);
  const [latched, setLatched] = useState(false);
  if (settledNow && !latched) setLatched(true);
  const ready = latched || settledNow;

  let top: ReactNode;
  if (!ready) {
    // Hold the hero's height until we know, so the welcome panel never flashes
    // at someone about to see a carousel, and the rows do not jump.
    top = (
      <div
        aria-hidden="true"
        className={`animate-pulse bg-[var(--color-bg-secondary)] motion-reduce:animate-none ${HERO_HEIGHT_CLASS}`}
      />
    );
  } else if (!resolved.hasCharacter) {
    top = <HeroWelcome onBrowse={() => revealSidebar('character-search')} fill={rows.length === 0} />;
  } else if (resolved.heroSlides.length === 1) {
    // D-H10: one slide is drawn statically — no rotation, controls or live region.
    top = (
      <section aria-label="Welcome" className={`relative overflow-hidden bg-black ${HERO_HEIGHT_CLASS}`}>
        <HeroSlideView
          slide={resolved.heroSlides[0]}
          eager
          onChat={handleChat}
          onAbout={setPreviewCharacter}
          onFeatureCta={handleFeatureCta}
        />
      </section>
    );
  } else {
    top = (
      <HeroCarousel
        slides={resolved.heroSlides}
        paused={paused}
        onChat={handleChat}
        onAbout={setPreviewCharacter}
        onFeatureCta={handleFeatureCta}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto" aria-busy={!ready}>
      {/* The page has no heading of its own (the header shows a logo until a
          character is chosen), and the slides and rows below are h3s. */}
      <h2 className="sr-only">Discover characters</h2>
      {top}
      {ready && (
        <CategoryRows
          rows={rows}
          onOpenCharacter={setPreviewCharacter}
          onOpenWork={(id) => useProjectStore.getState().openPanel(id)}
          onSeeAll={handleSeeAll}
        />
      )}

      {/* Siblings of the carousel, not children: focus and pointer events inside
          a modal bubble through React portals to the nearest React ancestor, and
          would otherwise stop the carousel from inside the very dialog that
          paused it. */}
      <CharacterPreviewModal
        isOpen={previewCharacter !== null}
        character={previewCharacter}
        onClose={() => setPreviewCharacter(null)}
        onStartChat={(avatar) => {
          setPreviewCharacter(null);
          handleChat(avatar);
        }}
      />
      {featureModal && (
        <FeatureInfoModal
          isOpen
          onClose={() => setFeatureModal(null)}
          heading={featureModal.heading}
          image={featureModal.image}
          bodyMarkdown={featureModal.bodyMarkdown}
        />
      )}
    </div>
  );
}
