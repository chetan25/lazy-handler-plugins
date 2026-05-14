"use client";

// HandlerPatterns.tsx — exhaustive matrix of JSX event-handler shapes.
//
// Every pattern's body holds a unique `[A1-marker]` / `[B3-marker]` style
// string. After `npm run build`, grep the main bundle and the nugget chunks:
//   * markers present in main bundle = handler stayed inline (skipped)
//   * markers present in a nugget = handler was extracted
//
// Manual UI test: each button must fire on click; dual-event buttons must
// also fire on hover; the multi-return component must keep working after
// toggling; the form submit must preventDefault before the chunk loads.

import { useEffect, useState, useCallback } from "react";
import { externalHandler } from "./externalHandler";

// ── Helper components ─────────────────────────────────────────────────────

// Prop-consumer child. `cb` is a destructured param — not function-shaped —
// so the named-ref extraction's `getFunctionFromBinding` returns null and
// the child's bindings stay inline.
function PropConsumer({ cb }: { cb: () => void }) {
  return (
    <button data-test="prop-consumer" onClick={cb} onMouseEnter={cb}>
      B8 · prop-passed handler (NOT extracted in child)
    </button>
  );
}

// Multi-return component — tests scope-wiring-before-every-return.
function MultiReturnTest({ log }: { log: (msg: string) => void }) {
  const [mode, setMode] = useState<"a" | "b">("a");
  const handleToggle = () => {
    log("[A12-marker] toggling " + mode);
    setMode((m) => (m === "a" ? "b" : "a"));
  };
  if (mode === "a") {
    return (
      <button data-test="multi-return-a" onClick={handleToggle}>
        A12 path A · click → B
      </button>
    );
  }
  return (
    <button data-test="multi-return-b" onClick={handleToggle}>
      A12 path B · click → A
    </button>
  );
}

// ── Main matrix ───────────────────────────────────────────────────────────

