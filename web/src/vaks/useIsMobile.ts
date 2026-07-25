import { useEffect, useState } from 'react';

/**
 * True when the viewport is phone-sized. Mirrors the `max-width: 620px` CSS
 * breakpoint used by the mobile layouts so JS and CSS agree on "phone".
 * Used by the per-view phone layouts (Timesheet, later Workload / Gantt).
 */
export function useIsMobile(query = '(max-width: 620px)'): boolean {
  const [match, setMatch] = useState<boolean>(() =>
    typeof window !== 'undefined' && 'matchMedia' in window
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatch(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return match;
}
