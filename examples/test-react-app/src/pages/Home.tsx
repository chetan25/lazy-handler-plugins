import { Suspense, lazy, useEffect, useRef, useState } from "react";
// Imported NORMALLY at the top — webpack would put `marked` (~30 KB raw)
// in the main bundle. The plugin's loader sees that `marked` is only used
// inside an extracted handler, so it re-imports it inside the nugget chunk
// and prunes the static import here. Net result: `marked` ships only when
// the user clicks "Render markdown".
import { marked } from "marked";

// Zustand store imported normally. We use BOTH selector and imperative
// patterns below to show how each one composes with the plugin.
import { useCounter } from "../store/counter";

// useContext + provider lives one level up. Captured as a local binding.
import { useAppContext } from "../context/AppContext";

type Post = {
  id: number;
  userId: number;
  title: string;
  body: string;
};

// ─── Below-fold section is split into its own chunk and only mounted when
// the trigger element nears the viewport (IntersectionObserver). This is
// orthogonal to the nugget plugin — it splits the *component code* itself,
// not just its handlers.
const BelowFold = lazy(
  () => import(/* webpackChunkName: "below-fold" */ "./Home.BelowFold")
);

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

  // Zustand: selector pattern — count + history subscribed via the hook
  const count = useCounter((s) => s.count);
  const history = useCounter((s) => s.history);
  const lastChangedAt = useCounter((s) => s.lastChangedAt);

  // useContext: full context value as a local binding
  const ctx = useAppContext();

  const [shouldMountBelowFold, setShouldMountBelowFold] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sentinelRef.current || shouldMountBelowFold) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShouldMountBelowFold(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [shouldMountBelowFold]);

  return (
    <main className="page">
      <section className="hero">
        <h1>Home (above the fold)</h1>
        <p>
          Click "Fetch posts" — its handler is a 10+ line async block: fetch,
          validate, transform, sort, set multiple pieces of state, handle
          errors. That is what the plugin extracts into a lazy nugget chunk.
        </p>

        <button
          onClick={async () => {
            setLoadingPosts(true);
            setPostsError(null);
            try {
              const res = await fetch(
                "https://jsonplaceholder.typicode.com/posts"
              );
              if (!res.ok) {
                throw new Error(`HTTP ${res.status} fetching posts`);
              }
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
            <code>marked</code> is imported at the top of this file as a normal
            static import. The plugin moves it into the handler chunk so the
            initial bundle does not carry the parser.
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

        <div className="state-demos">
          <h2>State-management demos</h2>

          <div className="demo-block">
            <h3>Zustand — selector pattern</h3>
            <p>
              <code>count</code>, <code>history</code>, and{" "}
              <code>lastChangedAt</code> are subscribed via{" "}
              <code>useCounter(s =&gt; s.x)</code>. They become local bindings
              and the plugin registers them in the scope registry. The handler
              calls <code>useCounter.getState().increment()</code> to mutate
              the store imperatively from inside the lazy chunk.
            </p>
            <p className="meta">
              count: <strong>{count}</strong>
              {lastChangedAt && <> · last change: {lastChangedAt}</>}
              {history.length > 0 && <> · snapshots: {history.length}</>}
            </p>
            <button
              onClick={() => {
                if (count > 20) {
                  console.log("[zustand] resetting (count > 20)");
                  useCounter.getState().reset();
                  return;
                }
                const next = count + 1;
                console.log("[zustand] increment", count, "->", next);
                useCounter.getState().increment(1);
                useCounter.getState().recordSnapshot();
              }}
            >
              Increment + snapshot
            </button>
            <button
              onClick={() => {
                const step = count >= 5 ? 5 : 1;
                console.log("[zustand] decrement by", step);
                useCounter.getState().decrement(step);
                useCounter.getState().recordSnapshot();
              }}
            >
              Decrement (auto step)
            </button>
          </div>

          <div className="demo-block">
            <h3>Zustand — imperative read</h3>
            <p>
              This handler reads <code>useCounter.getState()</code> without
              going through a React subscription. The plugin captures{" "}
              <code>useCounter</code> as an <em>imported</em> capture and
              re-imports it inside the nugget chunk. Note that{" "}
              <code>zustand</code> is still in the main bundle here because
              the <em>other</em> demo above keeps a live selector
              subscription — the loader only prunes an import when{" "}
              <em>nothing</em> in the rewritten file still references it.
            </p>
            <button
              onClick={() => {
                const snapshot = useCounter.getState();
                const summary = {
                  current: snapshot.count,
                  total: snapshot.history.length,
                  history: snapshot.history.slice(-5),
                };
                console.log("[zustand imperative] snapshot", summary);
                alert(
                  `Count: ${summary.current}\nSnapshots: ${summary.total}\nRecent: ${summary.history.join(", ") || "(none)"}`
                );
              }}
            >
              Inspect store (imperative)
            </button>
          </div>

          <div className="demo-block">
            <h3>useContext</h3>
            <p>
              The whole <code>ctx</code> object from{" "}
              <code>useAppContext()</code> is a local binding. The handler
              reads <code>ctx.theme</code>, calls{" "}
              <code>ctx.setTheme(next)</code>, and records a visit. All from a
              chunk that loaded on click.
            </p>
            <p className="meta">
              app: <strong>{ctx.appName}</strong> · theme:{" "}
              <strong>{ctx.theme}</strong> · visits:{" "}
              <strong>{ctx.visits}</strong>
            </p>
            <button
              onClick={() => {
                const next = ctx.theme === "dark" ? "light" : "dark";
                console.log("[context] switching theme to", next);
                ctx.setTheme(next);
                ctx.recordVisit(`theme→${next}`);
                document.documentElement.style.colorScheme = next;
              }}
            >
              Toggle theme & log visit
            </button>
          </div>
        </div>

        <p className="hint">
          Scroll down. The "below the fold" section is in a separate chunk
          (React.lazy), mounted via IntersectionObserver only when it nears the
          viewport. Open DevTools → Network to watch the chunk arrive.
        </p>
      </section>

      <section className="filler">
        <p>spacer — keep scrolling</p>
      </section>

      <div ref={sentinelRef} aria-hidden="true" />

      <Suspense fallback={<div className="placeholder">Loading section…</div>}>
        {shouldMountBelowFold && <BelowFold />}
      </Suspense>
    </main>
  );
}
