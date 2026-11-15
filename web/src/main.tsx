import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/caprasimo/400.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/fraunces/600.css';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './styles/organic.css';
import './styles/app.css';
import App from './App';
import { apply, cached } from './appearance';

// This device's last appearance, before anything paints; the saved one replaces it once you're signed in.
apply(cached());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
