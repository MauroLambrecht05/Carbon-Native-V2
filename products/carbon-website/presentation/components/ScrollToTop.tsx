import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** Without this, navigating to a new route keeps the old page's scroll position. */
export function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) return; // let the browser handle in-page anchors
    window.scrollTo({ top: 0 });
  }, [pathname, hash]);
  return null;
}
