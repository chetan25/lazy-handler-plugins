import { useState } from "react";
import "./Home.BelowFold.css";

type User = {
  name: string;
  email: string;
  company: string;
  city: string;
};

type Comment = {
  id: number;
  body: string;
  createdAt: string;
};

// This whole module is fetched as its own webpack chunk via React.lazy in
// Home.tsx. Its JS and its companion CSS only ship after the user scrolls
// near it — that is the below-fold cut at the *component* level.
export default function HomeBelowFold() {
  const [userId, setUserId] = useState("1");
  const [user, setUser] = useState<User | null>(null);
  const [userError, setUserError] = useState<string | null>(null);
  const [loadingUser, setLoadingUser] = useState(false);

  const [comment, setComment] = useState("");
  const [comments, setComments] = useState<Comment[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [todos, setTodos] = useState<{ id: number; title: string; done: boolean }[]>([]);
  const [todoFilter, setTodoFilter] = useState<"all" | "open" | "done">("all");

  return (
    <section className="below-fold">
      <h2>Below the fold</h2>
      <p>
        This whole section, including these handlers and the
        <code> Home.BelowFold.css</code> styles, is in a separate chunk that
        only loaded because you scrolled here.
      </p>

      <div className="card">
        <h3>Fetch a user</h3>
        <input
          type="text"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="user id (1–10)"
        />
        <button
          onClick={async () => {
            const trimmed = userId.trim();
            const parsed = Number(trimmed);
            if (!trimmed || Number.isNaN(parsed) || parsed < 1 || parsed > 10) {
              setUserError("Please enter a numeric user id between 1 and 10");
              setUser(null);
              return;
            }
            setLoadingUser(true);
            setUserError(null);
            try {
              const res = await fetch(
                `https://jsonplaceholder.typicode.com/users/${parsed}`
              );
              if (!res.ok) {
                throw new Error(`User ${parsed} not found`);
              }
              const data = await res.json();
              setUser({
                name: data.name,
                email: data.email,
                company: data.company?.name ?? "—",
                city: data.address?.city ?? "—",
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Unknown error";
              setUserError(msg);
              setUser(null);
            } finally {
              setLoadingUser(false);
            }
          }}
        >
          {loadingUser ? "Fetching…" : "Fetch user"}
        </button>
        {userError && <p className="error">Error: {userError}</p>}
        {user && (
          <dl className="user">
            <dt>Name</dt><dd>{user.name}</dd>
            <dt>Email</dt><dd>{user.email}</dd>
            <dt>Company</dt><dd>{user.company}</dd>
            <dt>City</dt><dd>{user.city}</dd>
          </dl>
        )}
      </div>

      <div className="card">
        <h3>Add a comment</h3>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="write something (min 5 characters)"
          rows={3}
        />
        <button
          onClick={async () => {
            const trimmed = comment.trim();
            if (trimmed.length < 5) {
              alert("Comment must be at least 5 characters long");
              return;
            }
            setSubmitting(true);
            try {
              const res = await fetch(
                "https://jsonplaceholder.typicode.com/comments",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ postId: 1, body: trimmed }),
                }
              );
              const data = await res.json();
              const next: Comment = {
                id: data.id ?? Date.now(),
                body: trimmed,
                createdAt: new Date().toLocaleTimeString(),
              };
              setComments([next, ...comments]);
              setComment("");
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Submit failed";
              alert(`Could not submit: ${msg}`);
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {submitting ? "Submitting…" : "Submit comment"}
        </button>
        <ul className="comments">
          {comments.map((c) => (
            <li key={c.id}>
              <time>{c.createdAt}</time>
              <p>{c.body}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Todos</h3>
        <button
          onClick={async () => {
            try {
              const res = await fetch(
                "https://jsonplaceholder.typicode.com/todos?_limit=12"
              );
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const data = await res.json();
              const mapped = data.map((t: { id: number; title: string; completed: boolean }) => ({
                id: t.id,
                title: t.title,
                done: t.completed,
              }));
              setTodos(mapped);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Unknown error";
              alert(`Could not fetch todos: ${msg}`);
            }
          }}
        >
          Fetch todos
        </button>

        <div className="filter-row">
          {(["all", "open", "done"] as const).map((f) => (
            <button
              key={f}
              className={todoFilter === f ? "active" : ""}
              onClick={() => {
                const next = f;
                console.log("[todos] filter changed to", next);
                setTodoFilter(next);
              }}
            >
              {f}
            </button>
          ))}
        </div>

        <ul className="todos">
          {todos
            .filter((t) =>
              todoFilter === "all"
                ? true
                : todoFilter === "done"
                  ? t.done
                  : !t.done
            )
            .map((t) => (
              <li key={t.id} className={t.done ? "done" : ""}>
                {t.title}
              </li>
            ))}
        </ul>
      </div>
    </section>
  );
}
