"use client";

import { useState } from "react";
import { NuggetLazy } from "lazy-handler-plugin/runtime";
// `marked` is imported as a normal static import at the top of the page.
// The plugin sees that it's only referenced inside an extracted handler,
// re-imports it inside the nugget chunk, and prunes the static import here
// — so the markdown parser ships only when the user clicks "Render markdown".
import { marked } from "marked";
import type { Post } from "./Home.BelowFold";

// Comprehensive matrix of event-handler shapes (extracted + skipped).
import HandlerPatterns from "./HandlerPatterns";

export default function Home() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [mdSource, setMdSource] = useState(
    "# Hello\n\nThis renders **markdown** via `marked`. Try editing!\n\n- list item\n- another\n\n```js\nconst x = 1;\n```"
  );
  const [mdHtml, setMdHtml] = useState("");

  // ── Named-handler test (function-declaration form) ─────────────────────
  // Exercises the FunctionDeclaration branch of the plugin's named-ref
  // extraction (the const-arrow form is tested in the React/Vite test
  // apps). The plugin should extract this function, route it to its own
  // nugget chunk, and remove the declaration from the main bundle.
  function handleReset() {
    console.log("[home] named handler — resetting state");
    setPosts([]);
    setPostsError(null);
    setLastFetchedAt(null);
    setMdHtml("");
  }

  return (
    <main className="page">
      <section className="hero">
        <h1>Home (above the fold)</h1>
        <p>
          Next.js 14 App Router · the plugin extracts each inline handler
          below into its own lazy chunk under <code>.next/static/nuggets/</code>.
          Everything below the spacer is itself a separate{" "}
          <code>below-fold</code> chunk loaded via{" "}
          <code>&lt;NuggetLazy&gt;</code> (sentinel + IntersectionObserver
          built in).
        </p>

        <button
          onClick={async () => {
            setLoadingPosts(true);
            setPostsError(null);
            try {
              const res = await fetch(
                "https://jsonplaceholder.typicode.com/posts"
              );
              if (!res.ok) throw new Error(`HTTP ${res.status} fetching posts`);
              const data = await res.json();
              const trimmed = data
                .filter((p: Post) => p.title.length > 20)
                .slice(0, 8)
                .map((p: Post) => ({
                  ...p,
                  title: p.title.charAt(0).toUpperCase() + p.title.slice(1),
                }));
              setPosts(trimmed);
              setLastFetchedAt(new Date().toLocaleTimeString());
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Unknown error";
              setPostsError(msg);
              setPosts([]);
            } finally {
              setLoadingPosts(false);
            }
          }}
        >
          {loadingPosts ? "Fetching…" : "Fetch posts"}
        </button>

        <button
          onClick={() => {
            const next = sortDir === "asc" ? "desc" : "asc";
            const sorted = [...posts].sort((a, b) => {
              const cmp = a.title.localeCompare(b.title);
              return next === "asc" ? cmp : -cmp;
            });
            setPosts(sorted);
            setSortDir(next);
          }}
        >
          Sort posts ({sortDir === "asc" ? "A → Z" : "Z → A"})
        </button>

        {/* Named-handler test — `handleReset` is declared above as a
            `function` statement, exercising the FunctionDeclaration path. */}
        <button onClick={handleReset}>Reset (named handler)</button>

        {postsError && <p className="error">Error: {postsError}</p>}
        {lastFetchedAt && (
          <p className="meta">
            Last fetched at {lastFetchedAt} — {posts.length} posts
          </p>
        )}

        <ul className="posts">
          {posts.map((p) => (
            <li key={p.id}>
              <strong>{p.title}</strong>
              <span className="excerpt">{p.body.slice(0, 80)}…</span>
            </li>
          ))}
        </ul>

        <div className="markdown-demo">
          <h2>The fat-handler demo</h2>
          <p>
            <code>marked</code> imported normally at the top of this file. The
            plugin moves it to the handler chunk so the initial bundle does
            not carry the parser.
          </p>
          <textarea
            value={mdSource}
            onChange={(e) => setMdSource(e.target.value)}
            rows={6}
            spellCheck={false}
          />
          <button
            onClick={() => {
              const src = mdSource.trim();
              if (!src) {
                setMdHtml("(nothing to render)");
                return;
              }
              const result = marked.parse(src, { gfm: true, breaks: true });
              if (typeof result !== "string") {
                setMdHtml("(error: async parser configuration)");
                return;
              }
              const stamped =
                result +
                "\n<!-- rendered " +
                new Date().toLocaleTimeString() +
                " -->";
              setMdHtml(stamped);
            }}
          >
            Render markdown
          </button>
          {mdHtml && (
            <pre className="md-rendered">
              <code>{mdHtml}</code>
            </pre>
          )}
        </div>

        <p className="hint">
          Scroll down. The below-fold half (Reverse posts, Fetch users, plus
          the four state-demo sections) lives in a separate chunk — open
          DevTools → Network and watch the BelowFold chunk arrive only when
          the <code>NuggetLazy</code> sentinel enters the viewport.
        </p>
      </section>

      <HandlerPatterns />

      <section className="filler">
        <p>spacer — keep scrolling</p>
      </section>

      <NuggetLazy
        load={() => import("./Home.BelowFold")}
        props={{ posts, setPosts }}
        rootMargin="300px"
        loading={<div className="placeholder">Loading section…</div>}
      />
    </main>
  );
}
