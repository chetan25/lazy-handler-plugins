// src/core/transform.js
// Bundler-agnostic JSX transform — turns inline event handlers into proxy
// stubs and registers the extracted source in the shared registry. Webpack,
// Rollup, and Vite adapters all delegate to this function. The adapter is
// responsible for serving the registered source as a virtual module
// (`nugget://<chunkName>`) when the bundler later resolves the dynamic import
// the proxy stub emits.
"use strict";

const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");
const crypto = require("crypto");
const path = require("path");
const nuggetRegistry = require("./registry");

// Identifiers that resolve to host or built-in globals at runtime — never
// need to be derefed from the scope registry.
const KNOWN_GLOBALS = new Set([
  "undefined", "null", "true", "false", "NaN", "Infinity", "globalThis",
  "self", "window", "document", "navigator", "location", "history",
  "console", "fetch", "alert", "confirm", "prompt",
  "Promise", "Math", "JSON", "Date",
  "Number", "String", "Boolean", "Array", "Object", "Symbol", "BigInt",
  "Map", "Set", "WeakMap", "WeakSet",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  "isNaN", "isFinite", "parseInt", "parseFloat",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "URL", "URLSearchParams", "FormData", "Blob", "Headers",
  "Request", "Response", "AbortController", "AbortSignal",
  "Intl", "Reflect", "Proxy", "RegExp",
  "atob", "btoa", "structuredClone",
  "localStorage", "sessionStorage", "performance", "crypto",
]);

/**
 * Transform a JSX/TSX module: extract inline event handlers into virtual
 * `nugget://` modules and rewrite the props to dynamic-import proxy stubs.
 *
 * Pure function — does not depend on any bundler API. Side effect: writes
 * the extracted nugget sources to the shared `nuggetRegistry` so the
 * adapter's resolveId/load hooks (Rollup) or readResource hook (webpack)
 * can serve them as virtual modules.
 *
 * @param {string} source   Original module source.
 * @param {string} filePath Absolute path of the source module (used for
 *                          stable hashing and resolving relative imports).
 * @param {object} options  Same shape as the plugin's user options.
 * @returns {{ code: string, map: object | null }} Rewritten source + sourcemap.
 *                          If the file contains no extractable handlers, returns
 *                          { code: source, map: null } so the caller can short-
 *                          circuit.
 */
