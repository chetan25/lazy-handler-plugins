"use client";

import {
  useState,
  useReducer,
  createContext,
  useContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { atom, useAtom, useAtomValue } from "jotai";

export type Post = {
  id: number;
  userId: number;
  title: string;
  body: string;
};

// ─── Jotai atoms (module scope, no provider needed) ─────────────────────────
type Todo = { id: number; text: string; done: boolean };
const todosAtom = atom<Todo[]>([]);
const unfinishedCountAtom = atom((get) =>
  get(todosAtom).filter((t) => !t.done).length
);

// ─── Cart Context + reducer ─────────────────────────────────────────────────
type CartItem = { id: number; name: string; price: number };
type CartState = { items: CartItem[]; lastAction: string };
type CartAction =
  | { type: "ADD"; id: number; name: string; price: number }
  | { type: "CLEAR" };

function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "ADD":
      return {
        items: [
          ...state.items,
          { id: action.id, name: action.name, price: action.price },
        ],
        lastAction: `Added ${action.name}`,
      };
    case "CLEAR":
      return { items: [], lastAction: "Cleared cart" };
  }
}

const CartContext = createContext<{
  state: CartState;
  dispatch: Dispatch<CartAction>;
} | null>(null);

function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be inside CartProvider");
  return ctx;
}

function CartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, {
    items: [],
    lastAction: "",
  });
  return (
    <CartContext.Provider value={{ state, dispatch }}>
      {children}
    </CartContext.Provider>
  );
}

