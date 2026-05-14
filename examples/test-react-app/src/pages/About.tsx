import { useState } from "react";

export default function About() {
  const [likes, setLikes] = useState(0);
  const [reactions, setReactions] = useState<string[]>([]);

  return (
    <main className="page">
      <h1>About</h1>
      <p>This is a minimal React + TypeScript app built with a custom webpack 5 config. It is meant to be the test bed for the <code>lazy-handler-webpack-plugin</code> plugin.</p>

      <button
        onClick={() => {
          const next = likes + 1;
          console.log("[about] like clicked, total:", next);
          setLikes(next);
        }}
      >
        Like ({likes})
      </button>

      <button
        onClick={() => {
          const emojis = ["🚀", "🎉", "🔥", "✨", "💡"];
          const pick = emojis[Math.floor(Math.random() * emojis.length)];
          setReactions([...reactions, pick]);
        }}
      >
        Add a reaction
      </button>

      <p className="reactions">{reactions.join(" ")}</p>
    </main>
  );
}