function nuggetTransform(source, filePath, options = {}) {
  const { eventProps = [], minHandlerLines = 3 } = options;

  // ── Parse source into AST ─────────────────────────────────────────────────
  let ast;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "classProperties"],
    });
  } catch (err) {
    // Unparseable — pass through untouched
    return { code: source, map: null };
  }

  const importedIdentifiers = new Map(); // name → import source
  const extractedHandlers = [];
  // Bindings (named-handler declarations) we extracted by value-of-binding
  // rather than by inline expression. After Phase 4 rewrites every JSX use
  // of them into a proxy stub, the original declarations are dead code in
  // the main bundle — we delete them in Phase 6.5.
  const bindingsToRemove = new Set();
  // Maps identifier-name → registered handlerId, so multiple JSX references
  // to the same named handler share one nugget chunk.
  const namedHandlerCache = new Map();

  // ── Phase 1: collect existing imports ────────────────────────────────────
  // Track each import's local name + source module + kind (default / named /
  // namespace) + the original exported name, so the nugget chunk can rebuild
  // an equivalent import statement.
  //
  // Relative specifiers (./foo, ../bar) are resolved to absolute paths here.
  // The nugget chunk's resource is a virtual `nugget://...` URL, so webpack
  // can't resolve relatives against it — we hand it an absolute path instead.
  const sourceFileDir = path.dirname(filePath);
  traverse(ast, {
    ImportDeclaration(nodePath) {
      // Skip the entire declaration if it's `import type { ... }` — these
      // names exist only in TypeScript type-position and are erased before
      // runtime, so the nugget chunk must NOT re-import them as values.
      // Combining a type-only default + a value-named would produce
      // `import Foo, { bar } from "./mod"` which TS rejects with
      // "Import type cannot combine a type only default with value named
      //  import." If the original was a type declaration we just skip it.
      if (nodePath.node.importKind === "type") return;

      const rawSource = nodePath.node.source.value;
      const resolvedSource = /^\.\.?\//.test(rawSource)
        ? path.resolve(sourceFileDir, rawSource).replace(/\\/g, "/")
        : rawSource;
      nodePath.node.specifiers.forEach((spec) => {
        // Skip per-specifier type modifiers: `import { type Foo, bar }`.
        // Only `bar` is a runtime value here.
        if (spec.importKind === "type") return;

        let kind, imported;
        if (spec.type === "ImportDefaultSpecifier") {
          kind = "default";
          imported = "default";
        } else if (spec.type === "ImportNamespaceSpecifier") {
          kind = "namespace";
          imported = "*";
        } else {
          // ImportSpecifier — handle "import { foo as bar }"
          kind = "named";
          imported =
            spec.imported.type === "Identifier"
              ? spec.imported.name
              : spec.imported.value;
        }
        importedIdentifiers.set(spec.local.name, {
          source: resolvedSource,
          kind,
          imported,
        });
      });
    },
  });

  // ── Phase 2: detect and extract JSX event handler props ──────────────────
  traverse(ast, {
    JSXAttribute(nodePath) {
      const propName = nodePath.node.name?.name;
      if (!eventProps.includes(propName)) return;

      const value = nodePath.node.value;
      if (value?.type !== "JSXExpressionContainer") return;

      // The expression we extract from. Starts as the JSX prop value; for
      // identifier refs we swap it for the function expression the binding
      // resolves to so the rest of this visitor body works unchanged.
      let expr = value.expression;
      // For named-ref extraction we track the binding so we can:
      //   (a) verify every reference is rewritable here,
      //   (b) reuse one nugget across multiple JSX uses of the same name,
      //   (c) remove the original declaration in Phase 6.5.
      let namedBinding = null;
      let namedIdentifier = null;

      if (expr.type === "Identifier") {
        const ident = expr.name;
        const binding = nodePath.scope.getBinding(ident);
        if (!binding) return; // implicit global — skip
        const fnNode = getFunctionFromBinding(binding, t);
        if (!fnNode) return; // not a function-shaped binding
        if (!allReferencesAreEventProps(binding, eventProps)) return;
        namedBinding = binding;
        namedIdentifier = ident;
        expr = fnNode;
      }

      const isInlineFunction =
        expr.type === "ArrowFunctionExpression" ||
        expr.type === "FunctionExpression";
      if (!isInlineFunction) return;

      // Strip TypeScript-only syntax from the handler AST. The emitted nugget
      // module is served via the readResource hook with no loaders attached,
      // so it must already be plain JS by the time it leaves the loader.
      // (The main bundle still goes through babel-loader normally — these
      // mutations don't affect it because the original handler node is replaced
      // outright by the proxy call below.)
      stripTypes(expr);

      // Skip trivial handlers below the line threshold
      const handlerSource = generate(expr).code;
      const lineCount = handlerSource.split("\n").length;
      if (lineCount < minHandlerLines) return;

      // Stable hash — same handler in same file always produces same chunk name.
      // For named-ref extraction we key by identifier instead of prop+body so
      // multiple JSX uses (e.g. <a onClick={fn}/> and <button onSubmit={fn}/>)
      // share a single nugget chunk.
      const hashInput = namedIdentifier
        ? filePath + "::named::" + namedIdentifier
        : filePath + propName + handlerSource;
      const hash = crypto
        .createHash("sha1")
        .update(hashInput)
        .digest("hex")
        .slice(0, 8);

      const idLabel = namedIdentifier || propName;
      const handlerId = `nugget_${idLabel}_${hash}`;
      const chunkName = `nugget-${hash}`;
      if (namedBinding) bindingsToRemove.add(namedBinding);

      // ── Detect time-sensitive calls to hoist (preventDefault etc.) ────────
      // Only look at TOP-LEVEL statements of the handler body. A nested call
      // such as `setTimeout(() => e.preventDefault(), 100)` must NOT be
      // hoisted — that would call preventDefault synchronously and defeat the
      // user's intent. We also drop hoist support for handlers whose first
      // statement is an `if` / branch — we can't statically tell whether the
      // branch was meant to actually run on every event.
      const hoistedCalls = [];
      const hoistTargets = new Set(["preventDefault", "stopPropagation", "stopImmediatePropagation"]);

      if (expr.body && expr.body.type === "BlockStatement") {
        for (const stmt of expr.body.body) {
          if (stmt.type !== "ExpressionStatement") break;
          const call = stmt.expression;
          if (
            call.type === "CallExpression" &&
            call.callee.type === "MemberExpression" &&
            !call.callee.computed &&
            call.callee.property.type === "Identifier" &&
            hoistTargets.has(call.callee.property.name)
          ) {
            hoistedCalls.push(call);
            continue;
          }
          // First non-hoistable statement → stop scanning. Hoisting past a
          // user statement would reorder side effects.
          break;
        }
      }

      // ── Detect captured variables (closure analysis) ──────────────────────
      // A capture is an identifier referenced inside the handler that is bound
      // OUTSIDE the handler's own function scope. State setters, state values,
      // props, and other component-scope names are captures. Handler params,
      // local consts, and params of nested callbacks (e.g. `p` in `.map(p => …)`)
      // are NOT captures.
      //
      // For named-ref extraction the function lives at its original AST
      // position (the binding's declaration) — we walk THAT in-tree path so
      // `handlerScope` matches Babel's existing scope objects. Walking a
      // detached clone would create fresh scope objects that don't compare
      // equal to the bindings' actual scopes.
      const capturedVars = new Set();
      const handlerPath = namedBinding
        ? getFunctionInTreePath(namedBinding)
        : nodePath.get("value").get("expression");
      const handlerScope = handlerPath.scope;

      handlerPath.traverse({
        Identifier(innerPath) {
          if (!innerPath.isReferencedIdentifier()) return;
          const name = innerPath.node.name;
          if (KNOWN_GLOBALS.has(name)) return;

          const binding = innerPath.scope.getBinding(name);
          if (!binding) return; // implicit global — leave alone

          // Walk up from the binding's scope. If we reach handlerScope, the
          // binding lives inside the handler → local, not a capture.
          let s = binding.scope;
          let isLocal = false;
          while (s) {
            if (s === handlerScope) { isLocal = true; break; }
            s = s.parent;
          }
          if (!isLocal) capturedVars.add(name);
        },
      });

      // Classify captured vars — determines extraction strategy
      const captures = [...capturedVars].map((name) => {
        const info = importedIdentifiers.get(name);
        return {
          name,
          isImported: !!info,
          importSource: info && info.source,
          importKind: info && info.kind,
          importedName: info && info.imported,
        };
      });

      // If the handler hoists a call (preventDefault etc.) we must preserve
      // its identifier bindings on the wrapper. We can only do that safely for
      // identifier-shaped params; destructuring patterns would need us to
      // re-evaluate the destructure on the wrapper side. Rather than emit a
      // wrong wrapper, we silently drop the hoist when params are too complex.
      const paramsForwardable = (expr.params || []).every(
        (p) =>
          p.type === "Identifier" ||
          (p.type === "AssignmentPattern" && p.left.type === "Identifier") ||
          (p.type === "RestElement" && p.argument.type === "Identifier")
      );
      const safeHoistedCalls = paramsForwardable ? hoistedCalls : [];

      extractedHandlers.push({
        id: handlerId,
        chunkName,
        code: handlerSource,
        propName,
        nodePath,
        captures,
        hoistedCalls: safeHoistedCalls,
        // Preserve the original handler's parameter AST nodes. We rebuild the
        // proxy wrapper with the SAME identifier names so any references in
        // the hoisted statements (e.g. `e.preventDefault()`) still resolve.
        params: expr.params,
        hash,
      });
    },
  });

  if (extractedHandlers.length === 0) {
    return { code: source, map: null };
  }

  // ── Phase 3: inject runtime import (after any leading directives) ───────
  // Pages tagged with "use client" / "use server" in App Router require the
  // directive to be the FIRST statement in the module. Inserting an import
  // before it silently demotes the file from client component to server
  // component (or vice versa). Skip past leading directive-style statements.
  const runtimeImport = t.importDeclaration(
    [
      t.importSpecifier(t.identifier("__nuggetProxy"), t.identifier("__nuggetProxy")),
      t.importSpecifier(t.identifier("__nuggetCreateScope"), t.identifier("__nuggetCreateScope")),
      t.importSpecifier(t.identifier("__nuggetDestroyScope"), t.identifier("__nuggetDestroyScope")),
      t.importSpecifier(t.identifier("__nuggetRegisterRef"), t.identifier("__nuggetRegisterRef")),
    ],
    t.stringLiteral("lazy-handler-plugin/runtime")
  );
  const directiveCount = countLeadingDirectives(ast);
  ast.program.body.splice(directiveCount, 0, runtimeImport);

  // ── Phase 4: rewrite JSX props with proxy wrappers ───────────────────────
  for (const handler of extractedHandlers) {
    const { id, chunkName, nodePath, hoistedCalls, captures, params } = handler;

    // The webpackChunkName magic comment preserves the human-readable chunk
    // name so output.chunkFilename can route it to nuggetDir.
    const importArg = t.stringLiteral(`nugget://${chunkName}`);
    t.addComment(importArg, "leading", ` webpackChunkName: "${chunkName}" `);

    // Build the wrapper's parameter list. We keep the SAME identifier bindings
    // the original handler used so any hoisted statement that references one
    // of them (e.g. `e.preventDefault()`) resolves cleanly. After the named
    // params we tack on a rest element so the wrapper still forwards any
    // extra arguments React might pass.
    const REST_NAME = "__nuggetRest";
    const wrapperParams = [];
    const forwardedArgs = [];
    let needsRest = true;
    for (const p of params || []) {
      // RestElement must be last and prevents any further named params. Once
      // the user wrote `(...args) => …`, we just forward that.
      if (p.type === "RestElement" && p.argument.type === "Identifier") {
        wrapperParams.push(t.cloneNode(p));
        forwardedArgs.push(t.spreadElement(t.identifier(p.argument.name)));
        needsRest = false;
        break;
      }
      if (p.type === "Identifier") {
        wrapperParams.push(t.cloneNode(p));
        forwardedArgs.push(t.identifier(p.name));
        continue;
      }
      if (p.type === "AssignmentPattern" && p.left.type === "Identifier") {
        wrapperParams.push(t.cloneNode(p));
        forwardedArgs.push(t.identifier(p.left.name));
        continue;
      }
      // Any other shape (destructuring patterns, TS-style this params, etc.)
      // is replaced with a synthetic name we control. This is only reached
      // when there were no hoisted calls (the param-forwardability check at
      // extraction time would have stripped them otherwise), so the handler
      // body never references the original binding by name.
      const synthetic = t.identifier(`__nuggetArg${forwardedArgs.length}`);
      wrapperParams.push(synthetic);
      forwardedArgs.push(t.cloneNode(synthetic));
    }
    if (needsRest) {
      wrapperParams.push(t.restElement(t.identifier(REST_NAME)));
      forwardedArgs.push(t.spreadElement(t.identifier(REST_NAME)));
    }

    const proxyCall = t.callExpression(t.identifier("__nuggetProxy"), [
      t.stringLiteral(id),
      t.arrowFunctionExpression(
        [],
        t.callExpression(t.import(), [importArg])
      ),
      t.arrayExpression(forwardedArgs),
      t.objectExpression([
        t.objectProperty(t.identifier("scopeId"), t.identifier("__scopeId")),
        t.objectProperty(
          t.identifier("refs"),
          t.arrayExpression(captures.map((c) => t.stringLiteral(c.name)))
        ),
      ]),
    ]);

    // Hoist time-sensitive calls before the proxy. The captured AST nodes
    // were already validated as top-level + reference the original params,
    // which we kept in `wrapperParams` above.
    const bodyStatements = [
      ...hoistedCalls.map((call) => t.expressionStatement(t.cloneNode(call))),
      t.expressionStatement(proxyCall),
    ];

    const replacement = t.jsxExpressionContainer(
      t.arrowFunctionExpression(
        wrapperParams,
        t.blockStatement(bodyStatements)
      )
    );

    nodePath.node.value = replacement;

    // Tag the JSX opening element so the runtime IntersectionObserver can
    // preload this handler's chunk as the element nears the viewport.
    // The runtime watches for `data-nugget-lazy="<chunkName>"` and emits a
    // <link rel="modulepreload"> when the element scrolls into range.
    const openingElement = nodePath.parent;
    if (openingElement && openingElement.type === "JSXOpeningElement") {
      const alreadyTagged = openingElement.attributes.some(
        (attr) =>
          attr.type === "JSXAttribute" &&
          attr.name &&
          attr.name.type === "JSXIdentifier" &&
          attr.name.name === "data-nugget-lazy"
      );
      if (!alreadyTagged) {
        openingElement.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-nugget-lazy"),
            t.stringLiteral(chunkName)
          )
        );
      }
    }

    // Register in global registry — source is served by the plugin's
    // readResource hook when webpack builds the virtual nugget:// module.
    nuggetRegistry.register(id, {
      chunkName,
      sourceFile: filePath,
      prop: handler.propName,
      source: buildNuggetSource(handler, filePath),
    });
  }

  // ── Phase 5: inject per-component scope wiring ──────────────────────────
  // For every component that contains at least one extracted handler, prepend
  // a useRef-backed scope id, a useEffect cleanup, and one __nuggetRegisterRef
  // call per non-imported capture. Without this, the proxy's `__scopeId`
  // would be undefined and `__nuggetDeref` would return null at click time.
  injectScopeWiring(ast, extractedHandlers, t);

  // ── Phase 5.5: remove the original declarations of named handlers ───────
  // Every JSX use of `handleClick` was rewritten in Phase 4. We verified at
  // extraction time that there are no OTHER references in the file, so the
  // declaration is now dead code — but webpack/rollup tree-shaking won't
  // necessarily drop a const/function declaration inside a component body.
  // Remove it explicitly so the function source doesn't ship in the main
  // bundle.
  for (const binding of bindingsToRemove) {
    const bp = binding.path;
    if (bp.isFunctionDeclaration()) {
      bp.remove();
    } else if (bp.isVariableDeclarator()) {
      const decl = bp.parentPath;
      if (decl.node.declarations.length === 1) decl.remove();
      else bp.remove();
    }
  }

  // ── Phase 6: prune imports that have no remaining references ────────────
  // After the handler bodies were replaced with proxy stubs, any library
  // import whose only consumer was an extracted handler is now dead in the
  // main bundle. The nugget chunk re-imports it from its original module,
  // so dropping it here keeps that library out of the main bundle.
  // (Side-effect-only imports — `import "polyfill"` — are preserved.)
  removeUnusedImports(ast);

  const { code, map } = generate(ast, { sourceMaps: true }, source);
  return { code, map };
}

