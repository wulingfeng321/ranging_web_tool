import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** Snapshot transitions preserve component identity and avoid delaying navigation. */
export function usePageNavigation(initial: string) {
  const [page, setPage] = useState(initial);
  const current = useRef(initial);
  const transition = useRef<ViewTransition | null>(null);
  const sequence = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(
    () => () => {
      sequence.current++;
      transition.current?.skipTransition();
    },
    [],
  );
  function navigate(next: string) {
    if (next === current.current) return;
    current.current = next;
    const token = ++sequence.current;
    transition.current?.skipTransition();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const update = () => {
      if (token !== sequence.current) return;
      flushSync(() => setPage(next));
      window.scrollTo(0, 0);
    };
    if (document.startViewTransition && !reduced) {
      const active = document.startViewTransition(update);
      transition.current = active;
      // Rapid navigation may intentionally skip an intermediate snapshot.
      void active.ready.catch(() => {});
      void active.finished
        .finally(() => {
          if (transition.current === active) transition.current = null;
        })
        .catch(() => {});
    } else {
      update();
      if (!reduced) {
        surface.current
          ?.getAnimations()
          .forEach((animation) => animation.cancel());
        surface.current?.animate(
          [
            { opacity: 0.45, transform: "translateY(8px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 280, easing: "cubic-bezier(.2,.7,.2,1)" },
        );
      }
    }
  }
  return { page, navigate, surface };
}
