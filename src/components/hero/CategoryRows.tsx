import { useId, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Library } from 'lucide-react';
import type { CharacterInfo, ProjectListItem } from '../../api/client';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { getDefaultAvatarUrl } from '../../utils/emotions';
import { initialOf, type RowModel } from '../../utils/hero/heroModel';

interface CategoryRowsProps {
  rows: RowModel[];
  onOpenCharacter: (character: CharacterInfo) => void;
  onOpenWork: (workId: string) => void;
  onSeeAll: (rowId: RowModel['id']) => void;
}

/** D-H21: images beyond the first six per row load lazily. */
const EAGER_PER_ROW = 6;

const GUTTER = 'px-4 sm:px-8 lg:px-12';

/**
 * The rows below the hero (D-H21). The caller passes only rows that HAVE items
 * (buildRows omits the rest), so nothing here renders an empty row.
 */
export function CategoryRows({ rows, onOpenCharacter, onOpenWork, onSeeAll }: CategoryRowsProps) {
  if (rows.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-6 pb-10 pt-6 sm:gap-8">
      {rows.map((row) =>
        row.id === 'works' ? (
          <Row key={row.id} title={row.title} onSeeAll={() => onSeeAll(row.id)}>
            {row.items.map((work: ProjectListItem, i) => (
              <Card
                key={work.id}
                ratio="wide"
                title={work.name}
                tag={row.tag}
                eager={i < EAGER_PER_ROW}
                onActivate={() => onOpenWork(work.id)}
              />
            ))}
          </Row>
        ) : (
          <Row key={row.id} title={row.title} onSeeAll={() => onSeeAll(row.id)}>
            {row.items.map((character, i) => (
              <Card
                key={character.avatar}
                ratio="portrait"
                title={character.name}
                tag={row.tag}
                image={getDefaultAvatarUrl(character.avatar)}
                eager={i < EAGER_PER_ROW}
                onActivate={() => onOpenCharacter(character)}
              />
            ))}
          </Row>
        ),
      )}
    </div>
  );
}

interface RowProps {
  title: string;
  onSeeAll: () => void;
  children: ReactNode;
}

function Row({ title, onSeeAll, children }: RowProps) {
  const headingId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  // Reduced motion scrolls instantly (D-H21), the same as everywhere else.
  const scroll = (direction: -1 | 1) => {
    const list = listRef.current;
    if (!list || typeof list.scrollBy !== 'function') return;
    list.scrollBy({ left: direction * list.clientWidth * 0.8, behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  // Shown from 640px on hover or focus; below that the row is swipe-only (D-H21).
  const arrow =
    'focus-ring-contrast absolute top-[40%] z-10 hidden -translate-y-1/2 h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 sm:flex motion-reduce:transition-none';

  return (
    <section aria-labelledby={headingId} className="group/row relative">
      <div className={`mb-2 flex items-baseline justify-between sm:mb-3 ${GUTTER}`}>
        <h3 id={headingId} className="text-lg font-semibold text-[var(--color-text-primary)] sm:text-xl">
          {title}
        </h3>
        <button
          type="button"
          onClick={onSeeAll}
          aria-label={`See all ${title}`}
          className="focus-ring-contrast min-h-6 rounded px-1 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
        >
          See all <span aria-hidden="true">›</span>
        </button>
      </div>

      <div className="relative">
        <button
          type="button"
          aria-label={`Scroll ${title} left`}
          onClick={() => scroll(-1)}
          className={`${arrow} left-2`}
        >
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
        <ul
          ref={listRef}
          className={`flex snap-x snap-mandatory gap-3 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${GUTTER} scroll-px-4 sm:scroll-px-8 lg:scroll-px-12`}
        >
          {children}
        </ul>
        <button
          type="button"
          aria-label={`Scroll ${title} right`}
          onClick={() => scroll(1)}
          className={`${arrow} right-2`}
        >
          <ChevronRight size={22} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

interface CardProps {
  ratio: 'portrait' | 'wide';
  title: string;
  tag: string;
  /** Absent for a work: it has no artwork, so it gets a themed tile. */
  image?: string;
  eager: boolean;
  onActivate: () => void;
}

/** A card is a real <button> (D-H21), never a div with a handler. */
function Card({ ratio, title, tag, image, eager, onActivate }: CardProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = image !== undefined && failedSrc !== image;
  const width =
    ratio === 'portrait'
      ? 'w-[130px] sm:w-[160px] lg:w-[190px] xl:w-[200px]'
      : 'w-[200px] sm:w-[240px] xl:w-[260px]';
  const aspect = ratio === 'portrait' ? 'aspect-[2/3]' : 'aspect-video';

  return (
    <li className={`shrink-0 snap-start ${width}`}>
      <button type="button" onClick={onActivate} className="focus-ring-contrast block w-full rounded-lg text-left">
        <span
          className={`relative block overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)] ${aspect}`}
        >
          {showImage ? (
            <img
              src={image}
              alt=""
              aria-hidden="true"
              loading={eager ? 'eager' : 'lazy'}
              decoding="async"
              onError={() => setFailedSrc(image)}
              className="h-full w-full object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex h-full w-full items-center justify-center text-[var(--color-text-secondary)]"
            >
              {image !== undefined ? (
                <span className="text-[64px] font-semibold leading-none text-[var(--color-text-primary)]">
                  {initialOf(title)}
                </span>
              ) : (
                <Library size={36} />
              )}
            </span>
          )}
          {/* Fixed colours with their own backing: legible over any artwork. Hidden
              from assistive technology: it repeats what the row's heading already
              says ("New this week", "Works"), and read first it would front every
              card's name with "NEW" or "CHARACTER". */}
          <span
            aria-hidden="true"
            className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-white"
          >
            {tag}
          </span>
        </span>
        <span className="mt-1.5 block truncate text-sm font-medium text-[var(--color-text-primary)]">{title}</span>
      </button>
    </li>
  );
}