module.exports = { nuggetTransform };

// ─── Scope wiring injection ────────────────────────────────────────────────

function injectScopeWiring(ast, extractedHandlers, t) {
  // Group handlers by their enclosing component function path.
  const componentToHandlers = new Map();
  for (const h of extractedHandlers) {
    const fnPath = h.nodePath.getFunctionParent();
    if (!fnPath) continue; // top-level JSX (unusual) — skip
    const list = componentToHandlers.get(fnPath) || [];
    list.push(h);
    componentToHandlers.set(fnPath, list);
  }

  for (const [fnPath, handlers] of componentToHandlers) {
    // Collect unique non-imported captures across all handlers in this component.
    // Imported captures get static `import` statements inside the nugget chunk,
    // so they don't need to flow through the scope registry.
    const captureNames = new Set();
    for (const h of handlers) {
      for (const c of h.captures) {
        if (!c.isImported) captureNames.add(c.name);
      }
    }

    // Ensure the function body is a BlockStatement (convert expression body).
    if (fnPath.node.body.type !== "BlockStatement") {
      fnPath.node.body = t.blockStatement([
        t.returnStatement(fnPath.node.body),
      ]);
    }
    const body = fnPath.node.body;

    // Scope wiring — three pieces:
    //
    // 1. Lazy useRef init for the scope id. Evaluating __nuggetCreateScope() as
    //    the argument to useRef() (the previous shape) leaked one scope per
    //    render, because JS evaluates the arg every call even though useRef
    //    only uses the first one.
    //
    //       const __scopeRef = useRef(null);
    //       if (__scopeRef.current === null) {
    //         __scopeRef.current = __nuggetCreateScope();
    //       }
    //       const __scopeId = __scopeRef.current;
    const refDecl = t.variableDeclaration("const", [
      t.variableDeclarator(
        t.identifier("__scopeRef"),
        t.callExpression(t.identifier("useRef"), [t.nullLiteral()])
      ),
    ]);
    const lazyInit = t.ifStatement(
      t.binaryExpression(
        "===",
        t.memberExpression(t.identifier("__scopeRef"), t.identifier("current")),
        t.nullLiteral()
      ),
      t.blockStatement([
        t.expressionStatement(
          t.assignmentExpression(
            "=",
            t.memberExpression(
              t.identifier("__scopeRef"),
              t.identifier("current")
            ),
            t.callExpression(t.identifier("__nuggetCreateScope"), [])
          )
        ),
      ])
    );
    const scopeIdDecl = t.variableDeclaration("const", [
      t.variableDeclarator(
        t.identifier("__scopeId"),
        t.memberExpression(
          t.identifier("__scopeRef"),
          t.identifier("current")
        )
      ),
    ]);

    // 2. Cleanup effect — destroy the scope on real unmount. Note that in
    //    React 18 StrictMode dev mode this cleanup *also* fires during the
    //    artificial unmount→remount cycle, which leaves the scope destroyed
    //    while the committed JSX still holds the original scope id. That's
    //    why piece (3) below re-registers from inside an effect — the effect
    //    re-runs after the strict remount, and __nuggetRegisterRef lazily
    //    re-creates the scope entry if missing.
    //
    //       useEffect(() => () => __nuggetDestroyScope(__scopeId), []);
    const cleanupEffect = t.expressionStatement(
      t.callExpression(t.identifier("useEffect"), [
        t.arrowFunctionExpression(
          [],
          t.arrowFunctionExpression(
            [],
            t.callExpression(t.identifier("__nuggetDestroyScope"), [
              t.identifier("__scopeId"),
            ])
          )
        ),
        t.arrayExpression([]),
      ])
    );

    // 3. Register effect — re-installs every capture on each commit. The
    //    no-deps form fires on every render AND re-fires after the strict
    //    remount, which is what makes the StrictMode case recover.
    //
    //       useEffect(() => {
    //         __nuggetRegisterRef(__scopeId, "setX", setX);
    //         ...
    //       });
    const registerEffect = t.expressionStatement(
      t.callExpression(t.identifier("useEffect"), [
        t.arrowFunctionExpression(
          [],
          t.blockStatement(
            [...captureNames].map((name) =>
              t.expressionStatement(
                t.callExpression(t.identifier("__nuggetRegisterRef"), [
                  t.identifier("__scopeId"),
                  t.stringLiteral(name),
                  t.identifier(name),
                ])
              )
            )
          )
        ),
      ])
    );

    // Synchronous render-body register calls cover the narrow window between
    // commit and the first effect tick (clicks that fire on the same task as
    // initial paint can otherwise see no refs registered). These must fire
    // on EVERY render path that can produce JSX, so we splice them in before
    // every ReturnStatement in the component body — not just the first one
    // at the top level. Components with early returns, conditional renders,
    // or branched render paths (e.g. `if (loading) return <Spinner/>; return
    // <Main/>;`) would otherwise miss registration on whichever path didn't
    // get the splice — the nugget's `__nuggetDeref` would then return null
    // and the handler would no-op (the originally-reported "onMouseEnter
    // doesn't fire" symptom).
    //
    // We build a fresh template per insertion site so each call site gets
    // its own AST nodes (Babel doesn't like node identity sharing across
    // multiple parent positions).
    const buildRenderBodyRegisterCalls = () =>
      [...captureNames].map((name) =>
        t.expressionStatement(
          t.callExpression(t.identifier("__nuggetRegisterRef"), [
            t.identifier("__scopeId"),
            t.stringLiteral(name),
            t.identifier(name),
          ])
        )
      );

    // Walk the component body for every ReturnStatement, skipping nested
    // function scopes so we don't inject into `useCallback` arrows, JSX
    // proxy stubs, or unrelated helpers declared inside the component.
    const returnPaths = [];
    fnPath.traverse({
      Function(innerPath) {
        innerPath.skip();
      },
      ReturnStatement(rp) {
        returnPaths.push(rp);
      },
    });

    if (returnPaths.length === 0) {
      // No top-level return found — append the calls at the body's end.
      // Pathological (component returns undefined) but at least keeps the
      // registry populated on render.
      body.body.push(...buildRenderBodyRegisterCalls());
    } else {
      for (const rp of returnPaths) {
        rp.insertBefore(buildRenderBodyRegisterCalls());
      }
    }

    // Hooks (useRef, useEffect for cleanup, useEffect for re-register) must
    // run on every render in stable order. We place ALL hooks at the top of
    // the body — putting the register effect before each return would make
    // it a conditional hook, which violates React's rules of hooks when the
    // component has more than one return path.
    body.body.unshift(
      refDecl,
      lazyInit,
      scopeIdDecl,
      cleanupEffect,
      registerEffect
    );
  }

  // Ensure useRef and useEffect are imported from "react".
  let reactImport = ast.program.body.find(
    (n) =>
      n.type === "ImportDeclaration" && n.source && n.source.value === "react"
  );
  if (!reactImport) {
    reactImport = t.importDeclaration([], t.stringLiteral("react"));
    // Place after leading directives + the runtime import that Phase 3 added.
    const insertAt = countLeadingDirectives(ast) + 1;
    ast.program.body.splice(insertAt, 0, reactImport);
  }
  const have = new Set(
    reactImport.specifiers
      .filter((s) => s.type === "ImportSpecifier")
      .map((s) => s.imported.name)
  );
  for (const name of ["useRef", "useEffect"]) {
    if (!have.has(name)) {
      reactImport.specifiers.push(
        t.importSpecifier(t.identifier(name), t.identifier(name))
      );
    }
  }
}

