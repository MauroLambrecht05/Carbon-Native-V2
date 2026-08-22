import { useEffect } from "react";

/** Sets document.title for the page it's rendered in — react-router doesn't do this itself. */
export function PageTitle({ title }: { readonly title: string }) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
  return null;
}
