// Vite test bed for lazy-handler-plugin.
// Mirrors the markdown demo from the webpack/Next.js test apps: `marked` is
// imported at the top normally, and the plugin should move it into the
// nugget chunk because it's only referenced inside an extracted handler.
import { useState } from "react";
import { marked } from "marked";

type Post = { id: number; title: string; body: string };

export default function App() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);

  const [mdSource, setMdSource] = useState(
    "# Hello\n\nThis renders **markdown** via `marked`.\n\n- list item\n- another"
  );
  const [mdHtml, setMdHtml] = useState("");

  // ── Named-handler test ──────────────────────────────────────────────────
  // `handleReset` is referenced ONLY as `onClick={handleReset}` below — no
  // other site uses this binding. The plugin should extract it the same way
  // it would an inline arrow, and remove this declaration from the main
  // bundle.
  const handleReset = () => {
    console.log("[named handler] resetting state");
    setPosts([]);
    setPostsError(null);
    setLastFetchedAt(null);
    setMdHtml("");
  };

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "system-ui" }}>
      <h1>Vite + lazy-handler-plugin</h1>
      <p>
        Open DevTools → Network and click a button. The handler ships in a
        separate <code>static/nuggets/nugget-*.js</code> chunk on first
        click; <code>marked</code> rides along inside it, never landing in
        the main bundle.
      </p>

      <button
        onClick={async () => {
          setLoadingPosts(true);
          setPostsError(null);
          try {
            const res = await fetch("https://jsonplaceholder.typicode.com/posts");
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching posts`);
            const data: Post[] = await res.json();
            const trimmed = data
              .filter((p) => p.title.length > 20)
              .slice(0, 8)
              .map((p) => ({
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

      {postsError && <p style={{ color: "crimson" }}>Error: {postsError}</p>}
      {lastFetchedAt && (
        <p>Last fetched at {lastFetchedAt} — {posts.length} posts</p>
      )}
      <ul>
        {posts.map((p) => (
          <li key={p.id}>
            <strong>{p.title}</strong> — {p.body.slice(0, 80)}…
          </li>
        ))}
      </ul>

      <hr />
      <h2>Markdown demo</h2>
      <textarea
        value={mdSource}
        onChange={(e) => setMdSource(e.target.value)}
        rows={6}
        spellCheck={false}
        style={{ width: "100%", fontFamily: "monospace" }}
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
          setMdHtml(result);
        }}
      >
        Render markdown
      </button>
      {mdHtml && (
        <pre style={{ background: "#f6f8fa", padding: "1rem", whiteSpace: "pre-wrap" }}>
          <code>{mdHtml}</code>
        </pre>
      )}

      <hr />
      <h2>Named-handler test</h2>
      <p>
        The handler below is a <em>named</em> binding (<code>handleReset</code>)
        referenced as <code>onClick={"{handleReset}"}</code>. The plugin should
        still extract it. Open DevTools → Network and click it once.
      </p>
      <button onClick={handleReset}>Reset all state</button>
    </main>
  );
}