// ─── Directive detection ───────────────────────────────────────────────────
// Module-level directives ("use client", "use server", "use strict") may
// appear in Program.body as ExpressionStatement(StringLiteral) when Babel
// parses module sources. They must remain the first statement(s) for React
// Server Components and Next.js App Router to detect the boundary correctly.

function countLeadingDirectives(ast) {
  let count = 0;
  for (const stmt of ast.program.body) {
    if (
      stmt.type === "ExpressionStatement" &&
      stmt.expression &&
      stmt.expression.type === "StringLiteral" &&
      typeof stmt.expression.value === "string" &&
      /^use [a-z]+$/.test(stmt.expression.value)
    ) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ─── Unused import pruning ─────────────────────────────────────────────────
// Drops import specifiers whose local names are no longer referenced anywhere
// in the program. If all of an import's specifiers get dropped AND the import
// originally had specifiers (i.e. it wasn't a bare `import "foo"` side-effect
// import), the whole declaration is removed.

function removeUnusedImports(ast) {
  // Collect the local names of every import specifier.
  const importedLocals = new Set();
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    for (const spec of node.specifiers) {
      importedLocals.add(spec.local.name);
    }
  }
  if (importedLocals.size === 0) return;

  // Walk the program for any reference to those locals. Skip ImportDeclaration
  // subtrees so the specifier-binding sites themselves don't count as refs.
  const referenced = new Set();
  traverse(ast, {
    ImportDeclaration(p) {
      p.skip();
    },
    Identifier(p) {
      const name = p.node.name;
      if (importedLocals.has(name)) referenced.add(name);
    },
    JSXIdentifier(p) {
      const name = p.node.name;
      if (importedLocals.has(name)) referenced.add(name);
    },
  });

  // Prune in-place.
  ast.program.body = ast.program.body.filter((node) => {
    if (node.type !== "ImportDeclaration") return true;
    const hadSpecifiers = node.specifiers.length > 0;
    node.specifiers = node.specifiers.filter((spec) =>
      referenced.has(spec.local.name)
    );
    // Was a real (specifier-bearing) import; nothing remains → drop it.
    if (hadSpecifiers && node.specifiers.length === 0) return false;
    return true;
  });
}

// ─── TS stripping ──────────────────────────────────────────────────────────
// Walks an AST node in-place and removes TypeScript-only constructs so the
// resulting source is valid JS. Used on handler ASTs before they're serialized
// for nugget chunks (which skip babel-loader).

const TS_WRAPPER_TYPES = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSSatisfiesExpression",
  "TSInstantiationExpression",
]);