export default function HandlerPatterns() {
  const [count, setCount] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const append = (msg: string) =>
    setHistory((h) => [...h.slice(-9), msg]);

  // ───────────────────────────────────────────────────────────────────────
  // SECTION A — patterns the plugin EXTRACTS
  // ───────────────────────────────────────────────────────────────────────

  // A2: inline async with await + multiple statements → extracted
  // (the JSX is the only consumer of this shape)

  // A3: form-submit with preventDefault hoist + named-handler chain
  const submitFlow = async () => {
    append("[A3-helper] submitFlow phase 1");
    await new Promise((r) => setTimeout(r, 10));
    append("[A3-helper] submitFlow phase 2");
    setCount((c) => c + 1);
  };

  // A4: named handlers each invoked together from a composed inline arrow
  const trackClick = () => append("[A4-helper-track] track");
  const persistState = () => append("[A4-helper-persist] persist");
  const updateUI = () => {
    setCount((c) => c + 1);
    append("[A4-helper-ui] ui");
  };

  // A5: named const-arrow handler, JSX-only refs → extracted
  // (kept JSX-only; declared near JSX so binding count is obvious)
  const a5Handler = (e: React.SyntheticEvent) => {
    append("[A5-marker] named const-arrow " + e.type);
    setCount((c) => c + 1);
  };

  // A6: named function-declaration handler → extracted
  function a6Handler(e: React.SyntheticEvent) {
    append("[A6-marker] named function-decl " + e.type);
    setCount((c) => c + 1);
  }

  // A7: same handler on BOTH onClick AND onMouseEnter (one element)
  //     → extracted into ONE nugget chunk shared by both proxies
  const a7Dual = (e: React.SyntheticEvent) => {
    append("[A7-marker] dual-bind " + e.type);
    setCount((c) => c + 1);
  };

  // A8: same handler on the SAME event across TWO buttons
  //     → extracted into ONE shared nugget chunk
  const a8Shared = () => {
    append("[A8-marker] shared across elements");
    setCount((c) => c + 1);
  };

  // A9: different named handlers on the same element (click vs hover)
  //     → each extracted independently into its own nugget
  const a9Click = () => {
    append("[A9-marker-click] click branch");
    setCount((c) => c + 1);
  };
  const a9Hover = () => {
    append("[A9-marker-hover] hover branch");
    setCount((c) => c + 1);
  };

  // A10: three mouse events with three different handlers. Each body is
  // padded above minHandlerLines so the named-ref extraction kicks in —
  // the point of A10 is to exercise extraction across different event
  // props, not to test the threshold behavior.
  const a10Enter = (e: React.MouseEvent) => {
    append("[A10-marker-enter] mouseenter at " + e.clientX);
    setCount((c) => c + 1);
  };
  const a10Leave = (e: React.MouseEvent) => {
    append("[A10-marker-leave] mouseleave at " + e.clientX);
    setCount((c) => c + 1);
  };
  const a10Down = (e: React.PointerEvent) => {
    append("[A10-marker-down] pointerdown button=" + e.button);
    setCount((c) => c + 1);
  };

  // A11: async named handler with await → extracted
  const a11AsyncNamed = async () => {
    append("[A11-marker] async named — fetching");
    await new Promise((r) => setTimeout(r, 10));
    append("[A11-marker] async named — done");
    setCount((c) => c + 1);
  };

  // ───────────────────────────────────────────────────────────────────────
  // SECTION B — patterns the plugin INTENTIONALLY SKIPS
  // ───────────────────────────────────────────────────────────────────────

  // B2: named handler ALSO referenced outside JSX → not extracted
  //     (allReferencesAreEventProps rejects because of the useEffect ref)
  const b2Handler = () => {
    append("[B2-marker] also-referenced-outside-JSX");
    setCount((c) => c + 1);
  };
  useEffect(() => {
    void b2Handler; // disqualifying reference outside JSX
  });

  // B3: useCallback-wrapped → not extracted (CallExpression init)
  const b3Handler = useCallback(() => {
    append("[B3-marker] useCallback-wrapped");
    setCount((c) => c + 1);
  }, []);

  // B5: member-expression handler → not extracted (expr is MemberExpression)
  const handlers = {
    member: () => {
      append("[B5-marker] member-expression");
      setCount((c) => c + 1);
    },
  };

  // B6: ternary at value position → not extracted (ConditionalExpression)
  const b6Enabled = count % 2 === 0;
  const b6A = () => {
    append("[B6-marker-a] ternary branch A");
    setCount((c) => c + 1);
  };
  const b6B = () => {
    append("[B6-marker-b] ternary branch B");
    setCount((c) => c + 1);
  };

  // B7: inline arrow wrapping a named call — the wrapper is under threshold
  //     so it stays inline; the named function inside it is referenced from
  //     a CallExpression, not directly from a JSXAttribute, so it can't be
  //     named-extracted either.
  const b7Inner = () => {
    append("[B7-marker] called by inline wrapper");
    setCount((c) => c + 1);
  };

  // B8: handler passed as a prop. A dedicated binding so we don't pollute
  //     A5's referencePaths (which would silently disqualify A5 from
  //     extraction — a real footgun worth showing in the test, separately).
  const b8Handler = () => {
    append("[B8-marker] prop-passed handler invoked");
    setCount((c) => c + 1);
  };

  return (
    <section style={{ marginTop: "2rem" }}>
      <h2>Handler invocation patterns</h2>
      <p>
        count: <strong>{count}</strong> · last submit:{" "}
        <strong>{submitted ?? "—"}</strong>
      </p>
      <ul
        style={{
          background: "#f6f8fa",
          fontFamily: "monospace",
          fontSize: 12,
          padding: "0.5rem 1rem",
          maxHeight: 220,
          overflow: "auto",
        }}
      >
        {history.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      <h3 style={{ marginTop: "1.5rem" }}>A. Extracted</h3>
      <div style={{ display: "grid", gap: "0.5rem" }}>
        {/* A1: long inline arrow */}
        <button
          data-test="A1"
          onClick={() => {
            append("[A1-marker] long inline arrow");
            const next = count + 1;
            console.log("count was", count, "now", next);
            setCount(next);
          }}
        >
          A1 · long inline arrow (≥ minHandlerLines)
        </button>

        {/* A2: inline async with await */}
        <button
          data-test="A2"
          onClick={async () => {
            append("[A2-marker] async inline — start");
            await new Promise((r) => setTimeout(r, 10));
            append("[A2-marker] async inline — done");
            setCount((c) => c + 1);
          }}
        >
          A2 · inline async with await
        </button>

        {/* A3: form-submit with preventDefault hoist */}
        <form
          data-test="A3"
          onSubmit={async (e) => {
            e.preventDefault();
            append("[A3-marker] form submit — hoist + chain");
            await submitFlow();
            setSubmitted(new Date().toLocaleTimeString());
          }}
          style={{ display: "flex", gap: "0.5rem" }}
        >
          <input name="q" defaultValue="hello" />
          <button type="submit">A3 · onSubmit (preventDefault hoisted)</button>
        </form>

        {/* A4: composed inline calling multiple named handlers */}
        <button
          data-test="A4"
          onClick={() => {
            append("[A4-marker] composed inline begins");
            trackClick();
            persistState();
            updateUI();
          }}
        >
          A4 · inline arrow composing three named handlers
        </button>

        {/* A5: named const-arrow */}
        <button data-test="A5" onClick={a5Handler}>
          A5 · named const-arrow
        </button>

        {/* A6: named function-declaration */}
        <button data-test="A6" onClick={a6Handler}>
          A6 · named function-declaration
        </button>

        {/* A7: same handler bound to two events on one element */}
        <button data-test="A7" onClick={a7Dual} onMouseEnter={a7Dual}>
          A7 · dual-bind onClick + onMouseEnter
        </button>

        {/* A8: same handler on the same event across two elements */}
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button data-test="A8-a" onClick={a8Shared}>
            A8 · shared (button A)
          </button>
          <button data-test="A8-b" onClick={a8Shared}>
            A8 · shared (button B)
          </button>
        </div>

        {/* A9: different handlers on the same element */}
        <button data-test="A9" onClick={a9Click} onMouseEnter={a9Hover}>
          A9 · different handlers on one element (click vs hover)
        </button>

        {/* A10: three mouse events */}
        <div
          data-test="A10"
          onMouseEnter={a10Enter}
          onMouseLeave={a10Leave}
          onPointerDown={a10Down}
          style={{
            padding: "1rem",
            border: "1px dashed #999",
            textAlign: "center",
          }}
        >
          A10 · hover or click here (3 mouse events, 3 handlers)
        </div>

        {/* A11: async named handler */}
        <button data-test="A11" onClick={a11AsyncNamed}>
          A11 · async named handler
        </button>

        {/* A12: multi-return component */}
        <MultiReturnTest log={append} />
      </div>

      <h3 style={{ marginTop: "1.5rem" }}>B. Skipped (kept inline)</h3>
      <div style={{ display: "grid", gap: "0.5rem" }}>
        {/* B1: single-line inline arrow */}
        <button
          data-test="B1"
          onClick={() => append("[B1-marker] single-line inline")}
        >
          B1 · single-line inline (under minHandlerLines)
        </button>

        {/* B2: also-referenced-outside-JSX */}
        <button data-test="B2" onClick={b2Handler}>
          B2 · named, also used outside JSX (NOT extracted)
        </button>

        {/* B3: useCallback-wrapped */}
        <button data-test="B3" onClick={b3Handler}>
          B3 · useCallback-wrapped (NOT extracted)
        </button>

        {/* B4: imported handler */}
        <button data-test="B4" onClick={externalHandler}>
          B4 · imported from another module (NOT extracted)
        </button>

        {/* B5: member-expression */}
        <button data-test="B5" onClick={handlers.member}>
          B5 · member expression (NOT extracted)
        </button>

        {/* B6: ternary at value position */}
        <button
          data-test="B6"
          onClick={b6Enabled ? b6A : b6B}
        >
          B6 · ternary at value position (NOT extracted, branch={b6Enabled ? "A" : "B"})
        </button>

        {/* B7: inline arrow wrapping a named handler */}
        <button
          data-test="B7"
          onClick={() => b7Inner()}
          onMouseEnter={() => b7Inner()}
        >
          B7 · inline arrow wrapping a named handler (NOT extracted)
        </button>

        {/* B8: handler passed as a prop to a child */}
        <PropConsumer cb={b8Handler} />
      </div>
    </section>
  );
}
