// examples/SearchBox.jsx
// ─────────────────────────────────────────────────────────────────────────────
// BEFORE: The full handler ships in the main bundle on every page load
// ─────────────────────────────────────────────────────────────────────────────

export function SearchBoxBefore() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);

  return (
    <button
      onClick={async () => {
        setLoading(true);
        const res = await fetch("/api/search");
        setResults(await res.json());
        setLoading(false);
      }}
    >
      {loading ? "Searching..." : "Search"}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AFTER: The plugin transforms this automatically — you write the same code.
// The handler chunk (~3KB) is fetched only on first click.
// The plugin emits this transformation — you do NOT write it manually.
// ─────────────────────────────────────────────────────────────────────────────

import {
  __nuggetProxy,
  __nuggetCreateScope,
  __nuggetDestroyScope,
  __nuggetRegisterRef,
} from "lazy-handler-webpack-plugin/runtime";
import { useRef, useEffect } from "react";

export function SearchBoxAfter() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);

  // Lazy useRef init — idempotent across renders and StrictMode double-mount.
  const __scopeRef = useRef(null);
  if (__scopeRef.current === null) __scopeRef.current = __nuggetCreateScope();
  const __scopeId = __scopeRef.current;

  // Destroy on real unmount.
  useEffect(() => () => __nuggetDestroyScope(__scopeId), []);

  // Synchronous register right before render — covers click-during-first-paint.
  __nuggetRegisterRef(__scopeId, "setLoading", setLoading);
  __nuggetRegisterRef(__scopeId, "setResults", setResults);

  // No-deps effect re-registers after every commit, including StrictMode's
  // artificial remount which would otherwise leave the scope destroyed.
  useEffect(() => {
    __nuggetRegisterRef(__scopeId, "setLoading", setLoading);
    __nuggetRegisterRef(__scopeId, "setResults", setResults);
  });

  return (
    <button
      data-nugget-lazy="nugget-7f3a9b2c"
      onClick={(...__nuggetRest) =>
        __nuggetProxy(
          "nugget_onClick_7f3a9b2c",
          () => import(/* webpackChunkName: "nugget-7f3a9b2c" */ "nugget://nugget-7f3a9b2c"),
          [...__nuggetRest],
          { scopeId: __scopeId, refs: ["setLoading", "setResults"] }
        )
      }
    >
      {loading ? "Searching..." : "Search"}
    </button>
  );
}

// The emitted nugget chunk (static/nuggets/nugget-7f3a9b2c.js) looks like this:
//
// import { __nuggetDeref, __nuggetHasScope } from "lazy-handler-webpack-plugin/runtime";
//
// export default async function nugget_onClick_7f3a9b2c(args, { scopeId }) {
//   if (!__nuggetHasScope(scopeId)) return; // unmounted
//   const setLoading = __nuggetDeref(scopeId, "setLoading");
//   const setResults = __nuggetDeref(scopeId, "setResults");
//
//   const handler = async () => {
//     setLoading(true);
//     const res = await fetch("/api/search");
//     setResults(await res.json());
//     setLoading(false);
//   };
//   return handler(...args);
// }