const TS_ERASED_DECLARATIONS = new Set([
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
  "TSDeclareFunction",
  "TSModuleDeclaration",
]);

const TS_TYPE_PROPS = [
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "superTypeParameters",
  "implements",
  "definite",
];

const SKIP_KEYS = new Set([
  "loc", "start", "end", "range",
  "leadingComments", "trailingComments", "innerComments",
]);

function stripTypes(node) {
  if (!node || typeof node !== "object") return node;

  if (TS_WRAPPER_TYPES.has(node.type)) {
    return stripTypes(node.expression);
  }

  for (const prop of TS_TYPE_PROPS) {
    if (node[prop] != null) node[prop] = null;
  }

  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const val = node[key];
    if (Array.isArray(val)) {
      const out = [];
      for (const v of val) {
        if (v && typeof v === "object" && v.type) {
          if (TS_ERASED_DECLARATIONS.has(v.type)) continue;
          out.push(stripTypes(v));
        } else {
          out.push(v);
        }
      }
      node[key] = out;
    } else if (val && typeof val === "object" && val.type) {
      if (TS_ERASED_DECLARATIONS.has(val.type)) {
        node[key] = null;
      } else {
        node[key] = stripTypes(val);
      }
    }
  }

  return node;
}

/**
 * Generate the source for a handler nugget virtual module.
 * Re-imports the identifiers it needs from their ORIGINAL module sources
 * (e.g. "marked", "date-fns") — not from the user's component file. This
 * lets webpack place the library code in the nugget's chunk graph instead
 * of the main bundle.
 */
