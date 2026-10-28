import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { loadLegacyDoc, store } from './engine/doc';
import { getDef } from './modules/registry';
import { defaultPatch } from './defaultPatch';
import { seedWhenEmpty } from './sync/session';
import { engine } from './engine/engine';

engine.setModuleLookup(getDef);

// A brand-new room starts with the patch from the single-user prototype, or the starter patch
seedWhenEmpty(
  () => store.isEmpty(),
  () => {
    const legacy = loadLegacyDoc();
    const valid = legacy && Object.values(legacy.nodes ?? {}).every((n) => getDef(n.type));
    store.replace(valid ? legacy : defaultPatch());
  },
);

createRoot(document.getElementById('root')!).render(<App />);