// ─── Section A: useState — Preferences form ─────────────────────────────────
function PrefsSection() {
  const [name, setName] = useState("");
  const [notifs, setNotifs] = useState(false);
  const [theme, setTheme] = useState<"light" | "dim" | "dark">("light");
  const [status, setStatus] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveCount, setSaveCount] = useState(0);

  return (
    <section className="below-fold">
      <h2>useState — Preferences form</h2>
      <p>
        Six <code>useState</code> setters all registered in this component&apos;s
        scope. The Save handler reads three of them, writes to three more.
      </p>
      <div className="prefs-form">
        <label>
          Name:
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="At least 2 chars"
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={notifs}
            onChange={(e) => setNotifs(e.target.checked)}
          />
          Notifications
        </label>
        <div className="theme-row">
          <span>Theme:</span>
          {(["light", "dim", "dark"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              aria-pressed={theme === t}
              className={theme === t ? "theme-on" : ""}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            const trimmed = name.trim();
            if (trimmed.length < 2) {
              setStatus("Name too short — need at least 2 chars");
              return;
            }
            setStatus(
              `Saved "${trimmed}" | notifications=${notifs} | theme=${theme}`
            );
            setSavedAt(new Date().toLocaleTimeString());
            setSaveCount((n) => n + 1);
          }}
        >
          Save preferences
        </button>
      </div>
      {status && <p className="meta">{status}</p>}
      {savedAt && (
        <p className="meta">
          Last saved {savedAt} (save #{saveCount})
        </p>
      )}
    </section>
  );
}

// ─── Section B: Context + useReducer — Cart ─────────────────────────────────
function CartSection() {
  const { state, dispatch } = useCart();
  const [flash, setFlash] = useState<string | null>(null);

  const total = state.items.reduce((s, i) => s + i.price, 0);

  return (
    <section className="below-fold">
      <h2>Context + useReducer — Cart</h2>
      <p>
        <code>dispatch</code> comes through React Context and gets registered in
        this section&apos;s scope. Last action:{" "}
        <strong>{state.lastAction || "—"}</strong>
      </p>
      <div className="cart-buttons">
        <button
          onClick={() => {
            const ts = Date.now();
            dispatch({ type: "ADD", id: ts, name: "Coffee", price: 4 });
            setFlash(`Added coffee at ${new Date().toLocaleTimeString()}`);
          }}
        >
          Add Coffee ($4)
        </button>
        <button
          onClick={() => {
            const ts = Date.now();
            dispatch({ type: "ADD", id: ts, name: "Bagel", price: 3 });
            setFlash(`Added bagel at ${new Date().toLocaleTimeString()}`);
          }}
        >
          Add Bagel ($3)
        </button>
        <button
          onClick={() => {
            const ts = Date.now();
            dispatch({ type: "ADD", id: ts, name: "Tea", price: 2 });
            setFlash(`Added tea at ${new Date().toLocaleTimeString()}`);
          }}
        >
          Add Tea ($2)
        </button>
        <button
          onClick={() => {
            const before = state.items.length;
            dispatch({ type: "CLEAR" });
            setFlash(`Cleared ${before} item${before === 1 ? "" : "s"}`);
          }}
        >
          Clear cart
        </button>
      </div>
      {flash && <p className="meta">{flash}</p>}
      <ul className="cart-list">
        {state.items.map((it) => (
          <li key={it.id}>
            {it.name} — ${it.price}
          </li>
        ))}
      </ul>
      <p className="meta">
        {state.items.length} item{state.items.length === 1 ? "" : "s"} · total $
        {total}
      </p>
    </section>
  );
}

// ─── Section C: Jotai — Todo list ───────────────────────────────────────────
function TodoSection() {
  const [todos, setTodos] = useAtom(todosAtom);
  const unfinishedCount = useAtomValue(unfinishedCountAtom);
  const [input, setInput] = useState("");

  return (
    <section className="below-fold">
      <h2>Jotai — Todo list</h2>
      <p>
        <code>useAtom</code> setter behaves like a <code>useState</code> setter
        — same scope-registry path under the hood.
      </p>
      <p className="meta">
        Pending: {unfinishedCount} of {todos.length}
      </p>
      <div className="todo-input-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="What needs doing?"
        />
        <button
          onClick={() => {
            const trimmed = input.trim();
            if (!trimmed) return;
            setTodos((prev) => [
              ...prev,
              { id: Date.now(), text: trimmed, done: false },
            ]);
            setInput("");
          }}
        >
          Add todo
        </button>
      </div>
      <button
        onClick={() => {
          const before = todos.length;
          const remaining = todos.filter((t) => !t.done);
          setTodos(remaining);
          console.log(
            `[todos] cleared ${before - remaining.length} completed`
          );
        }}
      >
        Clear completed
      </button>
      <ul className="todo-list">
        {todos.map((t) => (
          <li key={t.id} className={t.done ? "done" : ""}>
            <input
              type="checkbox"
              checked={t.done}
              onChange={() =>
                setTodos((prev) =>
                  prev.map((p) =>
                    p.id === t.id ? { ...p, done: !p.done } : p
                  )
                )
              }
            />
            <span>{t.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Section D: Mixed sources — Snapshot ────────────────────────────────────
function SnapshotSection() {
  const { state: cart } = useCart();
  const todos = useAtomValue(todosAtom);
  const [log, setLog] = useState<string[]>([]);
  const [snapshotCount, setSnapshotCount] = useState(0);

  // Precompute primitives at render time — these are the only outer values the
  // handler captures, which keeps the handler safely extractable.
  const cartCount = cart.items.length;
  const cartTotal = cart.items.reduce((s, i) => s + i.price, 0);
  const todoCount = todos.length;
  const pendingCount = todos.filter((t) => !t.done).length;

  return (
    <section className="below-fold">
      <h2>Mixed sources — Snapshot</h2>
      <p>
        One handler reads cart (Context), todos (Jotai), and its own local
        state. Three setters live in this component&apos;s scope; the read
        values are captured as primitives at render time.
      </p>
      <button
        onClick={() => {
          const stamp = new Date().toLocaleTimeString();
          const line = `[${stamp}] cart=${cartCount} ($${cartTotal}) todos=${todoCount} pending=${pendingCount}`;
          setLog((prev) => [line, ...prev].slice(0, 5));
          setSnapshotCount((n) => n + 1);
          console.log("[snapshot]", line);
        }}
      >
        Snapshot all state (#{snapshotCount})
      </button>
      <button
        onClick={() => {
          if (log.length === 0) return;
          setLog([]);
          setSnapshotCount(0);
          console.log("[snapshot] log cleared");
        }}
      >
        Clear log
      </button>
      <ul className="log-list">
        {log.map((line, i) => (
          <li key={i}>
            <code>{line}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Default export — the lazy-loaded below-fold component ──────────────────
// Lazy-imported in page.tsx via next/dynamic({ ssr: false }) and mounted by
// IntersectionObserver only when its sentinel nears the viewport. This whole
// file (plus everything it pulls in: jotai + the 4 demo components + nugget
// chunks for their handlers) ships in a separate chunk.
export default function HomeBelowFold({
  posts,
  setPosts,
}: {
  posts: Post[];
  setPosts: Dispatch<SetStateAction<Post[]>>;
}) {
  return (
    <>
      <section className="below-fold">
        <h2>Below the fold</h2>
        <p>
          This whole section, its handlers, and the four state-demo sections
          below all live in a separate <code>below-fold</code> chunk. It loaded
          only because you scrolled here.
        </p>

        <button
          onClick={() => {
            const next = posts.slice().reverse();
            console.log("[below-fold] reversing posts list, length:", posts.length);
            setPosts(next);
          }}
        >
          Reverse posts ({posts.length})
        </button>

        <button
          onClick={async () => {
            try {
              const res = await fetch(
                "https://jsonplaceholder.typicode.com/users?_limit=3"
              );
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const users = await res.json();
              const names = users.map((u: { name: string }) => u.name).join(", ");
              alert(`Fetched ${users.length} users: ${names}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Unknown error";
              alert(`Fetch failed: ${msg}`);
            }
          }}
        >
          Fetch users (below-fold)
        </button>
      </section>

      <CartProvider>
        <PrefsSection />
        <CartSection />
        <TodoSection />
        <SnapshotSection />
      </CartProvider>
    </>
  );
}