function buildNuggetSource(handler, sourceFilePath) {
  const importedCaptures = handler.captures.filter((c) => c.isImported);
  const refCaptures = handler.captures.filter((c) => !c.isImported);

  // Group captures by source module so we emit one import statement per
  // module, preserving default / namespace / named distinctions.
  const bySource = new Map();
  for (const c of importedCaptures) {
    if (!c.importSource) continue;
    if (!bySource.has(c.importSource)) bySource.set(c.importSource, []);
    bySource.get(c.importSource).push(c);
  }

  const importLines = [...bySource.entries()]
    .map(([src, caps]) => {
      const defaultCap = caps.find((c) => c.importKind === "default");
      const namespaceCap = caps.find((c) => c.importKind === "namespace");
      const namedCaps = caps.filter((c) => c.importKind === "named");

      const parts = [];
      if (defaultCap) parts.push(defaultCap.name);
      if (namespaceCap) parts.push(`* as ${namespaceCap.name}`);
      if (namedCaps.length) {
        const namedSpec = namedCaps
          .map((c) =>
            c.name === c.importedName ? c.name : `${c.importedName} as ${c.name}`
          )
          .join(", ");
        parts.push(`{ ${namedSpec} }`);
      }
      return `import ${parts.join(", ")} from "${src}";`;
    })
    .join("\n");

  const derefLines = refCaptures
    .map((c) => `  const ${c.name} = __nuggetDeref(scopeId, "${c.name}");`)
    .join("\n");

  // Use __nuggetHasScope to detect unmount — checking `!value` per capture
  // would mis-bail on legitimately falsy state (count===0, ""===empty, etc.).
  const scopeCheck = refCaptures.length
    ? `  if (!__nuggetHasScope(scopeId)) return; // component unmounted`
    : "";

  return `
// Auto-generated handler nugget — do not edit
// Source: ${sourceFilePath}
// Handler: ${handler.propName} (${handler.hash})
import { __nuggetDeref, __nuggetHasScope } from "lazy-handler-plugin/runtime";
${importLines}

export default async function ${handler.id}(args, { scopeId }) {
${scopeCheck}
${derefLines}
  const handler = ${handler.code};
  return handler(...args);
}
`.trim();
}

