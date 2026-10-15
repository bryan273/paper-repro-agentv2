import { useEffect } from 'react';

// The viewer is the original Paper Repro Agent UI, served unchanged from public/repro/.
// Do not rebuild or restyle it here. See .atoms/ATOMS.md, "Frozen directory".
const VIEWER = `${import.meta.env.BASE_URL}repro/index.html`;

export default function Index() {
  // keep ?runner=... and any hash, so a link that points the viewer at a runner still works
  const target = `${VIEWER}${window.location.search}${window.location.hash}`;
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem 1.5rem', textAlign: 'center' }}>
      <p>Opening the Paper Repro Agent viewer…</p>
      <p>
        <a href={target}>Open it now</a>
      </p>
    </main>
  );
}
