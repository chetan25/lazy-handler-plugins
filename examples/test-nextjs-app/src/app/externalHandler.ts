// External handler used by the "imported handler" pattern test. The
// plugin should NOT extract this — the binding inside HandlerPatterns is
// an ImportSpecifier, not a FunctionDeclaration / VariableDeclarator, so
// the named-ref extraction code returns null.
//
// The body has a unique string we can grep for in the build output to
// confirm it didn't get pulled into a nugget chunk.
export const externalHandler = () => {
  console.log("[external-handler-marker] external handler fired");
};