// ─── Named-handler binding helpers ─────────────────────────────────────────
// Support for `onClick={handleClick}` where `handleClick` resolves to a
// function declaration / arrow / function-expression in the same module.
// (The `@babel/types` binding `t` is already required at the top of this
// module — reused here.)

/**
 * Resolve the function node a binding points to, or null if the binding
 * isn't function-shaped (imports, class fields, useCallback wrappers, etc).
 * Returns a node we can use as the handler — for FunctionDeclaration we wrap
 * into an equivalent FunctionExpression so the proxy stub's wrapper-rebuild
 * code (which assumes an arrow/function expression) just works.
 */
function getFunctionFromBinding(binding) {
  const node = binding.path.node;
  if (!node) return null;
  if (node.type === "FunctionDeclaration") {
    return t.functionExpression(
      null,
      node.params,
      node.body,
      node.async,
      node.generator
    );
  }
  if (node.type === "VariableDeclarator" && node.init) {
    const init = node.init;
    if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
      return init;
    }
  }
  return null;
}

/**
 * Get the in-tree path of the function the binding points to. The path's
 * `.scope` is the function's own scope — what the capture analyzer compares
 * against. Returning the in-tree path lets us call `.traverse({...})` on it
 * directly, which reuses Babel's existing scope objects (a fresh `traverse`
 * call would create new ones that wouldn't compare equal to the bindings'
 * scopes we read from elsewhere).
 */
function getFunctionInTreePath(binding) {
  if (binding.path.isFunctionDeclaration()) return binding.path;
  if (binding.path.isVariableDeclarator()) return binding.path.get("init");
  return null;
}

/**
 * Return true iff every reference to `binding` is the direct expression of
 * a JSXAttribute value whose name is one of `eventProps`. Anything else —
 * a hook deps array, a manual addEventListener, a debug `console.log` — means
 * removing the original declaration would break the file, so we skip
 * extraction for that handler entirely.
 */
function allReferencesAreEventProps(binding, eventProps) {
  if (!binding.referencePaths || binding.referencePaths.length === 0) return false;
  for (const ref of binding.referencePaths) {
    const container = ref.parentPath;
    if (!container || !container.isJSXExpressionContainer()) return false;
    const attr = container.parentPath;
    if (!attr || !attr.isJSXAttribute()) return false;
    const attrName = attr.node.name && attr.node.name.name;
    if (!eventProps.includes(attrName)) return false;
  }
  return true;
}

